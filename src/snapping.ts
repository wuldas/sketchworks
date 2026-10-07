import { type Entity, type Point, type XY } from "./model";
import { add, arcInfo, dist, EPS, lerp, mul, paperPath, sub } from "./geometry";

export type SnapKind =
  | "endpoint"
  | "tangent"
  | "intersection"
  | "point"
  | "midpoint"
  | "origin"
  | "grid";

export interface SnapOptions {
  grid: boolean;
  midpoint: boolean;
  endpoint: boolean;
  tangent: boolean;
  intersection: boolean;
}

export const defaultSnapOptions: SnapOptions = {
  grid: true,
  midpoint: true,
  endpoint: true,
  tangent: true,
  intersection: true,
};

export function isSnapEnabled(kind: SnapKind, options: SnapOptions): boolean {
  return kind === "point" || kind === "origin" ? true : options[kind];
}
export type IndexedSnapPoint = {
  point: Point;
  ref?: string;
  kind: "endpoint" | "point";
};

export function pathEndpoints(entity: Entity): Point[] {
  switch (entity.kind) {
    case "line":
      return entity.points.slice(0, 2);
    case "arc":
      return entity.points.slice(1, 3);
    case "spline":
      return [entity.points[0], entity.points.at(-1)!];
    case "bezier":
      return [entity.points[0], entity.points[3]];
    case "conic":
      return [entity.points[0], entity.points[2]];
    default:
      return [];
  }
}

export function entitySnapPoints(entity: Entity): IndexedSnapPoint[] {
  const endpoints = pathEndpoints(entity),
    endpointIds = new Set(endpoints.map((point) => point.id));
  const points =
    entity.sourceId || entity.kind === "bezier" || entity.kind === "conic"
      ? endpoints
      : entity.points;
  return points.map((point) => ({
    point,
    kind: endpointIds.has(point.id) ? "endpoint" : "point",
    ref: entity.sourceId ? undefined : point.id,
  }));
}

export function tangentPoints(entity: Entity, from: XY): XY[] {
  if (entity.kind !== "circle" && entity.kind !== "arc") return [];
  const count = entity.kind === "arc" ? 3 : 1;
  if (
    entity.points.length < count ||
    ![from, ...entity.points.slice(0, count)].every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    )
  )
    return [];
  const info = entity.kind === "arc" ? arcInfo(entity) : undefined,
    center = entity.points[0],
    radius = info?.r ?? entity.radius ?? 1;
  if (!Number.isFinite(radius) || radius <= EPS) return [];
  if (
    info &&
    (info.sweep === 0 || dist(entity.points[1], entity.points[2]) < EPS)
  )
    return [];

  const delta = sub(from, center),
    distance = Math.hypot(delta.x, delta.y);
  if (
    !Number.isFinite(distance) ||
    distance - radius <= 8 * Number.EPSILON * Math.max(distance, radius)
  )
    return [];

  // Normalizing the circle formula avoids squared-distance overflow.
  const direction = mul(delta, 1 / distance),
    ratio = radius / distance,
    base = add(center, mul(direction, radius * ratio)),
    offset = mul(
      { x: -direction.y, y: direction.x },
      radius * Math.sqrt((1 - ratio) * (1 + ratio)),
    );
  return [add(base, offset), sub(base, offset)].filter((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (!info) return true;
    const tau = Math.PI * 2,
      angle = Math.atan2(point.y - center.y, point.x - center.x),
      signedTravel = info.sweep < 0 ? info.start - angle : angle - info.start,
      travel = ((signedTravel % tau) + tau) % tau;
    return travel <= Math.abs(info.sweep) + EPS || tau - travel <= EPS;
  });
}

export function pathMidpoint(entity: Entity): XY | undefined {
  switch (entity.kind) {
    case "line":
      return lerp(entity.points[0], entity.points[1], 0.5);
    case "arc": {
      const { c, r, start, sweep } = arcInfo(entity),
        angle = start + sweep / 2;
      return { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) };
    }
    case "bezier":
    case "spline":
    case "conic": {
      const path = paperPath(entity);
      try {
        const point = path.getPointAt(path.length / 2);
        return point ? { x: point.x, y: point.y } : undefined;
      } finally {
        path.remove();
      }
    }
    default:
      return undefined;
  }
}

export const snapRadius = (kind: SnapKind) => (kind === "endpoint" ? 10 : 8);
export const snapPriority = (kind: SnapKind) =>
  kind === "endpoint"
    ? 0
    : kind === "tangent" || kind === "intersection"
      ? 1
      : kind === "grid"
        ? 3
        : 2;
