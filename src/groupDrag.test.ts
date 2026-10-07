import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createGeometry, defaultConfig } from "./creation";
import {
  clone,
  emptyDocument,
  entity,
  type Document,
  type Entity,
  type XY,
} from "./model";
import {
  dragPosition,
  resolveBodyDragEntities,
  solveDrag,
  type DocumentSolver,
} from "./dragTransaction";
import { initSolver, solveSketch } from "./solver";

const require = createRequire(import.meta.url);
let restoreNativeLog: (() => void) | undefined;
beforeAll(async () => {
  await initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  );
  // PlaneGCS logs redundant-solving diagnostics for every valid slot frame.
  const nativeLog = vi.spyOn(console, "log").mockImplementation(() => {});
  restoreNativeLog = () => nativeLog.mockRestore();
});
afterAll(() => restoreNativeLog?.());

type Fixture =
  | "rectangle"
  | "slot"
  | "arcSlot"
  | "polygon"
  | "dimensioned rectangle";
const fixtures: Fixture[] = [
  "rectangle",
  "slot",
  "arcSlot",
  "polygon",
  "dimensioned rectangle",
];
const inputs: Record<Exclude<Fixture, "dimensioned rectangle">, XY[]> = {
  rectangle: [
    { x: 2, y: 3 },
    { x: 35, y: 25 },
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
  polygon: [
    { x: 3, y: 4 },
    { x: 20, y: 9 },
  ],
};
function fixture(name: Fixture) {
  const document = emptyDocument(),
    sketch = document.sketches[0];
  const tool = name === "dimensioned rectangle" ? "rectangle" : name;
  Object.assign(
    sketch,
    createGeometry(tool, inputs[tool], {
      ...defaultConfig,
      sides: 4,
      autoConstraint: false,
    }),
  );
  if (name === "dimensioned rectangle") {
    sketch.constraints.push(
      { id: "width", kind: "length", refs: [sketch.entities[0].id], value: 33 },
      {
        id: "height",
        kind: "length",
        refs: [sketch.entities[1].id],
        value: 22,
      },
    );
  }
  expect(solveSketch(sketch).ok).toBe(true);
  return document;
}
const solve: DocumentSolver = (document, driver) =>
  solveSketch(document.sketches[0], driver);
const success = () => ({
  ok: true,
  dof: 2,
  status: "Success",
  conflicting: [],
});
const deltas: XY[] = [
  { x: 2, y: 1 },
  { x: 5, y: 2 },
  { x: 10, y: 4 },
  { x: 20, y: 8 },
  { x: 35, y: 14 },
  { x: 50, y: 20 },
  { x: 50, y: 20 },
  { x: 50, y: 20 },
  { x: 60, y: 24 },
  { x: 80, y: 32 },
  { x: 100, y: 40 },
  { x: 20, y: 8 },
  { x: 31, y: 14 },
  { x: 35, y: 14 },
  { x: 31, y: 14 },
  { x: 35, y: 14 },
  { x: 35, y: 14 },
  { x: 35, y: 14 },
  { x: 36, y: 14 },
];
function expectTranslated(before: Document, after: Document, shift: XY) {
  const initial = before.sketches[0],
    actual = after.sketches[0];
  expect(actual.constraints).toEqual(initial.constraints);
  expect(actual.entities.length).toBe(initial.entities.length);
  actual.entities.forEach((item, index) => {
    const original = initial.entities[index];
    expect(item.id).toBe(original.id);
    expect(item.ccw).toBe(original.ccw);
    expect(item.points.length).toBe(original.points.length);
    item.points.forEach((point, pointIndex) => {
      const originalPoint = original.points[pointIndex];
      expect(point.id).toBe(originalPoint.id);
      expect(point.x).toBeCloseTo(originalPoint.x + shift.x, 6);
      expect(point.y).toBeCloseTo(originalPoint.y + shift.y, 6);
    });
    for (const key of [
      "radius",
      "ry",
      "fontSize",
      "rotation",
      "weight",
    ] as const) {
      if (original[key] === undefined) expect(item[key]).toBeUndefined();
      else expect(item[key]).toBeCloseTo(original[key]!, 6);
    }
    if (item.kind === "line") {
      expect(item.points[1].x - item.points[0].x).toBeCloseTo(
        original.points[1].x - original.points[0].x,
        6,
      );
      expect(item.points[1].y - item.points[0].y).toBeCloseTo(
        original.points[1].y - original.points[0].y,
        6,
      );
    }
  });
}

for (const selectionMode of ["one body", "all members"] as const) {
  describe(`${selectionMode} with real PlaneGCS WASM and snapping disabled`, () => {
    it.each(fixtures)(
      "%s preserves all offsets through moves, holds, jitter, and release",
      (name) => {
        const before = fixture(name),
          baseline = clone(before),
          sketch = before.sketches[0];
        const selection = sketch.entities
          .slice(0, selectionMode === "one body" ? 1 : undefined)
          .map((item) => ({ entityId: item.id }));
        const primary = selection[0],
          origin = dragPosition(before, sketch.id, primary)!;
        const entityIds = resolveBodyDragEntities(sketch, selection, primary);
        expect(entityIds).toEqual(sketch.entities.map((item) => item.id));
        let accepted = clone(before),
          previousTarget = origin;
        for (const delta of deltas) {
          const target = { x: origin.x + delta.x, y: origin.y + delta.y },
            input = clone(accepted);
          const result = solveDrag(
            accepted,
            sketch.id,
            selection,
            { ...primary, delta, target, phase: "move", exact: false },
            solve,
            { previousTarget, entityIds },
          );
          expect(result.result.ok).toBe(true);
          expect(result.point.x).toBeCloseTo(target.x, 6);
          expect(result.point.y).toBeCloseTo(target.y, 6);
          expectTranslated(before, result.document, delta);
          expect(accepted).toEqual(input);
          expect(before).toEqual(baseline);
          accepted = result.document;
          previousTarget = target;
        }
        const result = solveDrag(
          accepted,
          sketch.id,
          selection,
          {
            ...primary,
            delta: deltas.at(-1)!,
            target: previousTarget,
            phase: "end",
            exact: false,
          },
          solve,
          { previousTarget, entityIds },
        );
        expect(result.result.ok).toBe(true);
        expectTranslated(before, result.document, deltas.at(-1)!);
        expect(before).toEqual(baseline);
      },
    );
  });
}

describe("body drag transaction boundaries", () => {
  it.each(fixtures)(
    "%s remains compatible with five-argument calls and automatically expanded bodies",
    (name) => {
      const before = fixture(name),
        sketch = before.sketches[0],
        primary = { entityId: sketch.entities[0].id };
      const origin = dragPosition(before, sketch.id, primary)!;
      let accepted = before;
      for (const delta of [
        { x: 35, y: 14 },
        { x: 35, y: 14 },
        { x: 50, y: 20 },
      ]) {
        const result = solveDrag(
          accepted,
          sketch.id,
          [primary],
          {
            ...primary,
            delta,
            target: { x: origin.x + delta.x, y: origin.y + delta.y },
            phase: "move",
          },
          solve,
        );
        expectTranslated(before, result.document, delta);
        accepted = result.document;
      }
    },
  );

  it("stops component expansion at fixed entities and rejects an explicitly selected fixed member", () => {
    const document = emptyDocument(),
      sketch = document.sketches[0];
    const members = [0, 10, 20].map((x) =>
      entity("line", [
        { x, y: 0 },
        { x: x + 10, y: 0 },
      ]),
    );
    sketch.entities.push(...members);
    sketch.constraints.push(
      {
        id: "ab",
        kind: "coincident",
        refs: [members[0].points[1].id, members[1].points[0].id],
      },
      {
        id: "bc",
        kind: "coincident",
        refs: [members[1].points[1].id, members[2].points[0].id],
      },
      { id: "fixed", kind: "fixed", refs: [members[1].points[0].id] },
    );
    const primary = { entityId: members[0].id };
    expect(resolveBodyDragEntities(sketch, [primary], primary)).toEqual([
      members[0].id,
    ]);
    expect(() =>
      resolveBodyDragEntities(
        sketch,
        [primary, { entityId: members[1].id }],
        primary,
      ),
    ).toThrow("固定对象");
    expect(() =>
      solveDrag(
        document,
        sketch.id,
        [primary, { entityId: members[1].id }],
        {
          ...primary,
          delta: { x: 1, y: 0 },
          target: { x: 1, y: 0 },
          phase: "move",
        },
        solve,
        { entityIds: [members[0].id] },
      ),
    ).toThrow("固定对象");
  });

  it("does not move or rewrite derived relationships when resolving a source body", () => {
    const document = emptyDocument(),
      sketch = document.sketches[0];
    const source = entity("point", [{ x: 3, y: 7 }]);
    const derived = entity("point", [{ x: 13, y: 7 }], {
      sourceId: source.id,
      transform: { kind: "translate", x: 10, y: 0 },
    });
    sketch.entities.push(source, derived);
    const primary = { entityId: source.id },
      baseline = clone(document);
    expect(resolveBodyDragEntities(sketch, [primary], source.id)).toEqual([
      source.id,
    ]);
    const result = solveDrag(
      document,
      sketch.id,
      [primary],
      {
        ...primary,
        delta: { x: 7, y: 13 },
        target: { x: 10, y: 20 },
        phase: "move",
      },
      () => success(),
    );
    expect(result.document.sketches[0].entities[1]).toEqual(derived);
    expect(document).toEqual(baseline);
    expect(() =>
      resolveBodyDragEntities(
        sketch,
        [primary, { entityId: derived.id }],
        primary,
      ),
    ).toThrow("关联对象");
  });

  it("uses cached body IDs even when unrelated live selection changes", () => {
    const before = fixture("rectangle"),
      sketch = before.sketches[0],
      extra = entity("point", [{ x: 200, y: 200 }]);
    sketch.entities.push(extra);
    const primary = { entityId: sketch.entities[0].id },
      frozen = resolveBodyDragEntities(sketch, [primary], primary);
    const result = solveDrag(
      before,
      sketch.id,
      [primary, { entityId: extra.id }],
      {
        ...primary,
        delta: { x: 35, y: 14 },
        target: { x: 37, y: 17 },
        phase: "move",
      },
      solve,
      { entityIds: frozen },
    );
    expect(result.document.sketches[0].entities.at(-1)).toEqual(extra);
    expect(result.point).toEqual({ x: 37, y: 17 });
  });

  it.each(["move", "canonical"] as const)(
    "rejects a successful %s solve that mirrors a body, without mutating the accepted seed",
    (stage) => {
      const before = fixture("dimensioned rectangle"),
        baseline = clone(before),
        sketch = before.sketches[0];
      const primary = { entityId: sketch.entities[0].id };
      const deform: DocumentSolver = (candidate, driver) => {
        if (
          (stage === "move" && driver) ||
          (stage === "canonical" && !driver)
        ) {
          const item = candidate.sketches[0].entities[0];
          item.points[1].x = item.points[0].x - 33;
        }
        return success();
      };
      expect(() =>
        solveDrag(
          before,
          sketch.id,
          [primary],
          {
            ...primary,
            delta: { x: 35, y: 14 },
            target: { x: 37, y: 17 },
            phase: stage === "canonical" ? "end" : "move",
          },
          deform,
        ),
      ).toThrow("整体拖动");
      expect(before).toEqual(baseline);
    },
  );

  it.each(["radius", "ry", "fontSize", "rotation", "weight"] as const)(
    "rejects a body solver that changes %s",
    (key) => {
      const document = emptyDocument(),
        sketch = document.sketches[0];
      const item = entity(
        "ellipse",
        [
          { x: 3, y: 7 },
          { x: 8, y: 7 },
        ],
        { radius: 5, ry: 2, fontSize: 12, rotation: 0, weight: 0.7 },
      );
      sketch.entities.push(item);
      const baseline = clone(document),
        primary = { entityId: item.id };
      const deform: DocumentSolver = (candidate) => {
        const moving: Entity = candidate.sketches[0].entities[0];
        moving[key] = moving[key]! + 1;
        return success();
      };
      expect(() =>
        solveDrag(
          document,
          sketch.id,
          [primary],
          {
            ...primary,
            delta: { x: 7, y: 13 },
            target: { x: 10, y: 20 },
            phase: "move",
          },
          deform,
        ),
      ).toThrow("整体拖动");
      expect(document).toEqual(baseline);
    },
  );

  it("allows a hard constraint to project a soft body target while preserving rigid geometry", () => {
    const document = emptyDocument(),
      sketch = document.sketches[0];
    const fixed = entity("line", [
      { x: -100, y: 0 },
      { x: 100, y: 0 },
    ]);
    const moving = entity("line", [
      { x: 3, y: 0 },
      { x: 13, y: 0 },
    ]);
    sketch.entities.push(fixed, moving);
    sketch.constraints.push(
      { id: "fixed", kind: "fixed", refs: [fixed.id] },
      { id: "horizontal", kind: "horizontal", refs: [moving.id] },
      { id: "length", kind: "length", refs: [moving.id], value: 10 },
      { id: "onLine", kind: "onLine", refs: [moving.points[0].id, fixed.id] },
    );
    expect(solveSketch(sketch).ok).toBe(true);
    const baseline = clone(document),
      primary = { entityId: moving.id };
    expect(resolveBodyDragEntities(sketch, [primary], primary)).toEqual([
      moving.id,
    ]);
    const result = solveDrag(
      document,
      sketch.id,
      [primary],
      {
        ...primary,
        delta: { x: 7, y: 7 },
        target: { x: 10, y: 7 },
        phase: "move",
      },
      solve,
    );
    expect(result.point.x).toBeCloseTo(10, 6);
    expect(result.point.y).toBeCloseTo(0, 6);
    const line = result.document.sketches[0].entities[1];
    expect(line.points[1].x).toBeCloseTo(20, 6);
    expect(line.points[1].y).toBeCloseTo(0, 6);
    expect(result.document.sketches[0].entities[0]).toEqual(fixed);
    expect(document).toEqual(baseline);
  });

  it("keeps point dragging soft and allows deformation under its hard constraints", () => {
    const document = emptyDocument(),
      sketch = document.sketches[0];
    const line = entity("line", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    sketch.entities.push(line);
    sketch.constraints.push(
      { id: "fixed", kind: "fixed", refs: [line.points[0].id] },
      { id: "horizontal", kind: "horizontal", refs: [line.id] },
    );
    expect(solveSketch(sketch).ok).toBe(true);
    const baseline = clone(document);
    const result = solveDrag(
      document,
      sketch.id,
      [{ entityId: line.id }],
      {
        entityId: line.id,
        pointId: line.points[1].id,
        delta: { x: 10, y: 7 },
        target: { x: 20, y: 7 },
        phase: "move",
      },
      solve,
      { previousTarget: { x: 10, y: 0 }, entityIds: [line.id] },
    );
    expect(result.point.x).toBeCloseTo(20, 6);
    expect(result.point.y).toBeCloseTo(0, 6);
    expect(result.document.sketches[0].entities[0].points[0]).toEqual(
      line.points[0],
    );
    expect(document).toEqual(baseline);
  });
});
