import {
  decode as decodeMessagePack,
  encode as encodeMessagePack,
} from "@msgpack/msgpack";
import { gzipSync, Gunzip } from "fflate";
import { type Document, validateDocument } from "./model";

export interface ProjectAttachment {
  id: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: number;
  [key: string]: unknown;
}

export interface ProjectDocumentEntry {
  path: string;
  format: "jsonb";
  codec: "msgpack";
  compression: "gzip";
  version: 1;
  uncompressedSize: number;
  [key: string]: unknown;
}

export interface ProjectManifest {
  format: "sketchworks-project";
  version: 1;
  name: string;
  documents: { cad2d: ProjectDocumentEntry; [key: string]: unknown };
  attachments: ProjectAttachment[];
  [key: string]: unknown;
}

export type CadProject = {
  manifest: ProjectManifest;
  document: Document;
  /** Retained ASAR entries; encodeProject regenerates only the manifest and 2D sketch. */
  files: Map<string, Uint8Array>;
};

export const PROJECT_EXTENSION = ".swcad";
export function projectFileName(value: string): string {
  const name = value.trim().normalize("NFC");
  const base = name
    .replace(/\.(?:swcad|asar)$/i, "")
    .replace(/(?:\.sketch)?\.json$/i, "");
  return `${base || "未命名项目"}${PROJECT_EXTENSION}`;
}

const MANIFEST_PATH = "manifest.json";
const SKETCH_PATH = "documents/sketch.jsonb.gz";
const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
const MAX_SKETCH_SIZE = 10 * 1024 * 1024;
const MAX_HEADER_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_DEPTH = 128;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const align4 = (size: number) => Math.ceil(size / 4) * 4;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
function fail(message: string): never {
  throw new Error(`工程文件：${message}`);
}

function validatePath(path: string): string[] {
  if (typeof path !== "string" || !path || path.length > 4096)
    fail("文件路径无效或过长");
  const parts = path.split("/");
  if (
    parts.length > MAX_DEPTH ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === "__proto__" ||
        part === "constructor" ||
        part === "prototype" ||
        part.length > 255 ||
        /[\\<>:"|?*\u0000-\u001f\u007f]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    fail("文件路径不安全");
  return parts;
}

/** JSON.parse alone silently accepts duplicate keys, including duplicate ASAR paths. */
function parseJson(bytes: Uint8Array, label: string): unknown {
  if (bytes.length > MAX_HEADER_SIZE) fail(`${label}超过 5 MB 限制`);
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return fail(`${label}不是有效的 UTF-8`);
  }
  let pos = 0;
  const whitespace = () => {
    while (pos < text.length && /[\t\n\r ]/.test(text[pos])) pos++;
  };
  const stringToken = () => {
    if (text[pos] !== '"') fail(`${label}的 JSON 字符串无效`);
    const start = pos++;
    while (pos < text.length) {
      const character = text[pos++];
      if (character === '"') return text.slice(start, pos);
      if (character === "\\") pos++;
    }
    return fail(`${label}的 JSON 字符串未结束`);
  };
  const value = (depth: number): void => {
    if (depth > MAX_DEPTH) fail(`${label}的 JSON 嵌套过深`);
    whitespace();
    const character = text[pos];
    if (character === '"') {
      stringToken();
      return;
    }
    if (character === "{" || character === "[") {
      const object = character === "{";
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      pos++;
      whitespace();
      if (text[pos] === end) {
        pos++;
        return;
      }
      while (pos < text.length) {
        whitespace();
        if (object) {
          const key = JSON.parse(stringToken()) as string;
          if (keys.has(key)) fail(`${label}包含重复名称或字段`);
          keys.add(key);
          whitespace();
          if (text[pos++] !== ":") fail(`${label}的 JSON 字段无效`);
        }
        value(depth + 1);
        whitespace();
        if (text[pos] === end) {
          pos++;
          return;
        }
        if (text[pos++] !== ",") fail(`${label}的 JSON 结构无效`);
      }
      fail(`${label}的 JSON 未结束`);
    }
    const start = pos;
    while (pos < text.length && !/[\t\n\r ,}\]]/.test(text[pos])) pos++;
    if (pos === start) fail(`${label}的 JSON 值无效`);
  };
  try {
    value(0);
    whitespace();
    if (pos !== text.length) fail(`${label}包含多余 JSON 数据`);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("工程文件："))
      throw error;
    return fail(`${label}的 JSON 格式无效`);
  }
}

function cloneManifest(manifest: ProjectManifest): ProjectManifest {
  try {
    return structuredClone(manifest);
  } catch {
    return fail("项目清单包含不能保存的数据");
  }
}

function checkedDocument(raw: unknown): Document {
  try {
    return validateDocument(raw);
  } catch (error) {
    const reason =
      error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : "结构或引用无效";
    return fail(`草图数据无效：${reason}`);
  }
}

function documentBytes(document: Document): Uint8Array {
  let bytes: Uint8Array;
  try {
    // Optional properties remain optional; undefined must not become MessagePack nil.
    bytes = encodeMessagePack(document, { ignoreUndefined: true });
  } catch {
    return fail("草图不能编码为 JSONB");
  }
  if (!bytes.length || bytes.length > MAX_SKETCH_SIZE)
    fail("解码草图超过 10 MB 限制");
  return bytes;
}

function validName(name: unknown, label: string, maxLength: number): void {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(name)
  )
    fail(`${label}名称无效`);
}

function validateManifest(
  raw: unknown,
  files: Map<string, Uint8Array>,
): ProjectManifest {
  if (!isRecord(raw) || raw.format !== "sketchworks-project")
    fail("项目清单格式无效");
  if (raw.version !== 1) fail("项目清单版本不支持");
  validName(raw.name, "项目", 1000);
  if (!isRecord(raw.documents) || !isRecord(raw.documents.cad2d))
    fail("项目清单缺少二维草图");
  const sketch = raw.documents.cad2d;
  if (
    sketch.path !== SKETCH_PATH ||
    sketch.format !== "jsonb" ||
    sketch.codec !== "msgpack" ||
    sketch.compression !== "gzip" ||
    sketch.version !== 1
  )
    fail("二维草图格式、路径或版本不支持");
  if (
    !Number.isSafeInteger(sketch.uncompressedSize) ||
    (sketch.uncompressedSize as number) < 1 ||
    (sketch.uncompressedSize as number) > MAX_SKETCH_SIZE
  )
    fail("二维草图声明大小无效或超过 10 MB 限制");
  if (!Array.isArray(raw.attachments) || raw.attachments.length > MAX_FILES)
    fail("附件清单无效或过多");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const attachment of raw.attachments) {
    if (!isRecord(attachment)) fail("附件清单结构无效");
    if (
      typeof attachment.id !== "string" ||
      !attachment.id ||
      attachment.id.length > 128 ||
      ids.has(attachment.id)
    )
      fail("附件 ID 无效或重复");
    ids.add(attachment.id);
    validName(attachment.name, "附件", 255);
    if (/[\\/]/.test(attachment.name as string)) fail("附件名称无效");
    if (
      typeof attachment.mimeType !== "string" ||
      attachment.mimeType.length > 255 ||
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/.test(
        attachment.mimeType,
      )
    )
      fail("附件 MIME 类型无效");
    if (typeof attachment.path !== "string") fail("附件文件引用无效");
    validatePath(attachment.path);
    if (!attachment.path.startsWith("assets/") || paths.has(attachment.path))
      fail("附件路径无效或重复");
    paths.add(attachment.path);
    if (
      !Number.isSafeInteger(attachment.size) ||
      (attachment.size as number) < 0 ||
      (attachment.size as number) > MAX_ARCHIVE_SIZE ||
      !Number.isSafeInteger(attachment.addedAt) ||
      (attachment.addedAt as number) < 0
    )
      fail("附件大小或时间无效");
    const data = files.get(attachment.path);
    if (!data || data.length !== attachment.size)
      fail("附件文件缺失或大小不匹配");
  }
  return raw as unknown as ProjectManifest;
}

type AsarEntry =
  | { files: Record<string, AsarEntry> }
  | { size: number; offset: string };
const directory = (): { files: Record<string, AsarEntry> } => ({
  files: Object.create(null) as Record<string, AsarEntry>,
});

/** Minimal Chromium-pickle ASAR writer. Offsets are relative to the file-data area. */
export function packAsar(files: Map<string, Uint8Array>): Uint8Array {
  if (!(files instanceof Map) || files.size > MAX_FILES)
    fail("ASAR 文件数量超过 10000 限制");
  const root = directory();
  let bodySize = 0;
  const entries = [...files.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [path, data] of entries) {
    const parts = validatePath(path);
    if (!(data instanceof Uint8Array)) fail("ASAR 文件内容必须是字节数组");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!own(node.files, part)) node.files[part] = directory();
      const child = node.files[part];
      if (!("files" in child)) fail("ASAR 文件与目录名称冲突");
      node = child;
    }
    const name = parts[parts.length - 1];
    if (own(node.files, name)) fail("ASAR 文件路径重复或与目录冲突");
    node.files[name] = { size: data.length, offset: String(bodySize) };
    bodySize += data.length;
    if (bodySize > MAX_ARCHIVE_SIZE) fail("ASAR 工程超过 100 MB 限制");
  }
  const header = utf8.encode(JSON.stringify(root));
  const headerSize = 8 + align4(header.length);
  if (headerSize > MAX_HEADER_SIZE) fail("ASAR 文件头超过 5 MB 限制");
  const dataOffset = 8 + headerSize;
  if (dataOffset + bodySize > MAX_ARCHIVE_SIZE)
    fail("ASAR 工程超过 100 MB 限制");
  const bytes = new Uint8Array(dataOffset + bodySize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 4, true); // Payload size of the 8-byte header-size pickle.
  view.setUint32(4, headerSize, true);
  view.setUint32(8, headerSize - 4, true);
  view.setUint32(12, header.length, true);
  bytes.set(header, 16);
  let offset = dataOffset;
  for (const [, data] of entries) {
    bytes.set(data, offset);
    offset += data.length;
  }
  return bytes;
}

/** Only inline regular files are accepted. No symlinks or external .unpacked files. */
export function unpackAsar(
  input: Uint8Array | ArrayBuffer,
): Map<string, Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_ARCHIVE_SIZE) fail("ASAR 工程超过 100 MB 限制");
  if (bytes.length < 16) fail("ASAR 文件头被截断");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(4, true);
  const headerLength = view.getUint32(12, true);
  if (
    view.getUint32(0, true) !== 4 ||
    headerSize < 8 ||
    headerSize % 4 !== 0 ||
    headerSize > MAX_HEADER_SIZE ||
    view.getUint32(8, true) !== headerSize - 4 ||
    headerSize !== 8 + align4(headerLength) ||
    headerLength > 0x7fffffff ||
    8 + headerSize > bytes.length
  )
    fail("ASAR pickle 文件头长度无效或超出限制");
  const dataOffset = 8 + headerSize;
  for (let index = 16 + headerLength; index < dataOffset; index++)
    if (bytes[index] !== 0) fail("ASAR pickle 填充字节无效");
  const root = parseJson(bytes.subarray(16, 16 + headerLength), "ASAR 文件头");
  if (!isRecord(root) || !isRecord(root.files)) fail("ASAR 文件头结构无效");
  const files = new Map<string, Uint8Array>();
  const ranges: { start: number; end: number }[] = [];
  const emptyOffsets: number[] = [];
  const pending: { path: string; node: Record<string, unknown> }[] = [
    { path: "", node: root },
  ];
  const bodySize = bytes.length - dataOffset;
  while (pending.length) {
    const { path, node } = pending.pop()!;
    if (own(node, "link") || own(node, "unpacked"))
      fail("ASAR 不允许链接或外部解包文件");
    if (own(node, "files")) {
      if (!isRecord(node.files) || own(node, "size") || own(node, "offset"))
        fail("ASAR 目录结构无效");
      for (const [name, child] of Object.entries(node.files)) {
        if (name.includes("/")) fail("ASAR 文件名称无效");
        const childPath = path ? `${path}/${name}` : name;
        validatePath(childPath);
        if (!isRecord(child)) fail("ASAR 文件条目无效");
        pending.push({ path: childPath, node: child });
      }
      continue;
    }
    if (
      !Number.isSafeInteger(node.size) ||
      (node.size as number) < 0 ||
      (node.size as number) > MAX_ARCHIVE_SIZE ||
      typeof node.offset !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(node.offset) ||
      (own(node, "executable") && typeof node.executable !== "boolean")
    )
      fail("ASAR 文件大小、偏移或标记无效");
    const start = Number(node.offset);
    const end = start + (node.size as number);
    if (!Number.isSafeInteger(start) || start > bodySize || end > bodySize)
      fail("ASAR 文件范围超出数据区");
    if (files.has(path)) fail("ASAR 文件路径重复");
    if (files.size >= MAX_FILES) fail("ASAR 文件数量超过 10000 限制");
    if (start === end) emptyOffsets.push(start);
    else ranges.push({ start, end });
    files.set(path, bytes.slice(dataOffset + start, dataOffset + end));
  }
  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  const boundaries = new Set([0]);
  for (const range of ranges) {
    if (range.start !== cursor) fail("ASAR 文件数据区重叠、缺失或存在多余数据");
    cursor = range.end;
    boundaries.add(cursor);
  }
  if (
    cursor !== bodySize ||
    emptyOffsets.some((offset) => !boundaries.has(offset))
  )
    fail("ASAR 文件数据区长度或空文件偏移无效");
  return files;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function updateCrc(crc: number, data: Uint8Array): number {
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function decodeGzip(data: Uint8Array, expectedSize: number): Uint8Array {
  if (
    data.length < 18 ||
    data[0] !== 0x1f ||
    data[1] !== 0x8b ||
    data[2] !== 8 ||
    (data[3] & 0xe0) !== 0
  )
    fail("草图 gzip 文件头或标记无效");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const trailer = data.length - 8;
  if (view.getUint32(trailer + 4, true) !== expectedSize)
    fail("草图 gzip 声明大小与清单不匹配");
  const flags = data[3];
  let start = 10;
  if (flags & 4) {
    if (start + 2 > trailer) fail("草图 gzip 扩展字段被截断");
    start += 2 + view.getUint16(start, true);
  }
  for (const flag of [8, 16]) {
    if (!(flags & flag)) continue;
    while (start < trailer && data[start] !== 0) start++;
    if (start >= trailer) fail("草图 gzip 名称或注释被截断");
    start++;
  }
  if (flags & 2) {
    if (
      start + 2 > trailer ||
      view.getUint16(start, true) !==
        ((updateCrc(0xffffffff, data.subarray(0, start)) ^ 0xffffffff) & 0xffff)
    )
      fail("草图 gzip 文件头校验失败");
    start += 2;
  }
  if (start >= trailer) fail("草图 gzip 数据被截断");
  // Small compressed input blocks bound fflate's temporary output even for forged gzip bombs.
  const output = new Uint8Array(expectedSize);
  let written = 0;
  let crc = 0xffffffff;
  let finished = false;
  let foundBoundary = false;
  const gunzip = new Gunzip((chunk, final) => {
    if (chunk.length > expectedSize - written)
      fail("草图解压大小超出清单或 10 MB 限制");
    output.set(chunk, written);
    written += chunk.length;
    crc = updateCrc(crc, chunk);
    finished = final;
  });
  // fflate ignores trailing bytes in a one-shot final push. A valid empty sentinel member
  // makes its public onmember callback report the exact end of the original member.
  // This also rejects junk immediately instead of accumulating it after DEFLATE finishes.
  const emptyMember = new Uint8Array([
    0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const normalizedLength = 10 + data.length - start;
  gunzip.onmember = (offset) => {
    if (foundBoundary || offset !== normalizedLength)
      fail("草图 gzip 包含多余数据或多个压缩成员");
    foundBoundary = true;
  };
  try {
    // The optional header was validated above; a plain header avoids repeatedly buffering
    // a potentially long original filename/comment while preserving the DEFLATE bytes.
    gunzip.push(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]), false);
    for (let offset = start; offset < data.length; offset += 256)
      gunzip.push(
        data.subarray(offset, Math.min(offset + 256, data.length)),
        false,
      );
    gunzip.push(emptyMember, false);
    gunzip.push(new Uint8Array(), true);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("工程文件："))
      throw error;
    return fail("草图 gzip 压缩数据无效或被截断");
  }
  if (!foundBoundary || !finished || written !== expectedSize)
    fail("草图解压大小或成员长度与清单不匹配");
  if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(trailer, true))
    fail("草图 gzip 数据校验失败");
  return output;
}

/** Check declared lengths before the library allocates arrays for untrusted MessagePack. */
function checkMessagePackBounds(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const remaining = [1];
  let needed = 1;
  let pos = 0;
  const take = (size: number) => {
    if (size > bytes.length - pos) fail("草图 JSONB 数据被截断");
    const start = pos;
    pos += size;
    return start;
  };
  const length = (size: 1 | 2 | 4) => {
    const start = take(size);
    return size === 1
      ? bytes[start]
      : size === 2
        ? view.getUint16(start)
        : view.getUint32(start);
  };
  while (remaining.length) {
    const top = remaining.length - 1;
    if (!remaining[top]) {
      remaining.pop();
      continue;
    }
    remaining[top]--;
    needed--;
    const code = bytes[take(1)];
    let children = 0;
    if (code >= 0x80 && code <= 0x8f) children = (code & 15) * 2;
    else if (code >= 0x90 && code <= 0x9f) children = code & 15;
    else if (code >= 0xa0 && code <= 0xbf) take(code & 31);
    else if (code === 0xc1) fail("草图 JSONB 包含无效类型");
    else if (code >= 0xc4 && code <= 0xc9) {
      const width =
        code === 0xc4 || code === 0xc7
          ? 1
          : code === 0xc5 || code === 0xc8
            ? 2
            : 4;
      take(length(width) + (code >= 0xc7 ? 1 : 0));
    } else if (code >= 0xca && code <= 0xd3) {
      take([4, 8, 1, 2, 4, 8, 1, 2, 4, 8][code - 0xca]);
    } else if (code >= 0xd4 && code <= 0xd8) {
      take((1 << (code - 0xd4)) + 1);
    } else if (code >= 0xd9 && code <= 0xdb) {
      take(length(code === 0xd9 ? 1 : code === 0xda ? 2 : 4));
    } else if (code >= 0xdc && code <= 0xdf) {
      const count = length(code === 0xdc || code === 0xde ? 2 : 4);
      if (count > 100_000) fail("草图 JSONB 容器过大");
      children = count * (code >= 0xde ? 2 : 1);
    }
    if (children) {
      if (remaining.length >= MAX_DEPTH) fail("草图 JSONB 嵌套过深");
      remaining.push(children);
      needed += children;
    }
    if (needed > bytes.length - pos) fail("草图 JSONB 容器声明超出数据区");
  }
  if (pos !== bytes.length) fail("草图 JSONB 包含多余数据");
}

export function createProject(doc: Document): CadProject {
  const document = checkedDocument(doc);
  const uncompressedSize = documentBytes(document).length;
  const manifest: ProjectManifest = {
    format: "sketchworks-project",
    version: 1,
    name: document.name,
    documents: {
      cad2d: {
        path: SKETCH_PATH,
        format: "jsonb",
        codec: "msgpack",
        compression: "gzip",
        version: 1,
        uncompressedSize,
      },
    },
    attachments: [],
  };
  validateManifest(manifest, new Map());
  return { manifest, document, files: new Map() };
}

export function withProjectDocument(
  project: CadProject,
  doc: Document,
): CadProject {
  const document = checkedDocument(doc);
  const files = new Map(project.files);
  validateManifest(project.manifest, files);
  const manifest = cloneManifest(project.manifest);
  manifest.name = document.name;
  manifest.documents.cad2d.uncompressedSize = documentBytes(document).length;
  validateManifest(manifest, files);
  return { manifest, document, files };
}

export function encodeProject(project: CadProject): Uint8Array {
  validateManifest(project.manifest, project.files);
  const document = checkedDocument(project.document);
  const sketch = documentBytes(document);
  const manifest = cloneManifest(project.manifest);
  manifest.name = document.name;
  manifest.documents.cad2d.uncompressedSize = sketch.length;
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = utf8.encode(JSON.stringify(manifest));
  } catch {
    return fail("项目清单不能编码为 JSON");
  }
  if (manifestBytes.length > MAX_HEADER_SIZE) fail("项目清单超过 5 MB 限制");
  const files = new Map(project.files);
  files.set(MANIFEST_PATH, manifestBytes);
  files.set(SKETCH_PATH, gzipSync(sketch, { level: 6, mtime: 0 }));
  return packAsar(files);
}

export function decodeProject(bytes: Uint8Array | ArrayBuffer): CadProject {
  const files = unpackAsar(bytes);
  const manifestBytes = files.get(MANIFEST_PATH);
  if (!manifestBytes) fail("ASAR 工程缺少 manifest.json 项目清单");
  const manifest = validateManifest(
    parseJson(manifestBytes, "项目清单"),
    files,
  );
  const compressed = files.get(manifest.documents.cad2d.path);
  if (!compressed) fail("ASAR 工程缺少二维草图文件");
  const sketch = decodeGzip(
    compressed,
    manifest.documents.cad2d.uncompressedSize,
  );
  checkMessagePackBounds(sketch);
  let raw: unknown;
  try {
    raw = decodeMessagePack(sketch, {
      maxStrLength: MAX_SKETCH_SIZE,
      maxBinLength: MAX_SKETCH_SIZE,
      maxArrayLength: 100_000,
      maxMapLength: 100_000,
      maxExtLength: MAX_SKETCH_SIZE,
    });
  } catch {
    return fail("草图 JSONB 数据无效");
  }
  return { manifest, document: checkedDocument(raw), files };
}

export function addProjectAttachment(
  project: CadProject,
  input: { name: string; mimeType: string; data: Uint8Array },
): CadProject {
  validateManifest(project.manifest, project.files);
  validName(input.name, "附件", 255);
  if (/[\\/]/.test(input.name)) fail("附件名称无效");
  if (
    !(input.data instanceof Uint8Array) ||
    input.data.length > MAX_ARCHIVE_SIZE
  )
    fail("附件内容无效或超过 100 MB 限制");
  const manifest = cloneManifest(project.manifest);
  const files = new Map(project.files);
  const id = crypto.randomUUID();
  const suffix =
    input.name.split(".").length > 1
      ? input.name
          .slice(input.name.lastIndexOf(".") + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 16) || "bin"
      : "bin";
  const path = `assets/${id}.${suffix}`;
  if (
    files.has(path) ||
    manifest.attachments.some((attachment) => attachment.id === id)
  )
    fail("附件 ID 冲突，请重试");
  files.set(path, input.data.slice());
  manifest.attachments.push({
    id,
    path,
    name: input.name,
    mimeType: input.mimeType || "application/octet-stream",
    size: input.data.length,
    addedAt: Date.now(),
  });
  validateManifest(manifest, files);
  if (new Set([...files.keys(), MANIFEST_PATH, SKETCH_PATH]).size > MAX_FILES)
    fail("ASAR 文件数量超过 10000 限制");
  let size = 0;
  for (const data of files.values()) {
    size += data.length;
    if (size > MAX_ARCHIVE_SIZE) fail("ASAR 工程超过 100 MB 限制");
  }
  return { manifest, document: project.document, files };
}

export function removeProjectAttachment(
  project: CadProject,
  id: string,
): CadProject {
  validateManifest(project.manifest, project.files);
  const manifest = cloneManifest(project.manifest);
  const files = new Map(project.files);
  const attachment = manifest.attachments.find((entry) => entry.id === id);
  if (attachment) {
    files.delete(attachment.path);
    manifest.attachments = manifest.attachments.filter(
      (entry) => entry.id !== id,
    );
  }
  return { manifest, document: project.document, files };
}

export function attachmentData(
  project: CadProject,
  id: string,
): Uint8Array | undefined {
  const attachment = project.manifest.attachments.find(
    (entry) => entry.id === id,
  );
  return attachment ? project.files.get(attachment.path)?.slice() : undefined;
}
