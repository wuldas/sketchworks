import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  createGeometry,
  appendGeometry,
  creationInputPoints,
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
  add,
  mul,
  cross,
  normalize,
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
  threeRectangle: [
    { x: 3, y: 4 },
    { x: 31, y: 13 },
    { x: 12, y: 27 },
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
  it("inscribed polygon puts the sizing pick at the edge-0 midpoint", () => {
    const [center, pick] = inputs.polygon,
      s = make("polygon", inputs.polygon, {
        ...defaultConfig,
        sides: 6,
        polygonOuter: true,
      }),
      before = structuredClone(s.entities);
    solve(s);
    unchanged(before, s.entities);
    const edge = s.entities[0],
      mid = {
        x: (edge.points[0].x + edge.points[1].x) / 2,
        y: (edge.points[0].y + edge.points[1].y) / 2,
      };
    expect(dist(mid, pick)).toBeLessThan(1e-7);
    expect(dist(edge.points[0], pick)).toBeGreaterThan(1e-3);
    for (const e of s.entities)
      expect(dist(e.points[0], center)).toBeCloseTo(
        dist(center, pick) / Math.cos(Math.PI / 6),
        6,
      );
  });
  it("circumscribed polygon keeps the sizing pick on the circumcircle as vertex zero", () => {
    const [, pick] = inputs.polygon,
      s = make("polygon", inputs.polygon, {
        ...defaultConfig,
        sides: 6,
        polygonOuter: false,
      });
    solve(s);
    expect(dist(s.entities[0].points[0], pick)).toBeLessThan(1e-7);
    expect(dist(s.entities[0].points[0], s.entities[0].points[1])).toBeCloseTo(
      dist(s.entities[1].points[0], s.entities[1].points[1]),
      6,
    );
  });
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
  it("three-point rectangle builds vertices from the signed normal offset", () => {
    const [a, b, c] = inputs.threeRectangle,
      s = make("threeRectangle"),
      before = structuredClone(s.entities),
      d = sub(b, a),
      base = Math.hypot(d.x, d.y),
      n = { x: -d.y / base, y: d.x / base },
      h = dot(sub(c, a), n);
    expect(h).toBeGreaterThan(0);
    solve(s);
    unchanged(before, s.entities);
    const [l0, l1, l2, l3] = s.entities,
      [v0, v1, v2, v3] = [l0, l1, l2, l3].map((e) => e.points[0]),
      expected = [a, b, add(b, mul(n, h)), add(a, mul(n, h))];
    [v0, v1, v2, v3].forEach((v, i) =>
      expect(dist(v, expected[i])).toBeLessThan(1e-7),
    );
    expect(Math.abs(dot(sub(v1, v0), sub(v2, v1)))).toBeLessThan(1e-9);
    expect(dist(l3.points[1], v0)).toBeLessThan(1e-7);
    expect(s.constraints.filter((c) => c.kind === "coincident")).toHaveLength(
      4,
    );
    expect(s.constraints.filter((c) => c.kind === "parallel")).toHaveLength(2);
    expect(
      s.constraints.filter((c) => c.kind === "perpendicular"),
    ).toHaveLength(1);
    expect(
      s.constraints.some(
        (c) => c.kind === "horizontal" || c.kind === "vertical",
      ),
    ).toBe(false);
  });
  it("three-point rectangle keeps a negative height on the other baseline side", () => {
    const a = { x: 3, y: 4 },
      b = { x: 31, y: 13 },
      ps = [a, b, { x: 12, y: -19 }],
      s = make("threeRectangle", ps),
      before = structuredClone(s.entities),
      d = sub(b, a),
      base = Math.hypot(d.x, d.y),
      n = { x: -d.y / base, y: d.x / base },
      h = dot(sub(ps[2], a), n);
    expect(h).toBeLessThan(0);
    solve(s);
    unchanged(before, s.entities);
    const [, , l2, l3] = s.entities;
    expect(dist(l2.points[0], add(b, mul(n, h)))).toBeLessThan(1e-7);
    expect(dist(l2.points[1], add(a, mul(n, h)))).toBeLessThan(1e-7);
    expect(Math.abs(dot(sub(l2.points[1], a), d) / base)).toBeLessThan(1e-9);
  });
  it("rejects a degenerate three-point rectangle baseline or height", () => {
    expect(() =>
      createGeometry(
        "threeRectangle",
        [
          { x: 3, y: 4 },
          { x: 3, y: 4 },
          { x: 12, y: 27 },
        ],
        { ...defaultConfig },
      ),
    ).toThrow("矩形基线长度不能为零");
    expect(() =>
      createGeometry(
        "threeRectangle",
        [
          { x: 3, y: 4 },
          { x: 31, y: 13 },
          { x: 17, y: 8.5 },
        ],
        { ...defaultConfig },
      ),
    ).toThrow("矩形高度不能为零");
  });
  it("three-point rectangle stays rectangular after dragging an opposite corner", () => {
    const s = make("threeRectangle"),
      [a, b] = inputs.threeRectangle;
    solve(s);
    const [l0, l1, l2, l3] = s.entities;
    s.constraints.push({
      id: "fix-a",
      kind: "fixed",
      refs: [l0.points[0].id],
    });
    const dragged = solveSketch(s, {
      pointId: l2.points[0].id,
      x: b.x - 4,
      y: l2.points[0].y + 6,
      exact: true,
    });
    expect(dragged.ok, JSON.stringify(dragged)).toBe(true);
    validGeometry(s);
    const [v0, v1, v2, v3] = [l0, l1, l2, l3].map((e) => e.points[0]);
    expect(dist(l0.points[1], l1.points[0])).toBeLessThan(1e-7);
    expect(dist(l1.points[1], l2.points[0])).toBeLessThan(1e-7);
    expect(dist(l2.points[1], l3.points[0])).toBeLessThan(1e-7);
    expect(dist(l3.points[1], l0.points[0])).toBeLessThan(1e-7);
    expect(Math.abs(dot(sub(v1, v0), sub(v2, v1)))).toBeLessThan(1e-6);
    expect(Math.abs(cross(sub(v1, v0), sub(v3, v2)))).toBeLessThan(1e-6);
    expect(Math.abs(cross(sub(v2, v1), sub(v0, v3)))).toBeLessThan(1e-6);
    expect(dist(v0, a)).toBeLessThan(1e-9);
    const d = sub(v1, v0),
      base = Math.hypot(d.x, d.y),
      n = { x: -d.y / base, y: d.x / base };
    expect(dist(v3, add(v0, mul(n, dot(sub(v2, v0), n))))).toBeLessThan(1e-6);
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
    "threeRectangle",
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

describe("creation angle contract", () => {
  const angled = (angle: number) => ({ ...defaultConfig, angle });

  it("is idempotent when handed already transformed picks", () => {
    const once = creationInputPoints("polygon", inputs.polygon, angled(125));
    const fromRaw = make("polygon", inputs.polygon, angled(125)),
      fromMoved = make("polygon", once, angled(125));
    fromMoved.entities.forEach((e, i) =>
      e.points.forEach((p, j) =>
        expect(dist(p, fromRaw.entities[i].points[j])).toBeLessThan(1e-9),
      ),
    );
  });

  it.each([-340, 380, -700, 740] as const)(
    "wraps %i° onto the same 20° orientation",
    (angle) => {
      const base = make("polygon", inputs.polygon, angled(20)),
        wrapped = make("polygon", inputs.polygon, angled(angle));
      wrapped.entities.forEach((e, i) =>
        e.points.forEach((p, j) => {
          expect(dist(p, base.entities[i].points[j])).toBeLessThan(1e-9);
        }),
      );
    },
  );

  it.each([30, -150, 405] as const)(
    "center rectangle solves at %i° with the exact picked corner",
    (angle) => {
      const [a, b] = inputs.centerRectangle,
        theta = (angle * Math.PI) / 180,
        u = { x: Math.cos(theta), y: Math.sin(theta) },
        w = { x: -u.y, y: u.x },
        s = make("centerRectangle", inputs.centerRectangle, angled(angle));
      const before = structuredClone(s.entities);
      solve(s);
      unchanged(before, s.entities);
      const corners = s.entities.map((e) => e.points[0]);
      expect(dist(s.entities[2].points[0], b)).toBeLessThan(1e-7);
      for (const [p, q] of [
        [0, 2],
        [1, 3],
      ] as const)
        expect(dist(mul(add(corners[p], corners[q]), 0.5), a)).toBeLessThan(
          1e-7,
        );
      for (let i = 0; i < 4; i++) {
        const edge = sub(corners[(i + 1) % 4], corners[i]),
          axis = i % 2 ? w : u;
        expect(Math.abs(cross(edge, axis))).toBeLessThan(1e-7);
      }
    },
  );

  it.each([NaN, Infinity] as const)(
    "createGeometry throws on a non-finite %p angle instead of assuming auto",
    (angle) => {
      expect(() =>
        createGeometry("centerRectangle", inputs.centerRectangle, {
          ...defaultConfig,
          angle,
        }),
      ).toThrow(Error);
      expect(() =>
        createGeometry("polygon", inputs.polygon, { ...defaultConfig, angle }),
      ).toThrow(Error);
      expect(() =>
        createGeometry("line", inputs.line, { ...defaultConfig, angle }),
      ).toThrow(Error);
    },
  );

  it.each([
    { mode: "inscribed", outer: false },
    { mode: "circumscribed", outer: true },
  ] as const)(
    "angled $mode polygon keeps its radius rule and orientation",
    ({ outer }) => {
      const [center, pick] = inputs.polygon,
        sides = 5,
        angle = 210,
        theta = (angle * Math.PI) / 180 - (outer ? Math.PI / sides : 0),
        r = dist(center, pick) / (outer ? Math.cos(Math.PI / sides) : 1),
        s = make("polygon", inputs.polygon, {
          ...defaultConfig,
          sides,
          polygonOuter: outer,
          angle,
        }),
        before = structuredClone(s.entities);
      solve(s);
      unchanged(before, s.entities);
      expect(s.entities).toHaveLength(sides);
      s.entities.forEach((e, i) => {
        const phi = theta + (Math.PI * 2 * i) / sides,
          vertex = add(center, {
            x: r * Math.cos(phi),
            y: r * Math.sin(phi),
          });
        expect(dist(e.points[0], center)).toBeCloseTo(r, 9);
        expect(dist(e.points[0], vertex)).toBeLessThan(1e-9);
        expect(
          dist(e.points[1], s.entities[(i + 1) % sides].points[0]),
        ).toBeLessThan(1e-9);
      });
    },
  );

  it("angled ellipse keeps both radii and aims the major axis", () => {
    const [center, axisPick, widthPick] = inputs.ellipse,
      angle = -60,
      s = make("ellipse", inputs.ellipse, angled(angle)),
      before = structuredClone(s.entities);
    solve(s);
    unchanged(before, s.entities);
    const e = s.entities[0],
      axis = sub(e.points[1], e.points[0]),
      n = normalize({ x: -(axisPick.y - center.y), y: axisPick.x - center.x }),
      nativeRy = Math.abs(dot(sub(widthPick, center), n));
    expect(dist(e.points[0], center)).toBeLessThan(1e-9);
    expect(Math.hypot(axis.x, axis.y)).toBeCloseTo(dist(center, axisPick), 9);
    expect(Math.atan2(axis.y, axis.x)).toBeCloseTo((angle * Math.PI) / 180, 9);
    expect(e.ry!).toBeCloseTo(nativeRy, 9);
  });

  it("angled center arc keeps radius, aim and sweep", () => {
    const [center, start] = inputs.centerArc,
      angle = 135,
      s = make("centerArc", inputs.centerArc, angled(angle)),
      before = structuredClone(s.entities);
    solve(s);
    unchanged(before, s.entities);
    const info = arcInfo(s.entities[0]);
    expect(dist(s.entities[0].points[0], center)).toBeLessThan(1e-9);
    expect(info.r).toBeCloseTo(dist(center, start), 9);
    expect(info.start).toBeCloseTo((angle * Math.PI) / 180, 9);
    expect(info.sweep).toBeCloseTo(Math.PI / 2, 9);
    expect(s.entities[0].ccw).toBe(true);
  });

  it("angled arc slot keeps both radii, width and sweeps", () => {
    const angle = 75,
      s = make("arcSlot", inputs.arcSlot, angled(angle)),
      plain = make("arcSlot"),
      before = structuredClone(s.entities);
    solve(s);
    unchanged(before, s.entities);
    const [outer, inner, capStart, capEnd] = s.entities.map(arcInfo),
      [pOuter, pInner, , pCapEnd] = plain.entities.map(arcInfo);
    expect(dist(s.entities[0].points[0], inputs.arcSlot[0])).toBeLessThan(1e-9);
    expect(outer.r).toBeCloseTo(pOuter.r, 9);
    expect(inner.r).toBeCloseTo(pInner.r, 9);
    expect(outer.r - inner.r).toBeCloseTo(2 * pCapEnd.r, 9);
    expect(outer.sweep).toBeCloseTo(pOuter.sweep, 9);
    expect(inner.sweep).toBeCloseTo(pInner.sweep, 9);
    expect(capStart.sweep).toBeCloseTo(Math.PI, 9);
    expect(capEnd.sweep).toBeCloseTo(Math.PI, 9);
    expect(outer.start).toBeCloseTo((angle * Math.PI) / 180, 9);
  });

  it("angled slot keeps length, width and cap sweeps", () => {
    const [a, b] = inputs.slot,
      angle = 35,
      s = make("slot", inputs.slot, angled(angle)),
      plain = make("slot"),
      before = structuredClone(s.entities);
    solve(s);
    unchanged(before, s.entities);
    const [l1, cap1, , cap2] = s.entities,
      dir = sub(l1.points[1], l1.points[0]);
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(dist(a, b), 9);
    expect(Math.atan2(dir.y, dir.x)).toBeCloseTo((angle * Math.PI) / 180, 9);
    expect(arcInfo(cap1).r).toBeCloseTo(arcInfo(plain.entities[1]).r, 9);
    expect(arcInfo(cap2).r).toBeCloseTo(arcInfo(plain.entities[3]).r, 9);
    expect(arcInfo(cap1).sweep).toBeCloseTo(Math.PI, 9);
    expect(arcInfo(cap2).sweep).toBeCloseTo(Math.PI, 9);
  });

  it("angled midline stays centered on the first pick", () => {
    const [a, b] = inputs.midline,
      s = make("midline", inputs.midline, angled(90)),
      before = structuredClone(s.entities);
    solve(s);
    unchanged(before, s.entities);
    const [line, mid] = s.entities,
      dir = sub(line.points[1], line.points[0]);
    expect(dist(mid.points[0], a)).toBeLessThan(1e-9);
    expect(Math.atan2(dir.y, dir.x)).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(2 * dist(a, b), 9);
  });
});
