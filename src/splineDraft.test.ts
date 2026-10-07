import { describe, expect, it } from "vitest";
import { appendSplinePoint } from "./splineDraft";
import { entity, emptyDocument } from "./model";
import { dragAnchor } from "./dragging";
import { CanvasRenderer, type CanvasFrame } from "./canvasRenderer";

const frame: CanvasFrame = {
  width: 800,
  height: 600,
  dpr: 1,
  view: { center: { x: 0, y: 0 }, scale: 4 },
  grid: false,
  unit: "mm",
  selection: [],
  drafts: [],
  preview: [],
  cursor: null,
  snapPoint: null,
  marquee: null,
};
describe("spline draft and endpoint capture", () => {
  it("does not append duplicate points on the second click of a finishing double-click", () => {
    const first = appendSplinePoint(
      [
        { x: 0, y: 0 },
        { x: 10, y: 5 },
      ],
      ["start", undefined],
      { x: 20, y: 0 },
      "end",
    );
    const second = appendSplinePoint(
      first.points,
      first.refs,
      { x: 20, y: 0 },
      "end",
    );
    expect(second.points).toHaveLength(3);
    expect(second.refs).toEqual(["start", undefined, "end"]);
    expect(second.points).toBe(first.points);
  });
  it("can upgrade a last-point capture reference without creating a new fit point", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 5 },
    ];
    const result = appendSplinePoint(
      points,
      [undefined, undefined],
      { x: 10, y: 5 },
      "captured",
    );
    expect(result.points).toBe(points);
    expect(result.refs).toEqual([undefined, "captured"]);
  });
  it("keeps first and last fit points distinct when a spline returns to its start", () => {
    const result = appendSplinePoint(
      [
        { x: 0, y: 0 },
        { x: 10, y: 5 },
      ],
      ["same-source", undefined],
      { x: 0, y: 0 },
      "same-source",
    );
    expect(result.points).toHaveLength(3);
    expect(result.refs).toEqual(["same-source", undefined, "same-source"]);
  });
  it.each([false, true])(
    "captures a static connected line endpoint while dragging only the free spline end (fixed=%s)",
    (fixed) => {
      const s = emptyDocument().sketches[0];
      const line = entity("line", [
        { x: 0, y: 0 },
        { x: 30, y: 10 },
      ]);
      const spline = entity("spline", [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
        { x: 20, y: 5 },
      ]);
      s.entities.push(line, spline);
      s.constraints.push({
        id: "join",
        kind: "coincident",
        refs: [line.points[0].id, spline.points[0].id],
      });
      if (fixed)
        s.constraints.push({ id: "fixed", kind: "fixed", refs: [line.id] });
      const anchor = dragAnchor(
        s,
        { entityId: spline.id, pointId: spline.points[2].id },
        [],
        spline.points[2],
      )!;
      expect(anchor.excluded.has(spline.points[2].id)).toBe(true);
      expect(anchor.excluded.has(line.id)).toBe(false);
      expect(anchor.excluded.has(line.points[1].id)).toBe(false);
      const r = new CanvasRenderer();
      r.sync([s], s.id);
      expect(
        r.snap({ x: 30.1, y: 10.1 }, frame, anchor.excluded),
      ).toMatchObject({ kind: "endpoint", ref: line.points[1].id });
    },
  );
  it("excludes a moving coincident alias but leaves the other static endpoint available", () => {
    const s = emptyDocument().sketches[0];
    const a = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const b = entity("line", [
      { x: 20, y: 0 },
      { x: 30, y: 10 },
    ]);
    s.entities.push(a, b);
    s.constraints.push({
      id: "join",
      kind: "coincident",
      refs: [a.points[1].id, b.points[0].id],
    });
    const anchor = dragAnchor(
      s,
      { entityId: a.id, pointId: a.points[1].id },
      [],
      a.points[1],
    )!;
    const r = new CanvasRenderer();
    r.sync([s], s.id);
    expect(anchor.excluded.has(b.points[0].id)).toBe(true);
    expect(r.snap({ x: 20.1, y: 0.1 }, frame, anchor.excluded)).toBeNull();
    expect(r.snap({ x: 30.1, y: 10.1 }, frame, anchor.excluded)?.ref).toBe(
      b.points[1].id,
    );
  });
});
