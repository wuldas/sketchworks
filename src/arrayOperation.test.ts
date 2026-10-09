import { describe, expect, it } from "vitest";
import { emptyDocument, entity, clone, validateDocument } from "./model";
import { modifySketch } from "./operations";

const fixture = () => {
  const doc = emptyDocument(),
    s = doc.sketches[0];
  s.entities = [entity("point", [{ x: 3, y: 5 }])];
  return { doc, s, id: s.entities[0].id };
};

describe("rectangular array modes", () => {
  it("uses the oblique first direction and perpendicular second direction", () => {
    const { doc, s, id } = fixture();
    modifySketch(s, [id], "rectangularArray", {
      cols: 3,
      rows: 2,
      dx: 10,
      dy: 20,
      ux: 3,
      uy: 4,
    });
    expect(s.entities).toHaveLength(6);
    const offsets = s.entities.slice(1).map((e) => e.transform!);
    const expected = [
      [6, 8],
      [12, 16],
      [-16, 12],
      [-10, 20],
      [-4, 28],
    ];
    offsets.forEach((t, i) => {
      expect(t.x).toBeCloseTo(expected[i][0], 8);
      expect(t.y).toBeCloseTo(expected[i][1], 8);
    });
    expect(() => validateDocument(doc)).not.toThrow();
  });

  it("distributes the requested range and preserves the original in reverse mode", () => {
    const { s, id } = fixture();
    modifySketch(s, [id], "rectangularArray", {
      cols: 4,
      rows: 1,
      dx: 30,
      dy: 0,
      range: 1,
      direction1: -1,
    });
    expect(s.entities.map((e) => e.points[0].x)).toEqual([3, -7, -17, -27]);
  });

  it("centers odd symmetric counts on the original in both directions", () => {
    const { s, id } = fixture();
    modifySketch(s, [id], "rectangularArray", {
      cols: 3,
      rows: 3,
      dx: 20,
      dy: 40,
      range: 1,
      direction1: 0,
      direction2: 0,
    });
    expect(s.entities).toHaveLength(9);
    const xs = s.entities.map((e) => e.points[0].x),
      ys = s.entities.map((e) => e.points[0].y);
    expect(new Set(xs)).toEqual(new Set([-7, 3, 13]));
    expect(new Set(ys)).toEqual(new Set([-15, 5, 25]));
    expect(
      s.entities.filter((e) => e.points[0].x === 3 && e.points[0].y === 5),
    ).toHaveLength(1);
  });

  it.each([
    { cols: 2, rows: 1, direction1: 0 },
    { cols: 4, rows: 1, direction1: 0 },
    { cols: 1, rows: 2, direction2: 0 },
    { cols: 1, rows: 4, direction2: 0 },
  ])("rejects an even symmetric count atomically: %j", (mode) => {
    const { s, id } = fixture(),
      before = clone(s);
    expect(() =>
      modifySketch(s, [id], "rectangularArray", {
        dx: 10,
        dy: 10,
        range: 1,
        ...mode,
        direction1: mode.direction1 ?? 1,
        direction2: mode.direction2 ?? 1,
      }),
    ).toThrow(/奇数/);
    expect(s).toEqual(before);
  });
});

describe("mirror axis persistence", () => {
  it("rejects a derived axis without modifying the document", () => {
    const { doc, s, id } = fixture();
    const source = entity("line", [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);
    s.entities.push(source);
    modifySketch(s, [source.id], "rectangularArray", {
      cols: 2,
      rows: 1,
      dx: 20,
    });
    const derived = s.entities.find((e) => e.sourceId === source.id)!;
    const before = clone(doc);
    expect(() => modifySketch(s, [id, derived.id], "mirror", {})).toThrow(
      /轴须先解除关联/,
    );
    expect(doc).toEqual(before);
    expect(() => validateDocument(doc)).not.toThrow();
  });
});
