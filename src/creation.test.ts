import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  createGeometry,
  appendGeometry,
  defaultConfig,
  toolLabels,
  type Tool,
} from "./creation";
import { initSolver, solveSketch, canConstrain } from "./solver";
import {
  arcInfo,
  dist,
  sampleEntity,
  validGeometry,
  bezierAt,
  conicAt,
  dot,
  sub,
  EPS,
} from "./geometry";
import { entity, type Sketch, type XY, type Entity } from "./model";
import { tangentPoints } from "./snapping";
const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);
const inputs: Record<Tool, XY[]> = {
  select: [],
  line: [
    { x: 0, y: 0 },
    { x: 25, y: 7 },
  ],
  midline: [
    { x: 10, y: 8 },
    { x: 30, y: 15 },
  ],
  rectangle: [
    { x: 2, y: 3 },
    { x: 35, y: 25 },
  ],
  centerRectangle: [
    { x: 3, y: 4 },
    { x: 25, y: 17 },
  ],
  circle: [
    { x: 3, y: 4 },
    { x: 18, y: 9 },
  ],
  threeCircle: [
    { x: 10, y: 0 },
    { x: 0, y: 10 },
    { x: -10, y: 0 },
  ],
  arc: [
    { x: 10, y: 0 },
    { x: 0, y: 10 },
    { x: -10, y: 0 },
  ],
  centerArc: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 12 },
  ],
  polygon: [
    { x: 3, y: 4 },
    { x: 20, y: 9 },
  ],
  ellipse: [
    { x: 3, y: 4 },
    { x: 20, y: 9 },
    { x: 0, y: 16 },
  ],
  slot: [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 20, y: 5 },
  ],
  arcSlot: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 0, y: 20 },
    { x: 24, y: 0 },
  ],
  spline: [
    { x: 0, y: 0 },
    { x: 10, y: 14 },
    { x: 20, y: -4 },
    { x: 30, y: 7 },
  ],
  bezier: [
    { x: 0, y: 0 },
    { x: 4, y: 18 },
    { x: 23, y: -12 },
    { x: 30, y: 5 },
  ],
  conic: [
    { x: 0, y: 0 },
    { x: 10, y: 20 },
    { x: 30, y: 5 },
  ],
  point: [{ x: 4, y: 8 }],
  text: [{ x: 4, y: 8 }],
};
function make(
  tool: Tool,
  ps = inputs[tool],
  config = { ...defaultConfig },
): Sketch {
  const created = createGeometry(tool, ps, config);
  return { id: "s", name: "test", visible: true, ...created };
}
function unchanged(before: Entity[], after: Entity[]) {
  expect(after.length).toBe(before.length);
  after.forEach((e, i) => {
    expect(e.kind).toBe(before[i].kind);
    e.points.forEach((p, j) =>
      expect(dist(p, before[i].points[j])).toBeLessThan(1e-6),
    );
    if (e.radius !== undefined && before[i].radius !== undefined)
      expect(e.radius).toBeCloseTo(before[i].radius!, 6);
    expect(e.ccw).toBe(before[i].ccw);
  });
}
function solve(s: Sketch) {
  for (const c of s.constraints)
    expect(canConstrain(s, c.kind, c.refs), c.kind).toBeNull();
  const result = solveSketch(s);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  validGeometry(s);
  return result;
}
function midpoint(e: Entity): XY {
  const { c, r, start, sweep } = arcInfo(e),
    a = start + sweep / 2;
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

describe("captured-coordinate creation", () => {
  const nearAxes = [
    { axis: "horizontal", start: { x: 3, y: 4 }, end: { x: 1003, y: 14 } },
    { axis: "vertical", start: { x: 3, y: 4 }, end: { x: 13, y: 1004 } },
  ] as const;
  it.each(nearAxes)(
    "preserves a captured near-$axis line without an incompatible axis constraint",
    ({ start, end }) => {
      const s = make("line", [start, end], {
          ...defaultConfig,
          autoConstraint: true,
          preserveCapturedCoordinates: true,
        }),
        before = structuredClone(s.entities);
      expect(s.constraints).toEqual([]);
      solve(s);
      unchanged(before, s.entities);
      expect(dist(s.entities[0].points[1], end)).toBeLessThan(EPS);
    },
  );
  it.each([
    { axis: "horizontal", end: { x: 1000, y: 0 } },
    { axis: "vertical", end: { x: 0, y: 1000 } },
    { axis: "horizontal", end: { x: 1000, y: EPS } },
    { axis: "vertical", end: { x: EPS, y: 1000 } },
  ] as const)(
    "still infers an already compatible $axis line ($end.x, $end.y)",
    ({ axis, end }) => {
      const s = make("line", [{ x: 0, y: 0 }, end], {
        ...defaultConfig,
        autoConstraint: true,
        preserveCapturedCoordinates: true,
      });
      expect(s.constraints).toMatchObject([
        { kind: axis, refs: [s.entities[0].id] },
      ]);
    },
  );
  it.each(nearAxes)(
    "keeps the default near-$axis inference for uncaptured lines",
    ({ axis, start, end }) => {
      for (const config of [
        { ...defaultConfig },
        { ...defaultConfig, preserveCapturedCoordinates: false },
      ]) {
        const s = make("line", [start, end], config);
        expect(s.constraints).toMatchObject([
          { kind: axis, refs: [s.entities[0].id] },
        ]);
        solve(s);
      }
    },
  );
  it("does not infer exact axes when automatic constraints are disabled", () => {
    const s = make(
      "line",
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      {
        ...defaultConfig,
        autoConstraint: false,
        preserveCapturedCoordinates: true,
      },
    );
    expect(s.constraints).toEqual([]);
  });
  it.each(nearAxes)(
    "retains the midpoint rule for a captured near-$axis midline",
    ({ start, end }) => {
      const s = make("midline", [start, end], {
          ...defaultConfig,
          preserveCapturedCoordinates: true,
        }),
        before = structuredClone(s.entities),
        [line, midpoint] = s.entities;
      expect(s.constraints).toMatchObject([
        { kind: "midpoint", refs: [midpoint.points[0].id, line.id] },
      ]);
      solve(s);
      unchanged(before, s.entities);
      expect(dist(midpoint.points[0], start)).toBeLessThan(EPS);
      expect(dist(line.points[1], end)).toBeLessThan(EPS);
    },
  );
  it.each(["rectangle", "centerRectangle"] as const)(
    "leaves %s direction rules unchanged",
    (tool) => {
      const s = make(tool, inputs[tool], {
        ...defaultConfig,
        preserveCapturedCoordinates: true,
      });
      expect(
        s.constraints.filter((constraint) => constraint.kind === "horizontal"),
      ).toHaveLength(2);
      expect(
        s.constraints.filter((constraint) => constraint.kind === "vertical"),
      ).toHaveLength(2);
      expect(
        s.constraints.filter((constraint) => constraint.kind === "coincident"),
      ).toHaveLength(4);
      solve(s);
    },
  );
  it("preserves a captured tangent endpoint through real PlaneGCS solving", () => {
    const center = { x: 0, y: 0 },
      circle = entity("circle", [center], { radius: 10 }),
      start = { x: -1000, y: 20 },
      captured = tangentPoints(circle, start).find((point) => point.y > 0)!,
      s = make("line", [start, captured], {
        ...defaultConfig,
        autoConstraint: true,
        preserveCapturedCoordinates: true,
      }),
      line = s.entities[0];
    expect(Math.abs(captured.y - start.y)).toBeLessThan(
      Math.abs(captured.x - start.x) * 0.015,
    );
    expect(s.constraints).toEqual([]);
    s.entities.unshift(circle);
    s.constraints.push(
      { id: "fixed-start", kind: "fixed", refs: [line.points[0].id] },
      { id: "fixed-circle", kind: "fixed", refs: [circle.id] },
    );
    solve(s);
    expect(dist(line.points[0], start)).toBeLessThan(EPS);
    expect(dist(line.points[1], captured)).toBeLessThan(EPS);
    expect(dist(line.points[1], circle.points[0])).toBeCloseTo(10, 8);
    expect(
      dot(
        sub(line.points[1], circle.points[0]),
        sub(line.points[0], line.points[1]),
      ),
    ).toBeCloseTo(0, 8);
  });
  it.each([true, false])(
    "keeps real-reference coincidence independent of preservation (auto=%s)",
    (autoConstraint) => {
      const target = entity("point", [{ x: 1000, y: 10 }]),
        config = {
          ...defaultConfig,
          autoConstraint,
          preserveCapturedCoordinates: true,
        },
        created = createGeometry(
          "line",
          [{ x: 0, y: 0 }, target.points[0]],
          config,
        ),
        s: Sketch = {
          id: "s",
          name: "test",
          visible: true,
          entities: [target],
          constraints: [],
        };
      appendGeometry(
        s,
        created,
        [{ pointIndex: 1, ref: target.points[0].id }],
        config.autoConstraint,
      );
      expect(s.constraints.map((constraint) => constraint.kind)).toEqual(
        autoConstraint ? ["coincident"] : [],
      );
      expect(defaultConfig).not.toHaveProperty("preserveCapturedCoordinates");
      for (const value of [...s.entities, ...s.constraints])
        expect(value).not.toHaveProperty("preserveCapturedCoordinates");
      solve(s);
    },
  );
});

describe("creation tools with real WASM", () => {
  it.each(Object.keys(toolLabels) as Tool[])(
    "%s constructs and solves without distortion",
    (tool) => {
      const s = make(tool),
        before = structuredClone(s.entities);
      solve(s);
      unchanged(before, s.entities);
    },
  );
  it("midline midpoint is exactly the first click", () => {
    const s = make("midline");
    solve(s);
    const [l, p] = s.entities;
    expect(dist(p.points[0], inputs.midline[0])).toBeLessThan(1e-7);
    expect(
      dist(p.points[0], {
        x: (l.points[0].x + l.points[1].x) / 2,
        y: (l.points[0].y + l.points[1].y) / 2,
      }),
    ).toBeLessThan(1e-7);
  });
  it.each([3, 5, 8])(
    "polygon with %i sides stays regular and closed",
    (sides) => {
      const s = make("polygon", inputs.polygon, { ...defaultConfig, sides }),
        before = structuredClone(s.entities);
      solve(s);
      unchanged(before, s.entities);
      const length = dist(s.entities[0].points[0], s.entities[0].points[1]);
      s.entities.forEach((e, i) => {
        expect(dist(e.points[0], e.points[1])).toBeCloseTo(length, 6);
        expect(
          dist(e.points[1], s.entities[(i + 1) % sides].points[0]),
        ).toBeLessThan(1e-7);
      });
    },
  );
  it("outer polygon matches the requested apothem", () => {
    const s = make("polygon", inputs.polygon, {
      ...defaultConfig,
      sides: 6,
      polygonOuter: true,
    });
    solve(s);
    expect(
      dist(s.entities[0].points[0], inputs.polygon[0]) * Math.cos(Math.PI / 6),
    ).toBeCloseTo(dist(...(inputs.polygon as [XY, XY])), 6);
  });
  it.each([true, false])(
    "three-point arc uses the correct %s orientation and passes through its middle click",
    (ccw) => {
      const ps = ccw
          ? inputs.arc
          : [
              { x: 10, y: 0 },
              { x: 0, y: -10 },
              { x: -10, y: 0 },
            ],
        s = make("arc", ps);
      solve(s);
      const a = s.entities[0];
      expect(a.ccw).toBe(ccw);
      expect(Math.sign(arcInfo(a).sweep)).toBe(ccw ? 1 : -1);
      expect(dist(midpoint(a), ps[1])).toBeLessThan(1e-6);
    },
  );
  it("slot caps face outward and every join remains coincident", () => {
    const s = make("slot");
    solve(s);
    const [l1, cap1, l2, cap2] = s.entities;
    expect(midpoint(cap1).x).toBeCloseTo(35, 6);
    expect(midpoint(cap2).x).toBeCloseTo(-5, 6);
    for (const [a, b] of [
      [l1.points[1], cap1.points[2]],
      [l2.points[0], cap1.points[1]],
      [l1.points[0], cap2.points[1]],
      [l2.points[1], cap2.points[2]],
    ])
      expect(dist(a, b)).toBeLessThan(1e-7);
    expect(arcInfo(cap1).sweep).toBeCloseTo(Math.PI, 6);
    expect(arcInfo(cap2).sweep).toBeCloseTo(Math.PI, 6);
  });
  it("rotated slot keeps cap radii and outward bulges", () => {
    const ps = [
        { x: 3, y: 4 },
        { x: 23, y: 24 },
        { x: 9, y: 24 },
      ],
      s = make("slot", ps),
      before = structuredClone(s.entities);
    solve(s);
    unchanged(before, s.entities);
    const [, end, , start] = s.entities,
      dir = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    for (const [cap, sign] of [
      [end, 1],
      [start, -1],
    ] as const) {
      const m = midpoint(cap),
        c = cap.points[0];
      expect((m.x - c.x) * dir.x + (m.y - c.y) * dir.y).toBeCloseTo(
        sign * cap.radius!,
        6,
      );
    }
  });
  it("arc slot has an outward start cap, correct inner sweep and closed seams", () => {
    const s = make("arcSlot");
    solve(s);
    const [outer, inner, start, end] = s.entities;
    expect(arcInfo(outer).r).toBeCloseTo(24, 6);
    expect(arcInfo(inner).r).toBeCloseTo(16, 6);
    expect(arcInfo(inner).sweep).toBeCloseTo(-Math.PI / 2, 6);
    expect(midpoint(start).y).toBeCloseTo(-4, 6);
    expect(midpoint(end).x).toBeCloseTo(-4, 6);
    for (const [a, b] of [
      [outer.points[1], start.points[2]],
      [inner.points[2], start.points[1]],
      [outer.points[2], end.points[1]],
      [inner.points[1], end.points[2]],
    ])
      expect(dist(a, b)).toBeLessThan(1e-7);
    expect(s.constraints.filter((c) => c.kind === "coincident")).toHaveLength(
      4,
    );
    expect(s.constraints.filter((c) => c.kind === "equal")).toHaveLength(1);
  });
  it.each(["spline", "bezier", "conic"] as const)(
    "%s retains genuine curviness after solve",
    (tool) => {
      const s = make(tool);
      solve(s);
      const e = s.entities[0],
        samples = sampleEntity(e, 0.01);
      expect(samples.length).toBeGreaterThan(5);
      const [a, b] = [samples[0], samples[samples.length - 1]],
        den = dist(a, b);
      expect(
        Math.max(
          ...samples.map(
            (p) =>
              Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) /
              den,
          ),
        ),
      ).toBeGreaterThan(3);
      if (tool === "bezier")
        expect(dist(bezierAt(e.points, 0.5), samples[0])).toBeGreaterThan(5);
      if (tool === "conic")
        expect(dist(conicAt(e, 0.5), samples[0])).toBeGreaterThan(5);
    },
  );
  it.each([
    "rectangle",
    "centerRectangle",
    "polygon",
    "slot",
    "arcSlot",
  ] as const)(
    "%s constraints permit creation with auto snapping disabled",
    (tool) => {
      const s = make(tool, inputs[tool], {
        ...defaultConfig,
        autoConstraint: false,
        construction: true,
      });
      solve(s);
      expect(s.entities.every((e) => e.construction)).toBe(true);
    },
  );
});
