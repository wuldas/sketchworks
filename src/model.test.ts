import { describe, expect, it } from "vitest";
import {
  type Document,
  type Transform,
  clone,
  deleteEntities,
  emptyDocument,
  entity,
  validateDocument,
} from "./model";

const line = (x = 0) =>
  entity("line", [
    { x, y: 0 },
    { x: x + 4, y: 0 },
  ]);
function associatedDocument() {
  const d = emptyDocument(),
    s = d.sketches[0],
    a = line(),
    b = line(8),
    axis = entity("line", [
      { x: 0, y: -2 },
      { x: 0, y: 2 },
    ]);
  const array = entity(
    "line",
    [
      { x: 0, y: 2 },
      { x: 4, y: 2 },
    ],
    {
      sourceId: a.id,
      transform: { kind: "translate", y: 2, yExpression: "pitch" },
    },
  );
  const mirror = entity(
    "line",
    [
      { x: 0, y: 0 },
      { x: -4, y: 0 },
    ],
    { sourceId: a.id, transform: { kind: "mirror", axisId: axis.id } },
  );
  const blend = entity(
    "bezier",
    [
      { x: 4, y: 0 },
      { x: 5, y: 0 },
      { x: 7, y: 0 },
      { x: 8, y: 0 },
    ],
    { sourceId: a.id, transform: { kind: "blend", secondarySourceId: b.id } },
  );
  s.entities.push(a, b, axis, array, mirror, blend);
  d.parameters.push({ name: "pitch", expression: "2", unit: "mm" });
  return { d, s, a, b, axis, array, mirror, blend };
}
function constraintRefsValid(d: Document) {
  for (const s of d.sketches) {
    const live = new Set(
      s.entities.flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
    );
    expect(s.constraints.every((c) => c.refs.every((r) => live.has(r)))).toBe(
      true,
    );
  }
}

describe("associated document validation and deletion", () => {
  it("rejects defined nonnumeric transform coordinates and angles", () => {
    for (const key of ["x", "y", "angle", "ax", "ay", "bx", "by"]) {
      for (const value of ["2", null, true]) {
        const { d, array } = associatedDocument();
        Object.assign(array.transform!, { [key]: value });
        expect(() => validateDocument(d)).toThrow("变换参数");
      }
    }
  });
  it("rejects inherited prototype names as entity and constraint kinds", () => {
    for (const kind of ["__proto__", "constructor", "toString"]) {
      const invalidEntity = associatedDocument();
      Object.assign(invalidEntity.a, { kind });
      expect(() => validateDocument(invalidEntity.d)).toThrow("几何类型");
      const invalidConstraint = associatedDocument();
      invalidConstraint.s.constraints.push({
        id: "invalid-kind",
        kind: kind as "horizontal",
        refs: [invalidConstraint.a.id],
      });
      expect(() => validateDocument(invalidConstraint.d)).toThrow("约束或引用");
    }
  });
  it("accepts associated arrays, mirrors, blends and fixed point anchors without sharing the result", () => {
    const { d, s, a } = associatedDocument();
    s.constraints.push({
      id: "fixed",
      kind: "fixed",
      refs: [a.points[0].id],
      anchors: [clone(a.points[0])],
    });
    const validated = validateDocument(d);
    expect(validated).toEqual(d);
    expect(validated).not.toBe(d);
    validated.sketches[0].entities[0].points[0].x = 50;
    expect(a.points[0].x).toBe(0);
  });
  it("cascades source deletion through arrays, mirrors, blends and affected point refs", () => {
    const { d, s, a, b, axis, array, mirror, blend } = associatedDocument();
    s.constraints.push(
      { id: "array", kind: "horizontal", refs: [array.id] },
      {
        id: "mirror-point",
        kind: "coincident",
        refs: [mirror.points[0].id, b.points[0].id],
      },
      {
        id: "blend-point",
        kind: "coincident",
        refs: [blend.points[3].id, b.points[0].id],
      },
      { id: "kept", kind: "horizontal", refs: [b.id] },
    );
    deleteEntities(s, [a.id]);
    expect(s.entities.map((e) => e.id)).toEqual([b.id, axis.id]);
    expect(s.constraints.map((c) => c.id)).toEqual(["kept"]);
    constraintRefsValid(d);
    expect(() => validateDocument(d)).not.toThrow();
  });
  it("cascades mirror-axis deletion without deleting its independent source or other dependents", () => {
    const { d, s, a, axis, mirror, array, blend } = associatedDocument();
    s.constraints.push({ id: "mirror", kind: "horizontal", refs: [mirror.id] });
    deleteEntities(s, [axis.id]);
    expect(s.entities.some((e) => e.id === mirror.id)).toBe(false);
    expect(
      s.entities.filter((e) => [a.id, array.id, blend.id].includes(e.id)),
    ).toHaveLength(3);
    expect(s.constraints).toEqual([]);
    constraintRefsValid(d);
    expect(() => validateDocument(d)).not.toThrow();
  });
  it("cascades secondary-source deletion only to its blend and dependent constraints", () => {
    const { d, s, b, blend, a, array, mirror } = associatedDocument();
    s.constraints.push({
      id: "blend",
      kind: "coincident",
      refs: [blend.points[0].id, a.points[1].id],
    });
    deleteEntities(s, [b.id]);
    expect(s.entities.some((e) => e.id === blend.id)).toBe(false);
    expect(
      s.entities.filter((e) => [a.id, array.id, mirror.id].includes(e.id)),
    ).toHaveLength(3);
    expect(s.constraints).toEqual([]);
    constraintRefsValid(d);
    expect(() => validateDocument(d)).not.toThrow();
  });
  it("rejects missing, nonline and derived mirror-axis references", () => {
    for (const invalid of ["missing", "circle", "derived"] as const) {
      const { d, s, mirror, array } = associatedDocument();
      if (invalid === "missing") mirror.transform!.axisId = "missing";
      if (invalid === "derived") mirror.transform!.axisId = array.id;
      if (invalid === "circle") {
        const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 3 });
        s.entities.push(circle);
        mirror.transform!.axisId = circle.id;
      }
      expect(() => validateDocument(d)).toThrow("镜像轴引用");
    }
  });
  it("rejects unknown transforms and missing, derived or non-Bezier blend references", () => {
    const unknown = associatedDocument();
    unknown.array.transform!.kind = "unsupported" as Transform["kind"];
    expect(() => validateDocument(unknown.d)).toThrow("变换参数");
    const missing = associatedDocument();
    missing.blend.transform!.secondarySourceId = "missing";
    expect(() => validateDocument(missing.d)).toThrow("过渡曲线引用");
    const derived = associatedDocument();
    derived.blend.transform!.secondarySourceId = derived.array.id;
    expect(() => validateDocument(derived.d)).toThrow("过渡曲线引用");
    const wrongKind = associatedDocument();
    wrongKind.blend.kind = "line";
    expect(() => validateDocument(wrongKind.d)).toThrow("过渡曲线引用");
  });
  it("rejects nonstring and oversized transform or constraint expressions", () => {
    for (const expr of [12, "x".repeat(501)]) {
      const transform = associatedDocument();
      transform.array.transform!.xExpression = expr as string;
      expect(() => validateDocument(transform.d)).toThrow("变换表达式");
      const constraint = associatedDocument();
      constraint.s.constraints.push({
        id: "length",
        kind: "length",
        refs: [constraint.a.id],
        expression: expr as string,
      });
      expect(() => validateDocument(constraint.d)).toThrow("约束或引用");
    }
  });
  it("preserves valid dimension label positions without sharing the imported object", () => {
    const { d, s, a } = associatedDocument();
    s.constraints.push({
      id: "length",
      kind: "length",
      refs: [a.id],
      value: 4,
      labelPosition: { x: 2, y: 8 },
      labelOffset: { x: 0, y: 8 },
    });
    const validated = validateDocument(d);
    expect(validated.sketches[0].constraints[0].labelPosition).toEqual({
      x: 2,
      y: 8,
    });
    validated.sketches[0].constraints[0].labelPosition!.x = 10;
    expect(s.constraints[0].labelPosition!.x).toBe(2);
    expect(validated.sketches[0].constraints[0].labelOffset).toEqual({
      x: 0,
      y: 8,
    });
    validated.sketches[0].constraints[0].labelOffset!.x = 10;
    expect(s.constraints[0].labelOffset!.x).toBe(0);
  });
  it("rejects malformed dimension label positions", () => {
    for (const labelPosition of [
      null,
      "position",
      {},
      { x: 1, y: NaN },
      { x: Infinity, y: 0 },
      { x: 1e8, y: 0 },
      { x: "1", y: 0 },
    ]) {
      const { d, s, a } = associatedDocument();
      s.constraints.push({
        id: "length",
        kind: "length",
        refs: [a.id],
        value: 4,
      });
      Object.assign(s.constraints[0], { labelPosition });
      expect(() => validateDocument(d)).toThrow("尺寸标注位置");
    }
  });
  it("rejects missing anchor refs, nonfinite/out-of-range coordinates and malformed anchor arrays", () => {
    for (const anchors of [
      [{ id: "missing", x: 0, y: 0 }],
      [{ id: "", x: Infinity, y: 0 }],
      [{ id: "", x: 1e8, y: 0 }],
      "not-an-array",
    ]) {
      const { d, s, a } = associatedDocument();
      if (Array.isArray(anchors) && anchors[0].id === "")
        anchors[0].id = a.points[0].id;
      s.constraints.push({
        id: "fixed",
        kind: "fixed",
        refs: [a.points[0].id],
        anchors: anchors as typeof a.points,
      });
      expect(() => validateDocument(d)).toThrow("锚点");
    }
  });
});
