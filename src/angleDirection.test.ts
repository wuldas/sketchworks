import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  entity,
  emptyDocument,
  validateDocument,
  type Entity,
  type Sketch,
  type XY,
  type AngleSector,
} from "./model";
import {
  angleDimensionFrame,
  cross,
  dist,
  selectAngleSector,
  sub,
} from "./geometry";
import { convertAngleSector, resolveAnglePlacement } from "./angleDimension";
import { initSolver, solveSketch } from "./solver";
import { placeDimensionLabel } from "./dimensionLabel";
import { applyParameters } from "./parameters";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);
const line = (a: XY, b: XY) => entity("line", [a, b]);
const sketch = (...entities: Entity[]): Sketch => ({
  id: "angles",
  name: "angles",
  visible: true,
  entities,
  constraints: [],
});
const crossing = () =>
  [
    line({ x: -20, y: 0 }, { x: 20, y: 0 }),
    line({ x: -10, y: -10 * Math.sqrt(3) }, { x: 10, y: 10 * Math.sqrt(3) }),
  ] as const;
const cases = [
  { point: { x: 10, y: 5 }, value: 60 },
  { point: { x: -5, y: 10 }, value: 120 },
  { point: { x: -10, y: -5 }, value: 60 },
  { point: { x: 5, y: -10 }, value: 120 },
];
const degrees = (a: Entity, b: Entity, sector: AngleSector) =>
  (Math.abs(angleDimensionFrame(a, b, sector).sweep) * 180) / Math.PI;

function polygon(clockwise = false, mixed = false) {
  const center = { x: 35, y: 23 },
    sign = clockwise ? -1 : 1,
    vertices = Array.from({ length: 6 }, (_, i) => {
      const angle = (sign * i * Math.PI) / 3;
      return {
        x: center.x + (20 + (i % 2 ? 0.25 : -0.2)) * Math.cos(angle),
        y: center.y + (20 + (i % 3 ? -0.15 : 0.2)) * Math.sin(angle),
      };
    }),
    reversed = vertices.map((_, i) => mixed && i % 2 === 1),
    lines = vertices.map((p, i) =>
      reversed[i]
        ? line(vertices[(i + 1) % 6], p)
        : line(p, vertices[(i + 1) % 6]),
    ),
    s = sketch(...lines);
  for (let i = 0; i < 6; i++) {
    const previous = (i + 5) % 6;
    s.constraints.push({
      id: `join-${i}`,
      kind: "coincident",
      refs: [
        lines[previous].points[reversed[previous] ? 0 : 1].id,
        lines[i].points[reversed[i] ? 1 : 0].id,
      ],
    });
  }
  const points = () => lines.map((e, i) => e.points[reversed[i] ? 1 : 0]);
  const convex = () => {
    const ps = points();
    for (let i = 0; i < 6; i++) {
      expect(
        sign *
          cross(
            sub(ps[(i + 1) % 6], ps[i]),
            sub(ps[(i + 2) % 6], ps[(i + 1) % 6]),
          ),
      ).toBeGreaterThan(1e-6);
      expect(dist(ps[i], ps[(i + 1) % 6])).toBeGreaterThan(1e-4);
    }
  };
  return { center, lines, s, convex };
}

describe("choosing angle rays from the annotation region", () => {
  for (const firstReverse of [false, true])
    for (const secondReverse of [false, true]) {
      it.each(cases)(
        `chooses $value degrees irrespective of endpoint order (${firstReverse},${secondReverse})`,
        ({ point, value }) => {
          const [a, b] = crossing();
          if (firstReverse) a.points.reverse();
          if (secondReverse) b.points.reverse();
          const sector = selectAngleSector(a, b, point);
          expect(degrees(a, b, sector)).toBeCloseTo(value, 7);
          const frame = angleDimensionFrame(a, b, sector),
            bisector = frame.start + frame.sweep / 2;
          expect(
            Math.cos(bisector) * point.x + Math.sin(bisector) * point.y,
          ).toBeGreaterThan(0);
        },
      );
    }
  it("defaults to rays pointing away from a joined polygon corner", () => {
    const { lines, s } = polygon();
    for (let i = 0; i < 6; i++) {
      const a = lines[(i + 5) % 6],
        b = lines[i],
        selected = resolveAnglePlacement(s, [a.id, b.id])!;
      expect(selected.value).toBeGreaterThan(110);
      expect(selected.value).toBeLessThan(130);
      expect(selected.angleSector).toEqual({
        reverseFirst: true,
        reverseSecond: false,
        clockwise: true,
      });
    }
  });
  it("converts complementary sectors without changing the underlying parameter relationship", () => {
    const [a, b] = crossing(),
      previous = selectAngleSector(a, b, cases[0].point),
      next = selectAngleSector(a, b, cases[1].point),
      changed = convertAngleSector(
        { value: 60, expression: "turn", angleSector: previous },
        next,
        120,
      );
    expect(changed.value).toBeCloseTo(120);
    expect(changed.expression).toBe("180 - (turn)");
    const legacy = convertAngleSector(
      { value: 60, expression: "turn" },
      { reverseFirst: true, reverseSecond: false, clockwise: true },
      120,
    );
    expect(legacy.value).toBe(120);
    expect(legacy.expression).toBe("180 - (turn)");
  });
  it("switches a parameter-driven legacy angle to the supplementary sector without moving geometry", () => {
    const [a, b] = crossing(),
      s = sketch(a, b),
      doc = emptyDocument();
    doc.sketches = [s];
    doc.parameters = [{ name: "turn", expression: "60", unit: "deg" }];
    s.constraints.push({
      id: "parameter-angle",
      kind: "angle",
      refs: [a.id, b.id],
      value: 60,
      expression: "turn",
      labelPosition: { x: 15, y: 5 },
    });
    expect(solveSketch(s).ok).toBe(true);
    const before = s.entities.map((e) => e.points.map((p) => ({ ...p }))),
      c = s.constraints[0];
    placeDimensionLabel(s, c, { x: -10, y: 15 });
    expect(c.value).toBeCloseTo(120);
    expect(c.expression).toBe("180 - (turn)");
    applyParameters(doc);
    expect(solveSketch(s).ok).toBe(true);
    s.entities.forEach((e, i) =>
      e.points.forEach((p, j) =>
        expect(dist(p, before[i][j])).toBeLessThan(1e-6),
      ),
    );
    doc.parameters[0].expression = "70";
    applyParameters(doc);
    expect(c.value).toBeCloseTo(110);
    expect(solveSketch(s).ok).toBe(true);
    expect(degrees(a, b, c.angleSector!)).toBeCloseTo(110, 5);
  });
  it("round trips ray flags and rejects malformed or non-angle direction metadata", () => {
    const [a, b] = crossing(),
      s = sketch(a, b),
      doc = emptyDocument();
    doc.sketches = [s];
    const angleSector = selectAngleSector(a, b, cases[1].point);
    s.constraints.push({
      id: "angle",
      kind: "angle",
      refs: [a.id, b.id],
      value: 120,
      angleSector,
    });
    const restored = validateDocument(doc);
    expect(restored.sketches[0].constraints[0].angleSector).toEqual(
      angleSector,
    );
    restored.sketches[0].constraints[0].angleSector!.clockwise = false;
    expect(s.constraints[0].angleSector!.clockwise).toBe(true);
    for (const bad of [
      null,
      {},
      { reverseFirst: "true", reverseSecond: false, clockwise: true },
      { reverseFirst: false, reverseSecond: false },
    ]) {
      const invalid = structuredClone(doc);
      Object.assign(invalid.sketches[0].constraints[0], { angleSector: bad });
      expect(() => validateDocument(invalid)).toThrow("角度方向");
    }
  });
});

describe("selected-ray native angles", () => {
  it.each(cases)(
    "retains the picked $value-degree crossing sector through real solving",
    ({ point, value }) => {
      const [a, b] = crossing(),
        s = sketch(a, b),
        sector = selectAngleSector(a, b, point);
      s.constraints.push({
        id: "angle",
        kind: "angle",
        refs: [a.id, b.id],
        value,
        angleSector: sector,
      });
      const result = solveSketch(s);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(degrees(a, b, sector)).toBeCloseTo(value, 5);
    },
  );
  it("supports a directed 120-degree constraint while editing a different crossing angle", () => {
    const a = line({ x: 0, y: 0 }, { x: 20, y: 0 }),
      b = line({ x: 0, y: 0 }, { x: 10, y: Math.sqrt(300) }),
      s = sketch(a, b),
      sector: AngleSector = {
        reverseFirst: false,
        reverseSecond: false,
        clockwise: false,
      };
    s.constraints.push(
      { id: "fixed", kind: "fixed", refs: [a.id] },
      {
        id: "joint",
        kind: "coincident",
        refs: [a.points[0].id, b.points[0].id],
      },
      { id: "length", kind: "length", refs: [b.id], value: 20 },
      {
        id: "angle",
        kind: "angle",
        refs: [a.id, b.id],
        value: 120,
        angleSector: sector,
      },
    );
    const result = solveSketch(s);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(degrees(a, b, sector)).toBeCloseTo(120, 5);
    expect(b.points[1].x).toBeLessThan(0);
    expect(b.points[1].y).toBeGreaterThan(0);
  });
  for (const clockwise of [false, true])
    for (const mixed of [false, true]) {
      it(`enforces all six 120-degree hexagon interiors without folding (cw=${clockwise},mixed=${mixed})`, () => {
        const { center, lines, s, convex } = polygon(clockwise, mixed);
        expect(solveSketch(s).ok).toBe(true);
        convex();
        for (let i = 0; i < 6; i++) {
          const a = lines[(i + 5) % 6],
            b = lines[i],
            selected = resolveAnglePlacement(s, [a.id, b.id], center)!;
          s.constraints.push({
            id: `angle-${i}`,
            kind: "angle",
            refs: [a.id, b.id],
            value: 120,
            angleSector: selected.angleSector,
          });
          const result = solveSketch(s);
          expect(result.ok, JSON.stringify({ index: i, result })).toBe(true);
          convex();
          for (const c of s.constraints.filter((c) => c.kind === "angle")) {
            const x = lines.find((e) => e.id === c.refs[0])!,
              y = lines.find((e) => e.id === c.refs[1])!;
            expect(degrees(x, y, c.angleSector!)).toBeCloseTo(120, 4);
          }
        }
        expect(s.constraints.filter((c) => c.kind === "angle")).toHaveLength(6);
        s.constraints.find((c) => c.id === "angle-5")!.value = 121;
        const before = structuredClone(s),
          result = solveSketch(s);
        expect(result.ok).toBe(false);
        expect(s).toEqual(before);
      });
    }
  it("rejects an unsatisfied fixed angle atomically instead of accepting another sector", () => {
    const [a, b] = crossing(),
      s = sketch(a, b),
      sector = selectAngleSector(a, b, cases[1].point);
    s.constraints.push(
      { id: "a-fixed", kind: "fixed", refs: [a.id] },
      { id: "b-fixed", kind: "fixed", refs: [b.id] },
      {
        id: "angle",
        kind: "angle",
        refs: [a.id, b.id],
        angleSector: sector,
        value: 60,
      },
    );
    const before = structuredClone(s),
      result = solveSketch(s);
    expect(result.ok).toBe(false);
    expect(s).toEqual(before);
  });
});
