import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  entity,
  emptyDocument,
  validateDocument,
  type Constraint,
  type Entity,
  type Sketch,
  type XY,
} from "./model";
import {
  dimensionLabelAnchor,
  dimensionLabelPosition,
  dimensionReferences,
  placeDimensionLabel,
  prepareDimensionLabels,
  updateDimensionLabels,
} from "./dimensionLabel";
import { dist, pointLineDistance, projection } from "./geometry";
import { modifySketch } from "./operations";
import { initSolver, solveSketch } from "./solver";
import { solveDrag, type DocumentSolver } from "./dragTransaction";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);
const sketch = (...entities: Entity[]): Sketch => ({
  id: "labels",
  name: "labels",
  visible: true,
  entities,
  constraints: [],
});
const line = () =>
  entity("line", [
    { x: -20, y: 0 },
    { x: 20, y: 0 },
  ]);
const near = (a: XY | undefined, b: XY) => {
  expect(a).toBeDefined();
  expect(dist(a!, b)).toBeLessThan(1e-6);
};
const documentFor = (s: Sketch) => ({ ...emptyDocument(), sketches: [s] });
const solve: DocumentSolver = (doc, driver) =>
  solveSketch(doc.sketches[0], driver);
const dimension = (
  s: Sketch,
  kind: Constraint["kind"],
  refs: string[],
  world: XY,
): Constraint => {
  const c: Constraint = {
    id: `label-${s.constraints.length}`,
    kind,
    refs,
    labelPosition: { ...world },
  };
  s.constraints.push(c);
  return c;
};

function fixture(kind: Constraint["kind"]): { s: Sketch; c: Constraint } {
  if (kind === "radius" || kind === "diameter") {
    const e = entity("circle", [{ x: 0, y: 0 }], { radius: 10 }),
      s = sketch(e);
    return { s, c: dimension(s, kind, [e.id], { x: 16, y: 4 }) };
  }
  if (kind === "angle") {
    const a = line(),
      b = entity("line", [
        { x: 0, y: -20 },
        { x: 0, y: 20 },
      ]),
      s = sketch(a, b);
    return { s, c: dimension(s, kind, [a.id, b.id], { x: 10, y: 10 }) };
  }
  if (kind === "lineDistance") {
    const a = line(),
      p = entity("point", [{ x: 0, y: 10 }]),
      s = sketch(a, p);
    return { s, c: dimension(s, kind, [p.points[0].id, a.id], { x: 8, y: 5 }) };
  }
  const e =
      kind === "distanceY"
        ? entity("line", [
            { x: 0, y: -20 },
            { x: 0, y: 20 },
          ])
        : line(),
    s = sketch(e);
  return {
    s,
    c: dimension(
      s,
      kind,
      [e.id],
      kind === "distanceY" ? { x: 8, y: 0 } : { x: 0, y: 8 },
    ),
  };
}

describe("geometry-relative dimension placement", () => {
  it.each([
    { kind: "length", position: { x: 1000, y: 8 }, expected: { x: 0, y: 8 } },
    {
      kind: "distanceX",
      position: { x: 1000, y: 8 },
      expected: { x: 0, y: 8 },
    },
    {
      kind: "distanceY",
      position: { x: 8, y: 1000 },
      expected: { x: 8, y: 0 },
    },
    {
      kind: "lineDistance",
      position: { x: 8, y: 1000 },
      expected: { x: 8, y: 5 },
    },
    {
      kind: "angle",
      position: { x: Math.sqrt(200), y: 0 },
      expected: { x: 10, y: 10 },
    },
    { kind: "radius", position: { x: 16, y: 4 }, expected: { x: 16, y: 4 } },
    { kind: "diameter", position: { x: 16, y: 4 }, expected: { x: 16, y: 4 } },
  ] as const)(
    "fits the displayed $kind label rather than its raw pointer position",
    ({ kind, position, expected }) => {
      const { s, c } = fixture(kind);
      c.labelPosition = position;
      near(dimensionLabelAnchor(c, dimensionReferences(s)), expected);
    },
  );

  it.each([
    "length",
    "distanceX",
    "distanceY",
    "lineDistance",
    "radius",
    "diameter",
    "angle",
  ] as const)(
    "keeps %s placement relative to the translated geometry",
    (kind) => {
      const { s, c } = fixture(kind),
        original = { ...c.labelPosition! };
      prepareDimensionLabels(s);
      const offset = { ...c.labelOffset! };
      for (const e of s.entities)
        for (const p of e.points) {
          p.x += 12;
          p.y -= 7;
        }
      near(dimensionLabelPosition(c, dimensionReferences(s)), {
        x: original.x + 12,
        y: original.y - 7,
      });
      updateDimensionLabels(s);
      near(c.labelPosition, { x: original.x + 12, y: original.y - 7 });
      expect(c.labelOffset).toEqual(offset);
      const restored = validateDocument(
        JSON.parse(JSON.stringify(documentFor(s))),
      ).sketches[0];
      updateDimensionLabels(restored);
      expect(restored.constraints[0]).toEqual(c);
    },
  );

  it("preserves the perpendicular gap while rotating a line", () => {
    const { s, c } = fixture("length");
    modifySketch(
      s,
      s.entities.map((e) => e.id),
      "rotate",
      { cx: 0, cy: 0, angle: 90 },
    );
    near(c.labelPosition, { x: 0, y: 8 }); // modifySketch commits cloned constraints.
    const placed = s.constraints[0],
      e = s.entities[0];
    near(placed.labelPosition, { x: -8, y: 0 });
    expect(
      pointLineDistance(placed.labelPosition!, e.points[0], e.points[1]),
    ).toBeCloseTo(8, 6);
  });

  it("keeps an arc leader relative to its rotating geometry", () => {
    const e = entity(
        "arc",
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 0, y: 10 },
        ],
        { radius: 10, ccw: true },
      ),
      s = sketch(e);
    dimension(s, "radius", [e.id], { x: 14, y: 4 });
    modifySketch(s, [e.id], "rotate", { angle: 90, cx: 0, cy: 0 });
    near(s.constraints[0].labelPosition, { x: -4, y: 14 });
  });

  it("stores a new offset when a label is dragged", () => {
    const { s, c } = fixture("length");
    prepareDimensionLabels(s);
    placeDimensionLabel(s, c, { x: 0, y: 14 });
    for (const p of s.entities[0].points) {
      p.x += 6;
      p.y += 9;
    }
    updateDimensionLabels(s);
    near(c.labelPosition, { x: 6, y: 23 });
    expect(c.labelOffset).toEqual({ x: 0, y: 14 });
  });

  it("migrates absolute legacy placements without changing their initial world position", () => {
    const e = entity("line", [
        { x: 3, y: 4 },
        { x: 19, y: 13 },
      ]),
      s = sketch(e),
      c = dimension(s, "length", [e.id], { x: 8, y: 20 });
    updateDimensionLabels(s);
    expect(c.labelPosition).toEqual({ x: 8, y: 20 });
    const before = JSON.stringify(s);
    updateDimensionLabels(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("retains geometry-relative placement when copying placed dimensions", () => {
    const { s } = fixture("length"),
      originalId = s.entities[0].id;
    modifySketch(s, [originalId], "copy", { dx: 15, dy: -4 });
    near(s.constraints[0].labelPosition, { x: 0, y: 8 });
    near(s.constraints[1].labelPosition, { x: 15, y: 4 });
    expect(s.constraints[1].labelOffset).toEqual(s.constraints[0].labelOffset);
    modifySketch(s, [s.entities[1].id], "move", { dx: 6, dy: 9 });
    near(s.constraints[1].labelPosition, { x: 21, y: 13 });
    near(s.constraints[0].labelPosition, { x: 0, y: 8 });
  });

  it("keeps a world-size gap during scaling rather than scaling the annotation offset", () => {
    const { s } = fixture("length");
    modifySketch(s, [s.entities[0].id], "scale", { factor: 2, cx: 0, cy: 0 });
    near(s.constraints[0].labelPosition, { x: 0, y: 8 });
  });

  it("uses the explicit point and line regardless of their reference order", () => {
    const { s, c } = fixture("lineDistance");
    c.refs.reverse();
    prepareDimensionLabels(s);
    expect(c.labelOffset).toEqual({ x: 8, y: 0 });
    const foot = projection(
      s.entities[1].points[0],
      s.entities[0].points[0],
      s.entities[0].points[1],
      false,
    ).point;
    expect(foot).toEqual({ x: 0, y: 0 });
  });

  it("rejects malformed persisted offsets", () => {
    for (const offset of [
      null,
      {},
      { x: "1", y: 2 },
      { x: Infinity, y: 0 },
      { x: 0, y: NaN },
      { x: 3e7 + 1, y: 0 },
    ]) {
      const { s, c } = fixture("length");
      Object.assign(c, { labelOffset: offset });
      expect(() => validateDocument(documentFor(s))).toThrow("偏移");
    }
  });
});

describe("dimension labels during real solved geometry drags", () => {
  it("follows repeated body drags and the final settlement without offset drift", () => {
    const { s, c } = fixture("length");
    c.value = 40;
    const id = s.entities[0].id,
      before = documentFor(s);
    const move = solveDrag(
      before,
      s.id,
      [],
      {
        entityId: id,
        phase: "move",
        delta: { x: 12, y: 6 },
        target: { x: -8, y: 6 },
      },
      solve,
    );
    near(move.document.sketches[0].constraints[0].labelPosition, {
      x: 12,
      y: 14,
    });
    const end = solveDrag(
      move.document,
      s.id,
      [],
      {
        entityId: id,
        phase: "end",
        delta: { x: 14, y: 8 },
        target: { x: -6, y: 8 },
        exact: true,
      },
      solve,
      { previousTarget: { x: -8, y: 6 } },
    );
    near(end.document.sketches[0].constraints[0].labelPosition, {
      x: 14,
      y: 16,
    });
    expect(end.document.sketches[0].constraints[0].labelOffset).toEqual({
      x: 0,
      y: 8,
    });
    expect(before.sketches[0].constraints[0]).not.toHaveProperty("labelOffset");
    near(before.sketches[0].constraints[0].labelPosition, { x: 0, y: 8 });
  });

  it("follows a circle when its center is dragged while preserving the leader gap", () => {
    const { s, c } = fixture("radius");
    c.value = 10;
    const e = s.entities[0],
      before = documentFor(s);
    const dragged = solveDrag(
      before,
      s.id,
      [],
      {
        entityId: e.id,
        pointId: e.points[0].id,
        phase: "end",
        delta: { x: 9, y: -3 },
        target: { x: 9, y: -3 },
        exact: true,
      },
      solve,
    );
    const after = dragged.document.sketches[0],
      circle = after.entities[0],
      placed = after.constraints[0];
    near(placed.labelPosition, { x: 25, y: 1 });
    expect(
      dist(placed.labelPosition!, circle.points[0]) - circle.radius!,
    ).toBeCloseTo(Math.hypot(16, 4) - 10, 6);
  });

  it("does not mutate positions or attach offsets to the input document when a drag fails", () => {
    const { s, c } = fixture("length");
    c.value = 40;
    s.constraints.push({
      id: "fixed",
      kind: "fixed",
      refs: [s.entities[0].id],
    });
    const doc = documentFor(s),
      before = structuredClone(doc),
      e = s.entities[0];
    expect(() =>
      solveDrag(
        doc,
        s.id,
        [],
        {
          entityId: e.id,
          pointId: e.points[0].id,
          phase: "end",
          delta: { x: 10, y: 0 },
          target: { x: -10, y: 0 },
          exact: true,
        },
        solve,
      ),
    ).toThrow();
    expect(doc).toEqual(before);
  });
});
