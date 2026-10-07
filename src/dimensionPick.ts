import {
  type ConstraintKind,
  type Entity,
  type Selection,
  type Sketch,
  type XY,
  findPoint,
  referencePoint,
  resolveEntity,
} from "./model";
import {
  cross,
  dot,
  sub,
  pointLineDistance as geometryPointLineDistance,
} from "./geometry";
import { canConstrain } from "./solver";

export type DimensionPickMode = "auto" | ConstraintKind;
export type DimensionRequest = {
  kind: ConstraintKind;
  refs: string[];
  /** All references needed for this dimension have been picked. */
  complete: boolean;
};
const circular = (kind: string | undefined) =>
  kind === "circle" || kind === "arc";
const lineOf = (sketch: Sketch, ref: string) => {
  const entity = resolveEntity(sketch, ref);
  return entity?.kind === "line" && !findPoint(sketch, ref)
    ? entity
    : undefined;
};
const direction = (line: Entity) => sub(line.points[1], line.points[0]);
/** Sine of the angle between two lines; near zero means parallel. */
export const lineParallelism = (a: Entity, b: Entity) => {
  const da = direction(a),
    db = direction(b),
    length = Math.hypot(da.x, da.y) * Math.hypot(db.x, db.y);
  return length ? Math.abs(cross(da, db)) / length : 0;
};
/** Signed angle from the first line to the second, in degrees. */
export const linePairAngle = (a: Entity, b: Entity) => {
  const da = direction(a),
    db = direction(b);
  return (Math.atan2(cross(da, db), dot(da, db)) * 180) / Math.PI;
};
/** Perpendicular distance from a point to an infinite line. */
export const pointLineDistance = (point: XY, line: Entity) =>
  geometryPointLineDistance(point, line.points[0], line.points[1]);
/** Perpendicular distance between two parallel lines. */
export const parallelLineDistance = (a: Entity, b: Entity) =>
  pointLineDistance(a.points[0], b);
/** A point of the first line plus the second line describe the distance. */
const lineDistanceRefs = (a: Entity, b: Entity) => [a.points[0].id, b.id];
const PARALLEL_TOLERANCE = 1e-6;
export const isParallelPair = (a: Entity, b: Entity) =>
  lineParallelism(a, b) <= PARALLEL_TOLERANCE;

/** Hover previews a compatible second reference without confirming the pick. */
export function resolveDimensionPreview(
  sketch: Sketch,
  picked: readonly string[],
  preferred: DimensionPickMode = "auto",
  hovered: Selection | null = null,
): DimensionRequest | null {
  if (picked.length === 1 && hovered) {
    const candidate = resolveDimension(
      sketch,
      [...picked, hovered.pointId ?? hovered.entityId],
      preferred,
    );
    if (candidate?.complete) return candidate;
  }
  const request = resolveDimension(sketch, picked, preferred);
  return request?.complete ? request : null;
}

/** References needed before a fixed dimension type can be created. */
export function dimensionRefLimit(kind: ConstraintKind) {
  if (kind === "radius" || kind === "diameter") return 1;
  return 2;
}
export function selectionRefs(selection: readonly Selection[]) {
  return selection.map((item) => item.pointId ?? item.entityId);
}

/**
 * Turn accumulated references into a dimension request.
 * Returns null when the picked geometry cannot carry the requested dimension.
 */
export function resolveDimension(
  sketch: Sketch,
  picked: readonly string[],
  preferred: DimensionPickMode = "auto",
): DimensionRequest | null {
  const refs = [
    ...new Set(
      picked.map((ref) => {
        const e = resolveEntity(sketch, ref);
        return e?.kind === "point" ? e.points[0].id : ref;
      }),
    ),
  ];
  if (!refs.length) return null;
  const isPoint = (ref: string) => !!findPoint(sketch, ref);
  const entityKind = (ref: string) => resolveEntity(sketch, ref)?.kind;
  const lines = () =>
    refs
      .map((ref) => lineOf(sketch, ref))
      .filter((line): line is Entity => Boolean(line));
  const mixed =
    refs.length === 2 && refs.some(isPoint) && lines().length === 1
      ? [refs.find(isPoint)!, lines()[0].id]
      : null;
  const pointLineRequest = (): DimensionRequest | null =>
    mixed &&
    resolveEntity(sketch, mixed[0])?.id !== mixed[1] &&
    !canConstrain(sketch, "lineDistance", mixed)
      ? { kind: "lineDistance", refs: mixed, complete: true }
      : null;
  if (preferred !== "auto") {
    if (refs.length > dimensionRefLimit(preferred)) return null;
    if (preferred === "radius" || preferred === "diameter") {
      if (
        refs.length !== 1 ||
        isPoint(refs[0]) ||
        !circular(entityKind(refs[0]))
      )
        return null;
    } else if (preferred === "angle") {
      if (refs.some((ref) => isPoint(ref) || entityKind(ref) !== "line"))
        return null;
      // An angle between two lines needs both of them.
      if (refs.length < 2) return { kind: "angle", refs, complete: false };
    } else if (preferred === "lineDistance") {
      const pair = lines();
      if (refs.length === 1 && (pair.length === 1 || isPoint(refs[0])))
        return { kind: "lineDistance", refs, complete: false };
      if (mixed) return pointLineRequest();
      if (refs.length !== 2 || pair.length !== 2) return null;
      const distance = lineDistanceRefs(pair[0], pair[1]);
      return {
        kind: "lineDistance",
        refs: distance,
        complete: !canConstrain(sketch, "lineDistance", distance),
      };
    } else if (refs.length === 1) {
      if (isPoint(refs[0])) return { kind: preferred, refs, complete: false };
      if (entityKind(refs[0]) !== "line") return null;
    } else if (!refs.every(isPoint)) return null;
    return {
      kind: preferred,
      refs,
      complete: !canConstrain(sketch, preferred, refs),
    };
  }
  if (mixed) return pointLineRequest();
  if (isPoint(refs[0])) {
    if (refs.length === 1) return { kind: "length", refs, complete: false };
    if (refs.length !== 2 || !refs.every(isPoint)) return null;
    const a = referencePoint(sketch, refs[0])!,
      b = referencePoint(sketch, refs[1])!;
    // Aligned point pairs use an axis distance, otherwise the true length.
    const kind: ConstraintKind =
      Math.abs(b.x - a.x) <= 1e-6
        ? "distanceY"
        : Math.abs(b.y - a.y) <= 1e-6
          ? "distanceX"
          : "length";
    return { kind, refs, complete: !canConstrain(sketch, kind, refs) };
  }
  if (refs.length === 2) {
    const pair = lines();
    if (pair.length !== 2) return null;
    // Parallel lines measure a distance; intersecting lines measure an angle.
    if (isParallelPair(pair[0], pair[1])) {
      const distance = lineDistanceRefs(pair[0], pair[1]);
      return {
        kind: "lineDistance",
        refs: distance,
        complete: !canConstrain(sketch, "lineDistance", distance),
      };
    }
    return {
      kind: "angle",
      refs,
      complete: !canConstrain(sketch, "angle", refs),
    };
  }
  if (refs.length !== 1) return null;
  if (circular(entityKind(refs[0])))
    return { kind: "diameter", refs, complete: true };
  if (entityKind(refs[0]) === "line")
    return { kind: "length", refs, complete: true };
  return null;
}
