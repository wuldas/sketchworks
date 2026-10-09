import { type XY } from "./model";
import { dist, EPS } from "./geometry";

/** Radial labels define a ray; a diameter spans both ends of that ray. */
export function circularDimensionEndpoints(
  center: XY,
  radius: number,
  kind: "radius" | "diameter",
  position?: XY,
): { a: XY; b: XY } {
  const length = position ? dist(center, position) : 0;
  const direction =
    position && length > EPS
      ? {
          x: (position.x - center.x) / length,
          y: (position.y - center.y) / length,
        }
      : { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const delta = { x: direction.x * radius, y: direction.y * radius };
  return {
    a:
      kind === "diameter"
        ? { x: center.x - delta.x, y: center.y - delta.y }
        : { ...center },
    b: { x: center.x + delta.x, y: center.y + delta.y },
  };
}
