import { type XY } from "./model";
import { dist } from "./geometry";

export function appendSplinePoint<Ref>(
  points: XY[],
  refs: (Ref | undefined)[],
  point: XY,
  ref?: Ref,
) {
  const last = points.at(-1);
  if (last && dist(last, point) <= 1e-7) {
    if (!ref || refs[points.length - 1] === ref) return { points, refs };
    const nextRefs = [...refs];
    nextRefs[points.length - 1] = ref;
    return { points, refs: nextRefs };
  }
  return {
    points: [...points, { x: point.x, y: point.y }],
    refs: [...refs, ref],
  };
}
