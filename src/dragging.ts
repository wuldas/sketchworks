import { type Selection, type Sketch, type XY } from "./model";
import { dist } from "./geometry";
import { type CanvasSnap } from "./canvasRenderer";
import { snapPriority } from "./snapping";

export type DragEvent = Selection & {
  delta: XY;
  target: XY;
  phase: "start" | "move" | "end" | "cancel";
  exact?: boolean;
  entityIds?: readonly string[];
};
export type DragFeedback = { ok: boolean; point?: XY };
export const sameDragPosition = (a: XY | null, b: XY) =>
  !!a && dist(a, b) <= 1e-7;

export function dragAnchor(
  sketch: Sketch,
  selected: Selection,
  selection: Selection[],
  grabbed: XY,
) {
  const entity = sketch.entities.find((item) => item.id === selected.entityId);
  const anchor = selected.pointId
    ? entity?.points.find((item) => item.id === selected.pointId)
    : entity?.points[0];
  if (!anchor) return null;
  const group =
    !selected.pointId &&
    selection.some((item) => item.entityId === selected.entityId)
      ? new Set(selection.map((item) => item.entityId))
      : new Set([selected.entityId]);
  const entities = new Map(sketch.entities.map((item) => [item.id, item]));
  const pointOwners = new Map<string, string>();
  for (const item of sketch.entities)
    for (const point of item.points) pointOwners.set(point.id, item.id);
  const refPoints = (ref: string) =>
    pointOwners.has(ref)
      ? [ref]
      : (entities.get(ref)?.points.map((point) => point.id) ?? []);
  const refPoint = (ref: string) =>
    pointOwners.has(ref) ? ref : entities.get(ref)?.points[0]?.id;
  const fixed = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const link = (ids: string[]) => {
    for (const id of ids.slice(1)) {
      if (!adjacency.has(ids[0])) adjacency.set(ids[0], new Set());
      if (!adjacency.has(id)) adjacency.set(id, new Set());
      adjacency.get(ids[0])!.add(id);
      adjacency.get(id)!.add(ids[0]);
    }
  };
  for (const item of sketch.entities)
    if (item.kind === "arc") link(item.points.map((point) => point.id));
  for (const constraint of sketch.constraints) {
    if (constraint.kind === "fixed") {
      for (const ref of constraint.refs)
        for (const id of refPoints(ref)) fixed.add(id);
      continue;
    }
    const ids =
      constraint.kind === "coincident" || constraint.kind === "concentric"
        ? constraint.refs.map(refPoint).filter((id): id is string => !!id)
        : constraint.refs.flatMap(refPoints);
    link([...new Set(ids)]);
  }
  const seeds = selected.pointId
    ? [anchor.id]
    : [...group].flatMap(
        (id) => entities.get(id)?.points.map((point) => point.id) ?? [],
      );
  const moving = new Set(seeds),
    queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    if (fixed.has(queue[i])) continue;
    for (const id of adjacency.get(queue[i]) ?? []) {
      if (moving.has(id) || fixed.has(id)) continue;
      moving.add(id);
      queue.push(id);
    }
  }
  const excluded = new Set<string>(selected.pointId ? [] : group);
  for (const id of moving) excluded.add(id);
  const moves = (id: string | undefined) =>
    !!id &&
    (excluded.has(id) ||
      entities.get(id)?.points.some((point) => moving.has(point.id)));
  for (const item of sketch.entities)
    if (
      item.sourceId &&
      (moves(item.sourceId) ||
        moves(item.transform?.axisId) ||
        moves(item.transform?.secondarySourceId))
    )
      excluded.add(item.id);
  return {
    pointId: anchor.id,
    point: { x: anchor.x, y: anchor.y },
    offset: { x: anchor.x - grabbed.x, y: anchor.y - grabbed.y },
    excluded,
  };
}

export function resolveDragSnap(
  proposed: XY,
  previous: CanvasSnap | null,
  nearest: CanvasSnap | null,
  scale: number,
): { target: XY; snap: CanvasSnap | null } {
  let snap = nearest;
  if (previous && dist(proposed, previous.point) * scale < 12) {
    snap =
      nearest && snapPriority(nearest.kind) < snapPriority(previous.kind)
        ? nearest
        : previous;
  }
  if (!snap) return { target: proposed, snap: null };
  const point = { x: snap.point.x, y: snap.point.y };
  return { target: point, snap: { ...snap, point } };
}
