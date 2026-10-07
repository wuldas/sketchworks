import { describe, expect, it } from "vitest";
import {
  angleDimensionFrame,
  blendEntity,
  bounds,
  cross,
  dist,
  dot,
  sub,
  updateDerived,
  validGeometry,
} from "./geometry";
import { type Entity, type XY, emptyDocument, entity, uid } from "./model";

const line = (ax: number, ay: number, bx: number, by: number) =>
  entity("line", [
    { x: ax, y: ay },
    { x: bx, y: by },
  ]);
const xy = (p: XY) => ({ x: p.x, y: p.y });
function expectDirection(actual: XY, expected: XY) {
  expect(cross(actual, expected)).toBeCloseTo(0, 10);
  expect(dot(actual, expected)).toBeGreaterThan(0);
}
function derivedBlend(a: Entity, b: Entity) {
  return {
    ...blendEntity(a, b),
    id: uid(),
    sourceId: a.id,
    transform: { kind: "blend" as const, secondarySourceId: b.id },
  };
}

describe("tangent blends and derived updates", () => {
  it("frames disjoint horizontal and downward vertical lines at their actual infinite intersection", () => {
    const horizontal = line(2, 3, 5, 3),
      downward = line(9, 10, 9, 7);
    const frame = angleDimensionFrame(horizontal, downward);
    expect(xy(frame.vertex)).toEqual({ x: 9, y: 3 });
    expect(frame.start).toBeCloseTo(0);
    expect(frame.sweep).toBeCloseTo(-Math.PI / 2);
  });
  it("frames absolute sloped-line angles from the horizontal baseline with both signs", () => {
    for (const sign of [1, -1]) {
      const sloped = line(4, -2, 7, -2 + sign * 3);
      const frame = angleDimensionFrame(sloped);
      expect(frame.vertex).toBe(sloped.points[0]);
      expect(frame.start).toBe(0);
      expect(frame.sweep).toBeCloseTo((sign * Math.PI) / 4);
    }
  });
  it("fits many large circles with exact extents and no spread or sampling overflow", () => {
    const circles = Array.from({ length: 1000 }, (_, i) =>
      entity("circle", [{ x: i * 3, y: -i * 2 }], { radius: 100000 }),
    );
    let result: ReturnType<typeof bounds> | undefined;
    expect(() => {
      result = bounds(circles);
    }).not.toThrow();
    expect(result).toEqual({
      minX: -100000,
      maxX: 102997,
      minY: -101998,
      maxY: 100000,
    });
  });
  it("rotates text width and height around its baseline with descenders and CJK widths", () => {
    const text = entity("text", [{ x: 10, y: 20 }], {
      text: "A\u4e2d",
      fontSize: 4,
      rotation: 0,
    });
    const unrotated = bounds([text]);
    expect(unrotated.minX).toBeCloseTo(10);
    expect(unrotated.maxX).toBeCloseTo(16.6);
    expect(unrotated.minY).toBeCloseTo(19);
    expect(unrotated.maxY).toBeCloseTo(24);
    text.rotation = 90;
    const rotated = bounds([text]);
    expect(rotated.minX).toBeCloseTo(6);
    expect(rotated.maxX).toBeCloseTo(11);
    expect(rotated.minY).toBeCloseTo(20);
    expect(rotated.maxY).toBeCloseTo(26.6);
  });
  it("joins line end to line start with cubic controls aligned to both tangents", () => {
    const a = line(0, 0, 3, 0),
      b = line(8, 4, 8, 8),
      blend = blendEntity(a, b),
      ps = blend.points;
    expect(blend.kind).toBe("bezier");
    expect(ps).toHaveLength(4);
    expect(xy(ps[0])).toEqual(xy(a.points[1]));
    expect(xy(ps[3])).toEqual(xy(b.points[0]));
    expectDirection(sub(ps[1], ps[0]), sub(a.points[1], a.points[0]));
    expectDirection(sub(ps[3], ps[2]), sub(b.points[1], b.points[0]));
    const controlLength = dist(ps[0], ps[3]) / 3;
    expect(dist(ps[0], ps[1])).toBeCloseTo(controlLength);
    expect(dist(ps[2], ps[3])).toBeCloseTo(controlLength);
    expect(new Set(ps.map((p) => p.id)).size).toBe(4);
  });
  it("uses arc endpoints rather than centers and respects clockwise/CCW tangent orientation", () => {
    for (const ccw of [true, false]) {
      const a = entity(
        "arc",
        [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 0, y: ccw ? 2 : -2 },
        ],
        { ccw },
      );
      const b = entity(
        "arc",
        [
          { x: 8, y: 0 },
          { x: 6, y: 0 },
          { x: 8, y: 2 },
        ],
        { ccw },
      );
      const blend = blendEntity(a, b),
        ps = blend.points;
      expect(xy(ps[0])).toEqual(xy(a.points[2]));
      expect(xy(ps[3])).toEqual(xy(b.points[1]));
      const tangent = (arc: Entity, index: number) => {
        const r = sub(arc.points[index], arc.points[0]);
        return { x: -r.y * (ccw ? 1 : -1), y: r.x * (ccw ? 1 : -1) };
      };
      expectDirection(sub(ps[1], ps[0]), tangent(a, 2));
      expectDirection(sub(ps[3], ps[2]), tangent(b, 1));
    }
  });
  it("matches cubic Bezier endpoint derivatives without modifying either input", () => {
    const a = entity("bezier", [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 1 },
    ]);
    const b = entity("bezier", [
      { x: 8, y: 2 },
      { x: 7, y: 4 },
      { x: 10, y: 6 },
      { x: 12, y: 1 },
    ]);
    const before = structuredClone([a, b]),
      ps = blendEntity(a, b).points;
    expectDirection(sub(ps[1], ps[0]), sub(a.points[3], a.points[2]));
    expectDirection(sub(ps[3], ps[2]), sub(b.points[1], b.points[0]));
    expect([a, b]).toEqual(before);
  });
  it("refuses unsupported tangent sources and coincident blend endpoints", () => {
    const a = line(0, 0, 3, 0),
      touching = line(3, 0, 4, 1),
      unsupported = entity(
        "ellipse",
        [
          { x: 8, y: 0 },
          { x: 10, y: 0 },
        ],
        { ry: 1 },
      );
    expect(() => blendEntity(a, touching)).toThrow("端点必须分离");
    expect(() => blendEntity(a, unsupported)).toThrow("支持直线、圆弧与贝塞尔");
  });
  it("updates blends from primary and secondary changes while preserving entity and point IDs", () => {
    const a = line(0, 0, 3, 0),
      b = line(8, 4, 8, 8),
      blend = derivedBlend(a, b),
      s = emptyDocument().sketches[0];
    blend.name = "Named blend";
    blend.construction = true;
    s.entities.push(a, b, blend);
    const id = blend.id,
      pointIds = blend.points.map((p) => p.id);
    a.points[1].x = 4;
    a.points[1].y = 1;
    updateDerived(s);
    expect(blend.points.map(xy)).toEqual(blendEntity(a, b).points.map(xy));
    b.points[0].x = 10;
    b.points[0].y = 5;
    b.points[1].x = 12;
    updateDerived(s);
    expect(blend.points.map(xy)).toEqual(blendEntity(a, b).points.map(xy));
    expect(blend.id).toBe(id);
    expect(blend.points.map((p) => p.id)).toEqual(pointIds);
    expect(blend.name).toBe("Named blend");
    expect(blend.construction).toBe(true);
    expect(blend.sourceId).toBe(a.id);
    expect(blend.transform.secondarySourceId).toBe(b.id);
    validGeometry(s);
  });
  it("rejects missing and derived secondary sources instead of retaining stale blend geometry", () => {
    const a = line(0, 0, 3, 0),
      b = line(8, 4, 8, 8),
      blend = derivedBlend(a, b),
      s = emptyDocument().sketches[0];
    s.entities.push(a, b, blend);
    blend.transform.secondarySourceId = "missing";
    expect(() => updateDerived(s)).toThrow("过渡曲线源对象");
    blend.transform.secondarySourceId = b.id;
    b.sourceId = a.id;
    b.transform = { kind: "translate", x: 5 };
    expect(() => updateDerived(s)).toThrow("过渡曲线源对象");
    delete b.sourceId;
    delete b.transform;
    blend.sourceId = "missing";
    expect(() => updateDerived(s)).toThrow("派生源对象");
  });
});
