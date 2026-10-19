import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  arcInfo,
  bezierAt,
  blendEntity,
  dist,
  dot,
  sub,
  validGeometry,
} from "./geometry";
import {
  type Entity,
  type Sketch,
  clone,
  deleteEntities,
  emptyDocument,
  entity,
  uid,
  validateDocument,
} from "./model";
import { modifySketch } from "./operations";
import { updateDimensionLabels } from "./dimensionLabel";
import { initSolver, solveSketch } from "./solver";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);

const line = (ax: number, ay: number, bx: number, by: number) =>
  entity("line", [
    { x: ax, y: ay },
    { x: bx, y: by },
  ]);
const sketch = (...entities: Entity[]) => {
  const s = emptyDocument().sketches[0];
  s.entities = entities;
  return s;
};
function valid(s: Sketch) {
  validGeometry(s);
  const d = emptyDocument();
  d.sketches = [s];
  expect(() => validateDocument(d)).not.toThrow();
  const refs = new Set(
    s.entities.flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
  );
  expect(s.constraints.every((c) => c.refs.every((r) => refs.has(r)))).toBe(
    true,
  );
}
const ids = (s: Sketch) => s.entities.map((e) => e.id);
const xy = (p: { x: number; y: number }) => ({ x: p.x, y: p.y });
function square() {
  return sketch(
    line(0, 0, 10, 0),
    line(10, 0, 10, 10),
    line(10, 10, 0, 10),
    line(0, 10, 0, 0),
  );
}
function extent(es: Entity[]) {
  const ps = es.flatMap((e) => e.points);
  return {
    minX: Math.min(...ps.map((p) => p.x)),
    maxX: Math.max(...ps.map((p) => p.x)),
    minY: Math.min(...ps.map((p) => p.y)),
    maxY: Math.max(...ps.map((p) => p.y)),
  };
}

describe("sketch transformations", () => {
  it("moves, rotates in degrees, and scales while retaining constraint IDs", () => {
    const s = sketch(line(1, 0, 3, 0));
    s.constraints.push({
      id: "horizontal",
      kind: "horizontal",
      refs: [s.entities[0].id],
    });
    expect(
      modifySketch(s, ids(s), "move", { dx: 2, dy: 1 }).removedConstraints,
    ).toEqual([]);
    expect(xy(s.entities[0].points[0])).toEqual({ x: 3, y: 1 });
    modifySketch(s, ids(s), "rotate", { angle: 90, cx: 3, cy: 1 });
    expect(s.entities[0].points[1].x).toBeCloseTo(3);
    expect(s.entities[0].points[1].y).toBeCloseTo(3);
    modifySketch(s, ids(s), "scale", { factor: 2, cx: 3, cy: 1 });
    expect(s.entities[0].points[1].y).toBeCloseTo(5);
    expect(s.constraints[0].id).toBe("horizontal");
    valid(s);
  });
  it("scales circle radius and ellipse minor radius", () => {
    const s = sketch(
      entity("circle", [{ x: 1, y: 1 }], { radius: 2 }),
      entity(
        "ellipse",
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
        { ry: 2 },
      ),
    );
    modifySketch(s, ids(s), "scale", { factor: 3 });
    expect(s.entities[0].radius).toBe(6);
    expect(s.entities[1].ry).toBe(6);
    valid(s);
  });
  it("refuses fixed transforms atomically without deleting constraints", () => {
    const s = sketch(line(0, 0, 2, 0));
    s.constraints.push({
      id: "fixed",
      kind: "fixed",
      refs: [s.entities[0].points[0].id],
    });
    const before = clone(s);
    expect(() => modifySketch(s, ids(s), "move", { dx: 1 })).toThrow("固定");
    expect(s).toEqual(before);
  });
  it("copies only internal constraints, with fresh refs and no fixed anchors", () => {
    const a = line(0, 0, 2, 0),
      b = line(2, 0, 2, 3),
      outside = line(10, 0, 10, 5);
    const s = sketch(a, b, outside);
    s.constraints.push(
      {
        id: "join",
        kind: "coincident",
        refs: [a.points[1].id, b.points[0].id],
      },
      { id: "h", kind: "horizontal", refs: [a.id] },
      { id: "external", kind: "parallel", refs: [b.id, outside.id] },
      {
        id: "fixed",
        kind: "fixed",
        refs: [a.points[0].id],
        anchors: [clone(a.points[0])],
      },
    );
    modifySketch(s, [a.id, b.id], "copy", { dx: 5, dy: 2 });
    expect(s.entities).toHaveLength(5);
    expect(s.constraints).toHaveLength(6);
    const copiedRefs = new Set(
      s.entities.slice(3).flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
    );
    expect(
      s.constraints
        .slice(4)
        .every((c) => c.refs.every((r) => copiedRefs.has(r))),
    ).toBe(true);
    expect(s.constraints.slice(4).map((c) => c.kind)).toEqual([
      "coincident",
      "horizontal",
    ]);
    valid(s);
  });
  it("does not copy an absolute origin binding into a translated copy", () => {
    const a = line(0, 0, 20, 8),
      s = sketch(a);
    s.constraints.push({
      id: "origin",
      kind: "origin",
      refs: [a.points[0].id],
    });
    modifySketch(s, [a.id], "copy", { dx: 50, dy: 10 });
    expect(s.constraints).toHaveLength(1);
    expect(s.entities[1].points[0]).toMatchObject({ x: 50, y: 10 });
    expect(s.entities[1].points[1]).toMatchObject({ x: 70, y: 18 });
    expect(() => modifySketch(s, [a.id], "move", { dx: 10 })).toThrow("固定");
    valid(s);
  });
  it("remaps copied auxiliary ownership and releases independent helper copies", () => {
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 10 }),
      helper = entity("point", [{ x: 10, y: 0 }], {
        construction: true,
        ownerId: circle.id,
      }),
      s = sketch(circle, helper);
    s.constraints.push({
      id: "onCurve",
      kind: "onCurve",
      refs: [helper.points[0].id, circle.id],
    });
    modifySketch(s, [circle.id, helper.id], "copy", { dx: 30 });
    const copiedCircle = s.entities[2],
      copiedHelper = s.entities[3];
    expect(copiedHelper.ownerId).toBe(copiedCircle.id);
    modifySketch(s, [helper.id], "copy", { dx: 50 });
    expect(s.entities[4].ownerId).toBeUndefined();
    valid(s);
    deleteEntities(s, [circle.id]);
    expect(s.entities.some((e) => e.id === copiedHelper.id)).toBe(true);
    expect(
      s.constraints.some(
        (c) =>
          c.kind === "onCurve" && c.refs.includes(copiedHelper.points[0].id),
      ),
    ).toBe(true);
    valid(s);
  });
  it("copies placed dimensions with their geometry and preserves the original label", () => {
    const a = line(0, 0, 20, 0);
    const s = sketch(a);
    s.constraints.push({
      id: "length",
      kind: "length",
      refs: [a.id],
      value: 20,
      labelPosition: { x: 10, y: 10 },
    });
    updateDimensionLabels(s);
    const original = clone(s.constraints[0]);
    modifySketch(s, [a.id], "copy", { dx: 3, dy: 50 });
    expect(s.entities[1].points[0]).toMatchObject({ x: 3, y: 50 });
    expect(s.constraints[1].refs).toEqual([s.entities[1].id]);
    expect(s.constraints[1].labelPosition).toEqual({ x: 13, y: 60 });
    expect(s.constraints[0]).toEqual(original);
    s.constraints[1].labelPosition!.x = 99;
    expect(s.constraints[0].labelPosition).toEqual({ x: 10, y: 10 });
    valid(s);
  });
  it("creates and updates derived mirrors, then allows explicit detachment", () => {
    const source = entity(
      "arc",
      [
        { x: 2, y: 0 },
        { x: 3, y: 0 },
        { x: 2, y: 1 },
      ],
      { ccw: true },
    );
    const axis = line(0, -5, 0, 5),
      s = sketch(source, axis);
    modifySketch(s, [source.id, axis.id], "mirror", {});
    const mirrored = s.entities[2];
    expect(mirrored.sourceId).toBe(source.id);
    expect(mirrored.ccw).toBe(false);
    expect(mirrored.points[0].x).toBe(-2);
    modifySketch(s, [source.id], "move", { dx: 1 });
    expect(s.entities[2].points[0].x).toBe(-3);
    expect(() =>
      modifySketch(s, [mirrored.id], "break", {}, { x: -3, y: 1 }),
    ).toThrow("派生");
    modifySketch(s, [mirrored.id], "detach", {});
    expect(s.entities[2].sourceId).toBeUndefined();
    valid(s);
  });
  it("updates mirrors when their referenced axis moves and protects fixed dependents", () => {
    const a = line(2, 0, 4, 0),
      axis = line(0, -2, 0, 2),
      s = sketch(a, axis);
    modifySketch(s, [a.id, axis.id], "mirror", {});
    expect(s.entities[2].transform?.axisId).toBe(axis.id);
    modifySketch(s, [axis.id], "move", { dx: 1 });
    expect(s.entities[2].points[0].x).toBe(0);
    expect(s.entities[2].points[1].x).toBe(-2);
    s.constraints.push({
      id: "fixed",
      kind: "fixed",
      refs: [s.entities[2].id],
    });
    expect(() => modifySketch(s, [axis.id], "move", { dx: 1 })).toThrow("固定");
    valid(s);
  });
  it("blocks changes when a derived dependent is fixed", () => {
    const a = line(1, 0, 2, 0),
      axis = line(0, -1, 0, 1),
      s = sketch(a, axis);
    modifySketch(s, [a.id, axis.id], "mirror", {});
    s.constraints.push({
      id: "fixed",
      kind: "fixed",
      refs: [s.entities[2].id],
    });
    expect(() => modifySketch(s, [a.id], "move", { dx: 1 })).toThrow("固定");
  });
  it("makes rectangular and full-circle arrays without duplicating originals", () => {
    const s = sketch(line(1, 0, 2, 0));
    modifySketch(s, ids(s), "rectangularArray", {
      cols: 3,
      rows: 2,
      dx: 5,
      dy: 7,
    });
    expect(s.entities).toHaveLength(6);
    expect(extent(s.entities)).toEqual({ minX: 1, maxX: 12, minY: 0, maxY: 7 });
    valid(s);
    const circular = sketch(entity("circle", [{ x: 2, y: 0 }], { radius: 1 }));
    modifySketch(circular, ids(circular), "circularArray", {
      count: 4,
      angle: 360,
    });
    expect(circular.entities).toHaveLength(4);
    const centers = circular.entities.map((e) => e.points[0]);
    expect(centers[1].y).toBeCloseTo(2);
    expect(centers[2].x).toBeCloseTo(-2);
    expect(centers[3].y).toBeCloseTo(-2);
    valid(circular);
  });
  it("treats partial circular-array angle as inclusive total span", () => {
    const s = sketch(entity("circle", [{ x: 4, y: 0 }], { radius: 1 }));
    modifySketch(s, ids(s), "circularArray", { count: 3, angle: 90 });
    expect(s.entities[1].points[0].x).toBeCloseTo(Math.sqrt(8));
    expect(s.entities[2].points[0].y).toBeCloseTo(4);
  });
  it("keeps associated arrays synchronized without duplicating directional constraints", () => {
    const s = sketch(line(1, 0, 2, 0)),
      source = s.entities[0];
    s.constraints.push({ id: "h", kind: "horizontal", refs: [source.id] });
    modifySketch(s, [source.id], "circularArray", { count: 4 });
    expect(s.constraints).toHaveLength(1);
    expect(
      s.entities
        .slice(1)
        .every(
          (e) => e.sourceId === source.id && e.transform?.kind === "rotate",
        ),
    ).toBe(true);
    const derivedIds = s.entities.slice(1).map((e) => e.id);
    modifySketch(s, [source.id], "move", { dx: 2 });
    expect(s.entities[1].points[0].y).toBeCloseTo(3);
    expect(s.entities[2].points[0].x).toBeCloseTo(-3);
    expect(s.entities.slice(1).map((e) => e.id)).toEqual(derivedIds);
    valid(s);
    expect(() =>
      modifySketch(s, [derivedIds[0]], "circularArray", { count: 2 }),
    ).toThrow("派生");
    const rectangular = sketch(line(0, 0, 1, 0)),
      rectangularSource = rectangular.entities[0].id;
    modifySketch(rectangular, [rectangularSource], "rectangularArray", {
      cols: 2,
      rows: 2,
      dx: 3,
      dy: 4,
    });
    modifySketch(rectangular, [rectangularSource], "move", { dx: 1, dy: 2 });
    expect(rectangular.entities[3].points[0].x).toBe(4);
    expect(rectangular.entities[3].points[0].y).toBe(6);
    valid(rectangular);
  });
  it("rejects scalar overflow even when all point coordinates remain valid", () => {
    const s = sketch(entity("circle", [{ x: 0, y: 0 }], { radius: 2 })),
      before = clone(s);
    expect(() => modifySketch(s, ids(s), "scale", { factor: 1e100 })).toThrow(
      "越界",
    );
    expect(s).toEqual(before);
    expect(() => modifySketch(s, ids(s), "offset", { distance: 1e8 })).toThrow(
      "越界",
    );
    expect(s).toEqual(before);
  });
  it("bounds total entity quantities and rejects nonfinite or zero scale", () => {
    const s = sketch(line(0, 0, 1, 0), line(0, 0, 0, 1));
    const before = clone(s);
    expect(() =>
      modifySketch(s, ids(s), "rectangularArray", {
        cols: 100,
        rows: 100,
        dx: 2,
        dy: 2,
      }),
    ).toThrow("10000");
    expect(() => modifySketch(s, ids(s), "scale", { factor: 0 })).toThrow(
      "大于零",
    );
    expect(() => modifySketch(s, ids(s), "move", { dx: Infinity })).toThrow(
      "有限",
    );
    expect(s).toEqual(before);
  });
});

describe("fillet and chamfer topology", () => {
  const joined = (
    s: Sketch,
    lineIndex: number,
    endpoint: number,
    arcIndex: number,
    arcEndpoint: number,
  ) => {
    const line = s.entities[lineIndex],
      arc = s.entities[arcIndex];
    expect(dist(line.points[endpoint], arc.points[arcEndpoint])).toBeLessThan(
      1e-6,
    );
    const radius = sub(arc.points[arcEndpoint], arc.points[0]),
      direction = sub(line.points[1], line.points[0]);
    expect(
      Math.abs(dot(radius, direction)) /
        (Math.hypot(radius.x, radius.y) * Math.hypot(direction.x, direction.y)),
    ).toBeLessThan(1e-6);
  };
  it.each([false, true])(
    "keeps fillet contacts and line directions when its radius changes, reversed line %s",
    (reverse) => {
      const a = reverse ? line(10, 0, 0, 0) : line(0, 0, 10, 0),
        b = line(0, 10, 0, 0),
        s = sketch(a, b);
      s.constraints.push(
        { id: "horizontal", kind: "horizontal", refs: [a.id] },
        { id: "vertical", kind: "vertical", refs: [b.id] },
      );
      modifySketch(s, [a.id, b.id], "fillet", { radius: 2 });
      const arc = s.entities[2];
      s.constraints.push(
        { id: "anchor-a", kind: "fixed", refs: [a.points[reverse ? 0 : 1].id] },
        { id: "anchor-b", kind: "fixed", refs: [b.points[0].id] },
        { id: "radius", kind: "radius", refs: [arc.id], value: 3 },
      );
      expect(solveSketch(s)).toMatchObject({ ok: true });
      expect(arcInfo(arc).r).toBeCloseTo(3, 6);
      joined(s, 0, reverse ? 1 : 0, 2, 1);
      joined(s, 1, 1, 2, 2);
      expect(arc.points[0].x).toBeCloseTo(3, 6);
      expect(arc.points[0].y).toBeCloseTo(3, 6);
      valid(s);
    },
  );
  it("keeps an earlier fillet connected and tangent when the other end of its line is rounded", () => {
    const top = line(0, 20, 20, 20),
      left = line(0, 0, 0, 20),
      bottom = line(20, 0, 0, 0),
      s = sketch(top, left, bottom);
    s.constraints.push(
      { id: "top-axis", kind: "horizontal", refs: [top.id] },
      { id: "left-axis", kind: "vertical", refs: [left.id] },
      { id: "bottom-axis", kind: "horizontal", refs: [bottom.id] },
      {
        id: "top-joint",
        kind: "coincident",
        refs: [top.points[0].id, left.points[1].id],
      },
      {
        id: "bottom-joint",
        kind: "coincident",
        refs: [left.points[0].id, bottom.points[1].id],
      },
    );
    modifySketch(s, [top.id, left.id], "fillet", { radius: 3 });
    modifySketch(s, [left.id, bottom.id], "fillet", { radius: 3 });
    s.constraints.push(
      { id: "top-anchor", kind: "fixed", refs: [top.points[1].id] },
      { id: "bottom-anchor", kind: "fixed", refs: [bottom.points[0].id] },
      { id: "top-radius", kind: "radius", refs: [s.entities[3].id], value: 5 },
      {
        id: "bottom-radius",
        kind: "radius",
        refs: [s.entities[4].id],
        value: 3,
      },
    );
    expect(solveSketch(s)).toMatchObject({ ok: true });
    expect(arcInfo(s.entities[3]).r).toBeCloseTo(5, 6);
    expect(arcInfo(s.entities[4]).r).toBeCloseTo(3, 6);
    joined(s, 0, 0, 3, 1);
    joined(s, 1, 1, 3, 2);
    joined(s, 1, 0, 4, 1);
    joined(s, 2, 1, 4, 2);
    valid(s);
  });
  it.each([false, true])(
    "makes a tangent fillet with reversed endpoint order %s",
    (reverse) => {
      const a = reverse ? line(10, 0, 0, 0) : line(0, 0, 10, 0),
        b = line(0, 0, 0, 10),
        s = sketch(a, b);
      s.constraints.push(
        {
          id: "joint",
          kind: "coincident",
          refs: [a.points[reverse ? 1 : 0].id, b.points[0].id],
        },
        { id: "len", kind: "length", refs: [a.id], value: 10 },
      );
      const result = modifySketch(s, ids(s), "fillet", { radius: 2 });
      expect(result.removedConstraints.sort()).toEqual(["joint", "len"]);
      const arc = s.entities[2],
        info = arcInfo(arc);
      expect(info.r).toBeCloseTo(2);
      expect(Math.abs(info.sweep)).toBeCloseTo(Math.PI / 2);
      expect(xy(arc.points[0])).toEqual({ x: 2, y: 2 });
      expect(
        dot(
          sub(arc.points[1], arc.points[0]),
          sub(s.entities[0].points[1], s.entities[0].points[0]),
        ),
      ).toBeCloseTo(0);
      expect(
        dot(
          sub(arc.points[2], arc.points[0]),
          sub(s.entities[1].points[1], s.entities[1].points[0]),
        ),
      ).toBeCloseTo(0);
      valid(s);
    },
  );
  it("creates an acute-angle tangent fillet", () => {
    const s = sketch(line(0, 0, 20, 0), line(0, 0, 10, 10 * Math.sqrt(3)));
    modifySketch(s, ids(s), "fillet", { radius: 2 });
    const arc = s.entities[2];
    for (let i = 0; i < 2; i++)
      expect(
        dot(
          sub(arc.points[i + 1], arc.points[0]),
          sub(s.entities[i].points[1], s.entities[i].points[0]),
        ),
      ).toBeCloseTo(0);
    valid(s);
  });
  it("builds a two-distance chamfer and reports changed constraints", () => {
    const s = sketch(line(0, 0, 10, 0), line(0, 0, 0, 10));
    s.constraints.push({
      id: "len",
      kind: "length",
      refs: [s.entities[0].id],
      value: 10,
    });
    expect(
      modifySketch(s, ids(s), "chamfer", { distance: 2, distance2: 3 })
        .removedConstraints,
    ).toEqual(["len"]);
    expect(s.entities[2].points.map(xy)).toEqual([
      { x: 2, y: 0 },
      { x: 0, y: 3 },
    ]);
    valid(s);
  });
  it("builds angle-distance chamfers using the actual included angle", () => {
    const s = sketch(line(0, 0, 10, 0), line(0, 0, 0, 10));
    modifySketch(s, ids(s), "chamfer", { distance: 3, angle: 30 });
    expect(s.entities[2].points[1].y).toBeCloseTo(Math.sqrt(3));
    valid(s);
  });
  it("rejects nonintersecting, parallel, oversized and fixed corners atomically", () => {
    const s = sketch(line(0, 0, 1, 0), line(0, 0, 0, 1)),
      before = clone(s);
    expect(() => modifySketch(s, ids(s), "fillet", { radius: 1 })).toThrow(
      "过大",
    );
    expect(s).toEqual(before);
    expect(() =>
      modifySketch(s, ids(s), "chamfer", { distance: 1, angle: 90 }),
    ).toThrow("不相容");
    const nonintersecting = sketch(line(1, 0, 2, 0), line(0, 1, 0, 2));
    expect(() =>
      modifySketch(nonintersecting, ids(nonintersecting), "fillet", {
        radius: 0.1,
      }),
    ).toThrow("必须相交");
    const parallel = sketch(line(0, 0, 3, 0), line(0, 1, 3, 1));
    expect(() =>
      modifySketch(parallel, ids(parallel), "fillet", { radius: 1 }),
    ).toThrow("平行");
  });
});

describe("Clipper chain offsets", () => {
  it.each([false, true])(
    "offsets a square outward with unordered/reversed selection %s",
    (reversed) => {
      const s = square();
      if (reversed) {
        s.entities.reverse();
        s.entities[1].points.reverse();
        s.entities[3].points.reverse();
      }
      const original = ids(s);
      modifySketch(s, original, "offset", { distance: 2 });
      const out = s.entities.filter((e) => !original.includes(e.id));
      expect(out).toHaveLength(4);
      expect(extent(out)).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });
      for (const e of out)
        expect(
          out.some(
            (other) =>
              other.id !== e.id &&
              other.points.some((p) => dist(p, e.points[1]) < 0.001),
          ),
        ).toBe(true);
      valid(s);
    },
  );
  it("offsets a square inward and refuses collapse atomically", () => {
    const s = square(),
      original = ids(s);
    modifySketch(s, original, "offset", { distance: -2 });
    expect(extent(s.entities.slice(4))).toEqual({
      minX: 2,
      minY: 2,
      maxX: 8,
      maxY: 8,
    });
    valid(s);
    const collapsed = square(),
      before = clone(collapsed);
    expect(() =>
      modifySketch(collapsed, ids(collapsed), "offset", { distance: -6 }),
    ).toThrow("消失");
    expect(collapsed).toEqual(before);
  });
  it("offsets concave closed polygons with clipped joins and valid geometry", () => {
    const points = [
      [0, 0],
      [8, 0],
      [8, 3],
      [3, 3],
      [3, 8],
      [0, 8],
    ];
    const s = sketch(
      ...points.map(([x, y], i) =>
        line(x, y, ...(points[(i + 1) % points.length] as [number, number])),
      ),
    );
    modifySketch(s, ids(s), "offset", { distance: 1 });
    expect(s.entities.length).toBeGreaterThan(6);
    valid(s);
  });
  it.each([1, -1])(
    "offsets open L chains on the signed side %s",
    (distance) => {
      const s = sketch(line(0, 0, 10, 0), line(10, 0, 10, 10));
      modifySketch(s, ids(s), "offset", { distance });
      const out = s.entities.slice(2);
      expect(out).toHaveLength(2);
      expect(extent(out)).toEqual(
        distance > 0
          ? { minX: 0, maxX: 9, minY: 1, maxY: 10 }
          : { minX: 0, maxX: 11, minY: -1, maxY: 10 },
      );
      valid(s);
    },
  );
  it("supports tiny signed open-chain offsets without confusing the caps", () => {
    const s = sketch(line(0, 0, 10, 0), line(10, 0, 10, 10));
    modifySketch(s, ids(s), "offset", { distance: 0.0001 });
    expect(s.entities.slice(2)).toHaveLength(2);
    expect(s.entities[2].points[0].y).toBeCloseTo(0.0001, 6);
    valid(s);
  });
  it("offsets closed line-arc chains with bounded 0.001 sampling tolerance", () => {
    const arc = entity(
      "arc",
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 0, y: 5 },
      ],
      { ccw: true },
    );
    const s = sketch(arc, line(0, 5, 0, 0), line(0, 0, 5, 0));
    modifySketch(s, ids(s), "offset", { distance: 1 });
    const result = s.entities.slice(3);
    expect(result.length).toBeGreaterThan(20);
    expect(result.length).toBeLessThan(1000);
    const box = extent(result);
    expect(box.minX).toBeCloseTo(-1, 3);
    expect(box.minY).toBeCloseTo(-1, 3);
    expect(box.maxX).toBeCloseTo(6, 2);
    expect(box.maxY).toBeCloseTo(6, 2);
    valid(s);
  });
  it("rejects disconnected and branching chains", () => {
    const disconnected = sketch(line(0, 0, 2, 0), line(3, 0, 4, 0));
    expect(() =>
      modifySketch(disconnected, ids(disconnected), "offset", { distance: 1 }),
    ).toThrow("连续链");
    const branched = sketch(
      line(0, 0, 2, 0),
      line(2, 0, 3, 1),
      line(2, 0, 3, -1),
    );
    expect(() =>
      modifySketch(branched, ids(branched), "offset", { distance: 1 }),
    ).toThrow("分叉");
  });
  it.each(["ellipse", "spline", "bezier", "conic"] as const)(
    "produces valid sampled %s offsets explicitly labelled approximate",
    (kind) => {
      const curve =
        kind === "ellipse"
          ? entity(
              kind,
              [
                { x: 0, y: 0 },
                { x: 5, y: 0 },
              ],
              { ry: 3 },
            )
          : kind === "bezier"
            ? entity(kind, [
                { x: 0, y: 0 },
                { x: 2, y: 2 },
                { x: 4, y: 2 },
                { x: 6, y: 0 },
              ])
            : entity(
                kind,
                [
                  { x: 0, y: 0 },
                  { x: 3, y: 2 },
                  { x: 6, y: 0 },
                ],
                kind === "conic" ? { weight: 0.75 } : {},
              );
      const s = sketch(curve);
      modifySketch(s, [curve.id], "offset", { distance: 0.5 });
      expect(s.entities.length).toBeGreaterThan(10);
      expect(
        s.entities
          .slice(1)
          .every((e) => e.kind === "line" && e.name === "偏移（近似）"),
      ).toBe(true);
      valid(s);
    },
  );
  it("offsets single lines, circles and arcs exactly without derived links", () => {
    const s = sketch(line(0, 0, 4, 0));
    modifySketch(s, ids(s), "offset", { distance: 2 });
    expect(s.entities[1].points.map(xy)).toEqual([
      { x: 0, y: 2 },
      { x: 4, y: 2 },
    ]);
    valid(s);
    const curves = sketch(
      entity("circle", [{ x: 0, y: 0 }], { radius: 5 }),
      entity(
        "arc",
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 0, y: 5 },
        ],
        { ccw: false },
      ),
    );
    modifySketch(curves, [curves.entities[0].id], "offset", { distance: -2 });
    expect(curves.entities[2].radius).toBe(3);
    modifySketch(curves, [curves.entities[1].id], "offset", { distance: 2 });
    expect(arcInfo(curves.entities[3]).r).toBe(7);
    expect(curves.entities[3].ccw).toBe(false);
    valid(curves);
  });
});

describe("trim, break, and extend", () => {
  it("trims the picked middle line interval and removes all obsolete refs", () => {
    const a = line(0, 0, 10, 0),
      b = line(3, -1, 3, 1),
      c = line(7, -1, 7, 1),
      s = sketch(a, b, c);
    s.constraints.push(
      { id: "length", kind: "length", refs: [a.id], value: 10 },
      {
        id: "join",
        kind: "coincident",
        refs: [a.points[0].id, b.points[0].id],
      },
      { id: "vertical", kind: "vertical", refs: [b.id] },
    );
    expect(
      modifySketch(
        s,
        [a.id],
        "trim",
        {},
        { x: 5, y: 0 },
      ).removedConstraints.sort(),
    ).toEqual(["join", "length"]);
    expect(s.entities.slice(2).map((e) => e.points.map(xy))).toEqual([
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
      ],
      [
        { x: 7, y: 0 },
        { x: 10, y: 0 },
      ],
    ]);
    expect(s.constraints.map((c) => c.id)).toEqual(["vertical"]);
    valid(s);
  });
  it("trims an end using line-circle intersections", () => {
    const a = line(-10, 0, 10, 0),
      s = sketch(a, entity("circle", [{ x: 0, y: 0 }], { radius: 5 }));
    modifySketch(s, [a.id], "trim", {}, { x: -8, y: 0 });
    expect(s.entities[1].points[0].x).toBeCloseTo(-5);
    expect(s.entities[1].points[1].x).toBeCloseTo(10);
    valid(s);
  });
  it("trims a circle to its retained complementary arc", () => {
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 5 }),
      s = sketch(circle, line(-10, 0, 10, 0));
    modifySketch(s, [circle.id], "trim", {}, { x: 0, y: 5 });
    const arc = s.entities[1];
    expect(arc.kind).toBe("arc");
    expect(Math.abs(arcInfo(arc).sweep)).toBeCloseTo(Math.PI);
    expect(arc.points[1].x).toBeCloseTo(-5);
    valid(s);
  });
  it("trims a clockwise arc with exact intersections", () => {
    const arc = entity(
        "arc",
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: -5, y: 0 },
        ],
        { ccw: false },
      ),
      s = sketch(arc, line(0, -10, 0, 10));
    modifySketch(s, [arc.id], "trim", {}, { x: 3, y: -4 });
    expect(s.entities[1].ccw).toBe(false);
    expect(s.entities[1].points[1].y).toBeCloseTo(-5);
    valid(s);
  });
  it.each(["line", "arc"] as const)(
    "breaks a single %s into two valid pieces with no dangling refs",
    (kind) => {
      const a =
        kind === "line"
          ? line(0, 0, 10, 0)
          : entity(
              "arc",
              [
                { x: 0, y: 0 },
                { x: 5, y: 0 },
                { x: 0, y: 5 },
              ],
              { ccw: true },
            );
      const s = sketch(a);
      s.constraints.push({
        id: "length",
        kind: kind === "line" ? "length" : "radius",
        refs: [a.id],
        value: 5,
      });
      const pick =
        kind === "line"
          ? { x: 4, y: 0 }
          : { x: Math.sqrt(12.5), y: Math.sqrt(12.5) };
      expect(
        modifySketch(s, [a.id], "break", {}, pick).removedConstraints,
      ).toEqual(["length"]);
      expect(s.entities).toHaveLength(2);
      expect(
        dist(
          s.entities[0].points[kind === "line" ? 1 : 2],
          s.entities[1].points[kind === "line" ? 0 : 1],
        ),
      ).toBeLessThan(1e-6);
      valid(s);
    },
  );
  it("breaks cubic Bezier curves exactly via de Casteljau", () => {
    const curve = entity("bezier", [
        { x: 0, y: 0 },
        { x: 2, y: 5 },
        { x: 4, y: -2 },
        { x: 8, y: 1 },
      ]),
      s = sketch(curve);
    s.constraints.push({
      id: "coincident",
      kind: "coincident",
      refs: [curve.points[0].id, curve.points[3].id],
    });
    const t = 0.35,
      pick = bezierAt(curve.points, t);
    expect(
      modifySketch(s, [curve.id], "break", {}, pick).removedConstraints,
    ).toEqual(["coincident"]);
    expect(s.entities).toHaveLength(2);
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(
        dist(bezierAt(s.entities[0].points, u), bezierAt(curve.points, u * t)),
      ).toBeLessThan(1e-7);
      expect(
        dist(
          bezierAt(s.entities[1].points, u),
          bezierAt(curve.points, t + u * (1 - t)),
        ),
      ).toBeLessThan(1e-7);
    }
    valid(s);
  });
  it("extends the selected line end to the nearest unselected boundary", () => {
    const a = line(0, 0, 2, 0),
      s = sketch(a, line(5, -3, 5, 3), line(8, -3, 8, 3));
    s.constraints.push({
      id: "length",
      kind: "length",
      refs: [a.id],
      value: 2,
    });
    expect(
      modifySketch(s, [a.id], "extend", {}, { x: 2, y: 0 }).removedConstraints,
    ).toEqual(["length"]);
    expect(s.entities[0].points[1].x).toBe(5);
    valid(s);
  });
  it("extends the start of a line against circle boundaries", () => {
    const a = line(0, 0, 2, 0),
      s = sketch(a, entity("circle", [{ x: 0, y: 0 }], { radius: 5 }));
    modifySketch(s, [a.id], "extend", {}, { x: 0, y: 0 });
    expect(s.entities[0].points[0].x).toBe(-5);
    valid(s);
  });
  it("extends an arc end and start in their oriented direction", () => {
    const arc = entity(
      "arc",
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 0, y: 5 },
      ],
      { ccw: true },
    );
    const s = sketch(arc, line(-5, -10, -5, 10));
    modifySketch(s, [arc.id], "extend", {}, { x: 0, y: 5 });
    expect(s.entities[0].points[2].x).toBeCloseTo(-5);
    expect(Math.abs(arcInfo(s.entities[0]).sweep)).toBeCloseTo(Math.PI);
    valid(s);
    const start = sketch(arc, line(-10, -5, 10, -5));
    modifySketch(start, [arc.id], "extend", {}, { x: 5, y: 0 });
    expect(start.entities[0].points[1].y).toBeCloseTo(-5);
    expect(Math.abs(arcInfo(start.entities[0]).sweep)).toBeCloseTo(Math.PI);
    valid(start);
  });
  it("refuses unsupported topology and endpoint breaks with descriptive errors", () => {
    const unsupported = sketch(
      entity("bezier", [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 3, y: 0 },
      ]),
      line(1, -1, 1, 2),
    );
    expect(() =>
      modifySketch(
        unsupported,
        [unsupported.entities[0].id],
        "trim",
        {},
        { x: 1, y: 1 },
      ),
    ).toThrow("不支持");
    const s = sketch(line(0, 0, 1, 0));
    expect(() => modifySketch(s, ids(s), "break", {}, { x: 0, y: 0 })).toThrow(
      "端点",
    );
    expect(() => modifySketch(s, ids(s), "trim", {}, { x: 0.5, y: 0 })).toThrow(
      "边界",
    );
    valid(s);
  });
  it("blocks blend secondary-source topology until the dependent is detached", () => {
    const a = line(0, 0, 3, 0),
      b = line(8, 4, 8, 8);
    const blend = {
        ...blendEntity(a, b),
        id: uid(),
        sourceId: a.id,
        transform: { kind: "blend" as const, secondarySourceId: b.id },
      },
      s = sketch(a, b, blend);
    const before = clone(s);
    expect(() => modifySketch(s, [b.id], "break", {}, { x: 8, y: 6 })).toThrow(
      "派生",
    );
    expect(s).toEqual(before);
    modifySketch(s, [blend.id], "detach", {});
    expect(s.entities[2].sourceId).toBeUndefined();
    expect(s.entities[2].transform).toBeUndefined();
    modifySketch(s, [b.id], "break", {}, { x: 8, y: 6 });
    expect(s.entities).toHaveLength(4);
    expect(
      s.entities.some((e) => e.id === blend.id && e.kind === "bezier"),
    ).toBe(true);
    valid(s);
  });
  it("protects fixed blend geometry when the secondary source is transformed", () => {
    const a = line(0, 0, 3, 0),
      b = line(8, 4, 8, 8);
    const blend = {
        ...blendEntity(a, b),
        id: uid(),
        sourceId: a.id,
        transform: { kind: "blend" as const, secondarySourceId: b.id },
      },
      s = sketch(a, b, blend);
    s.constraints.push({
      id: "fixed-blend",
      kind: "fixed",
      refs: [blend.points[3].id],
      anchors: [clone(blend.points[3])],
    });
    const before = clone(s);
    expect(() => modifySketch(s, [b.id], "move", { dx: 1 })).toThrow("固定");
    expect(s).toEqual(before);
    valid(s);
  });
  it("refuses topology changes of a source with active derived copies", () => {
    const a = line(1, 0, 4, 0),
      axis = line(0, -1, 0, 1),
      s = sketch(a, axis);
    modifySketch(s, [a.id, axis.id], "mirror", {});
    const before = clone(s);
    expect(() => modifySketch(s, [a.id], "break", {}, { x: 2, y: 0 })).toThrow(
      "派生",
    );
    expect(s).toEqual(before);
  });
});
