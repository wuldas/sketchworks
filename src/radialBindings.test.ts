import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { appendGeometry, createGeometry, defaultConfig } from "./creation";
import { clone, emptyDocument, entity, validateDocument } from "./model";
import { canConstrain, initSolver, solveSketch } from "./solver";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);

function fixture(y: number, slot = false) {
  const doc = emptyDocument(),
    s = doc.sketches[0];
  const source = entity("point", [{ x: 0, y }]);
  s.entities.push(source);
  const coords = [{ x: 0, y: 0 }, { x: 10, y: 0 }, source.points[0]];
  if (slot) coords.push({ x: 0, y: 17 });
  const tool = slot ? "arcSlot" : "centerArc";
  const created = createGeometry(tool, coords, defaultConfig);
  appendGeometry(
    s,
    created,
    [
      { pointIndex: 0, point: coords[0], ref: { kind: "origin", refs: [] } },
      { pointIndex: 2, point: coords[2], ref: source.points[0].id },
    ],
    true,
    tool,
  );
  const arc = created.entities[0];
  const start = slot ? created.entities[2].points[0] : arc.points[1];
  const end = slot ? created.entities[3].points[0] : arc.points[2];
  s.constraints.push({ id: "start-fixed", kind: "fixed", refs: [start.id] });
  return { doc, s, source, arc, end };
}

const near = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
};

describe("captured radial directions with real PlaneGCS", () => {
  it.each([10, 15])(
    "keeps direction-only semantics when the initial input distance is %s",
    (y) => {
      const { doc, s, source, end } = fixture(y);
      expect(solveSketch(s).ok).toBe(true);
      near(end, 0, 10);
      expect(
        solveSketch(s, {
          pointId: source.points[0].id,
          x: 0,
          y: 20,
          exact: true,
        }).ok,
      ).toBe(true);
      near(source.points[0], 0, 20);
      near(end, 0, 10);
      expect(() => validateDocument(doc)).not.toThrow();
      const restored = validateDocument(JSON.parse(JSON.stringify(doc)));
      expect(restored.sketches[0].constraints.some((c) => c.sameRay)).toBe(
        true,
      );
      expect(solveSketch(restored.sketches[0]).ok).toBe(true);
    },
  );

  it.each([false, true])(
    "follows the positive ray when its captured source crosses the center (slot=%s)",
    (slot) => {
      const { s, source, end } = fixture(15, slot);
      expect(solveSketch(s).ok).toBe(true);
      const radius = Math.hypot(end.x, end.y);
      const result = solveSketch(s, {
        pointId: source.points[0].id,
        x: 0,
        y: -15,
        exact: true,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      near(source.points[0], 0, -15);
      near(end, 0, -radius);
    },
  );

  it("rejects the undefined center direction without publishing geometry or anchors", () => {
    const { s, source } = fixture(15);
    expect(solveSketch(s).ok).toBe(true);
    const before = clone(s);
    const result = solveSketch(s, {
      pointId: source.points[0].id,
      x: 0,
      y: 0,
      exact: true,
    });
    expect(result.ok).toBe(false);
    expect(s).toEqual(before);
  });

  it("does not capture a projected branch as the anchor of an initially fixed endpoint", () => {
    const { s, source, end } = fixture(15);
    s.constraints.push({ id: "end-fixed", kind: "fixed", refs: [end.id] });
    const before = clone(s);
    expect(
      solveSketch(s, {
        pointId: source.points[0].id,
        x: 0,
        y: -15,
        exact: true,
      }).ok,
    ).toBe(false);
    expect(s).toEqual(before);
  });

  it("keeps ordinary point-on-line incidence free to cross either side", () => {
    const s = emptyDocument().sketches[0];
    const line = entity("line", [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);
    const p = entity("point", [{ x: 0, y: 5 }]);
    s.entities.push(line, p);
    s.constraints.push(
      { id: "fixed-line", kind: "fixed", refs: [line.id] },
      { id: "ordinary-on-line", kind: "onLine", refs: [p.id, line.id] },
    );
    expect(
      solveSketch(s, { pointId: p.points[0].id, x: 0, y: -20, exact: true }).ok,
    ).toBe(true);
    near(p.points[0], 0, -20);
  });

  it("rejects a standalone point coincident with its own alias", () => {
    const s = emptyDocument().sketches[0],
      p = entity("point", [{ x: 2, y: 3 }]);
    s.entities.push(p);
    expect(
      canConstrain(s, "coincident", [p.id, p.points[0].id]),
    ).not.toBeNull();
    s.constraints.push({
      id: "self",
      kind: "coincident",
      refs: [p.id, p.points[0].id],
    });
    const before = clone(s);
    expect(solveSketch(s)).toMatchObject({ ok: false, conflicting: ["self"] });
    expect(s).toEqual(before);
  });
});
