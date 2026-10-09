import { afterEach, describe, expect, it } from "vitest";
import * as asar from "@electron/asar";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import {
  decode as decodeMessagePack,
  encode as encodeMessagePack,
} from "@msgpack/msgpack";
import { gunzipSync, gzipSync } from "fflate";
import { type Document, emptyDocument, entity } from "./model";
import {
  type CadProject,
  type ProjectManifest,
  addProjectAttachment,
  attachmentData,
  createProject,
  decodeProject,
  encodeProject,
  packAsar,
  projectFileName,
  removeProjectAttachment,
  unpackAsar,
  withProjectDocument,
} from "./projectArchive";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MANIFEST = "manifest.json";
const SKETCH = "documents/sketch.jsonb.gz";
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG0sAAAAASUVORK5CYII=",
    "base64",
  ),
);
const temporaryDirectories = new Set<string>();
const temporaryPrefix = "sketchworks-archive-vitest-";
async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), temporaryPrefix));
  temporaryDirectories.add(directory);
  return directory;
}
afterEach(async () => {
  asar.uncacheAll();
  for (const directory of temporaryDirectories) {
    const absolute = resolve(directory);
    if (
      dirname(absolute) !== resolve(tmpdir()) ||
      !basename(absolute).startsWith(temporaryPrefix)
    )
      throw new Error("测试临时目录不在指定范围内");
    await rm(absolute, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

function sketchDocument(): Document {
  const document = emptyDocument();
  document.name = "连接板工程";
  const circle = entity("circle", [{ x: 12.5, y: -2 }], {
    radius: 7.5,
    ry: undefined,
  });
  document.sketches[0].entities.push(circle);
  document.sketches[0].constraints.push({
    id: "diameter-real-reference",
    kind: "diameter",
    refs: [circle.id],
    value: 15,
    expression: undefined,
  });
  document.parameters.push({ name: "pitch", expression: "12.5", unit: "mm" });
  return document;
}
function projectFiles(): Map<string, Uint8Array> {
  return unpackAsar(encodeProject(createProject(sketchDocument())));
}
function mutateManifest(
  files: Map<string, Uint8Array>,
  mutate: (manifest: ProjectManifest) => void,
): void {
  const manifest = JSON.parse(
    decoder.decode(files.get(MANIFEST)!),
  ) as ProjectManifest;
  mutate(manifest);
  files.set(MANIFEST, encoder.encode(JSON.stringify(manifest)));
}
function replaceSketch(
  files: Map<string, Uint8Array>,
  bytes: Uint8Array,
): void {
  files.set(SKETCH, gzipSync(bytes, { mtime: 0 }));
  mutateManifest(files, (manifest) => {
    manifest.documents.cad2d.uncompressedSize = bytes.length;
  });
}
function rawAsar(header: unknown, body = new Uint8Array()): Uint8Array {
  const json = encoder.encode(
    typeof header === "string" ? header : JSON.stringify(header),
  );
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(8 + headerSize + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 4, true);
  view.setUint32(4, headerSize, true);
  view.setUint32(8, headerSize - 4, true);
  view.setUint32(12, json.length, true);
  bytes.set(json, 16);
  bytes.set(body, 8 + headerSize);
  return bytes;
}
function archiveWithAttachment(): CadProject {
  return addProjectAttachment(createProject(sketchDocument()), {
    name: "参考图.PNG",
    mimeType: "image/png",
    data: PNG,
  });
}

const unknownPayloads = new Map<string, Uint8Array>([
  [
    "documents/model3d.jsonb",
    new Uint8Array([0x81, 0xa4, 0x6d, 0x65, 0x73, 0x68, 0xc4, 4, 0, 255, 2, 4]),
  ],
  ["manufacturing/toolpath.cam", encoder.encode("G21\nG1 X12.5 Y-2 F300\n")],
  ["manufacturing/source/stock.bin", new Uint8Array([0, 1, 2, 128, 254, 255])],
  ["future/empty.dat", new Uint8Array()],
]);
function futureProject(): CadProject {
  const project = archiveWithAttachment();
  project.manifest.documents.cad3d = {
    path: "documents/model3d.jsonb",
    codec: "future-model-codec",
    version: 23,
  };
  project.manifest.documents.cad2d.futureSketchMetadata = {
    authoringVersion: "9.3",
    flags: [1, 3],
  };
  project.manifest.modules = {
    cam: {
      path: "manufacturing/toolpath.cam",
      machine: "future-mill",
      version: 5,
    },
  };
  project.manifest.extension = {
    nested: [false, null, { unicode: "未来的三维与制造模块" }],
  };
  for (const [path, data] of unknownPayloads)
    project.files.set(path, data.slice());
  return project;
}

describe("project file names", () => {
  it.each([
    ["工程图", "工程图.swcad"],
    ["工程图.swcad", "工程图.swcad"],
    ["工程图.SWCAD", "工程图.swcad"],
    ["工程图.asar", "工程图.swcad"],
    ["工程图.json", "工程图.swcad"],
    ["工程图.sketch.json", "工程图.swcad"],
    ["  工程图  ", "工程图.swcad"],
  ])("normalizes %s to %s", (name, expected) => {
    expect(projectFileName(name)).toBe(expected);
  });
});

describe("standards-compatible browser ASAR", () => {
  it("lets the official Electron ASAR reader list and extract every browser-produced file", async () => {
    const project = futureProject();
    const bytes = encodeProject(project);
    const files = unpackAsar(bytes);
    const directory = await testDirectory();
    const archive = join(directory, "browser-project.cad");
    await writeFile(archive, bytes);
    const listed = asar
      .listPackage(archive, { isPack: false })
      .map((path) => path.replace(/\\/g, "/").replace(/^\//, ""));
    for (const [path, data] of files) {
      expect(listed).toContain(path);
      expect(
        new Uint8Array(asar.extractFile(archive, join(...path.split("/")))),
      ).toEqual(data);
    }
    const header = asar.getRawHeader(archive);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(4);
    expect(header.headerSize).toBe(
      8 + Math.ceil(encoder.encode(header.headerString).length / 4) * 4,
    );
    expect(view.getUint32(8, true)).toBe(header.headerSize - 4);
    expect(header.header.files.documents).toHaveProperty("files");
    expect([...bytes.subarray(0, 2)]).not.toEqual([0x50, 0x4b]);
  });

  it("decodes an official ASAR writer archive with its nested directories and integrity metadata", async () => {
    const expected = futureProject();
    const files = unpackAsar(encodeProject(expected));
    const directory = await testDirectory();
    const source = join(directory, "input");
    for (const [path, data] of files) {
      const target = join(source, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    const archive = join(directory, "official-project.asar");
    await finished(await asar.createPackage(source, archive));
    const bytes = new Uint8Array(await readFile(archive));
    const project = decodeProject(bytes);
    expect(project.document).toEqual(
      JSON.parse(JSON.stringify(expected.document)),
    );
    expect(project.manifest).toEqual(expected.manifest);
    for (const [path, data] of files)
      expect(project.files.get(path)).toEqual(data);
    const encoded = encodeProject(project);
    const repacked = join(directory, "repacked.cad");
    await writeFile(repacked, encoded);
    for (const [path, data] of files)
      expect(
        new Uint8Array(asar.extractFile(repacked, join(...path.split("/")))),
      ).toEqual(data);
  });

  it("handles subarray byte offsets and ArrayBuffer input without sharing archive storage", () => {
    const files = new Map([
      ["a.bin", new Uint8Array([0, 255, 2])],
      ["folder/b.bin", new Uint8Array([9, 8])],
      ["folder/empty.bin", new Uint8Array()],
    ]);
    const bytes = packAsar(files);
    const padded = new Uint8Array(bytes.length + 19);
    padded.set(bytes, 7);
    const extracted = unpackAsar(padded.subarray(7, 7 + bytes.length));
    expect(extracted).toEqual(files);
    padded.fill(0);
    expect(extracted.get("a.bin")).toEqual(new Uint8Array([0, 255, 2]));
    const projectArchive = encodeProject(createProject(sketchDocument()));
    expect(decodeProject(projectArchive.slice().buffer).document.name).toBe(
      "连接板工程",
    );
  });
});

describe("project JSONB and immutable future payload preservation", () => {
  it("stores actual MessagePack under gzip, compresses repetitive geometry, and keeps internal radius", () => {
    const document = sketchDocument();
    for (let index = 0; index < 1500; index++)
      document.sketches[0].entities.push(
        entity("circle", [{ x: index % 50, y: Math.floor(index / 50) }], {
          radius: 7.5,
        }),
      );
    const before = structuredClone(document);
    const project = createProject(document);
    const archive = encodeProject(project);
    const files = unpackAsar(archive);
    const compressed = files.get(SKETCH)!;
    expect([...compressed.subarray(0, 3)]).toEqual([0x1f, 0x8b, 8]);
    const binary = gunzipSync(compressed);
    expect(binary[0]).not.toBe("{".charCodeAt(0));
    const decoded = decodeMessagePack(binary) as Document;
    expect(decoded).toEqual(JSON.parse(JSON.stringify(document)));
    expect(decoded.sketches[0].entities[0].radius).toBe(7.5);
    expect(decoded.sketches[0].entities[0]).not.toHaveProperty("ry");
    expect(decoded.sketches[0].constraints[0]).not.toHaveProperty("expression");
    expect(binary.length).toBe(
      project.manifest.documents.cad2d.uncompressedSize,
    );
    expect(binary.length).toBeLessThan(
      encoder.encode(JSON.stringify(document)).length,
    );
    expect(compressed.length).toBeLessThan(binary.length * 0.55);
    expect(decodeProject(archive).document).toEqual(decoded);
    expect(document).toEqual(before);
    expect(document.sketches[0].entities[0]).toHaveProperty("ry", undefined);
  });

  it("retains unknown manifest fields, 3D and CAM bytes, PNG bytes and map contents through document edits", () => {
    const original = futureProject();
    const decoded = decodeProject(encodeProject(original));
    const beforeManifest = structuredClone(decoded.manifest);
    const beforeFiles = new Map(
      [...decoded.files].map(([path, bytes]) => [path, bytes.slice()]),
    );
    const document = structuredClone(decoded.document);
    document.name = "编辑后的二维草图";
    document.sketches[0].entities[0].radius = 8.25;
    const updated = withProjectDocument(decoded, document);
    expect(updated.files).not.toBe(decoded.files);
    expect(updated.manifest).not.toBe(decoded.manifest);
    expect(updated.manifest.documents).not.toBe(decoded.manifest.documents);
    expect(updated.document).not.toBe(document);
    expect(decoded.manifest).toEqual(beforeManifest);
    expect(decoded.files).toEqual(beforeFiles);
    const roundTrip = decodeProject(encodeProject(updated));
    expect(roundTrip.document.name).toBe(document.name);
    expect(roundTrip.document.sketches[0].entities[0].radius).toBe(8.25);
    expect(roundTrip.manifest.documents.cad3d).toEqual(
      original.manifest.documents.cad3d,
    );
    expect(roundTrip.manifest.documents.cad2d.futureSketchMetadata).toEqual(
      original.manifest.documents.cad2d.futureSketchMetadata,
    );
    expect(roundTrip.manifest.modules).toEqual(original.manifest.modules);
    expect(roundTrip.manifest.extension).toEqual(original.manifest.extension);
    for (const [path, data] of unknownPayloads)
      expect(roundTrip.files.get(path)).toEqual(data);
    const attachment = roundTrip.manifest.attachments[0];
    expect(roundTrip.files.get(attachment.path)).toEqual(PNG);
    expect(updated.files).toEqual(beforeFiles);
  });

  it("clones input documents and only replaces the two known entries when encoding", () => {
    const document = sketchDocument();
    const before = structuredClone(document);
    const project = createProject(document);
    project.files.set(MANIFEST, encoder.encode("previous manifest bytes"));
    project.files.set(SKETCH, encoder.encode("previous sketch bytes"));
    project.files.set("future/opaque.bin", new Uint8Array([0, 255, 128]));
    const beforeFiles = new Map(
      [...project.files].map(([path, data]) => [path, data.slice()]),
    );
    const encoded = unpackAsar(encodeProject(project));
    expect(document).toEqual(before);
    expect(project.files).toEqual(beforeFiles);
    expect(project.document).not.toBe(document);
    expect(encoded.get(MANIFEST)).not.toEqual(beforeFiles.get(MANIFEST));
    expect(encoded.get(SKETCH)).not.toEqual(beforeFiles.get(SKETCH));
    expect(encoded.get("future/opaque.bin")).toEqual(
      beforeFiles.get("future/opaque.bin"),
    );
    project.document.sketches[0].entities[0].points[0].x = 99;
    expect(document.sketches[0].entities[0].points[0].x).toBe(12.5);
  });

  it("preserves harmless unknown __proto__ metadata without prototype pollution", () => {
    const files = projectFiles();
    const raw = JSON.parse(
      decoder.decode(files.get(MANIFEST)!),
    ) as ProjectManifest;
    const extended = {
      ...raw,
      ...JSON.parse('{"__proto__":{"archivePolluted":true}}'),
    };
    files.set(MANIFEST, encoder.encode(JSON.stringify(extended)));
    const project = decodeProject(packAsar(files));
    const roundTrip = decodeProject(
      encodeProject(withProjectDocument(project, project.document)),
    );
    expect(Object.hasOwn(roundTrip.manifest, "__proto__")).toBe(true);
    expect(roundTrip.manifest["__proto__"]).toEqual({ archivePolluted: true });
    expect(
      ({} as { archivePolluted?: boolean }).archivePolluted,
    ).toBeUndefined();
  });
});

describe("binary project attachments", () => {
  it("adds, retrieves, round-trips and removes a real PNG without changing its byte stream", () => {
    const source = createProject(sketchDocument());
    const input = PNG.slice();
    const project = addProjectAttachment(source, {
      name: "参考图.PNG",
      mimeType: "image/png",
      data: input,
    });
    const attachment = project.manifest.attachments[0];
    expect(attachment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(attachment.path).toBe(`assets/${attachment.id}.png`);
    expect(attachment.size).toBe(PNG.length);
    expect(attachment.addedAt).toBeGreaterThan(0);
    expect(source.manifest.attachments).toEqual([]);
    expect(source.files.size).toBe(0);
    input.fill(7);
    expect(attachmentData(project, attachment.id)).toEqual(PNG);
    const returned = attachmentData(project, attachment.id)!;
    returned.fill(8);
    expect(attachmentData(project, attachment.id)).toEqual(PNG);
    const decoded = decodeProject(encodeProject(project));
    expect(decoded.files.get(attachment.path)).toEqual(PNG);
    const removed = removeProjectAttachment(decoded, attachment.id);
    expect(removed.files).not.toBe(decoded.files);
    expect(removed.manifest.attachments).toEqual([]);
    expect(removed.files.has(attachment.path)).toBe(false);
    expect(attachmentData(removed, attachment.id)).toBeUndefined();
    expect(attachmentData(decoded, attachment.id)).toEqual(PNG);
    expect(decodeProject(encodeProject(removed)).manifest.attachments).toEqual(
      [],
    );
  });

  it("uses independent UUIDs, a sanitized suffix and a MIME fallback for arbitrary binary data", () => {
    const source = createProject(sketchDocument());
    const first = addProjectAttachment(source, {
      name: "toolpath.G-CO_DE!",
      mimeType: "",
      data: new Uint8Array([0, 255]),
    });
    const second = addProjectAttachment(first, {
      name: "无扩展名",
      mimeType: "application/octet-stream",
      data: new Uint8Array(),
    });
    expect(first.manifest.attachments).toHaveLength(1);
    expect(second.manifest.attachments).toHaveLength(2);
    expect(second.manifest.attachments[0].path).toMatch(/\.gcode$/);
    expect(second.manifest.attachments[0].mimeType).toBe(
      "application/octet-stream",
    );
    expect(second.manifest.attachments[1].path).toMatch(/\.bin$/);
    expect(second.manifest.attachments[0].id).not.toBe(
      second.manifest.attachments[1].id,
    );
    const decoded = decodeProject(encodeProject(second));
    expect(attachmentData(decoded, second.manifest.attachments[1].id)).toEqual(
      new Uint8Array(),
    );
    expect(removeProjectAttachment(second, "unknown-id").manifest).toEqual(
      second.manifest,
    );
  });
});

describe("ASAR format, paths and bounded data validation", () => {
  it.each([
    ["size pickle payload", 0, 3],
    ["unaligned header", 4, 9],
    ["oversized header", 4, 5 * 1024 * 1024 + 4],
    ["header pickle payload", 8, 7],
    ["negative string length", 12, 0xffffffff],
    ["incorrect string length", 12, 0],
  ])("rejects malformed %s", (_name, offset, value) => {
    const bytes = packAsar(new Map([["a", new Uint8Array([1])]]));
    new DataView(bytes.buffer).setUint32(offset, value, true);
    expect(() => unpackAsar(bytes)).toThrow("文件头");
  });

  it("rejects truncated pickles, bad padding, malformed/invalid UTF-8 JSON, and duplicate decoded names", () => {
    expect(() => unpackAsar(new Uint8Array(15))).toThrow("截断");
    const bytes = packAsar(new Map([["a", new Uint8Array([1])]]));
    expect(() => unpackAsar(bytes.subarray(0, 20))).toThrow("文件头");
    const padded = rawAsar('{"files":{}} ');
    padded[16 + new DataView(padded.buffer).getUint32(12, true)] = 1;
    expect(() => unpackAsar(padded)).toThrow("填充");
    const invalidUtf8 = rawAsar({ files: {} });
    invalidUtf8[16] = 0xff;
    expect(() => unpackAsar(invalidUtf8)).toThrow("UTF-8");
    expect(() => unpackAsar(rawAsar("{broken json"))).toThrow("JSON");
    expect(() =>
      unpackAsar(
        rawAsar(
          '{"files":{"a":{"size":1,"offset":"0"},"\\u0061":{"size":1,"offset":"1"}}}',
          new Uint8Array([1, 2]),
        ),
      ),
    ).toThrow("重复");
  });

  it.each([
    "",
    "../outside",
    "/absolute",
    "folder/../outside",
    "folder//asset",
    "folder\\asset",
    "C:outside",
    "__proto__",
    "constructor/asset",
    "prototype",
    "trailing.",
    "trailing ",
    "nul.bin",
    "bad\u0000name",
  ])("rejects unsafe inline path %j in writer and reader", (path) => {
    expect(() => packAsar(new Map([[path, new Uint8Array()]]))).toThrow(
      /路径|名称/,
    );
    expect(() =>
      unpackAsar(rawAsar({ files: { [path]: { size: 0, offset: "0" } } })),
    ).toThrow(/路径|名称/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    { link: "external" },
    { unpacked: true, size: 1 },
    { unpacked: false, size: 0, offset: "0" },
    { size: -1, offset: "0" },
    { size: 0.5, offset: "0" },
    { size: "1", offset: "0" },
    { size: 0, offset: 0 },
    { size: 0, offset: "-1" },
    { size: 0, offset: "1e0" },
    { size: 0, offset: "00" },
    { size: 0, offset: "9007199254740993" },
    { size: 1, offset: "0" },
    { size: 0, offset: "1" },
    { size: 0, offset: "0", executable: "yes" },
    { files: [], size: 0, offset: "0" },
    { files: {}, size: 0, offset: "0" },
  ])("rejects invalid ASAR entry %j", (entry) => {
    expect(() => unpackAsar(rawAsar({ files: { bad: entry } }))).toThrow(
      "工程文件：",
    );
  });

  it("rejects overlaps, gaps, dangling body bytes, and file-directory conflicts", () => {
    expect(() =>
      unpackAsar(
        rawAsar(
          {
            files: { a: { size: 2, offset: "0" }, b: { size: 1, offset: "1" } },
          },
          new Uint8Array(3),
        ),
      ),
    ).toThrow("重叠");
    expect(() =>
      unpackAsar(
        rawAsar({ files: { a: { size: 1, offset: "1" } } }, new Uint8Array(2)),
      ),
    ).toThrow("缺失");
    expect(() =>
      unpackAsar(rawAsar({ files: {} }, new Uint8Array([1]))),
    ).toThrow("数据区");
    expect(() =>
      unpackAsar(
        rawAsar(
          {
            files: {
              a: { size: 2, offset: "0" },
              empty: { size: 0, offset: "1" },
            },
          },
          new Uint8Array(2),
        ),
      ),
    ).toThrow("空文件");
    expect(() =>
      packAsar(
        new Map([
          ["a", new Uint8Array()],
          ["a/b", new Uint8Array()],
        ]),
      ),
    ).toThrow("冲突");
    expect(() => unpackAsar(rawAsar({ files: {}, unpacked: true }))).toThrow(
      "外部",
    );
  });

  it("enforces archive, header, file count and JSON depth limits before large decoding allocations", () => {
    const oversized = new Uint8Array(100 * 1024 * 1024 + 1);
    expect(() => unpackAsar(oversized)).toThrow("100 MB");
    expect(() => packAsar(new Map([["big.bin", oversized]]))).toThrow("100 MB");
    const tooMany = new Map(
      Array.from(
        { length: 10_001 },
        (_, index) => [`f${index}`, new Uint8Array()] as const,
      ),
    );
    expect(() => packAsar(tooMany)).toThrow("10000");
    const entries = Object.fromEntries(
      [...tooMany].map(([path]) => [path, { size: 0, offset: "0" }]),
    );
    expect(() => unpackAsar(rawAsar({ files: entries }))).toThrow("10000");
    let nested: unknown = {};
    for (let depth = 0; depth < 150; depth++)
      nested = { files: { child: nested } };
    expect(() => unpackAsar(rawAsar(nested))).toThrow("嵌套");
  });
});

describe("project schema, references and compressed sketch validation", () => {
  it.each([
    [
      "format",
      (manifest: ProjectManifest) =>
        Object.assign(manifest, { format: "zip-project" }),
    ],
    [
      "version",
      (manifest: ProjectManifest) => Object.assign(manifest, { version: 2 }),
    ],
    [
      "name type",
      (manifest: ProjectManifest) => Object.assign(manifest, { name: 42 }),
    ],
    [
      "empty name",
      (manifest: ProjectManifest) => Object.assign(manifest, { name: "" }),
    ],
    [
      "documents",
      (manifest: ProjectManifest) => Object.assign(manifest, { documents: [] }),
    ],
    [
      "attachments",
      (manifest: ProjectManifest) =>
        Object.assign(manifest, { attachments: {} }),
    ],
    [
      "sketch path",
      (manifest: ProjectManifest) =>
        Object.assign(manifest.documents.cad2d, { path: "../sketch" }),
    ],
    [
      "codec",
      (manifest: ProjectManifest) =>
        Object.assign(manifest.documents.cad2d, { codec: "json" }),
    ],
    [
      "sketch version",
      (manifest: ProjectManifest) =>
        Object.assign(manifest.documents.cad2d, { version: 9 }),
    ],
    [
      "negative size",
      (manifest: ProjectManifest) =>
        Object.assign(manifest.documents.cad2d, { uncompressedSize: -1 }),
    ],
    [
      "fractional size",
      (manifest: ProjectManifest) =>
        Object.assign(manifest.documents.cad2d, { uncompressedSize: 1.5 }),
    ],
    [
      "oversized sketch",
      (manifest: ProjectManifest) =>
        Object.assign(manifest.documents.cad2d, {
          uncompressedSize: 10 * 1024 * 1024 + 1,
        }),
    ],
  ])("rejects invalid project %s", (_name, mutate) => {
    const files = projectFiles();
    mutateManifest(files, mutate);
    expect(() => decodeProject(packAsar(files))).toThrow("工程文件：");
  });

  it("requires both manifest and sketch and rejects duplicate manifest keys", () => {
    const files = projectFiles();
    const missingManifest = new Map(files);
    missingManifest.delete(MANIFEST);
    expect(() => decodeProject(packAsar(missingManifest))).toThrow("项目清单");
    const missingSketch = new Map(files);
    missingSketch.delete(SKETCH);
    expect(() => decodeProject(packAsar(missingSketch))).toThrow("草图文件");
    files.set(
      MANIFEST,
      encoder.encode(
        '{"format":"sketchworks-project","format":"sketchworks-project"}',
      ),
    );
    expect(() => decodeProject(packAsar(files))).toThrow("重复");
  });

  it.each([
    ["id", { id: "" }],
    ["name", { name: 5 }],
    ["empty name", { name: "" }],
    ["path name", { name: "../image.png" }],
    ["mime", { mimeType: 42 }],
    ["mime syntax", { mimeType: "invalid" }],
    ["negative size", { size: -1 }],
    ["wrong size", { size: PNG.length + 1 }],
    ["timestamp", { addedAt: -1 }],
    ["unsafe path", { path: "assets/../image.png" }],
    ["missing reference", { path: "assets/missing.png" }],
    ["external path", { path: "https://example.com/image.png" }],
  ])("rejects malformed attachment %s", (_name, values) => {
    const files = unpackAsar(encodeProject(archiveWithAttachment()));
    mutateManifest(files, (manifest) =>
      Object.assign(manifest.attachments[0], values),
    );
    expect(() => decodeProject(packAsar(files))).toThrow("工程文件：");
  });

  it("rejects duplicate attachment IDs/paths and a missing referenced image", () => {
    for (const duplicate of ["id", "path"] as const) {
      const project = addProjectAttachment(archiveWithAttachment(), {
        name: "second.png",
        mimeType: "image/png",
        data: PNG,
      });
      const files = unpackAsar(encodeProject(project));
      mutateManifest(files, (manifest) => {
        manifest.attachments[1][duplicate] = manifest.attachments[0][duplicate];
      });
      expect(() => decodeProject(packAsar(files))).toThrow("重复");
    }
    const project = archiveWithAttachment();
    const files = unpackAsar(encodeProject(project));
    files.delete(project.manifest.attachments[0].path);
    expect(() => decodeProject(packAsar(files))).toThrow("缺失");
  });

  it("checks gzip magic, reserved flags, CRC, ISIZE, truncation and oversized real output", () => {
    for (const field of [
      "magic",
      "flags",
      "crc",
      "size",
      "truncation",
    ] as const) {
      const files = projectFiles();
      const gzip = files.get(SKETCH)!.slice();
      if (field === "magic") gzip[0] = 0;
      if (field === "flags") gzip[3] = 0x80;
      if (field === "crc") gzip[gzip.length - 8] ^= 0x80;
      if (field === "size") gzip[gzip.length - 4] ^= 1;
      files.set(
        SKETCH,
        field === "truncation" ? gzip.subarray(0, gzip.length - 1) : gzip,
      );
      expect(() => decodeProject(packAsar(files))).toThrow(/gzip|解压/);
    }
    const files = projectFiles();
    const bomb = gzipSync(new Uint8Array(10 * 1024 * 1024 + 1), {
      level: 9,
      mtime: 0,
    });
    new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength).setUint32(
      bomb.length - 4,
      1,
      true,
    );
    files.set(SKETCH, bomb);
    mutateManifest(files, (manifest) => {
      manifest.documents.cad2d.uncompressedSize = 1;
    });
    expect(() => decodeProject(packAsar(files))).toThrow("解压大小超出");
  });

  it("rejects unused bytes inside the gzip payload instead of silently accepting or buffering them", () => {
    for (const junkLength of [1, 3, 16_384]) {
      const files = projectFiles();
      const gzip = files.get(SKETCH)!;
      const corrupt = new Uint8Array(gzip.length + junkLength);
      corrupt.set(gzip.subarray(0, -8));
      corrupt.set(gzip.subarray(-8), corrupt.length - 8);
      files.set(SKETCH, corrupt);
      expect(() => decodeProject(packAsar(files))).toThrow("gzip");
    }
  });

  it("accepts the standard optional gzip filename header without changing document content", () => {
    const document = sketchDocument();
    const binary = encodeMessagePack(document, { ignoreUndefined: true });
    const files = projectFiles();
    files.set(SKETCH, gzipSync(binary, { filename: "sketch.jsonb", mtime: 0 }));
    mutateManifest(files, (manifest) => {
      manifest.documents.cad2d.uncompressedSize = binary.length;
    });
    expect(decodeProject(packAsar(files)).document).toEqual(
      JSON.parse(JSON.stringify(document)),
    );
  });

  it("rejects non-MessagePack payloads, hostile container declarations and invalid model references", () => {
    const files = projectFiles();
    replaceSketch(files, encoder.encode(JSON.stringify(sketchDocument())));
    expect(() => decodeProject(packAsar(files))).toThrow("JSONB");
    replaceSketch(files, new Uint8Array([0xdd, 0x7f, 0xff, 0xff, 0xff]));
    expect(() => decodeProject(packAsar(files))).toThrow("JSONB 容器");
    const nested = new Uint8Array(140).fill(0x91);
    nested[nested.length - 1] = 0xc0;
    replaceSketch(files, nested);
    expect(() => decodeProject(packAsar(files))).toThrow("JSONB 嵌套");
    const invalid = sketchDocument();
    invalid.sketches[0].constraints[0].refs = ["missing-real-entity"];
    replaceSketch(files, encodeMessagePack(invalid, { ignoreUndefined: true }));
    expect(() => decodeProject(packAsar(files))).toThrow("引用");
    expect(() => createProject(invalid)).toThrow("引用");
  });
});
