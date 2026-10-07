import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { canConstrain, initSolver, solveSketch } from "./solver";
import { pointLineDistance } from "./geometry";
import type { Sketch, Entity, ConstraintKind } from "./model";
const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);
const line = (id: string, x = 0, y = 0, dx = 9, dy = 3): Entity => ({
  id,
  kind: "line",
  name: id,
  points: [
    { id: id + "a", x, y },
    { id: id + "b", x: x + dx, y: y + dy },
  ],
});
const circle = (id: string, x = 0, y = 0, radius = 5): Entity => ({
  id,
  kind: "circle",
  name: id,
  points: [{ id: id + "p", x, y }],
  radius,
});
const pt = (id: string, x = 0, y = 0): Entity => ({
  id,
  kind: "point",
  name: id,
  points: [{ id: id + "p", x, y }],
});
const sketch = (...entities: Entity[]): Sketch => ({
  id: "sk",
  name: "test",
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
  s.constraints.push({ id: "c" + s.constraints.length, kind, refs, value });
}
const close = (actual: number, expected: number) =>
  expect(actual).toBeCloseTo(expected, 6);

describe("real PlaneGCS solver", () => {
  it("solves horizontal length and reports actual DOF", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "fixed", ["la"]);
    constrain(s, "horizontal", ["l"]);
    constrain(s, "length", ["l"], 10);
    expect(solveSketch(s)).toMatchObject({
      ok: true,
      dof: 0,
      status: "Success",
    });
    close(l.points[1].x, 10);
    close(l.points[1].y, 0);
  });
  it("solves vertical and point coincidence", () => {
    const l = line("l"),
      p = pt("p", 10, 4),
      s = sketch(l, p);
    constrain(s, "fixed", ["la"]);
    constrain(s, "vertical", ["l"]);
    constrain(s, "coincident", ["lb", "pp"]);
    expect(solveSketch(s).ok).toBe(true);
    close(l.points[1].x, 0);
    close(p.points[0].x, l.points[1].x);
    close(p.points[0].y, l.points[1].y);
  });
  it.each(["parallel", "perpendicular", "equal"] as const)(
    "solves %s lines",
    (kind) => {
      const a = line("a", 0, 0, 10, 0),
        b = line("b", 0, 10, 7, 3),
        s = sketch(a, b);
      constrain(s, "fixed", ["a"]);
      constrain(s, "fixed", ["ba"]);
      constrain(s, kind, ["a", "b"]);
      expect(solveSketch(s).ok).toBe(true);
      if (kind === "parallel") close(b.points[1].y, 10);
      else if (kind === "perpendicular") close(b.points[1].x, 0);
      else close(Math.hypot(b.points[1].x, b.points[1].y - 10), 10);
    },
  );
  it("converts degrees to radians for absolute angle", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "fixed", ["la"]);
    constrain(s, "angle", ["l"], 90);
    constrain(s, "length", ["l"], 10);
    expect(solveSketch(s).ok).toBe(true);
    close(l.points[1].x, 0);
    close(l.points[1].y, 10);
  });
  it("converts degrees for relative line angle", () => {
    const a = line("a", 0, 0, 10, 0),
      b = line("b", 0, 10, 7, 3),
      s = sketch(a, b);
    constrain(s, "fixed", ["a"]);
    constrain(s, "fixed", ["ba"]);
    constrain(s, "angle", ["a", "b"], 45);
    expect(solveSketch(s).ok).toBe(true);
    close(b.points[1].x, b.points[1].y - 10);
  });
  it("solves signed X and Y dimensions", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "fixed", ["la"]);
    constrain(s, "distanceX", ["l"], -12);
    constrain(s, "distanceY", ["l"], 7);
    expect(solveSketch(s).ok).toBe(true);
    close(l.points[1].x, -12);
    close(l.points[1].y, 7);
  });
  it("solves a midpoint and symmetry center", () => {
    const l = line("l", 0, 0, 10, 0),
      p = pt("p", 3, 4),
      s = sketch(l, p);
    constrain(s, "fixed", ["l"]);
    constrain(s, "midpoint", ["p", "l"]);
    expect(solveSketch(s).ok).toBe(true);
    close(p.points[0].x, 5);
    close(p.points[0].y, 0);
    s.constraints.pop();
    constrain(s, "symmetric", ["la", "lb", "p"]);
    expect(solveSketch(s).ok).toBe(true);
    close(p.points[0].x, 5);
  });
  it("solves symmetry about a line", () => {
    const axis = line("axis", 0, -10, 0, 20),
      a = pt("a", 2, 3),
      b = pt("b", -1, 5),
      s = sketch(axis, a, b);
    constrain(s, "fixed", ["axis"]);
    constrain(s, "fixed", ["a"]);
    constrain(s, "symmetric", ["a", "b", "axis"]);
    expect(solveSketch(s).ok).toBe(true);
    close(b.points[0].x, -2);
    close(b.points[0].y, 3);
  });
  it("solves concentric circles and equal radii", () => {
    const a = circle("a"),
      b = circle("b", 2, 3, 2),
      s = sketch(a, b);
    constrain(s, "fixed", ["a"]);
    constrain(s, "concentric", ["a", "b"]);
    constrain(s, "equal", ["a", "b"]);
    expect(solveSketch(s).ok).toBe(true);
    close(b.points[0].x, 0);
    close(b.points[0].y, 0);
    close(b.radius!, 5);
  });
  it("solves line/circle tangency and radius", () => {
    const l = line("l", -10, 0, 20, 0),
      c = circle("c", 0, 6),
      s = sketch(l, c);
    constrain(s, "fixed", ["l"]);
    constrain(s, "radius", ["c"], 5);
    constrain(s, "tangent", ["l", "c"]);
    expect(solveSketch(s).ok).toBe(true);
    close(Math.abs(c.points[0].y), 5);
  });
  it("solves diameter and collinear lines", () => {
    const a = line("a", 0, 0, 10, 0),
      b = line("b", 2, 5, 8, 3),
      c = circle("c"),
      s = sketch(a, b, c);
    constrain(s, "fixed", ["a"]);
    constrain(s, "collinear", ["a", "b"]);
    constrain(s, "diameter", ["c"], 12);
    expect(solveSketch(s).ok).toBe(true);
    close(b.points[0].y, 0);
    close(b.points[1].y, 0);
    close(c.radius!, 6);
  });
  it("solves a distance between parallel lines", () => {
    const a = line("a", 0, 0, 20, 0),
      b = line("b", 0, 8, 20, 10),
      s = sketch(a, b);
    constrain(s, "fixed", ["a"]);
    constrain(s, "parallel", ["a", "b"]);
    constrain(s, "lineDistance", [b.points[0].id, a.id], 6);
    expect(solveSketch(s).ok).toBe(true);
    close(pointLineDistance(b.points[0], a.points[0], a.points[1]), 6);
    close(b.points[1].y - b.points[0].y, 0);
  });
  it("solves a line distance between two free lines", () => {
    const a = line("a", 0, 0, 20, 0),
      b = line("b", 0, 14, 20, 14),
      s = sketch(a, b);
    constrain(s, "lineDistance", [b.points[0].id, a.id], 9);
    expect(solveSketch(s).ok).toBe(true);
    close(pointLineDistance(b.points[0], a.points[0], a.points[1]), 9);
  });
  it("rejects a parallel line distance that needs the same point and line", () => {
    const a = line("a", 0, 0, 20, 0),
      s = sketch(a);
    constrain(s, "lineDistance", [a.points[0].id, a.id], 5);
    expect(canConstrain(s, "lineDistance", [a.points[0].id, a.id])).toBeNull();
    expect(canConstrain(s, "lineDistance", [a.id, a.id])).not.toBeNull();
  });
  it("enforces arc rules and arc radius", () => {
    const a: Entity = {
        id: "a",
        kind: "arc",
        name: "a",
        radius: 5,
        points: [
          { id: "ac", x: 0, y: 0 },
          { id: "as", x: 5, y: 0 },
          { id: "ae", x: 0, y: 5 },
        ],
      },
      s = sketch(a);
    constrain(s, "fixed", ["ac"]);
    constrain(s, "radius", ["a"], 8);
    expect(solveSketch(s).ok).toBe(true);
    close(a.radius!, 8);
    for (const p of a.points.slice(1)) close(Math.hypot(p.x, p.y), 8);
  });
  it("preserves original fixed anchors after direct edits and drag", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "fixed", ["l"]);
    expect(solveSketch(s).ok).toBe(true);
    l.points[0].x = 100;
    l.points[1].y = 90;
    expect(solveSketch(s, { pointId: "la", x: 200, y: 200 }).ok).toBe(true);
    close(l.points[0].x, 0);
    close(l.points[1].y, 3);
  });
  it("fixes radius as well as center", () => {
    const c = circle("c"),
      s = sketch(c);
    constrain(s, "fixed", ["c"]);
    expect(solveSketch(s).ok).toBe(true);
    c.radius = 99;
    c.points[0].x = 100;
    expect(solveSketch(s).ok).toBe(true);
    close(c.radius!, 5);
    close(c.points[0].x, 0);
  });
  it("uses temporary drag targets while preserving hard constraints", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "fixed", ["la"]);
    constrain(s, "horizontal", ["l"]);
    expect(solveSketch(s, { pointId: "lb", x: 20, y: 7 }).ok).toBe(true);
    close(l.points[1].y, 0);
    close(l.points[1].x, 20);
  });
  it("does not modify geometry on contradictory dimensions", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "length", ["l"], 10);
    constrain(s, "length", ["l"], 20);
    const before = structuredClone(l);
    const result = solveSketch(s);
    expect(result.ok).toBe(false);
    expect(l).toEqual(before);
    expect(result.conflicting.length).toBeGreaterThan(0);
  });
  it("rejects unsupported entity combinations and missing refs", () => {
    const e: Entity = {
        id: "b",
        kind: "bezier",
        name: "b",
        points: [0, 1, 2, 3].map((n) => ({ id: "p" + n, x: n, y: n })),
      },
      s = sketch(e, circle("c"));
    expect(canConstrain(s, "tangent", ["b", "c"])).not.toBeNull();
    expect(canConstrain(s, "horizontal", ["b"])).not.toBeNull();
    expect(canConstrain(s, "fixed", ["p0"])).toBeNull();
    expect(canConstrain(s, "coincident", ["p0", "cp"])).toBeNull();
    expect(canConstrain(s, "coincident", ["missing", "cp"])).not.toBeNull();
  });
  it("solves point-on-line with either selection order", () => {
    const l = line("l", 0, 0, 10, 0),
      p = pt("p", 4, 8),
      s = sketch(l, p);
    constrain(s, "fixed", ["l"]);
    constrain(s, "onLine", ["l", "p"]);
    expect(solveSketch(s).ok).toBe(true);
    close(p.points[0].y, 0);
  });
  it("fixes an arc with an implicit radius", () => {
    const a: Entity = {
        id: "a",
        kind: "arc",
        name: "a",
        points: [
          { id: "ac", x: 0, y: 0 },
          { id: "as", x: 5, y: 0 },
          { id: "ae", x: 0, y: 5 },
        ],
      },
      s = sketch(a);
    constrain(s, "fixed", ["a"]);
    expect(solveSketch(s).ok).toBe(true);
    a.radius = 90;
    a.points[1].x = 90;
    expect(solveSketch(s).ok).toBe(true);
    close(a.radius!, 5);
    close(a.points[1].x, 5);
  });
  it("rejects a collapsed line without committing points", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "coincident", ["la", "lb"]);
    const before = structuredClone(l);
    const result = solveSketch(s);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("InvalidGeometry");
    expect(l).toEqual(before);
  });
  it("solves curve control-point coincidence and fixed only", () => {
    const b: Entity = {
        id: "b",
        kind: "bezier",
        name: "b",
        points: [0, 1, 2, 3].map((n) => ({ id: "p" + n, x: n, y: n })),
      },
      p = pt("p", 8, 9),
      s = sketch(b, p);
    constrain(s, "fixed", ["p"]);
    constrain(s, "coincident", ["p0", "pp"]);
    expect(solveSketch(s).ok).toBe(true);
    close(b.points[0].x, 8);
    close(b.points[0].y, 9);
    expect(canConstrain(s, "distanceX", ["p0", "pp"])).not.toBeNull();
  });
  it("rejects nonfinite dimensions without modifying sketch", () => {
    const l = line("l"),
      s = sketch(l);
    constrain(s, "length", ["l"], NaN);
    const before = structuredClone(s);
    expect(solveSketch(s).ok).toBe(false);
    expect(s).toEqual(before);
  });
});
