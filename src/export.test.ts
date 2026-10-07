import { describe, expect, it } from "vitest";
import DxfParser from "dxf-parser";
import { exportDxf, exportJson, exportSvg } from "./export";
import { emptyDocument, entity, validateDocument } from "./model";

const parse = (source: string) => new DxfParser().parseSync(source)!;
function example() {
  const doc = emptyDocument();
  doc.name = "Test <sketch>";
  doc.sketches[0].entities.push(
    entity("line", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    entity("circle", [{ x: 2, y: 3 }], { radius: 4 }),
    entity(
      "arc",
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 0, y: 5 },
      ],
      { radius: 5, ccw: true },
    ),
    entity(
      "ellipse",
      [
        { x: 1, y: 2 },
        { x: 7, y: 2 },
      ],
      { ry: 3 },
    ),
    entity("bezier", [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 0 },
    ]),
    entity(
      "conic",
      [
        { x: 0, y: 0 },
        { x: 2, y: 3 },
        { x: 4, y: 0 },
      ],
      { weight: 0.75 },
    ),
    entity("text", [{ x: 0, y: 10 }], {
      text: "A < B & C",
      fontSize: 3,
      rotation: 15,
    }),
    entity("point", [{ x: 12, y: 7 }]),
  );
  return doc;
}

describe("CAD export", () => {
  it("produces parser-readable native entities and millimeter units", () => {
    const parsed = parse(exportDxf(example()));
    expect(parsed.header.$INSUNITS).toBe(4);
    expect(parsed.entities.map((e) => e.type)).toEqual([
      "LINE",
      "CIRCLE",
      "ARC",
      "ELLIPSE",
      "SPLINE",
      "SPLINE",
      "TEXT",
      "POINT",
    ]);
    expect(parsed.entities.find((e) => e.type === "CIRCLE")).toMatchObject({
      center: { x: 2, y: 3 },
      radius: 4,
    });
    expect(parsed.entities.find((e) => e.type === "ELLIPSE")).toMatchObject({
      center: { x: 1, y: 2 },
      majorAxisEndPoint: { x: 6, y: 0 },
      axisRatio: 0.5,
    });
  });

  it("exports exact rational quadratic weights, degree and knots", () => {
    const doc = emptyDocument();
    doc.sketches[0].entities.push(
      entity(
        "conic",
        [
          { x: 0, y: 0 },
          { x: 2, y: 3 },
          { x: 4, y: 0 },
        ],
        { weight: 0.75 },
      ),
    );
    const source = exportDxf(doc);
    expect(parse(source).entities[0]).toMatchObject({
      type: "SPLINE",
      degreeOfSplineCurve: 2,
      controlPoints: [
        { x: 0, y: 0 },
        { x: 2, y: 3 },
        { x: 4, y: 0 },
      ],
      knotValues: [0, 0, 0, 1, 1, 1],
    });
    // dxf-parser does not expose rational weights, so check DXF group 41 records.
    const records = source.trim().split(/\r?\n/);
    const weights: number[] = [];
    let inSpline = false;
    for (let i = 0; i < records.length - 1; i += 2) {
      const code = records[i].trim(),
        value = records[i + 1].trim();
      if (code === "0") inSpline = value === "SPLINE";
      if (inSpline && code === "41") weights.push(Number(value));
    }
    expect(weights).toEqual([1, 0.75, 1]);
  });

  it("normalizes a taller ellipse to valid DXF major and minor axes", () => {
    const doc = emptyDocument();
    doc.sketches[0].entities.push(
      entity(
        "ellipse",
        [
          { x: 0, y: 0 },
          { x: 3, y: 0 },
        ],
        { ry: 6 },
      ),
    );
    expect(parse(exportDxf(doc)).entities[0]).toMatchObject({
      type: "ELLIPSE",
      majorAxisEndPoint: { x: 0, y: 6 },
      axisRatio: 0.5,
    });
  });

  it("reverses clockwise arc endpoints without tessellating", () => {
    const doc = emptyDocument();
    doc.sketches[0].entities.push(
      entity(
        "arc",
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 0, y: 5 },
        ],
        { ccw: false, radius: 5 },
      ),
    );
    expect(parse(exportDxf(doc)).entities[0]).toMatchObject({
      type: "ARC",
      startAngle: Math.PI / 2,
      endAngle: 0,
    });
  });

  it("excludes hidden sketches and construction geometry unless requested", () => {
    const doc = emptyDocument();
    const e = () =>
      entity("line", [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]);
    doc.sketches[0].entities.push(e(), { ...e(), construction: true });
    doc.sketches.push(
      {
        id: "hidden",
        name: "Hidden",
        visible: false,
        constraints: [],
        entities: [e()],
      },
      {
        id: "second",
        name: "Second",
        visible: true,
        constraints: [],
        entities: [e()],
      },
    );
    expect(parse(exportDxf(doc)).entities).toHaveLength(2);
    expect(parse(exportDxf(doc, { construction: true })).entities).toHaveLength(
      3,
    );
    expect(parse(exportDxf(doc, { allVisible: false })).entities).toHaveLength(
      1,
    );
  });

  it("preserves millimeter physical units when display units are inches", () => {
    const doc = example();
    doc.unit = "in";
    const result = parse(exportDxf(doc));
    expect(result.header.$INSUNITS).toBe(4);
    expect(result.entities[1]).toMatchObject({ radius: 4 });
    const svgIn = exportSvg(doc);
    doc.unit = "mm";
    expect(svgIn).toBe(exportSvg(doc));
    expect(svgIn).toMatch(/width="[0-9.]+mm" height="[0-9.]+mm"/);
  });

  it("isolates construction in dashed DXF layers and a distinct SVG subgroup", () => {
    const doc = emptyDocument();
    doc.sketches[0].entities.push(
      entity("line", [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
      entity(
        "line",
        [
          { x: 0, y: 2 },
          { x: 10, y: 2 },
        ],
        { construction: true },
      ),
    );
    const result = parse(exportDxf(doc, { construction: true }));
    expect(result.entities[0].layer).not.toContain("_construction");
    expect(result.entities[1].layer).toMatch(/_construction$/);
    expect(result.tables.layer.layers[result.entities[1].layer]).toMatchObject({
      colorIndex: 8,
    });
    const svg = exportSvg(doc, { construction: true });
    expect(svg).toMatch(
      /<g id="geometry"><line[^]*?<g id="construction" stroke-dasharray="2 1"><line/,
    );
    expect(exportSvg(doc)).not.toContain('id="construction"');
  });

  it("preserves a multi-segment spline as cubic DXF entities", () => {
    const doc = emptyDocument();
    doc.sketches[0].entities.push(
      entity("spline", [
        { x: 0, y: 0 },
        { x: 3, y: 5 },
        { x: 8, y: 1 },
      ]),
    );
    const result = parse(exportDxf(doc));
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.entities.every((e) => e.type === "SPLINE")).toBe(true);
  });

  it("uses exact SVG circles, ellipses, arcs and cubics and escapes text", () => {
    const svg = exportSvg(example());
    expect(svg).toContain("<circle");
    expect(svg).toContain("<ellipse");
    expect(svg).toContain(" A 5 5 ");
    expect(svg).toContain(" C 1 2 3 2 4 0");
    expect(svg).toContain("A &lt; B &amp; C");
    expect(svg).toContain("Test &lt;sketch&gt;");
    expect(svg).toContain("scale(1 -1)");
    expect(svg).not.toContain("NaN");
  });

  it("exports empty SVG with a finite viewBox and lossless JSON", () => {
    const doc = emptyDocument();
    expect(exportSvg(doc)).toContain('viewBox="-2 -102 104 104"');
    expect(validateDocument(JSON.parse(exportJson(doc)))).toEqual(doc);
  });
});
