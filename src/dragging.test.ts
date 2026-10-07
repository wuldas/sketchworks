import { describe, expect, it } from "vitest";
import { entity, emptyDocument } from "./model";
import { dragAnchor, resolveDragSnap, sameDragPosition } from "./dragging";

describe("drag targeting", () => {
  it("anchors whole-body dragging at the entity point instead of the mouse grip", () => {
    const sketch = emptyDocument().sketches[0];
    const circle = entity("circle", [{ x: 3, y: 7 }], { radius: 5 });
    sketch.entities.push(circle);
    const result = dragAnchor(sketch, { entityId: circle.id }, [], {
      x: 8,
      y: 7,
    })!;
    expect(result.point).toEqual({ x: 3, y: 7 });
    expect(result.offset).toEqual({ x: -5, y: 0 });
    expect(result.pointId).toBe(circle.points[0].id);
  });
  it("anchors selected controls without moving the rest of a selected group", () => {
    const sketch = emptyDocument().sketches[0];
    const line = entity("line", [
      { x: 1, y: 2 },
      { x: 8, y: 5 },
    ]);
    const other = entity("point", [{ x: 9, y: 9 }]);
    sketch.entities.push(line, other);
    const result = dragAnchor(
      sketch,
      { entityId: line.id, pointId: line.points[1].id },
      [{ entityId: line.id }, { entityId: other.id }],
      { x: 8.1, y: 5.2 },
    )!;
    expect(result.point).toEqual({ x: 8, y: 5 });
    expect([...result.excluded]).toEqual([line.points[1].id]);
    expect(result.excluded.has(line.points[0].id)).toBe(false);
  });
  it("excludes the dragged group and its constraint-connected geometry from self capture", () => {
    const sketch = emptyDocument().sketches[0];
    const a = entity("line", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    const b = entity("line", [
      { x: 10, y: 0 },
      { x: 10, y: 8 },
    ]);
    const c = entity("point", [{ x: 30, y: 40 }]);
    const independent = entity("point", [{ x: 50, y: 60 }]);
    sketch.entities.push(a, b, c, independent);
    sketch.constraints.push({
      id: "join",
      kind: "coincident",
      refs: [a.points[1].id, b.points[0].id],
    });
    const result = dragAnchor(
      sketch,
      { entityId: a.id },
      [{ entityId: a.id }, { entityId: c.id }],
      { x: 5, y: 0 },
    )!;
    expect(result.excluded).toEqual(
      new Set([
        a.id,
        c.id,
        ...a.points.map((point) => point.id),
        c.points[0].id,
        b.points[0].id,
      ]),
    );
    expect(result.excluded.has(b.points[1].id)).toBe(false);
    expect(result.excluded.has(independent.id)).toBe(false);
  });
  it("does not treat a shared fixed constraint as movement coupling", () => {
    const sketch = emptyDocument().sketches[0];
    const a = entity("point", [{ x: 0, y: 0 }]),
      b = entity("point", [{ x: 10, y: 0 }]);
    sketch.entities.push(a, b);
    sketch.constraints.push({ id: "fixed", kind: "fixed", refs: [a.id, b.id] });
    expect(
      dragAnchor(sketch, { entityId: a.id }, [], { x: 0, y: 0 })!.excluded.has(
        b.id,
      ),
    ).toBe(false);
  });
  it("latches a capture within a 12 CSS-pixel release band", () => {
    const previous = { point: { x: 10, y: 20 }, kind: "grid" as const };
    expect(
      resolveDragSnap({ x: 12.2, y: 20 }, previous, null, 5).target,
    ).toEqual(previous.point);
    expect(
      resolveDragSnap({ x: 12.4, y: 20 }, previous, null, 5).snap,
    ).toBeNull();
    expect(
      resolveDragSnap({ x: 11.1, y: 20 }, previous, null, 10).target,
    ).toEqual(previous.point);
  });
  it("promotes a real geometric reference over a latched grid position", () => {
    const previous = { point: { x: 10, y: 20 }, kind: "grid" as const };
    const nearest = {
      point: { x: 10.2, y: 20 },
      kind: "point" as const,
      ref: "actual-point",
    };
    expect(
      resolveDragSnap({ x: 10.3, y: 20 }, previous, nearest, 5).snap,
    ).toEqual(nearest);
  });
  it("copies captured positions and skips numerically identical targets", () => {
    const nearest = { point: { x: 10, y: 20 }, kind: "grid" as const };
    const result = resolveDragSnap({ x: 10.1, y: 20.2 }, null, nearest, 5);
    nearest.point.x = 99;
    expect(result.target).toEqual({ x: 10, y: 20 });
    expect(sameDragPosition(result.target, { x: 10 + 1e-8, y: 20 })).toBe(true);
    expect(sameDragPosition(result.target, { x: 10.01, y: 20 })).toBe(false);
    expect(sameDragPosition(null, result.target)).toBe(false);
  });
});
