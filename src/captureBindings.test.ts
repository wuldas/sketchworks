import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  appendGeometry,
  createGeometry,
  defaultConfig,
  type Tool,
} from "./creation";
import { CanvasRenderer, type CanvasFrame } from "./canvasRenderer";
import {
  entity,
  emptyDocument,
  deleteEntities,
  validateDocument,
  type Entity,
  type Sketch,
  type XY,
} from "./model";
import { dist, dot, intersections, sub, validGeometry } from "./geometry";
import {
  defaultSnapOptions,
  pathMidpoint,
  tangentPoints,
  type SnapReference,
} from "./snapping";
import { initSolver, solveSketch } from "./solver";
import { modifySketch } from "./operations";
import { appendSplinePoint } from "./splineDraft";
import { resolveBodyDragEntities } from "./dragTransaction";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);
const frame: CanvasFrame = {
  width: 800,
  height: 600,
  dpr: 1,
  view: { center: { x: 0, y: 0 }, scale: 5 },
  grid: false,
  snapOptions: { ...defaultSnapOptions, grid: false },
  unit: "mm",
  selection: [],
  drafts: [],
  preview: [],
  cursor: null,
  snapPoint: null,
  marquee: null,
};
const sketch = (...entities: Entity[]) => {
  const s = emptyDocument().sketches[0];
  s.entities.push(...entities);
  return s;
};
function create(
  s: Sketch,
  tool: Tool,
  points: XY[],
  refs: (SnapReference | undefined)[],
  auto = true,
) {
  const result = createGeometry(tool, points, {
    ...defaultConfig,
    autoConstraint: auto,
    preserveCapturedCoordinates: true,
  });
  appendGeometry(
    s,
    result,
    refs.flatMap((ref, pointIndex) =>
      ref === undefined ? [] : [{ pointIndex, point: points[pointIndex], ref }],
    ),
    auto,
    tool,
  );
  return result.entities;
}
function solve(s: Sketch) {
  const result = solveSketch(s);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  validGeometry(s);
}
function fixed(s: Sketch, e: Entity) {
  s.constraints.push({ id: `fix-${e.id}`, kind: "fixed", refs: [e.id] });
}
function near(actual: XY, expected: XY) {
  expect(dist(actual, expected)).toBeLessThan(1e-6);
}
function roundTrip(s: Sketch) {
  const doc = emptyDocument();
  doc.sketches = [s];
  return validateDocument(JSON.parse(JSON.stringify(doc))).sketches[0];
}

describe("capture identity reaches geometry creation", () => {
  it("retains midpoint, tangent, intersection and origin identities without fake point IDs", () => {
    const line = entity("line", [
        { x: 10, y: 20 },
        { x: 50, y: 20 },
      ]),
      crossing = entity("line", [
        { x: 25, y: 5 },
        { x: 25, y: 35 },
      ]),
      circle = entity("circle", [{ x: 80, y: 40 }], { radius: 10 }),
      s = sketch(line, crossing, circle),
      renderer = new CanvasRenderer();
    renderer.sync([s], s.id);
    expect(
      renderer.snap(
        { x: 30, y: 20 },
        {
          ...frame,
          snapOptions: { ...frame.snapOptions!, intersection: false },
        },
      )?.binding,
    ).toEqual({ kind: "midpoint", refs: [line.id] });
    expect(renderer.snap({ x: 25, y: 20 }, frame)?.binding).toEqual({
      kind: "intersection",
      refs: [line.id, crossing.id],
    });
    const from = { x: 60, y: 40 },
      tangent = tangentPoints(circle, from)[0];
    expect(
      renderer.snap(tangent, { ...frame, snapFrom: from })?.binding,
    ).toEqual({ kind: "tangent", refs: [circle.id] });
    expect(renderer.snap({ x: 0, y: 0 }, frame)?.binding).toEqual({
      kind: "origin",
      refs: [],
    });
    expect(renderer.snap(circle.points[0], frame)?.ref).toBe(
      circle.points[0].id,
    );
    expect(renderer.snap(line.points[0], frame)?.ref).toBe(line.points[0].id);
  });

  it("keeps derived captures coordinate-only", () => {
    const base = entity("circle", [{ x: 0, y: 0 }], { radius: 10 }),
      derived = entity("circle", [{ x: 80, y: 40 }], {
        radius: 10,
        sourceId: base.id,
        transform: { kind: "translate", x: 80, y: 40 },
      }),
      line = entity("line", [
        { x: 65, y: 40 },
        { x: 95, y: 40 },
      ]),
      s = sketch(base, derived, line),
      renderer = new CanvasRenderer();
    renderer.sync([s], s.id);
    const tangent = tangentPoints(derived, { x: 60, y: 40 })[0];
    expect(
      renderer.snap(tangent, { ...frame, snapFrom: { x: 60, y: 40 } })?.binding,
    ).toBeUndefined();
    expect(renderer.snap({ x: 90, y: 40 }, frame)?.binding).toBeUndefined();
    const [created] = create(
      s,
      "point",
      [derived.points[0]],
      [derived.points[0].id],
    );
    expect(
      s.constraints.some((c) => c.refs.includes(created.points[0].id)),
    ).toBe(false);
  });

  it("carries virtual capture relations through spline deduplication and completion", () => {
    const line = entity("line", [
        { x: 10, y: 20 },
        { x: 50, y: 20 },
      ]),
      s = sketch(line),
      binding: SnapReference = { kind: "midpoint", refs: [line.id] };
    const draft = appendSplinePoint<SnapReference>(
      [{ x: -10, y: 4 }],
      [undefined],
      { x: 30, y: 20 },
      binding,
    );
    const complete = appendSplinePoint(
      draft.points,
      draft.refs,
      { x: 30, y: 20 },
      binding,
    );
    expect(complete.points).toHaveLength(2);
    const [spline] = create(s, "spline", complete.points, complete.refs);
    expect(s.constraints).toContainEqual(
      expect.objectContaining({
        kind: "midpoint",
        refs: [spline.points[1].id, line.id],
      }),
    );
    fixed(s, line);
    solve(s);
    near(spline.points[1], { x: 30, y: 20 });
  });
});

describe("persistent six-category bindings", () => {
  it("binds endpoints and circle centers using stable explicit point IDs", () => {
    const line = entity("line", [
        { x: 10, y: 20 },
        { x: 25, y: 28 },
      ]),
      circle = entity("circle", [{ x: 50, y: 40 }], { radius: 5 }),
      s = sketch(line, circle);
    const [created] = create(
      s,
      "line",
      [line.points[1], circle.points[0]],
      [line.points[1].id, circle.points[0].id],
    );
    expect(s.constraints.filter((c) => c.kind === "coincident")).toHaveLength(
      2,
    );
    circle.points[0].x += 12;
    line.points[1].y += 3;
    fixed(s, line);
    fixed(s, circle);
    solve(s);
    near(created.points[0], line.points[1]);
    near(created.points[1], circle.points[0]);
    solve(roundTrip(s));
  });

  it.each(["line", "arc", "spline", "bezier", "conic"] as const)(
    "follows the actual %s midpoint after source movement",
    (kind) => {
      const coords: Record<typeof kind, XY[]> = {
        line: [
          { x: 20, y: 10 },
          { x: 60, y: 30 },
        ],
        arc: [
          { x: 40, y: 20 },
          { x: 50, y: 20 },
          { x: 40, y: 30 },
        ],
        spline: [
          { x: 20, y: 10 },
          { x: 25, y: 35 },
          { x: 45, y: 15 },
          { x: 60, y: 30 },
        ],
        bezier: [
          { x: 20, y: 10 },
          { x: 25, y: 35 },
          { x: 45, y: 15 },
          { x: 60, y: 30 },
        ],
        conic: [
          { x: 20, y: 10 },
          { x: 25, y: 35 },
          { x: 60, y: 30 },
        ],
      };
      const source = entity(kind, coords[kind], { ccw: true, weight: 0.65 }),
        s = sketch(source),
        initial = pathMidpoint(source)!;
      const [created] = create(
        s,
        "point",
        [initial],
        [{ kind: "midpoint", refs: [source.id] }],
      );
      solve(s);
      source.points.forEach((p) => {
        p.x += 9;
        p.y -= 6;
      });
      fixed(s, source);
      solve(s);
      near(created.points[0], pathMidpoint(source)!);
      expect(dist(created.points[0], initial)).toBeGreaterThan(5);
      solve(roundTrip(s));
    },
  );

  it("permits a soft source endpoint drag while keeping a created line start at its midpoint", () => {
    const guide = entity("line", [
        { x: -50, y: -40 },
        { x: 50, y: 40 },
      ]),
      source = entity("line", [
        { x: -24, y: 19 },
        { x: 16, y: 19 },
      ]),
      s = sketch(guide, source);
    fixed(s, guide);
    const [line] = create(
      s,
      "line",
      [
        { x: -4, y: 19 },
        { x: 28.926639, y: -21.308876 },
      ],
      [{ kind: "midpoint", refs: [source.id] }, undefined],
    );
    solve(s);
    const result = solveSketch(s, {
      pointId: source.points[0].id,
      x: -33,
      y: 27,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    near(line.points[0], {
      x: (source.points[0].x + source.points[1].x) / 2,
      y: (source.points[0].y + source.points[1].y) / 2,
    });
    expect(dist(line.points[0], { x: -4, y: 19 })).toBeGreaterThan(1);
  });

  it("retains tangency and contact after changing a circle radius", () => {
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 10 }),
      s = sketch(circle),
      start = { x: -20, y: 0 },
      contact = tangentPoints(circle, start)[0];
    const [line] = create(
      s,
      "line",
      [start, contact],
      [undefined, { kind: "tangent", refs: [circle.id] }],
    );
    s.constraints.push(
      { id: "center-fixed", kind: "fixed", refs: [circle.points[0].id] },
      { id: "start-fixed", kind: "fixed", refs: [line.points[0].id] },
      { id: "radius", kind: "radius", refs: [circle.id], value: 10 },
    );
    solve(s);
    s.constraints.find((c) => c.id === "radius")!.value = 6;
    solve(s);
    expect(dist(line.points[1], circle.points[0])).toBeCloseTo(6, 6);
    expect(
      dot(
        sub(line.points[1], circle.points[0]),
        sub(line.points[0], line.points[1]),
      ),
    ).toBeCloseTo(0, 6);
    expect(
      s.constraints.some(
        (c) => c.kind === "tangent" && c.refs.includes(line.id),
      ),
    ).toBe(true);
    expect(
      s.constraints.some(
        (c) => c.kind === "onCurve" && c.refs.includes(line.points[1].id),
      ),
    ).toBe(true);
  });

  it("follows a moving intersection rather than freezing its original coordinates", () => {
    const a = entity("line", [
        { x: -20, y: 10 },
        { x: 30, y: 10 },
      ]),
      b = entity("line", [
        { x: 5, y: -20 },
        { x: 5, y: 30 },
      ]),
      s = sketch(a, b);
    const [created] = create(
      s,
      "point",
      [{ x: 5, y: 10 }],
      [{ kind: "intersection", refs: [a.id, b.id] }],
    );
    solve(s);
    b.points.forEach((p) => {
      p.x = 14;
    });
    fixed(s, a);
    fixed(s, b);
    solve(s);
    near(created.points[0], { x: 14, y: 10 });
    expect(s.constraints.find((c) => c.kind === "intersection")?.refs).toEqual([
      created.points[0].id,
      a.id,
      b.id,
    ]);
    const restored = roundTrip(s);
    deleteEntities(restored, [a.id]);
    expect(restored.constraints.some((c) => c.kind === "intersection")).toBe(
      false,
    );
  });

  it("locks only the captured point to the origin without adding a fake origin entity", () => {
    const s = sketch(),
      [line] = create(
        s,
        "line",
        [
          { x: 0, y: 0 },
          { x: 20, y: 11 },
        ],
        [{ kind: "origin", refs: [] }, undefined],
      );
    expect(s.entities).toHaveLength(1);
    expect(s.constraints).toContainEqual(
      expect.objectContaining({ kind: "origin", refs: [line.points[0].id] }),
    );
    line.points[0].x = 6;
    solve(s);
    near(line.points[0], { x: 0, y: 0 });
    expect(
      solveSketch(s, { pointId: line.points[1].id, x: 24, y: 13, exact: true })
        .ok,
    ).toBe(true);
    near(line.points[0], { x: 0, y: 0 });
    near(line.points[1], { x: 24, y: 13 });
    expect(() => resolveBodyDragEntities(s, [], line.id)).toThrow();
    solve(roundTrip(s));
  });

  it("does not create bindings or auxiliary geometry when automatic constraints are off", () => {
    const source = entity("point", [{ x: 15, y: 7 }]),
      s = sketch(source);
    create(
      s,
      "circle",
      [{ x: 0, y: 0 }, source.points[0]],
      [{ kind: "origin", refs: [] }, source.points[0].id],
      false,
    );
    expect(s.entities).toHaveLength(2);
    expect(s.constraints).toEqual([]);
  });
});

describe("construction click-to-geometry mapping", () => {
  it("binds the second rectangle click to the opposite corner", () => {
    const target = entity("point", [{ x: 25, y: 18 }]),
      s = sketch(target);
    const es = create(
      s,
      "rectangle",
      [{ x: 2, y: 3 }, target.points[0]],
      [undefined, target.points[0].id],
    );
    const binding = s.constraints.find(
      (c) => c.kind === "coincident" && c.refs.includes(target.points[0].id),
    );
    expect(binding?.refs).toEqual([es[1].points[1].id, target.points[0].id]);
    fixed(s, target);
    solve(s);
    near(es[1].points[1], target.points[0]);
  });

  it.each(["midline", "centerRectangle", "polygon"] as const)(
    "binds the %s center to the origin and cleans its owned helpers",
    (tool) => {
      const s = sketch(),
        es = create(
          s,
          tool,
          [
            { x: 0, y: 0 },
            { x: 20, y: 12 },
          ],
          [{ kind: "origin", refs: [] }, undefined],
        );
      solve(s);
      const binding = s.constraints.find((c) => c.kind === "origin")!;
      const point = s.entities
        .flatMap((e) => e.points)
        .find((p) => p.id === binding.refs[0])!;
      near(point, { x: 0, y: 0 });
      if (tool !== "midline") {
        expect(s.entities.some((e) => e.ownerId === es[0].id)).toBe(true);
        const restored = roundTrip(s);
        deleteEntities(restored, [es[0].id]);
        expect(restored.entities.some((e) => e.ownerId === es[0].id)).toBe(
          false,
        );
        expect(restored.constraints.some((c) => c.id === binding.id)).toBe(
          false,
        );
      }
    },
  );

  it.each(["circle", "threeCircle"] as const)(
    "binds a %s perimeter click using an owned construction point",
    (tool) => {
      const target = entity("point", [{ x: 10, y: 0 }]),
        s = sketch(target),
        points =
          tool === "circle"
            ? [{ x: 0, y: 0 }, target.points[0]]
            : [target.points[0], { x: 0, y: 10 }, { x: -10, y: 0 }],
        refs =
          tool === "circle"
            ? [undefined, target.points[0].id]
            : [target.points[0].id, undefined, undefined];
      const [circle] = create(s, tool, points, refs);
      const helper = s.entities.find((e) => e.ownerId === circle.id)!;
      expect(circle.points).toHaveLength(1);
      expect(helper.kind).toBe("point");
      expect(
        s.constraints.some(
          (c) => c.kind === "onCurve" && c.refs.includes(helper.points[0].id),
        ),
      ).toBe(true);
      fixed(s, target);
      solve(s);
      near(helper.points[0], target.points[0]);
      expect(dist(helper.points[0], circle.points[0])).toBeCloseTo(
        circle.radius!,
        6,
      );
      const restored = roundTrip(s);
      deleteEntities(restored, [circle.id]);
      expect(restored.entities).toHaveLength(1);
      expect(restored.constraints.filter((c) => c.kind !== "fixed")).toEqual(
        [],
      );
    },
  );

  it("maps arc start and end captures to endpoints, not the computed center", () => {
    const a = entity("point", [{ x: 10, y: 0 }]),
      b = entity("point", [{ x: 0, y: 10 }]),
      c = entity("point", [{ x: -10, y: 0 }]),
      s = sketch(a, b, c);
    const [arc] = create(
      s,
      "arc",
      [a.points[0], b.points[0], c.points[0]],
      [a.points[0].id, b.points[0].id, c.points[0].id],
    );
    expect(s.constraints).toContainEqual(
      expect.objectContaining({
        kind: "coincident",
        refs: [arc.points[1].id, a.points[0].id],
      }),
    );
    expect(s.constraints).toContainEqual(
      expect.objectContaining({
        kind: "coincident",
        refs: [arc.points[2].id, c.points[0].id],
      }),
    );
    expect(
      s.constraints.some(
        (relation) =>
          relation.kind === "coincident" &&
          relation.refs.includes(arc.points[0].id),
      ),
    ).toBe(false);
    fixed(s, a);
    fixed(s, b);
    fixed(s, c);
    solve(s);
    near(arc.points[0], { x: 0, y: 0 });
  });

  it("binds a projected center-arc direction on its ray without moving the endpoint to the third click", () => {
    const target = entity("point", [{ x: 0, y: 15 }]),
      s = sketch(target);
    const [arc] = create(
      s,
      "centerArc",
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, target.points[0]],
      [{ kind: "origin", refs: [] }, undefined, target.points[0].id],
    );
    s.constraints.push({
      id: "start",
      kind: "fixed",
      refs: [arc.points[1].id],
    });
    fixed(s, target);
    solve(s);
    near(arc.points[2], { x: 0, y: 10 });
    expect(
      s.entities.some((e) => e.ownerId === arc.id && e.kind === "line"),
    ).toBe(true);
    solve(roundTrip(s));
  });

  it("binds an outer polygon sizing click to its apothem and orientation", () => {
    const source = entity("point", [{ x: 20, y: 0 }]),
      s = sketch(source),
      points = [{ x: 0, y: 0 }, source.points[0]],
      result = createGeometry("polygon", points, {
        ...defaultConfig,
        polygonOuter: true,
        preserveCapturedCoordinates: true,
      });
    appendGeometry(
      s,
      result,
      [
        { pointIndex: 0, point: points[0], ref: { kind: "origin", refs: [] } },
        { pointIndex: 1, point: points[1], ref: source.points[0].id },
      ],
      true,
      "polygon",
    );
    fixed(s, source);
    solve(s);
    const outer = s.entities.find(
      (e) => e.kind === "circle" && e.ownerId === result.entities[0].id,
    )!;
    expect(outer.radius! * Math.cos(Math.PI / 6)).toBeCloseTo(20, 6);
    expect(
      s.constraints.some(
        (c) => c.kind === "coincident" && c.refs.includes(source.points[0].id),
      ),
    ).toBe(true);
    solve(roundTrip(s));
  });

  it("binds an ellipse's minor-axis sizing click and follows changes to that source", () => {
    const source = entity("point", [{ x: 3, y: 5 }]),
      s = sketch(source),
      [ellipse] = create(
        s,
        "ellipse",
        [{ x: 0, y: 0 }, { x: 10, y: 0 }, source.points[0]],
        [{ kind: "origin", refs: [] }, undefined, source.points[0].id],
      );
    s.constraints.push({
      id: "major",
      kind: "fixed",
      refs: [ellipse.points[1].id],
    });
    solve(s);
    expect(ellipse.ry).toBeCloseTo(5, 6);
    source.points[0].y = 8;
    fixed(s, source);
    solve(s);
    expect(ellipse.ry).toBeCloseTo(8, 6);
    expect(
      s.constraints.some(
        (c) => c.kind === "ellipseWidth" && c.refs.includes(ellipse.id),
      ),
    ).toBe(true);
    solve(roundTrip(s));
    deleteEntities(s, [ellipse.id]);
    expect(s.entities).toHaveLength(1);
  });

  it("recomputes ellipse intersections when its captured width source moves", () => {
    const source = entity("point", [{ x: 3, y: 5 }]),
      probe = entity("line", [
        { x: 5, y: -20 },
        { x: 5, y: 20 },
      ]),
      s = sketch(source, probe),
      [ellipse] = create(
        s,
        "ellipse",
        [{ x: 0, y: 0 }, { x: 10, y: 0 }, source.points[0]],
        [{ kind: "origin", refs: [] }, undefined, source.points[0].id],
      );
    s.constraints.push({
      id: "major",
      kind: "fixed",
      refs: [ellipse.points[1].id],
    });
    fixed(s, probe);
    const initial = intersections(ellipse, probe).find((p) => p.y > 0)!;
    const [attached] = create(
      s,
      "point",
      [initial],
      [{ kind: "intersection", refs: [ellipse.id, probe.id] }],
    );
    solve(s);
    source.points[0].y = 8;
    fixed(s, source);
    solve(s);
    near(
      attached.points[0],
      intersections(ellipse, probe).find((p) => p.y > 0)!,
    );
    expect(attached.points[0].y).toBeGreaterThan(initial.y + 1);
    solve(roundTrip(s));
  });

  it("copies an origin-bound ellipse and its internal width controls without copying the absolute anchor", () => {
    const source = entity("point", [{ x: 3, y: 5 }]),
      s = sketch(source),
      [ellipse] = create(
        s,
        "ellipse",
        [{ x: 0, y: 0 }, { x: 10, y: 0 }, source.points[0]],
        [{ kind: "origin", refs: [] }, undefined, source.points[0].id],
      );
    solve(s);
    const originals = new Set(s.entities.map((e) => e.id));
    modifySketch(s, [ellipse.id], "copy", { dx: 50, dy: 10 });
    const copies = s.entities.filter((e) => !originals.has(e.id)),
      copied = copies.find((e) => e.kind === "ellipse")!;
    solve(s);
    expect(copies).toHaveLength(4);
    near(copied.points[0], { x: 50, y: 10 });
    expect(copied.ry).toBeCloseTo(5, 6);
    expect(
      copies.filter((e) => e.ownerId).every((e) => e.ownerId === copied.id),
    ).toBe(true);
    deleteEntities(s, [ellipse.id]);
    solve(s);
    solve(roundTrip(s));
    expect(s.entities.filter((e) => e.ownerId === copied.id)).toHaveLength(3);
  });

  it.each(["slot", "arcSlot"] as const)(
    "keeps %s anchor and width captures attached to their geometric controls",
    (tool) => {
      const points =
        tool === "slot"
          ? [
              { x: 0, y: 0 },
              { x: 30, y: 0 },
              { x: 20, y: 5 },
            ]
          : [
              { x: 0, y: 0 },
              { x: 20, y: 0 },
              { x: 0, y: 30 },
              { x: 0, y: -24 },
            ];
      const targets = points.map((p) => entity("point", [p])),
        s = sketch(...targets);
      const es = create(
        s,
        tool,
        points,
        targets.map((e) => e.points[0].id),
      );
      targets.forEach((e) => fixed(s, e));
      solve(s);
      expect(
        s.constraints.filter(
          (c) =>
            c.kind === "coincident" &&
            targets.some((e) => c.refs.includes(e.points[0].id)),
        ),
      ).toHaveLength(points.length);
      solve(roundTrip(s));
      deleteEntities(
        s,
        es.map((e) => e.id),
      );
      expect(s.entities).toHaveLength(targets.length);
    },
  );

  it("rejects malformed persisted bindings and helper ownership", () => {
    const s = sketch(entity("point", [{ x: 0, y: 0 }]));
    s.constraints.push({
      id: "bad",
      kind: "origin",
      refs: [s.entities[0].id, s.entities[0].points[0].id],
    });
    expect(() => roundTrip(s)).toThrow();
    s.constraints = [];
    s.entities[0].ownerId = s.entities[0].id;
    expect(() => roundTrip(s)).toThrow();
  });
});
