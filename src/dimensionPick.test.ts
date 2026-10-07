import { describe, expect, it } from "vitest";
import { entity, emptyDocument, type Sketch } from "./model";
import {
  resolveDimension,
  resolveDimensionPreview,
  selectionRefs,
  linePairAngle,
  parallelLineDistance,
} from "./dimensionPick";

function fixture(entities: ReturnType<typeof entity>[] = []) {
  const sketch: Sketch = emptyDocument().sketches[0];
  sketch.entities.push(...entities);
  return sketch;
}
const line = (coords: { x: number; y: number }[]) => entity("line", coords);

describe("dimension picking", () => {
  it("completes a length dimension from a single line", () => {
    const shape = line([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(resolveDimension(fixture([shape]), [shape.id])).toEqual({
      kind: "length",
      refs: [shape.id],
      complete: true,
    });
  });
  it("uses a diameter for circles and arcs", () => {
    const circle = entity("circle", [{ x: 1, y: 2 }], { radius: 4 });
    const arc = entity(
      "arc",
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 0, y: 5 },
      ],
      { radius: 5, ccw: true },
    );
    const sketch = fixture([circle, arc]);
    expect(resolveDimension(sketch, [circle.id])?.kind).toBe("diameter");
    expect(resolveDimension(sketch, [arc.id])?.kind).toBe("diameter");
  });
  it("waits for a second point before completing a point dimension", () => {
    const point = entity("point", [{ x: 3, y: 4 }]);
    const first = resolveDimension(fixture([point]), [point.points[0].id]);
    expect(first).toEqual({
      kind: "length",
      refs: [point.points[0].id],
      complete: false,
    });
  });
  it("picks an axis distance for aligned point pairs and length otherwise", () => {
    const a = entity("point", [{ x: 0, y: 0 }]);
    const b = entity("point", [{ x: 12, y: 0 }]);
    const c = entity("point", [{ x: 0, y: 9 }]);
    const d = entity("point", [{ x: 7, y: 5 }]);
    const sketch = fixture([a, b, c, d]);
    const horizontal = resolveDimension(sketch, [
      a.points[0].id,
      b.points[0].id,
    ]);
    expect(horizontal).toMatchObject({ kind: "distanceX", complete: true });
    const vertical = resolveDimension(sketch, [a.points[0].id, c.points[0].id]);
    expect(vertical).toMatchObject({ kind: "distanceY", complete: true });
    const diagonal = resolveDimension(sketch, [a.points[0].id, d.points[0].id]);
    expect(diagonal).toMatchObject({ kind: "length", complete: true });
  });
  it("honours a fixed dimension type and rejects mismatched geometry", () => {
    const first = line([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const second = line([
      { x: 0, y: 5 },
      { x: 6, y: 9 },
    ]);
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 3 });
    const sketch = fixture([first, second, circle]);
    // An angle between two lines needs both of them.
    expect(resolveDimension(sketch, [first.id], "angle")).toMatchObject({
      kind: "angle",
      refs: [first.id],
      complete: false,
    });
    expect(
      resolveDimension(sketch, [first.id, second.id], "angle"),
    ).toMatchObject({ kind: "angle", complete: true });
    expect(resolveDimension(sketch, [first.id], "radius")).toBeNull();
    expect(resolveDimension(sketch, [circle.id], "radius")).toMatchObject({
      kind: "radius",
      complete: true,
    });
    expect(
      resolveDimension(sketch, [first.id, circle.id], "length"),
    ).toBeNull();
  });
  it("ignores duplicate picks and unusable references", () => {
    const shape = line([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const spline = entity("spline", [
      { x: 0, y: 0 },
      { x: 5, y: 3 },
      { x: 9, y: 0 },
    ]);
    const sketch = fixture([shape, spline]);
    expect(resolveDimension(sketch, [shape.id, shape.id])).toMatchObject({
      kind: "length",
      refs: [shape.id],
      complete: true,
    });
    expect(resolveDimension(sketch, [spline.id])).toBeNull();
    expect(resolveDimension(sketch, [])).toBeNull();
    expect(resolveDimension(sketch, [shape.id, spline.id])).toBeNull();
  });
  it("measures parallel lines by distance and converging lines by angle", () => {
    const a = line([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const b = line([
      { x: 0, y: 6 },
      { x: 20, y: 6 },
    ]);
    const c = line([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    const sketch = fixture([a, b, c]);
    const parallel = resolveDimension(sketch, [a.id, b.id]);
    expect(parallel).toMatchObject({ kind: "lineDistance", complete: true });
    // The distance is carried by one endpoint of the first line plus the other line.
    expect(parallel!.refs).toEqual([a.points[0].id, b.id]);
    expect(resolveDimension(sketch, [a.id, c.id])).toMatchObject({
      kind: "angle",
      refs: [a.id, c.id],
      complete: true,
    });
    expect(parallelLineDistance(a, b)).toBeCloseTo(6, 9);
    expect(linePairAngle(a, c)).toBeCloseTo(45, 9);
  });
  it("distinguishes slightly angled lines from parallel and reversed parallel pairs", () => {
    const a = line([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const b = line([
      { x: 0, y: 6 },
      { x: 100, y: 7 },
    ]);
    const reversed = line([
      { x: 100, y: 6 },
      { x: 0, y: 6 },
    ]);
    const noisy = line([
      { x: 0, y: 6 },
      { x: 100, y: 6.000001 },
    ]);
    const sketch = fixture([a, b, reversed, noisy]);
    expect(resolveDimension(sketch, [a.id, b.id])?.kind).toBe("angle");
    expect(
      resolveDimensionPreview(sketch, [a.id], "auto", { entityId: b.id })?.kind,
    ).toBe("angle");
    expect(resolveDimension(sketch, [a.id, reversed.id])?.kind).toBe(
      "lineDistance",
    );
    expect(resolveDimension(sketch, [a.id, noisy.id])?.kind).toBe(
      "lineDistance",
    );
  });
  it("supports fixing the dimension type to a parallel line distance", () => {
    const a = line([
      { x: 0, y: 0 },
      { x: 12, y: 0 },
    ]);
    const b = line([
      { x: 0, y: 9 },
      { x: 12, y: 3 },
    ]);
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 3 });
    const sketch = fixture([a, b, circle]);
    expect(resolveDimension(sketch, [a.id, b.id], "lineDistance")).toEqual({
      kind: "lineDistance",
      refs: [a.points[0].id, b.id],
      complete: true,
    });
    // Both fixed line types wait for the second line during picking.
    expect(resolveDimension(sketch, [a.id], "lineDistance")).toMatchObject({
      kind: "lineDistance",
      refs: [a.id],
      complete: false,
    });
    expect(resolveDimension(sketch, [a.id], "angle")).toMatchObject({
      kind: "angle",
      refs: [a.id],
      complete: false,
    });
    expect(
      resolveDimension(sketch, [a.id, circle.id], "lineDistance"),
    ).toBeNull();
  });
  it("normalizes point-line distances in both orders and fixed mode", () => {
    const edge = line([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const dot = entity("point", [{ x: 4, y: 8 }]);
    const sketch = fixture([edge, dot]);
    const expected = {
      kind: "lineDistance",
      refs: [dot.points[0].id, edge.id],
      complete: true,
    };
    for (const mode of ["auto", "lineDistance"] as const) {
      expect(
        resolveDimension(sketch, [edge.id, dot.points[0].id], mode),
      ).toEqual(expected);
      expect(
        resolveDimension(sketch, [dot.points[0].id, edge.id], mode),
      ).toEqual(expected);
      expect(resolveDimension(sketch, [dot.id, edge.id], mode)).toEqual(
        expected,
      );
    }
    expect(
      resolveDimension(sketch, [dot.points[0].id], "lineDistance")?.complete,
    ).toBe(false);
    expect(resolveDimension(sketch, [edge.id, edge.points[0].id])).toBeNull();
  });
  it("previews a parallel or angled second line without changing the picks", () => {
    const a = line([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const b = line([
      { x: 0, y: 6 },
      { x: 10, y: 6 },
    ]);
    const c = line([
      { x: 0, y: 0 },
      { x: 8, y: 8 },
    ]);
    const sketch = fixture([a, b, c]);
    const picks = [a.id];
    expect(resolveDimensionPreview(sketch, picks)?.kind).toBe("length");
    expect(
      resolveDimensionPreview(sketch, picks, "auto", { entityId: b.id }),
    ).toMatchObject({
      kind: "lineDistance",
      refs: [a.points[0].id, b.id],
      complete: true,
    });
    expect(
      resolveDimensionPreview(sketch, picks, "auto", { entityId: c.id })?.kind,
    ).toBe("angle");
    expect(picks).toEqual([a.id]);
    expect(sketch.constraints).toEqual([]);
    expect(resolveDimensionPreview(sketch, picks, "auto", null)?.kind).toBe(
      "length",
    );
    expect(
      resolveDimensionPreview(sketch, [a.id, b.id], "auto", { entityId: c.id })
        ?.kind,
    ).toBe("lineDistance");
  });
  it("previews point-line and point-point distances in either order", () => {
    const edge = line([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const a = entity("point", [{ x: 4, y: 8 }]);
    const b = entity("point", [{ x: 12, y: 8 }]);
    const c = entity("point", [{ x: 4, y: 16 }]);
    const d = entity("point", [{ x: 7, y: 12 }]);
    const sketch = fixture([edge, a, b, c, d]);
    const picked = [a.points[0].id];
    expect(resolveDimensionPreview(sketch, picked)).toBeNull();
    expect(
      resolveDimensionPreview(sketch, picked, "auto", { entityId: edge.id })
        ?.kind,
    ).toBe("lineDistance");
    expect(
      resolveDimensionPreview(sketch, [edge.id], "auto", {
        entityId: a.id,
        pointId: a.points[0].id,
      })?.kind,
    ).toBe("lineDistance");
    for (const [target, kind] of [
      [b, "distanceX"],
      [c, "distanceY"],
      [d, "length"],
    ] as const) {
      expect(
        resolveDimensionPreview(sketch, picked, "auto", {
          entityId: target.id,
          pointId: target.points[0].id,
        })?.kind,
      ).toBe(kind);
    }
    expect(
      resolveDimensionPreview(sketch, picked, "length", {
        entityId: b.id,
        pointId: b.points[0].id,
      })?.kind,
    ).toBe("length");
  });
  it("reads references from a live selection", () => {
    expect(
      selectionRefs([{ entityId: "e1" }, { entityId: "e2", pointId: "p2" }]),
    ).toEqual(["e1", "p2"]);
  });
});
