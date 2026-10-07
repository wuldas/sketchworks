import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  make_gcs_wrapper,
  SolveStatus,
  type GcsWrapper,
  type SketchPrimitive,
} from "@salusoft89/planegcs";
import { initSolver, solveSketch } from "./solver";
import { type Sketch, type Entity, type ConstraintKind } from "./model";

const require = createRequire(import.meta.url);
let native: GcsWrapper;
beforeAll(async () => {
  const path = require.resolve(
    "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
  );
  await initSolver(path);
  native = await make_gcs_wrapper(path);
});
const line = (id: string, x = 0, y = 0, dx = 10, dy = 0): Entity => ({
  id,
  kind: "line",
  name: id,
  points: [
    { id: `${id}_a`, x, y },
    { id: `${id}_b`, x: x + dx, y: y + dy },
  ],
});
const point = (id: string, x = 0, y = 0): Entity => ({
  id,
  kind: "point",
  name: id,
  points: [{ id: `${id}_p`, x, y }],
});
const sketch = (...entities: Entity[]): Sketch => ({
  id: "drag-test",
  name: "Drag",
  visible: true,
  entities,
  constraints: [],
});
function constrain(
  s: Sketch,
  kind: ConstraintKind,
  refs: string[],
  value?: number,
) {
  s.constraints.push({ id: `c_${s.constraints.length}`, kind, refs, value });
}
const exact = (pointId: string, x: number, y: number) => ({
  pointId,
  x,
  y,
  exact: true,
});
const close = (actual: number, expected: number) =>
  expect(actual).toBeCloseTo(expected, 7);
const success = (code: SolveStatus) =>
  code === SolveStatus.Success || code === SolveStatus.Converged;

function nativeHorizontal(targetY: number): SolveStatus {
  const primitives: SketchPrimitive[] = [
    { id: "a", type: "point", x: 0, y: 0, fixed: true },
    { id: "b", type: "point", x: 20, y: targetY, fixed: false },
    { id: "l", type: "line", p1_id: "a", p2_id: "b" },
    { id: "h", type: "horizontal_pp", p1_id: "a", p2_id: "b" },
    { id: "dx", type: "coordinate_x", p_id: "b", x: 20, temporary: false },
    { id: "dy", type: "coordinate_y", p_id: "b", y: targetY, temporary: false },
  ];
  native.clear_data();
  native.push_primitives_and_params(primitives);
  return native.solve();
}

describe("native hard coordinate investigation", () => {
  it("accepts a compatible fixed driver coordinate", () => {
    expect(success(nativeHorizontal(0))).toBe(true);
    native.apply_solution();
    const b = native.sketch_index
      .get_primitives()
      .find((p) => p.type === "point" && p.id === "b");
    expect(b).toMatchObject({ x: 20, y: 0 });
  });
  it("rejects an incompatible fixed driver without weakening the hard constraint", () => {
    expect(
      success(nativeHorizontal(7)) && !native.has_gcs_conflicting_constraints(),
    ).toBe(false);
  });
});

describe("exact final drag targets", () => {
  it("keeps ordinary move-phase dragging soft under hard constraints", () => {
    const e = line("l"),
      s = sketch(e);
    constrain(s, "fixed", ["l_a"]);
    constrain(s, "horizontal", ["l"]);
    expect(solveSketch(s, { pointId: "l_b", x: 20, y: 7 }).ok).toBe(true);
    close(e.points[1].x, 20);
    close(e.points[1].y, 0);
  });
  it("lands a free point exactly and does not persist a new fixed constraint", () => {
    const e = point("p", 3, 7),
      s = sketch(e);
    expect(solveSketch(s, exact("p_p", -15, 20)).ok).toBe(true);
    close(e.points[0].x, -15);
    close(e.points[0].y, 20);
    expect(s.constraints).toEqual([]);
    expect(solveSketch(s).ok).toBe(true);
    close(e.points[0].x, -15);
    close(e.points[0].y, 20);
    expect(solveSketch(s, exact("p_p", 30, -10)).ok).toBe(true);
    close(e.points[0].x, 30);
    close(e.points[0].y, -10);
  });
  it("restores document DOF after the final exact driver is removed", () => {
    const s = sketch(point("p", 3, 7));
    expect(solveSketch(s).dof).toBe(2);
    expect(solveSketch(s, exact("p_p", 10, 15)).dof).toBe(0);
    expect(solveSketch(s).dof).toBe(2);
    close(s.entities[0].points[0].x, 10);
    close(s.entities[0].points[0].y, 15);
    expect(s.constraints).toEqual([]);
  });
  it("pins a line anchor while preserving horizontal and length dimensions", () => {
    const e = line("l", 3, 3, 20, 0),
      s = sketch(e);
    constrain(s, "horizontal", ["l"]);
    constrain(s, "length", ["l"], 20);
    const constraints = structuredClone(s.constraints);
    expect(solveSketch(s, exact("l_a", 10, 15)).ok).toBe(true);
    close(e.points[0].x, 10);
    close(e.points[0].y, 15);
    close(e.points[1].x, 30);
    close(e.points[1].y, 15);
    expect(solveSketch(s).ok).toBe(true);
    close(e.points[0].x, 10);
    close(e.points[0].y, 15);
    expect(s.constraints).toEqual(constraints);
  });
  it("accepts an exact endpoint lying on its fixed-anchor length circle", () => {
    const e = line("l"),
      s = sketch(e);
    constrain(s, "fixed", ["l_a"]);
    constrain(s, "length", ["l"], 10);
    expect(solveSketch(s).ok).toBe(true);
    expect(solveSketch(s, exact("l_b", 6, 8)).ok).toBe(true);
    close(e.points[1].x, 6);
    close(e.points[1].y, 8);
    expect(solveSketch(s).ok).toBe(true);
    close(e.points[1].x, 6);
    close(e.points[1].y, 8);
  });
  it("rejects a captured endpoint incompatible with a hard horizontal constraint atomically", () => {
    const e = line("l"),
      s = sketch(e);
    constrain(s, "fixed", ["l_a"]);
    constrain(s, "horizontal", ["l"]);
    expect(solveSketch(s).ok).toBe(true);
    const before = structuredClone(s);
    expect(solveSketch(s, exact("l_b", 20, 7)).ok).toBe(false);
    expect(s).toEqual(before);
  });
  it("rejects a captured endpoint incompatible with the fixed length atomically", () => {
    const e = line("l"),
      s = sketch(e);
    constrain(s, "fixed", ["l_a"]);
    constrain(s, "length", ["l"], 10);
    expect(solveSketch(s).ok).toBe(true);
    const before = structuredClone(s);
    expect(solveSketch(s, exact("l_b", 6, 6)).ok).toBe(false);
    expect(s).toEqual(before);
  });
  it("rejects moving a fixed driver point instead of silently accepting the capture", () => {
    const e = point("p", 3, 7),
      s = sketch(e);
    constrain(s, "fixed", ["p"]);
    expect(solveSketch(s).ok).toBe(true);
    const before = structuredClone(s);
    expect(solveSketch(s, exact("p_p", 10, 15)).ok).toBe(false);
    expect(s).toEqual(before);
    expect(solveSketch(s, exact("p_p", 3, 7)).ok).toBe(true);
  });
  it("rejects stale exact driver references without mutating the sketch", () => {
    const s = sketch(point("p", 3, 7)),
      before = structuredClone(s);
    expect(solveSketch(s, exact("missing", 10, 15)).ok).toBe(false);
    expect(s).toEqual(before);
  });
});
