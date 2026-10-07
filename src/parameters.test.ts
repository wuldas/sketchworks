import { describe, it, expect } from "vitest";
import {
  evaluateExpression,
  resolveParameters,
  applyParameters,
  hasParameterReferences,
} from "./parameters";
import { emptyDocument, entity } from "./model";
describe("parameter expressions", () => {
  it("evaluates arithmetic and dependencies", () => {
    const p = resolveParameters([
      { name: "width", expression: "120", unit: "mm" },
      { name: "half", expression: "width / 2 + 5", unit: "mm" },
    ]);
    expect(p.get("half")?.value).toBe(65);
    expect(evaluateExpression("-(4 + 2) / 3")).toBe(-2);
  });
  it("rejects cycles, unit mixing and division by zero", () => {
    expect(() =>
      resolveParameters([
        { name: "a", expression: "b", unit: "mm" },
        { name: "b", expression: "a", unit: "mm" },
      ]),
    ).toThrow();
    expect(() => evaluateExpression("1 / 0")).toThrow();
    const vars = resolveParameters([
      { name: "length", expression: "10", unit: "mm" },
      { name: "angle", expression: "30", unit: "deg" },
    ]);
    expect(() => evaluateExpression("length+angle", vars)).toThrow();
  });
  it("rejects assignments, accessors and executable expressions", () => {
    for (const input of [
      "x=3",
      "[1,2]",
      "sqrt(4)",
      "constructor()",
      "a.b",
      "2^100",
      '"bad"',
    ])
      expect(() => evaluateExpression(input)).toThrow();
  });
  it("applies linked size expressions", () => {
    const doc = emptyDocument();
    doc.parameters = [{ name: "width", expression: "80", unit: "mm" }];
    doc.sketches[0].constraints = [
      { id: "c1", kind: "length", refs: ["line"], expression: "width / 2" },
    ];
    applyParameters(doc);
    expect(doc.sketches[0].constraints[0].value).toBe(40);
  });
  it("recomputes live transform spacing and angles", () => {
    const doc = emptyDocument();
    doc.parameters = [
      { name: "pitch", expression: "7", unit: "mm" },
      { name: "turn", expression: "60", unit: "deg" },
    ];
    const source = entity("circle", [{ x: 0, y: 0 }], { radius: 2 });
    const copy = entity("circle", [{ x: 7, y: 0 }], {
      radius: 2,
      sourceId: source.id,
      transform: {
        kind: "translate",
        xExpression: "2 * pitch",
        yExpression: "pitch / 2",
      },
    });
    const rotated = entity("circle", [{ x: 0, y: 0 }], {
      radius: 2,
      sourceId: source.id,
      transform: { kind: "rotate", angleExpression: "turn / 3" },
    });
    doc.sketches[0].entities.push(source, copy, rotated);
    applyParameters(doc);
    expect(copy.transform?.x).toBe(14);
    expect(copy.transform?.y).toBe(3.5);
    expect(rotated.transform?.angle).toBe(20);
    doc.parameters[0].expression = "9";
    doc.parameters[1].expression = "90";
    applyParameters(doc);
    expect(copy.transform?.x).toBe(18);
    expect(copy.transform?.y).toBe(4.5);
    expect(rotated.transform?.angle).toBe(30);
  });
  it("rejects wrong-dimensional transform expressions", () => {
    const doc = emptyDocument();
    doc.parameters = [{ name: "turn", expression: "60", unit: "deg" }];
    doc.sketches[0].entities = [
      entity("point", [{ x: 0, y: 0 }], {
        sourceId: "source",
        transform: { kind: "translate", xExpression: "turn" },
      }),
    ];
    expect(() => applyParameters(doc)).toThrow("单位");
    doc.sketches[0].entities[0].transform!.xExpression = "missing / 2";
    expect(() => applyParameters(doc)).toThrow("不存在");
  });
  it("accepts scientific notation and scalar constants", () => {
    expect(evaluateExpression("1e3 + 2")).toBe(1002);
    expect(evaluateExpression("2*pi")).toBeCloseTo(2 * Math.PI);
    expect(hasParameterReferences("1e3 + pi")).toBe(false);
    expect(hasParameterReferences("2*pitch")).toBe(true);
  });
});
