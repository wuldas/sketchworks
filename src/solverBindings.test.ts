import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { intersections, paperPath, pointLineDistance } from "./geometry";
import type {
  Constraint,
  ConstraintKind,
  Entity,
  EntityKind,
  Sketch,
  XY,
} from "./model";
import { pathMidpoint, tangentPoints } from "./snapping";
import { canConstrain, initSolver, solveSketch } from "./solver";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);
const shape = (
  id: string,
  kind: EntityKind,
  coords: XY[],
  extra: Partial<Entity> = {},
): Entity => ({
  id,
  kind,
  name: id,
  points: coords.map((p, i) => ({ id: `${id}_${i}`, ...p })),
  ...extra,
});
const point = (id: string, x = 3, y = 4) => shape(id, "point", [{ x, y }]);
const line = (id: string, a: XY = { x: 0, y: 0 }, b: XY = { x: 10, y: 0 }) =>
  shape(id, "line", [a, b]);
const circle = (id: string) =>
  shape(id, "circle", [{ x: 0, y: 0 }], { radius: 5 });
const arc = (id: string, ccw = true) =>
  shape(
    id,
    "arc",
    [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 0, y: 5 },
    ],
    { radius: 5, ccw },
  );
const curves: Record<"bezier" | "spline" | "conic" | "ellipse", () => Entity> =
  {
    bezier: () =>
      shape("curve", "bezier", [
        { x: 0, y: 0 },
        { x: 0, y: 9 },
        { x: 12, y: -1 },
        { x: 14, y: 4 },
      ]),
    spline: () =>
      shape("curve", "spline", [
        { x: 0, y: 0 },
        { x: 4, y: 8 },
        { x: 12, y: -2 },
        { x: 18, y: 4 },
      ]),
    conic: () =>
      shape(
        "curve",
        "conic",
        [
          { x: 0, y: 0 },
          { x: 7, y: 10 },
          { x: 14, y: 0 },
        ],
        { weight: 0.7 },
      ),
    ellipse: () =>
      shape(
        "curve",
        "ellipse",
        [
          { x: 0, y: 0 },
          { x: 8, y: 0 },
        ],
        { ry: 4 },
      ),
  };
const flatBezier = () =>
  shape("curve", "bezier", [
    { x: -10, y: 0 },
    { x: -4, y: 0 },
    { x: 4, y: 0 },
    { x: 10, y: 0 },
  ]);
const sketch = (...entities: Entity[]): Sketch => ({
  id: "sketch",
  name: "bindings",
  visible: true,
  entities,
  constraints: [],
});
function constrain(
  s: Sketch,
  kind: ConstraintKind,
  refs: string[],
  value?: number,
  id = `constraint_${s.constraints.length}`,
): Constraint {
  const c = { id, kind, refs, value };
  s.constraints.push(c);
  return c;
}
const expectXY = (actual: XY, expected: XY) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
};
function nearest(curve: Entity, p: XY): XY {
  const path = paperPath(curve);
  try {
    const result = path.getNearestPoint([p.x, p.y]);
    return { x: result.x, y: result.y };
  } finally {
    path.remove();
  }
}
function onPath(curve: Entity, fraction = 0.35): XY {
  const path = paperPath(curve);
  try {
    const p = path.getPointAt(path.length * fraction)!;
    return { x: p.x, y: p.y };
  } finally {
    path.remove();
  }
}

describe("positional binding validation", () => {
  it("allows explicit control points for positional bindings only", () => {
    const curve = curves.spline(),
      a = line("line"),
      b = circle("circle"),
      s = sketch(curve, a, b),
      p = curve.points[1].id;
    expect(canConstrain(s, "coincident", [p, a.points[0].id])).toBeNull();
    expect(canConstrain(s, "onLine", [p, a.id])).toBeNull();
    expect(canConstrain(s, "onCurve", [b.id, p])).toBeNull();
    expect(canConstrain(s, "midpoint", [p, a.id])).toBeNull();
    expect(canConstrain(s, "intersection", [p, a.id, b.id])).toBeNull();
    expect(canConstrain(s, "origin", [p])).toBeNull();
    expect(canConstrain(s, "distanceX", [p, a.points[0].id])).not.toBeNull();
    expect(canConstrain(s, "lineDistance", [p, a.id])).not.toBeNull();
    expect(
      canConstrain(s, "symmetric", [p, a.points[0].id, a.id]),
    ).not.toBeNull();
  });

  it("requires explicit targets, canonical intersections, and distinct live refs", () => {
    const a = line("a"),
      b = circle("b"),
      p = point("p"),
      s = sketch(a, b, p);
    expect(canConstrain(s, "onCurve", [a.id, b.id])).not.toBeNull();
    expect(canConstrain(s, "origin", [a.id])).not.toBeNull();
    expect(canConstrain(s, "intersection", [p.id, a.id, b.id])).toBeNull();
    expect(canConstrain(s, "intersection", [a.id, p.id, b.id])).not.toBeNull();
    expect(canConstrain(s, "intersection", [p.id, a.id, a.id])).not.toBeNull();
    expect(
      canConstrain(s, "intersection", [p.id, a.id, "missing"]),
    ).not.toBeNull();
    expect(canConstrain(s, "onCurve", ["missing", b.id])).not.toBeNull();
  });

  it("rejects entity and point refs owned by derived geometry", () => {
    const source = curves.bezier(),
      derived = line("derived"),
      p = point("p"),
      s = sketch(source, derived, p);
    derived.sourceId = source.id;
    derived.transform = { kind: "translate", x: 10 };
    expect(canConstrain(s, "fixed", [derived.id])).not.toBeNull();
    expect(
      canConstrain(s, "coincident", [p.id, derived.points[0].id]),
    ).not.toBeNull();
    expect(canConstrain(s, "midpoint", [p.id, derived.id])).not.toBeNull();
    expect(canConstrain(s, "onCurve", [p.id, derived.id])).not.toBeNull();
    expect(canConstrain(s, "origin", [derived.points[0].id])).not.toBeNull();
  });

  it("supports only open-curve midpoint semantics", () => {
    const p = point("p"),
      s = sketch(
        p,
        line("line"),
        arc("arc"),
        circle("circle"),
        curves.spline(),
        shape(
          "ellipse",
          "ellipse",
          [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
          ],
          { ry: 3 },
        ),
      );
    for (const id of ["line", "arc", "curve"])
      expect(canConstrain(s, "midpoint", [id, p.id])).toBeNull();
    for (const id of ["circle", "ellipse"])
      expect(canConstrain(s, "midpoint", [p.id, id])).not.toBeNull();
  });
});

describe("native geometry bindings with real PlaneGCS", () => {
  it.each(["bezier", "spline", "conic"] as const)(
    "follows an explicit %s endpoint by coincidence",
    (kind) => {
      const curve = curves[kind](),
        p = point("p"),
        s = sketch(curve, p);
      constrain(s, "coincident", [p.id, curve.points[0].id]);
      const target = { pointId: curve.points[0].id, x: 8, y: 11, exact: true };
      expect(solveSketch(s, target)).toMatchObject({ ok: true });
      expectXY(curve.points[0], target);
      expectXY(p.points[0], target);
      expect(solveSketch(s, { ...target, x: 12, y: 2 })).toMatchObject({
        ok: true,
      });
      expectXY(p.points[0], { x: 12, y: 2 });
    },
  );

  it("follows a circle center binding when the source center is dragged", () => {
    const curve = circle("circle"),
      p = point("p"),
      s = sketch(curve, p);
    constrain(s, "radius", [curve.id], 5);
    constrain(s, "coincident", [p.id, curve.points[0].id]);
    expect(
      solveSketch(s, { pointId: curve.points[0].id, x: 7, y: -3, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 7, y: -3 });
    expect(curve.radius).toBeCloseTo(5, 6);
  });

  it("solves origin bindings on spline-owned points and rejects exact motion atomically", () => {
    const curve = curves.spline(),
      s = sketch(curve),
      p = curve.points[1];
    constrain(s, "origin", [p.id], undefined, "origin");
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(p, { x: 0, y: 0 });
    const before = structuredClone(s);
    const result = solveSketch(s, { pointId: p.id, x: 2, y: 3, exact: true });
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("origin");
    expect(s).toEqual(before);
  });

  it("does not replace an incompatible fixed anchor with the origin", () => {
    const p = point("p"),
      s = sketch(p);
    constrain(s, "fixed", [p.id]);
    constrain(s, "origin", [p.id], undefined, "origin");
    const before = structuredClone(s),
      result = solveSketch(s);
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("origin");
    expect(s).toEqual(before);
  });

  it("retains the native line midpoint fast path and follows exact endpoint drags", () => {
    const curve = line("line"),
      p = point("p", 5, 0),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.points[0].id]);
    constrain(s, "midpoint", [curve.id, p.id]);
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      expect(solveSketch(s)).toMatchObject({ ok: true });
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    expectXY(p.points[0], { x: 5, y: 0 });
    expect(
      solveSketch(s, { pointId: curve.points[1].id, x: 20, y: 8, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 10, y: 4 });
  });

  it.each(["line", "circle", "arc"] as const)(
    "solves native point-on-%s in either order",
    (kind) => {
      const curve =
          kind === "line"
            ? line("curve")
            : kind === "circle"
              ? circle("curve")
              : arc("curve"),
        p = point("p", 4, 4),
        s = sketch(curve, p);
      constrain(s, "fixed", [curve.id]);
      constrain(s, "onCurve", [curve.id, p.id], undefined, "binding");
      expect(solveSketch(s)).toMatchObject({ ok: true });
      if (kind === "line") expect(p.points[0].y).toBeCloseTo(0, 6);
      else expect(Math.hypot(p.points[0].x, p.points[0].y)).toBeCloseTo(5, 6);
      const desired = kind === "line" ? { x: 8, y: 0 } : { x: 3, y: 4 };
      expect(
        solveSketch(s, { pointId: p.points[0].id, ...desired, exact: true }),
      ).toMatchObject({ ok: true });
      expectXY(p.points[0], desired);
      const before = structuredClone(s);
      const result = solveSketch(s, {
        pointId: p.points[0].id,
        x: 8,
        y: 3,
        exact: true,
      });
      expect(result.ok).toBe(false);
      expect(result.conflicting).toContain("binding");
      expect(s).toEqual(before);
    },
  );

  it.each(["circle", "arc"] as const)(
    "preserves captured %s tangency after radius edits without redundant contact gradients",
    (kind) => {
      const curve = kind === "circle" ? circle("curve") : arc("curve"),
        start = { x: 20, y: 0 },
        contact = tangentPoints(curve, start).find((p) => p.y > 0)!,
        tangent = line("tangent", start, contact),
        s = sketch(curve, tangent);
      constrain(s, "fixed", [curve.points[0].id]);
      constrain(s, "fixed", [tangent.points[0].id]);
      if (kind === "arc") {
        constrain(s, "horizontal", [curve.points[0].id, curve.points[1].id]);
        constrain(s, "vertical", [curve.points[0].id, curve.points[2].id]);
      }
      const radius = constrain(s, "radius", [curve.id], 5);
      constrain(
        s,
        "tangent",
        [curve.id, tangent.id],
        undefined,
        "tangent-binding",
      );
      constrain(
        s,
        "onCurve",
        [curve.id, tangent.points[1].id],
        undefined,
        "contact-binding",
      );
      expect(solveSketch(s)).toMatchObject({ ok: true });
      radius.value = 3;
      expect(solveSketch(s)).toMatchObject({ ok: true });
      const p = tangent.points[1],
        center = curve.points[0];
      expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeCloseTo(3, 6);
      expect(
        (p.x - center.x) * (start.x - p.x) + (p.y - center.y) * (start.y - p.y),
      ).toBeCloseTo(0, 6);
      expect(
        solveSketch(s, { pointId: p.id, x: p.x, y: p.y, exact: true }),
      ).toMatchObject({ ok: true });
      const before = structuredClone(s),
        result = solveSketch(s, { pointId: p.id, x: 3, y: 0, exact: true });
      expect(result.ok).toBe(false);
      expect(result.conflicting).toContain("tangent-binding");
      expect(s).toEqual(before);
      expect(s.entities).toHaveLength(2);
    },
  );

  it("follows a moving circle without turning point-on-curve into a fixed point", () => {
    const curve = circle("curve"),
      p = point("p", 5, 0),
      s = sketch(curve, p);
    constrain(s, "radius", [curve.id], 5);
    constrain(s, "onCurve", [p.id, curve.id]);
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expect(
      solveSketch(s, { pointId: curve.points[0].id, x: 2, y: 3, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(curve.points[0], { x: 2, y: 3 });
    expect(Math.hypot(p.points[0].x - 2, p.points[0].y - 3)).toBeCloseTo(5, 6);
    expect(s.constraints.some((c) => c.kind === "fixed")).toBe(false);
  });

  it.each([true, false])("enforces native arc membership for ccw=%s", (ccw) => {
    const curve = arc("curve", ccw),
      inside = ccw ? { x: 3, y: 4 } : { x: -5, y: 0 },
      outside = ccw ? { x: -5, y: 0 } : { x: 3, y: 4 },
      p = point("p", inside.x, inside.y),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "onCurve", [p.id, curve.id], undefined, "arc-binding");
    expect(solveSketch(s)).toMatchObject({ ok: true });
    const before = structuredClone(s);
    expect(
      solveSketch(s, { pointId: p.points[0].id, ...outside, exact: true }),
    ).toMatchObject({
      ok: false,
      conflicting: ["arc-binding"],
      status: "InvalidBinding",
    });
    expect(s).toEqual(before);
  });

  it("solves native intersections and follows source movement", () => {
    const a = line("a", { x: -10, y: 0 }, { x: 10, y: 0 }),
      b = line("b", { x: 2, y: -10 }, { x: 2, y: 10 }),
      p = point("p", 2, 0),
      s = sketch(a, b, p);
    constrain(s, "fixed", [a.id]);
    constrain(s, "fixed", [b.points[0].id]);
    constrain(s, "intersection", [p.id, a.id, b.id], undefined, "intersection");
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 2, y: 0 });
    expect(
      solveSketch(s, { pointId: b.points[1].id, x: 6, y: 10, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 4, y: 0 });
    expect(
      pointLineDistance(p.points[0], b.points[0], b.points[1]),
    ).toBeCloseTo(0, 6);
  });

  it("solves the nearby native circle intersection and permits exact branch changes", () => {
    const a = line("line", { x: 0, y: -10 }, { x: 0, y: 10 }),
      b = circle("circle"),
      p = point("p", 1, 4),
      s = sketch(a, b, p);
    constrain(s, "fixed", [a.id]);
    constrain(s, "fixed", [b.id]);
    constrain(s, "intersection", [p.id, a.id, b.id]);
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 0, y: 5 });
    expect(
      solveSketch(s, { pointId: p.points[0].id, x: 0, y: -5, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 0, y: -5 });
  });

  it("rejects a native circle-support intersection outside the signed arc", () => {
    const curve = arc("curve"),
      axis = line("axis", { x: -3, y: -10 }, { x: -3, y: 10 }),
      p = point("p", -3, 4),
      s = sketch(curve, axis, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "fixed", [axis.id]);
    constrain(
      s,
      "intersection",
      [p.id, curve.id, axis.id],
      undefined,
      "intersection",
    );
    const before = structuredClone(s);
    expect(solveSketch(s)).toMatchObject({
      ok: false,
      conflicting: ["intersection"],
      status: "InvalidBinding",
    });
    expect(s).toEqual(before);
  });

  it.each(["parallel lines", "disjoint circles"])(
    "reports a missing native intersection for %s atomically",
    (kind) => {
      const a = kind === "parallel lines" ? line("a") : circle("a"),
        b =
          kind === "parallel lines"
            ? line("b", { x: 0, y: 5 }, { x: 10, y: 5 })
            : circle("b"),
        p = point("p"),
        s = sketch(a, b, p);
      if (kind === "disjoint circles") b.points[0].x = 20;
      constrain(s, "fixed", [a.id]);
      constrain(s, "fixed", [b.id]);
      constrain(
        s,
        "intersection",
        [p.id, a.id, b.id],
        undefined,
        "intersection",
      );
      const before = structuredClone(s),
        result = solveSketch(s);
      expect(result.ok).toBe(false);
      expect(result.conflicting).toContain("intersection");
      expect(s).toEqual(before);
    },
  );

  it("rejects an intersection outside the finite native line without capturing anchors", () => {
    const a = line("a", { x: 0, y: 0 }, { x: 1, y: 0 }),
      b = line("b", { x: 2, y: -1 }, { x: 2, y: 1 }),
      p = point("p", 2, 0),
      s = sketch(a, b, p);
    constrain(s, "fixed", [a.id]);
    constrain(s, "fixed", [b.id]);
    constrain(s, "intersection", [p.id, a.id, b.id], undefined, "intersection");
    const before = structuredClone(s);
    expect(solveSketch(s)).toMatchObject({
      ok: false,
      conflicting: ["intersection"],
      status: "InvalidBinding",
    });
    expect(s).toEqual(before);
  });
});

describe("all-fixed positional binding conflicts", () => {
  it.each([
    {
      name: "point coincidence",
      kind: "coincident" as const,
      source: () => point("curve", 0, 0),
    },
    {
      name: "native line midpoint",
      kind: "midpoint" as const,
      source: () => line("curve"),
    },
    {
      name: "computed bezier midpoint",
      kind: "midpoint" as const,
      source: curves.bezier,
    },
    {
      name: "native line incidence",
      kind: "onCurve" as const,
      source: () => line("curve"),
    },
    {
      name: "computed conic incidence",
      kind: "onCurve" as const,
      source: curves.conic,
    },
  ])(
    "reports $name with a useful binding id and no captured anchors",
    ({ kind, source }) => {
      const curve = source(),
        p = point("p", 100, 100),
        s = sketch(curve, p);
      constrain(s, "fixed", [curve.id]);
      constrain(s, "fixed", [p.id]);
      constrain(s, kind, [p.id, curve.id], undefined, "binding");
      const before = structuredClone(s),
        result = solveSketch(s);
      expect(result.ok).toBe(false);
      expect(result.conflicting).toContain("binding");
      expect(s).toEqual(before);
    },
  );
});

describe("computed curve bindings with real PlaneGCS", () => {
  it.each(["bezier", "spline", "conic"] as const)(
    "solves the arc-length midpoint of a fixed %s",
    (kind) => {
      const curve = curves[kind](),
        p = point("p", -2, 8),
        s = sketch(curve, p),
        expected = pathMidpoint(curve)!;
      constrain(s, "fixed", [curve.id]);
      constrain(s, "midpoint", [p.id, curve.id]);
      expect(solveSketch(s)).toMatchObject({ ok: true, dof: 0 });
      expectXY(p.points[0], expected);
      expect(
        s.constraints.filter((c) => c.kind === "fixed").map((c) => c.refs),
      ).toEqual([[curve.id]]);
    },
  );

  it.each([true, false])(
    "uses exact signed arc midpoint semantics for ccw=%s",
    (ccw) => {
      const curve = arc("curve", ccw),
        p = point("p"),
        s = sketch(curve, p),
        expected = pathMidpoint(curve)!;
      constrain(s, "fixed", [curve.id]);
      constrain(s, "midpoint", [curve.id, p.id]);
      expect(solveSketch(s)).toMatchObject({ ok: true });
      expectXY(p.points[0], expected);
      expect(expected.x).toBeCloseTo(((ccw ? 1 : -1) * 5) / Math.sqrt(2), 6);
      expect(expected.y).toBeCloseTo(((ccw ? 1 : -1) * 5) / Math.sqrt(2), 6);
    },
  );

  it.each(["bezier", "spline", "conic"] as const)(
    "follows %s midpoint source controls on later exact drags",
    (kind) => {
      const curve = curves[kind](),
        p = point("p"),
        s = sketch(curve, p),
        moving = curve.points[1];
      for (const control of curve.points.filter(
        (control) => control !== moving,
      ))
        constrain(s, "fixed", [control.id]);
      constrain(s, "midpoint", [p.id, curve.id]);
      expect(solveSketch(s)).toMatchObject({ ok: true });
      const before = { ...p.points[0] },
        target = {
          pointId: moving.id,
          x: moving.x + 4,
          y: moving.y + 7,
          exact: true,
        };
      expect(solveSketch(s, target)).toMatchObject({ ok: true });
      expectXY(moving, target);
      expectXY(p.points[0], pathMidpoint(curve)!);
      expect(
        Math.hypot(p.points[0].x - before.x, p.points[0].y - before.y),
      ).toBeGreaterThan(0.1);
    },
  );

  it("recomputes an arc midpoint when a radius dimension moves its source during solving", () => {
    const curve = arc("curve"),
      p = point("p"),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.points[0].id]);
    constrain(s, "horizontal", [curve.points[0].id, curve.points[1].id]);
    constrain(s, "vertical", [curve.points[0].id, curve.points[2].id]);
    const radius = constrain(s, "radius", [curve.id], 5);
    constrain(s, "midpoint", [p.id, curve.id]);
    expect(solveSketch(s)).toMatchObject({ ok: true });
    radius.value = 10;
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 10 / Math.sqrt(2), y: 10 / Math.sqrt(2) });
    expectXY(p.points[0], pathMidpoint(curve)!);
  });

  it("restores persisted fixed source anchors before evaluating curved midpoints", () => {
    const curve = arc("curve"),
      p = point("p"),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "midpoint", [p.id, curve.id]);
    expect(solveSketch(s)).toMatchObject({ ok: true });
    const expected = { ...p.points[0] },
      anchors = structuredClone(s.constraints[0].anchors);
    curve.points[1].x = 90;
    curve.radius = 99;
    p.points[0].x = -50;
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expect(curve.points[1].x).toBeCloseTo(5, 6);
    expect(curve.radius).toBeCloseTo(5, 6);
    expectXY(p.points[0], expected);
    expect(s.constraints[0].anchors).toEqual(anchors);
  });

  it("does not partially commit source moves or new anchors if a later midpoint re-solve conflicts", () => {
    const curve = arc("curve"),
      midpoint = pathMidpoint(curve)!,
      p = point("p", midpoint.x, midpoint.y),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.points[0].id]);
    constrain(s, "fixed", [p.id]);
    constrain(s, "horizontal", [curve.points[0].id, curve.points[1].id]);
    constrain(s, "vertical", [curve.points[0].id, curve.points[2].id]);
    constrain(s, "radius", [curve.id], 10);
    constrain(s, "midpoint", [p.id, curve.id], undefined, "midpoint");
    const before = structuredClone(s),
      result = solveSketch(s);
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("midpoint");
    expect(s).toEqual(before);
  });

  it("honors exact midpoint drags and reports incompatible ones without modifying geometry", () => {
    const curve = curves.bezier(),
      p = point("p"),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "midpoint", [p.id, curve.id], undefined, "midpoint");
    const desired = pathMidpoint(curve)!;
    expect(
      solveSketch(s, { pointId: p.points[0].id, ...desired, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], desired);
    const before = structuredClone(s),
      result = solveSketch(s, {
        pointId: p.points[0].id,
        x: desired.x + 2,
        y: desired.y,
        exact: true,
      });
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("midpoint");
    expect(s).toEqual(before);
  });

  it.each(["bezier", "spline", "conic", "ellipse"] as const)(
    "uses the Paper nearest point for general %s incidence",
    (kind) => {
      const curve = curves[kind](),
        p = point("p", 7, 12),
        s = sketch(curve, p),
        expected = nearest(curve, p.points[0]);
      constrain(s, "fixed", [curve.id]);
      constrain(s, "onCurve", [curve.id, p.id]);
      expect(solveSketch(s)).toMatchObject({ ok: true, dof: 1 });
      expectXY(p.points[0], expected);
      expectXY(p.points[0], nearest(curve, p.points[0]));
      const desired = { pointId: p.points[0].id, x: 12, y: 7 },
        draggedNearest = nearest(curve, desired);
      expect(solveSketch(s, desired)).toMatchObject({ ok: true, dof: 1 });
      expectXY(p.points[0], draggedNearest);
    },
  );

  it.each(["spline", "bezier"] as const)(
    "keeps the sliding DOF on a fixed %s when a line length changes",
    (kind) => {
      const curve =
          kind === "spline"
            ? shape("curve", "spline", [
                { x: -10, y: 0 },
                { x: 10, y: 0 },
              ])
            : flatBezier(),
        segment = line("line", { x: 5, y: 0 }, { x: 0, y: 5 }),
        s = sketch(curve, segment);
      constrain(s, "fixed", [curve.id]);
      constrain(s, "fixed", [segment.points[1].id]);
      constrain(
        s,
        "onCurve",
        [segment.points[0].id, curve.id],
        undefined,
        "on-curve",
      );
      expect(solveSketch(s)).toMatchObject({ ok: true, dof: 1 });
      const length = constrain(s, "length", [segment.id], Math.sqrt(50));
      expect(solveSketch(s)).toMatchObject({ ok: true, dof: 0 });
      length.value = 10;
      expect(solveSketch(s)).toMatchObject({ ok: true, dof: 0 });
      expectXY(segment.points[0], { x: Math.sqrt(75), y: 0 });
      expectXY(segment.points[1], { x: 0, y: 5 });
      const anchors = s.constraints
        .slice(0, 2)
        .map((c) => structuredClone(c.anchors));
      length.value = 12;
      const before = structuredClone(s);
      expect(solveSketch(s)).toMatchObject({ ok: false });
      expect(s).toEqual(before);
      expect(s.constraints.slice(0, 2).map((c) => c.anchors)).toEqual(anchors);
    },
  );

  it("iterates local incidence when a dimension slides a point along a curved Bezier", () => {
    // This cubic represents y = x² / 10 exactly.
    const curve = shape("curve", "bezier", [
        { x: -10, y: 10 },
        { x: -10 / 3, y: -10 / 3 },
        { x: 10 / 3, y: -10 / 3 },
        { x: 10, y: 10 },
      ]),
      segment = line("line", { x: 5, y: 2.5 }, { x: 0, y: 0 }),
      s = sketch(curve, segment);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "fixed", [segment.points[1].id]);
    constrain(s, "onCurve", [segment.points[0].id, curve.id]);
    const length = constrain(s, "length", [segment.id], Math.hypot(5, 2.5));
    expect(solveSketch(s)).toMatchObject({ ok: true, dof: 0 });
    length.value = 10;
    const result = solveSketch(s);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, dof: 0 });
    const xSquared = 50 * (Math.sqrt(5) - 1);
    expectXY(segment.points[0], {
      x: Math.sqrt(xSquared),
      y: xSquared / 10,
    });
    expectXY(segment.points[0], nearest(curve, segment.points[0]));
    expect(Math.hypot(segment.points[0].x, segment.points[0].y)).toBeCloseTo(
      10,
      7,
    );
  });

  it("rejects exact incidence beyond a general curve endpoint without capturing anchors", () => {
    const curve = flatBezier(),
      p = point("p", 5, 0),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "onCurve", [p.id, curve.id], undefined, "on-curve");
    const before = structuredClone(s),
      result = solveSketch(s, {
        pointId: p.points[0].id,
        x: 12,
        y: 0,
        exact: true,
      });
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("on-curve");
    expect(s).toEqual(before);
  });

  it("honors exact general curve drags and rejects off-curve targets atomically", () => {
    const curve = curves.spline(),
      p = point("p"),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "onCurve", [p.id, curve.id], undefined, "on-curve");
    const desired = onPath(curve);
    expect(
      solveSketch(s, { pointId: p.points[0].id, ...desired, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], desired);
    const before = structuredClone(s),
      result = solveSketch(s, {
        pointId: p.points[0].id,
        x: 7,
        y: 25,
        exact: true,
      });
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("on-curve");
    expect(s).toEqual(before);
  });

  it("ignores soft drags of a fixed general-curve target without overwriting its anchor", () => {
    const curve = curves.bezier(),
      initial = onPath(curve),
      p = point("p", initial.x, initial.y),
      s = sketch(curve, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "fixed", [p.id]);
    constrain(s, "onCurve", [p.id, curve.id]);
    expect(solveSketch(s)).toMatchObject({ ok: true });
    const anchors = structuredClone(s.constraints[1].anchors);
    expect(
      solveSketch(s, { pointId: p.points[0].id, x: 30, y: 20 }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], initial);
    expect(s.constraints[1].anchors).toEqual(anchors);
  });

  it("follows general incidence after exact source-control movement", () => {
    const curve = curves.bezier(),
      p = point("p", 7, 12),
      s = sketch(curve, p),
      moving = curve.points[1];
    for (const control of curve.points.filter((control) => control !== moving))
      constrain(s, "fixed", [control.id]);
    constrain(s, "onCurve", [p.id, curve.id]);
    expect(solveSketch(s)).toMatchObject({ ok: true });
    const before = { ...p.points[0] };
    expect(
      solveSketch(s, { pointId: moving.id, x: 9, y: 18, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], nearest(curve, p.points[0]));
    expect(
      Math.hypot(p.points[0].x - before.x, p.points[0].y - before.y),
    ).toBeGreaterThan(0.1);
  });

  it.each([
    { kind: "circle" as const, ccw: true, storedRadius: true },
    { kind: "arc" as const, ccw: true, storedRadius: true },
    { kind: "arc" as const, ccw: false, storedRadius: true },
    { kind: "arc" as const, ccw: true, storedRadius: false },
  ])(
    "refines mixed $kind intersections to its exact radius and signed bounds (ccw=$ccw, storedRadius=$storedRadius)",
    ({ kind, ccw, storedRadius }) => {
      const curve =
          kind === "circle"
            ? shape("round", "circle", [{ x: 0, y: 0 }], { radius: 1000 })
            : shape(
                "round",
                "arc",
                [
                  { x: 0, y: 0 },
                  { x: 1000, y: 0 },
                  { x: 0, y: 1000 },
                ],
                { radius: storedRadius ? 1000 : undefined, ccw },
              ),
        general = shape("curve", "spline", [
          { x: -2000, y: 500 },
          { x: 2000, y: 500 },
        ]),
        sign = ccw ? 1 : -1,
        p = point("p", sign * 900, 500),
        s = sketch(curve, general, p),
        paperSeed = intersections(curve, general).find(
          (hit) => sign * hit.x > 0,
        )!;
      expect(
        Math.abs(Math.hypot(paperSeed.x, paperSeed.y) - 1000),
      ).toBeGreaterThan(0.01);
      constrain(s, "fixed", [curve.id]);
      constrain(s, "fixed", [general.id]);
      constrain(
        s,
        "intersection",
        [
          p.id,
          ...(kind === "circle"
            ? [curve.id, general.id]
            : [general.id, curve.id]),
        ],
        undefined,
        "intersection",
      );
      expect(solveSketch(s)).toMatchObject({ ok: true, dof: 0 });
      const desired = { x: sign * Math.sqrt(750000), y: 500 };
      expectXY(p.points[0], desired);
      expect(
        Math.abs(Math.hypot(p.points[0].x, p.points[0].y) - 1000),
      ).toBeLessThan(1e-7);
      expectXY(p.points[0], nearest(general, p.points[0]));
      expect(
        solveSketch(s, { pointId: p.points[0].id, ...desired, exact: true }),
      ).toMatchObject({ ok: true });
      const before = structuredClone(s),
        result = solveSketch(s, {
          pointId: p.points[0].id,
          ...paperSeed,
          exact: true,
        });
      expect(result.ok).toBe(false);
      expect(result.conflicting).toContain("intersection");
      expect(s).toEqual(before);
      if (kind === "arc") {
        const outside = solveSketch(s, {
          pointId: p.points[0].id,
          x: -desired.x,
          y: desired.y,
          exact: true,
        });
        expect(outside.ok).toBe(false);
        expect(outside.conflicting).toContain("intersection");
        expect(s).toEqual(before);
      }
    },
  );

  it("rejects a fixed mixed-intersection target at the approximate Paper seed without capturing anchors", () => {
    const curve = shape("round", "circle", [{ x: 0, y: 0 }], { radius: 1000 }),
      general = shape("curve", "spline", [
        { x: -2000, y: 500 },
        { x: 2000, y: 500 },
      ]),
      seed = intersections(curve, general).find((p) => p.x > 0)!,
      p = point("p", seed.x, seed.y),
      s = sketch(curve, general, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "fixed", [general.id]);
    constrain(s, "fixed", [p.id]);
    constrain(
      s,
      "intersection",
      [p.id, curve.id, general.id],
      undefined,
      "intersection",
    );
    const before = structuredClone(s),
      result = solveSketch(s);
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("intersection");
    expect(s).toEqual(before);
  });

  it.each(["outside the circle", "beyond the general curve endpoint"])(
    "rejects approximation-only mixed intersections %s atomically",
    (reason) => {
      const curve = shape("round", "circle", [{ x: 0, y: 0 }], {
          radius: 1000,
        }),
        angle = Math.PI / 8,
        normal = { x: Math.cos(angle), y: Math.sin(angle) },
        tangent = { x: -normal.y, y: normal.x },
        coords =
          reason === "outside the circle"
            ? [-2000, 2000].map((offset) => ({
                x: normal.x * 1000.1 + tangent.x * offset,
                y: normal.y * 1000.1 + tangent.y * offset,
              }))
            : [
                { x: Math.sqrt(750000) + 0.05, y: 500 },
                { x: 2000, y: 500 },
              ],
        general = shape("curve", "spline", coords),
        p = point("p", 900, 500),
        s = sketch(curve, general, p);
      expect(intersections(curve, general).length).toBeGreaterThan(0);
      constrain(s, "fixed", [curve.id]);
      constrain(s, "fixed", [general.id]);
      constrain(
        s,
        "intersection",
        [p.id, curve.id, general.id],
        undefined,
        "intersection",
      );
      const before = structuredClone(s);
      expect(solveSketch(s)).toMatchObject({
        ok: false,
        conflicting: ["intersection"],
        status: "InvalidBinding",
      });
      expect(s).toEqual(before);
    },
  );

  it("recomputes exact mixed circle intersections after a native radius edit", () => {
    const curve = shape("round", "circle", [{ x: 0, y: 0 }], { radius: 1000 }),
      general = shape("curve", "spline", [
        { x: -2000, y: 500 },
        { x: 2000, y: 500 },
      ]),
      p = point("p", 900, 500),
      s = sketch(curve, general, p);
    constrain(s, "fixed", [curve.points[0].id]);
    constrain(s, "fixed", [general.id]);
    const radius = constrain(s, "radius", [curve.id], 1000);
    constrain(
      s,
      "intersection",
      [p.id, curve.id, general.id],
      undefined,
      "intersection",
    );
    expect(solveSketch(s)).toMatchObject({ ok: true });
    radius.value = 1500;
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: Math.sqrt(2000000), y: 500 });
    expect(
      Math.abs(Math.hypot(p.points[0].x, p.points[0].y) - 1500),
    ).toBeLessThan(1e-7);
    radius.value = 400;
    const before = structuredClone(s);
    expect(solveSketch(s)).toMatchObject({
      ok: false,
      conflicting: ["intersection"],
      status: "InvalidBinding",
    });
    expect(s).toEqual(before);
  });

  it("re-solves a mixed intersection when native source dimensions move during solving", () => {
    const a = flatBezier(),
      b = line("line", { x: 2, y: -10 }, { x: 2, y: 10 }),
      p = point("p"),
      s = sketch(a, b, p);
    constrain(s, "fixed", [a.id]);
    constrain(s, "fixed", [b.points[0].id]);
    const dx = constrain(s, "distanceX", [b.id], 0);
    constrain(s, "distanceY", [b.id], 20);
    constrain(s, "intersection", [p.id, a.id, b.id]);
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 2, y: 0 });
    dx.value = 4;
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(b.points[1], { x: 6, y: 10 });
    expectXY(p.points[0], { x: 4, y: 0 });
    expectXY(p.points[0], intersections(a, b)[0]);
  });

  it("keeps the nearby general intersection branch and allows an exact branch change", () => {
    const curve = curves.ellipse(),
      axis = line("axis", { x: 0, y: -10 }, { x: 0, y: 10 }),
      p = point("p", 0, -3),
      s = sketch(curve, axis, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "fixed", [axis.id]);
    constrain(
      s,
      "intersection",
      [p.id, curve.id, axis.id],
      undefined,
      "intersection",
    );
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 0, y: -4 });
    expect(
      solveSketch(s, { pointId: p.points[0].id, x: 0, y: 4, exact: true }),
    ).toMatchObject({ ok: true });
    expectXY(p.points[0], { x: 0, y: 4 });
    const before = structuredClone(s),
      result = solveSketch(s, {
        pointId: p.points[0].id,
        x: 0,
        y: 2,
        exact: true,
      });
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain("intersection");
    expect(s).toEqual(before);
  });

  it("returns the binding id when a general intersection disappears during a native source solve", () => {
    const curve = flatBezier(),
      source = line("line", { x: -2, y: -1 }, { x: 2, y: 1 }),
      p = point("p", 0, 0),
      s = sketch(curve, source, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "fixed", [source.points[0].id]);
    constrain(s, "distanceX", [source.id], 4);
    const dy = constrain(s, "distanceY", [source.id], 2);
    constrain(
      s,
      "intersection",
      [p.id, curve.id, source.id],
      undefined,
      "intersection",
    );
    expect(solveSketch(s)).toMatchObject({ ok: true });
    dy.value = -2;
    const before = structuredClone(s),
      result = solveSketch(s);
    expect(result).toMatchObject({
      ok: false,
      conflicting: ["intersection"],
      status: "InvalidBinding",
    });
    expect(result.message).toMatch(/intersection/i);
    expect(s).toEqual(before);
  });

  it("does not capture fixed anchors or modify anything for an initially missing intersection", () => {
    const curve = flatBezier(),
      source = line("line", { x: -5, y: 5 }, { x: 5, y: 5 }),
      p = point("p"),
      s = sketch(curve, source, p);
    constrain(s, "fixed", [curve.id]);
    constrain(s, "fixed", [source.id]);
    constrain(
      s,
      "intersection",
      [p.id, curve.id, source.id],
      undefined,
      "intersection",
    );
    const before = structuredClone(s);
    expect(solveSketch(s)).toMatchObject({
      ok: false,
      conflicting: ["intersection"],
      status: "InvalidBinding",
    });
    expect(s).toEqual(before);
  });

  it("bounds cyclic computed midpoint solves and leaves points and anchors untouched", () => {
    const curve = shape("curve", "spline", [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
      s = sketch(curve);
    constrain(s, "fixed", [curve.points[1].id]);
    constrain(
      s,
      "midpoint",
      [curve.points[0].id, curve.id],
      undefined,
      "midpoint",
    );
    const before = structuredClone(s);
    expect(solveSketch(s)).toMatchObject({
      ok: false,
      conflicting: ["midpoint"],
      status: "BindingNotConverged",
    });
    expect(s).toEqual(before);
  });
});
