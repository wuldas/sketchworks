import { describe, expect, it } from "vitest";
import { circularDimensionEndpoints } from "./circularDimension";
import { dist } from "./geometry";
import { demoDocument } from "./model";

const center = { x: 12, y: -7 };
describe("circular dimension spans", () => {
  it.each([
    undefined,
    { x: 40, y: -7 },
    { x: -10, y: -7 },
    { x: 12, y: 20 },
    { x: 12, y: -7 },
  ])("spans a complete diameter toward label %j", (position) => {
    const { a, b } = circularDimensionEndpoints(
      center,
      8,
      "diameter",
      position,
    );
    expect(dist(a, b)).toBeCloseTo(16, 10);
    expect(dist(a, center)).toBeCloseTo(8, 10);
    expect(dist(b, center)).toBeCloseTo(8, 10);
    expect((a.x + b.x) / 2).toBeCloseTo(center.x, 10);
    expect((a.y + b.y) / 2).toBeCloseTo(center.y, 10);
  });
  it("retains the explicitly chosen radius span", () => {
    const { a, b } = circularDimensionEndpoints(center, 8, "radius", {
      x: 12,
      y: 20,
    });
    expect(a).toEqual(center);
    expect(b).toEqual({ x: 12, y: 1 });
    expect(dist(a, b)).toBe(8);
  });
  it("keeps diameter endpoints on their circle after translation", () => {
    const moved = { x: center.x + 25, y: center.y - 18 };
    const first = circularDimensionEndpoints(center, 8, "diameter", {
      x: 40,
      y: -7,
    });
    const second = circularDimensionEndpoints(moved, 8, "diameter", {
      x: 65,
      y: -25,
    });
    for (const key of ["a", "b"] as const) {
      expect(second[key].x - first[key].x).toBeCloseTo(25, 10);
      expect(second[key].y - first[key].y).toBeCloseTo(-18, 10);
    }
  });
  it("uses diameter values for example circle dimensions", () => {
    const sketch = demoDocument().sketches[0];
    const dimensions = sketch.constraints.filter((c) => c.kind === "diameter");
    expect(dimensions).toHaveLength(4);
    for (const c of dimensions) {
      const circle = sketch.entities.find((e) => e.id === c.refs[0])!;
      expect(circle.kind).toBe("circle");
      expect(c.value).toBe(2 * circle.radius!);
    }
  });
});
