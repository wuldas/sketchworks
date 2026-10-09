import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import { exportPdf } from "./pdfExport";
import { emptyDocument, entity, type Document, type XY } from "./model";

const PT_PER_MM = 72 / 25.4;
type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
const map = (m: Matrix, x: number, y: number): XY => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});
const distance = (a: XY, b: XY) => Math.hypot(b.x - a.x, b.y - a.y);
async function parse(doc: Document, options = {}) {
  const bytes = await exportPdf(doc, options);
  expect(new TextDecoder().decode(bytes.slice(0, 8))).toMatch(/^%PDF-1\./);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(1);
  const page = pdf.getPages()[0];
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray()
      : contents
        ? [contents]
        : [];
  const source = streams
    .map((ref) => {
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream))
        throw new Error("Expected PDF content stream");
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    })
    .join("\n");
  const images = pdf.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
    );
  return { bytes, pdf, page, source, images };
}
/** Read actual PDF drawing operators, including their graphics-state transforms. */
function drawing(source: string) {
  let matrix = identity;
  const stack: Matrix[] = [],
    paths: XY[][] = [],
    labels: { text: string; point: XY }[] = [];
  let path: XY[] = [],
    textPoint: XY = { x: 0, y: 0 };
  for (const raw of source.split("\n")) {
    const line = raw.trim(),
      parts = line.split(/\s+/),
      op = parts.at(-1);
    const nums = parts.slice(0, -1).map(Number);
    if (op === "q") stack.push([...matrix]);
    else if (op === "Q") matrix = stack.pop() ?? identity;
    else if (op === "cm") matrix = multiply(matrix, nums as Matrix);
    else if (op === "m") path = [map(matrix, nums[0], nums[1])];
    else if (op === "l") path.push(map(matrix, nums[0], nums[1]));
    else if (op === "c")
      for (let i = 0; i < 6; i += 2)
        path.push(map(matrix, nums[i], nums[i + 1]));
    else if (op === "S" || op === "f" || op === "f*" || op === "B") {
      paths.push(path);
      path = [];
    } else if (op === "Tm") textPoint = map(matrix, nums[4], nums[5]);
    else if (op === "Tj") {
      const hex = line.match(/<([0-9a-f]*)>/i)?.[1];
      if (hex)
        labels.push({
          text: Buffer.from(hex, "hex").toString("latin1"),
          point: textPoint,
        });
    }
  }
  return { paths, labels };
}
function lineDoc(width: number, height: number) {
  const doc = emptyDocument();
  doc.name = "PDF 工程图";
  doc.sketches[0].entities.push(
    entity("line", [
      { x: 0, y: 0 },
      { x: width, y: height },
    ]),
  );
  return doc;
}
function expectInside(
  paths: XY[][],
  width: number,
  height: number,
  margin = 11 * PT_PER_MM,
) {
  for (const point of paths.flat()) {
    expect(point.x).toBeGreaterThanOrEqual(margin);
    expect(point.y).toBeGreaterThanOrEqual(margin);
    expect(point.x).toBeLessThanOrEqual(width - margin);
    expect(point.y).toBeLessThanOrEqual(height - margin);
  }
}

describe("PDF export", () => {
  it("creates a real portrait A4 PDF with Unicode metadata and millimeter Y-up geometry", async () => {
    const parsed = await parse(lineDoc(20, 80));
    expect(parsed.pdf.getTitle()).toBe("PDF 工程图");
    expect(parsed.page.getWidth()).toBeCloseTo(210 * PT_PER_MM, 6);
    expect(parsed.page.getHeight()).toBeCloseTo(297 * PT_PER_MM, 6);
    const [path] = drawing(parsed.source).paths;
    expect(path[1].x - path[0].x).toBeCloseTo(20 * PT_PER_MM, 6);
    expect(path[1].y - path[0].y).toBeCloseTo(80 * PT_PER_MM, 6);
    expect(parsed.images).toHaveLength(0);
    expectInside([path], parsed.page.getWidth(), parsed.page.getHeight());
  });

  it("chooses landscape for wide drawings and uniformly fits oversized geometry inside margins", async () => {
    const parsed = await parse(lineDoc(1000, 400));
    expect(parsed.page.getWidth()).toBeCloseTo(297 * PT_PER_MM, 6);
    expect(parsed.page.getHeight()).toBeCloseTo(210 * PT_PER_MM, 6);
    const [path] = drawing(parsed.source).paths;
    expect((path[1].x - path[0].x) / (path[1].y - path[0].y)).toBeCloseTo(
      2.5,
      6,
    );
    expect(path[1].x - path[0].x).toBeLessThan(1000 * PT_PER_MM);
    expectInside([path], parsed.page.getWidth(), parsed.page.getHeight());
  });

  it("emits vector paths for every supported geometry and vector Latin/symbol text", async () => {
    const doc = emptyDocument(),
      sketch = doc.sketches[0];
    sketch.entities.push(
      entity("line", [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
      entity("circle", [{ x: 20, y: 0 }], { radius: 4 }),
      entity("arc", [
        { x: 30, y: 0 },
        { x: 34, y: 0 },
        { x: 30, y: 4 },
      ]),
      entity(
        "ellipse",
        [
          { x: 40, y: 0 },
          { x: 44, y: 2 },
        ],
        { ry: 3 },
      ),
      entity("bezier", [
        { x: 0, y: 10 },
        { x: 1, y: 13 },
        { x: 5, y: 13 },
        { x: 7, y: 10 },
      ]),
      entity("spline", [
        { x: 10, y: 10 },
        { x: 14, y: 15 },
        { x: 18, y: 11 },
      ]),
      entity(
        "conic",
        [
          { x: 20, y: 10 },
          { x: 24, y: 15 },
          { x: 28, y: 10 },
        ],
        { weight: 0.8 },
      ),
      entity("point", [{ x: 35, y: 10 }]),
      entity("text", [{ x: 0, y: 20 }], {
        text: "Latin Ø10 / 90°\nSecond line",
        fontSize: 3,
        rotation: 15,
      }),
    );
    const parsed = await parse(doc),
      output = drawing(parsed.source);
    expect(parsed.images).toHaveLength(0);
    expect(output.paths).toHaveLength(8);
    expect(
      output.paths.filter((p) => p.length >= 4).length,
    ).toBeGreaterThanOrEqual(7);
    expect(parsed.source).toMatch(/\bc\b/);
    expect(parsed.source).toMatch(/\bl\b/);
    expect(output.labels.map((label) => label.text)).toEqual([
      "Latin Ø10 / 90°",
      "Second line",
    ]);
    expect(parsed.source).not.toMatch(/NaN|Infinity/);
  });

  it("honors current/all-visible scope and construction inclusion with dashed vector paths", async () => {
    const doc = lineDoc(10, 0),
      current = doc.sketches[0];
    const auxiliary = entity(
      "line",
      [
        { x: 0, y: 2 },
        { x: 30, y: 2 },
      ],
      { construction: true },
    );
    current.entities.push(auxiliary);
    current.constraints.push({
      id: "construction-dim",
      kind: "length",
      refs: [auxiliary.id],
      value: 30,
    });
    doc.sketches.push(
      {
        id: "hidden",
        name: "Hidden",
        visible: false,
        constraints: [],
        entities: [
          entity("line", [
            { x: 0, y: 4 },
            { x: 50, y: 4 },
          ]),
        ],
      },
      {
        id: "second",
        name: "Second",
        visible: true,
        constraints: [],
        entities: [
          entity("line", [
            { x: 0, y: 6 },
            { x: 20, y: 6 },
          ]),
        ],
      },
    );
    const all = await parse(doc),
      first = await parse(doc, { allVisible: false }),
      construction = await parse(doc, { construction: true });
    expect(drawing(all.source).paths).toHaveLength(2);
    expect(drawing(first.source).paths).toHaveLength(1);
    expect(drawing(all.source).labels).toHaveLength(0);
    expect(drawing(construction.source).labels.map((l) => l.text)).toEqual([
      "30",
    ]);
    expect(construction.source).toContain("[2 1] 0 d");
    expect(all.source).not.toContain("[2 1] 0 d");
    expect(
      drawing(all.source).paths.every(
        (p) => distance(p[0], p.at(-1)!) < 21 * PT_PER_MM,
      ),
    ).toBe(true);
  });

  it("draws full opposite circle points through the center for diameter and a radius span for explicit R", async () => {
    for (const kind of ["diameter", "radius"] as const) {
      const doc = emptyDocument(),
        circle = entity("circle", [{ x: 0, y: 0 }], { radius: 5 });
      doc.sketches[0].entities.push(circle);
      doc.sketches[0].constraints.push({
        id: "circle-size",
        kind,
        refs: [circle.id],
        value: kind === "diameter" ? 10 : 5,
        labelPosition: { x: 12, y: 0 },
      });
      const parsed = await parse(doc),
        output = drawing(parsed.source);
      const shape = output.paths[0],
        center = {
          x:
            (Math.min(...shape.map((p) => p.x)) +
              Math.max(...shape.map((p) => p.x))) /
            2,
          y:
            (Math.min(...shape.map((p) => p.y)) +
              Math.max(...shape.map((p) => p.y))) /
            2,
        };
      const span = output.paths[1];
      expect(span).toHaveLength(2);
      expect(distance(span[0], span[1])).toBeCloseTo(
        (kind === "diameter" ? 10 : 5) * PT_PER_MM,
        6,
      );
      if (kind === "diameter") {
        expect((span[0].x + span[1].x) / 2).toBeCloseTo(center.x, 6);
        expect((span[0].y + span[1].y) / 2).toBeCloseTo(center.y, 6);
      } else expect(distance(span[0], center)).toBeCloseTo(0, 6);
      expect(output.labels.map((l) => l.text)).toEqual([
        kind === "diameter" ? "Ø10" : "R5",
      ]);
      expect(output.labels[0].point.x).toBeGreaterThan(
        center.x + 5 * PT_PER_MM,
      );
      expect(parsed.source).toMatch(/\/Helvetica-\d+ 9 Tf/);
      expectInside(
        output.paths,
        parsed.page.getWidth(),
        parsed.page.getHeight(),
      );
    }
  });

  it("resolves circle label offsets against moved geometry rather than stale absolute positions", async () => {
    const doc = emptyDocument(),
      circle = entity("circle", [{ x: 30, y: 40 }], { radius: 6 });
    doc.sketches[0].entities.push(circle);
    doc.sketches[0].constraints.push({
      id: "saved",
      kind: "diameter",
      refs: [circle.id],
      value: 12,
      labelPosition: { x: 1000, y: 1000 },
      labelOffset: { x: 0, y: 14 },
    });
    const { source } = await parse(doc),
      output = drawing(source),
      span = output.paths[1];
    expect(span[1].x - span[0].x).toBeCloseTo(0, 6);
    expect(span[1].y - span[0].y).toBeCloseTo(12 * PT_PER_MM, 6);
    expect(output.labels[0].point.y).toBeGreaterThan(span[1].y);
  });

  it("includes distance, point-line and sector-selected angle annotations without canvas metadata", async () => {
    const doc = emptyDocument(),
      sketch = doc.sketches[0];
    const horizontal = entity("line", [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
    ]);
    const vertical = entity("line", [
      { x: 0, y: 0 },
      { x: 0, y: 30 },
    ]);
    const p = entity("point", [{ x: 20, y: 12 }]);
    sketch.entities.push(horizontal, vertical, p);
    sketch.constraints.push(
      { id: "length", kind: "length", refs: [horizontal.id], value: 40 },
      {
        id: "x",
        kind: "distanceX",
        refs: [horizontal.points[0].id, p.points[0].id],
        value: 20,
        labelPosition: { x: 0, y: -14 },
      },
      {
        id: "y",
        kind: "distanceY",
        refs: [horizontal.points[0].id, p.points[0].id],
        value: 12,
      },
      {
        id: "point-line",
        kind: "lineDistance",
        refs: [p.points[0].id, horizontal.id],
        value: 12,
      },
      {
        id: "angle",
        kind: "angle",
        refs: [horizontal.id, vertical.id],
        value: 270,
        angleSector: {
          reverseFirst: false,
          reverseSecond: false,
          clockwise: true,
        },
        labelPosition: { x: -10, y: -10 },
      },
    );
    const parsed = await parse(doc),
      output = drawing(parsed.source);
    expect(output.labels.map((l) => l.text)).toEqual([
      "40",
      "20",
      "12",
      "12",
      "270°",
    ]);
    const arc = output.paths.find(
      (p) => p.length >= 10 && p !== output.paths[2],
    );
    expect(arc).toBeDefined();
    expect(output.paths.length).toBeGreaterThan(10);
    expectInside(output.paths, parsed.page.getWidth(), parsed.page.getHeight());
  });

  it("keeps model coordinates in mm when display units are inches and converts only dimension labels", async () => {
    const doc = lineDoc(25.4, 0),
      line = doc.sketches[0].entities[0];
    doc.sketches[0].constraints.push({
      id: "dimension",
      kind: "length",
      refs: [line.id],
      value: 25.4,
    });
    const mm = await parse(doc);
    doc.unit = "in";
    const inches = await parse(doc);
    expect(drawing(inches.source).paths[0]).toEqual(
      drawing(mm.source).paths[0],
    );
    expect(
      distance(...(drawing(inches.source).paths[0] as [XY, XY])),
    ).toBeCloseTo(72, 6);
    expect(drawing(mm.source).labels[0].text).toBe("25.4");
    expect(drawing(inches.source).labels[0].text).toBe("1");
  });

  it("fits far-away saved labels, multiline rotated text and oversized geometry inside the A4 page", async () => {
    const doc = lineDoc(1500, 500),
      line = doc.sketches[0].entities[0];
    doc.sketches[0].constraints.push({
      id: "far-label",
      kind: "length",
      refs: [line.id],
      value: 1581.139,
      labelPosition: { x: -4000, y: 5000 },
    });
    doc.sketches[0].entities.push(
      entity("text", [{ x: 1600, y: 500 }], {
        text: "LINE 1\nLINE 2\nLINE 3",
        rotation: 75,
        fontSize: 100,
      }),
    );
    const parsed = await parse(doc),
      output = drawing(parsed.source);
    expectInside(output.paths, parsed.page.getWidth(), parsed.page.getHeight());
    for (const label of output.labels) {
      expect(label.point.x).toBeGreaterThan(12 * PT_PER_MM);
      expect(label.point.y).toBeGreaterThan(12 * PT_PER_MM);
      expect(label.point.x).toBeLessThan(
        parsed.page.getWidth() - 12 * PT_PER_MM,
      );
      expect(label.point.y).toBeLessThan(
        parsed.page.getHeight() - 12 * PT_PER_MM,
      );
    }
  });

  it("exports an empty finite A4 sheet and rejects non-finite geometry, parameters and label positions", async () => {
    const blank = await parse(emptyDocument());
    expect(blank.page.getWidth()).toBeCloseTo(210 * PT_PER_MM, 6);
    expect(drawing(blank.source).paths).toHaveLength(0);
    for (const change of [
      (doc: Document) => {
        doc.sketches[0].entities[0].points[1].x = NaN;
      },
      (doc: Document) => {
        doc.sketches[0].entities[0].radius = Infinity;
      },
      (doc: Document) => {
        doc.sketches[0].constraints.push({
          id: "bad",
          kind: "length",
          refs: [doc.sketches[0].entities[0].id],
          value: Infinity,
        });
      },
      (doc: Document) => {
        doc.sketches[0].constraints.push({
          id: "bad",
          kind: "length",
          refs: [doc.sketches[0].entities[0].id],
          labelPosition: { x: NaN, y: 0 },
        });
      },
    ]) {
      const doc = lineDoc(10, 10);
      change(doc);
      await expect(exportPdf(doc)).rejects.toThrow(/Invalid export/);
    }
  });

  it("reports an explicit browser-canvas requirement for CJK text in a non-browser environment", async () => {
    const doc = emptyDocument();
    doc.sketches[0].entities.push(
      entity("text", [{ x: 0, y: 0 }], { text: "工程图 中文", fontSize: 3 }),
    );
    await expect(exportPdf(doc)).rejects.toThrow(
      "Unicode PDF text requires browser canvas support",
    );
  });
});
