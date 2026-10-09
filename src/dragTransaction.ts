import {
  clone,
  type Document,
  type Entity,
  type Selection,
  type Sketch,
  type XY,
} from "./model";
import { type SolverResult } from "./solver";
import { type DragEvent, sameDragPosition } from "./dragging";
import {
  prepareDimensionLabels,
  updateDimensionLabels,
} from "./dimensionLabel";

export type DragDriver = {
  pointId: string;
  x: number;
  y: number;
  exact?: boolean;
};
export type DocumentSolver = (
  document: Document,
  driver?: DragDriver,
) => SolverResult;

export function dragPosition(
  document: Document,
  sketchId: string,
  event: Selection,
): XY | undefined {
  const entity = document.sketches
    .find((sketch) => sketch.id === sketchId)
    ?.entities.find((item) => item.id === event.entityId);
  const point = event.pointId
    ? entity?.points.find((item) => item.id === event.pointId)
    : entity?.points[0];
  return point ? { x: point.x, y: point.y } : undefined;
}

export type DragSolveOptions = {
  previousTarget?: XY;
  entityIds?: readonly string[];
};

function bodyOwnership(sketch: Sketch) {
  const entities = new Map(
    sketch.entities.map((entity) => [entity.id, entity]),
  );
  const owners = new Map<string, string>();
  for (const entity of sketch.entities) {
    owners.set(entity.id, entity.id);
    for (const point of entity.points) owners.set(point.id, entity.id);
  }
  const fixed = new Set(
    sketch.constraints
      .filter(
        (constraint) =>
          constraint.kind === "fixed" || constraint.kind === "origin",
      )
      .flatMap((constraint) => constraint.refs.map((ref) => owners.get(ref)))
      .filter((id): id is string => !!id),
  );
  return { entities, owners, fixed };
}

function bodySeeds(selection: readonly Selection[], primaryId: string) {
  return selection.some((item) => item.entityId === primaryId)
    ? selection.map((item) => item.entityId)
    : [primaryId];
}

function assertEditableBodyEntities(
  entities: ReadonlyMap<string, Entity>,
  fixed: ReadonlySet<string>,
  ids: Iterable<string>,
) {
  for (const id of ids) {
    const entity = entities.get(id);
    if (!entity) throw new Error("拖动对象不存在");
    if (entity.sourceId) throw new Error("关联对象须先解除关联后整体移动");
    if (fixed.has(id)) throw new Error("固定对象不能整体移动");
  }
}

export function resolveBodyDragEntities(
  sketch: Sketch,
  selection: readonly Selection[],
  primary: Selection | string,
): string[] {
  const primaryId = typeof primary === "string" ? primary : primary.entityId;
  const { entities, owners, fixed } = bodyOwnership(sketch);
  const seeds = bodySeeds(selection, primaryId);
  assertEditableBodyEntities(entities, fixed, seeds);
  const adjacency = new Map<string, Set<string>>();
  for (const constraint of sketch.constraints) {
    if (constraint.kind === "fixed") continue;
    const ids = [
      ...new Set(constraint.refs.map((ref) => owners.get(ref))),
    ].filter(
      (id): id is string =>
        !!id && !fixed.has(id) && !entities.get(id)?.sourceId,
    );
    for (const id of ids.slice(1)) {
      if (!adjacency.has(ids[0])) adjacency.set(ids[0], new Set());
      if (!adjacency.has(id)) adjacency.set(id, new Set());
      adjacency.get(ids[0])!.add(id);
      adjacency.get(id)!.add(ids[0]);
    }
  }
  const moving = new Set(seeds),
    queue = [...moving];
  for (let index = 0; index < queue.length; index++) {
    for (const id of adjacency.get(queue[index]) ?? []) {
      if (moving.has(id)) continue;
      moving.add(id);
      queue.push(id);
    }
  }
  return sketch.entities
    .filter((entity) => moving.has(entity.id))
    .map((entity) => entity.id);
}

const BODY_TOLERANCE = 1e-6;
function assertBodyTranslation(
  before: Sketch,
  after: Sketch,
  ids: ReadonlySet<string>,
  primaryId: string,
) {
  const origin = before.entities.find((entity) => entity.id === primaryId)
    ?.points[0];
  const actual = after.entities.find((entity) => entity.id === primaryId)
    ?.points[0];
  if (!origin || !actual) throw new Error("最终拖动位置无效");
  // A soft target may project the anchor, but every body control must share its shift.
  const delta = { x: actual.x - origin.x, y: actual.y - origin.y };
  const resultEntities = new Map(
    after.entities.map((entity) => [entity.id, entity]),
  );
  const scalar = (
    entity: Entity,
    key: "radius" | "ry" | "fontSize" | "rotation" | "weight",
  ) =>
    key === "radius" && entity.kind === "arc"
      ? (entity.radius ??
        Math.hypot(
          entity.points[1].x - entity.points[0].x,
          entity.points[1].y - entity.points[0].y,
        ))
      : entity[key];
  const fail: () => never = () => {
    throw new Error("整体拖动不能改变对象形状或相对位置");
  };
  for (const original of before.entities) {
    if (!ids.has(original.id)) continue;
    const entity = resultEntities.get(original.id);
    if (
      !entity ||
      entity.kind !== original.kind ||
      entity.ccw !== original.ccw ||
      entity.points.length !== original.points.length
    )
      fail();
    for (let index = 0; index < original.points.length; index++) {
      const point = entity.points[index],
        initial = original.points[index];
      if (
        point.id !== initial.id ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        Math.hypot(
          point.x - initial.x - delta.x,
          point.y - initial.y - delta.y,
        ) > BODY_TOLERANCE
      )
        fail();
    }
    for (const key of [
      "radius",
      "ry",
      "fontSize",
      "rotation",
      "weight",
    ] as const) {
      const initial = scalar(original, key),
        value = scalar(entity, key);
      if (
        initial !== value &&
        (initial === undefined ||
          value === undefined ||
          !Number.isFinite(value) ||
          Math.abs(initial - value) > BODY_TOLERANCE)
      )
        fail();
    }
  }
}

export function solveDrag(
  seed: Document,
  sketchId: string,
  selection: readonly Selection[],
  event: DragEvent,
  solve: DocumentSolver,
  options: DragSolveOptions = {},
): { document: Document; result: SolverResult; point: XY } {
  const candidate = clone(seed),
    sketch = candidate.sketches.find((item) => item.id === sketchId),
    original = seed.sketches.find((item) => item.id === sketchId);
  const entity = sketch?.entities.find((item) => item.id === event.entityId);
  if (!sketch || !original || !entity) throw new Error("拖动对象不存在");
  if (entity.sourceId) throw new Error("派生对象请编辑源对象");
  const point = event.pointId
    ? entity.points.find((item) => item.id === event.pointId)
    : entity.points[0];
  if (!point) throw new Error("控制点不存在");
  prepareDimensionLabels(sketch);
  let bodyIds: Set<string> | undefined;
  if (!event.pointId) {
    bodyIds = new Set(
      options.entityIds ?? resolveBodyDragEntities(original, selection, event),
    );
    bodyIds.add(entity.id);
    const { entities, fixed } = bodyOwnership(original);
    assertEditableBodyEntities(
      entities,
      fixed,
      bodySeeds(selection, entity.id),
    );
    assertEditableBodyEntities(entities, fixed, bodyIds);
    const previous =
      options.previousTarget ?? dragPosition(seed, sketchId, event)!;
    const delta = {
      x: event.target.x - previous.x,
      y: event.target.y - previous.y,
    };
    for (const item of sketch.entities)
      if (bodyIds.has(item.id))
        for (const control of item.points) {
          control.x += delta.x;
          control.y += delta.y;
        }
  }
  const exact = event.phase === "end" && !!event.exact;
  const result = solve(candidate, {
    pointId: point.id,
    x: event.target.x,
    y: event.target.y,
    exact,
  });
  if (!result.ok) throw new Error(result.message ?? "拖动目标无法满足现有约束");
  if (bodyIds) assertBodyTranslation(original, sketch, bodyIds, entity.id);
  updateDimensionLabels(sketch);
  if (event.phase !== "end")
    return {
      document: candidate,
      result,
      point: dragPosition(candidate, sketchId, event)!,
    };
  const final = clone(candidate),
    finalResult = solve(final),
    actual = dragPosition(final, sketchId, event);
  if (!finalResult.ok || !actual) throw new Error("最终拖动位置无效");
  if (exact && !sameDragPosition(actual, event.target))
    throw new Error("捕获位置与现有约束冲突");
  if (bodyIds)
    assertBodyTranslation(
      original,
      final.sketches.find((item) => item.id === sketchId)!,
      bodyIds,
      entity.id,
    );
  updateDimensionLabels(final.sketches.find((item) => item.id === sketchId)!);
  return { document: final, result: finalResult, point: actual };
}
