import {
  clone,
  type Document,
  type Entity,
  type Sketch,
  type XY,
} from "./model";
import { normalize, sub } from "./geometry";
import { modifySketch } from "./operations";
import {
  evaluateExpression,
  hasParameterReferences,
  resolveParameters,
} from "./parameters";
import {
  commandGeometryError,
  commandSelections,
  type CommandSession,
} from "./commandParameters";

export interface OperationInput {
  operation: string;
  values: Record<string, number>;
  ids: string[];
  pick?: XY;
  expressions: Record<string, string>;
}
export interface OperationPreview {
  entities: Entity[] | null;
  error: string | null;
}
const previewOperations = new Set([
  "mirror",
  "rectangularArray",
  "circularArray",
  "move",
]);
export const hasOperationPreview = (command: CommandSession | null) =>
  !!command &&
  command.type === "operation" &&
  previewOperations.has(command.name);

/** Both confirmation and preview resolve exactly the same geometry and units. */
export function resolveOperationInput(
  doc: Document,
  sketchId: string,
  command: CommandSession,
): OperationInput {
  if (command.type !== "operation") throw new Error("此命令不是几何操作");
  const missing = commandGeometryError(command);
  if (missing) throw new Error(missing);
  const sketch = doc.sketches.find((s) => s.id === sketchId);
  if (!sketch) throw new Error("当前草图不存在");
  const values: Record<string, number> = {},
    expressions: Record<string, string> = {};
  const vars = resolveParameters(doc.parameters);
  for (const field of command.fields) {
    if (field.type === "select") continue;
    const raw = command.values[field.key] ?? "";
    try {
      const reference = hasParameterReferences(raw);
      const number = evaluateExpression(
        raw,
        vars,
        field.unit === "°" ? "deg" : field.unit ? "mm" : "scalar",
      );
      values[field.key] =
        number * (!reference && field.unit === "in" ? 25.4 : 1);
      if (reference) expressions[field.key] = raw;
    } catch (error) {
      throw new Error(`${field.label}：${(error as Error).message}`);
    }
  }
  if (command.name === "rectangularArray") {
    const directionId = command.geometry.find((p) => p.key === "direction")
      ?.selections[0]?.entityId;
    if (directionId) {
      const direction = sketch.entities.find((e) => e.id === directionId);
      if (!direction || direction.kind !== "line")
        throw new Error("阵列方向须为有效直线");
      const vector = normalize(sub(direction.points[1], direction.points[0]));
      values.ux = vector.x;
      values.uy = vector.y;
    }
    values.range = command.values.distribution === "范围" ? 1 : 0;
    values.direction1 =
      command.values.direction1 === "反向"
        ? -1
        : command.values.direction1 === "对称"
          ? 0
          : 1;
    values.direction2 =
      command.values.direction2 === "反向"
        ? -1
        : command.values.direction2 === "对称"
          ? 0
          : 1;
  }
  const pick = command.geometry.find((p) => p.kind === "position")?.position;
  if (pick && ["rotate", "scale", "circularArray"].includes(command.name)) {
    values.cx = pick.x;
    values.cy = pick.y;
  }
  const ids =
    command.name === "mirror"
      ? commandSelections(command).map((s) => s.entityId)
      : (
          command.geometry.find((p) => p.key === "objects")?.selections ?? []
        ).map((s) => s.entityId);
  if (!ids.length) throw new Error("请选择对象");
  return { operation: command.name, values, ids, pick, expressions };
}

/** Build a private candidate; nothing here publishes a document or history entry. */
export function createOperationCandidate(
  doc: Document,
  sketchId: string,
  input: OperationInput,
) {
  const document = clone(doc),
    sketch = document.sketches.find((s) => s.id === sketchId);
  if (!sketch) throw new Error("当前草图不存在");
  const { operation, values, ids, pick, expressions } = input;
  const result = modifySketch(sketch, ids, operation, values, pick);
  const beforeIds = new Set(
    doc.sketches.find((s) => s.id === sketchId)!.entities.map((e) => e.id),
  );
  for (const e of sketch.entities) {
    if (beforeIds.has(e.id) || !e.transform) continue;
    const t = e.transform;
    if (
      operation === "rectangularArray" &&
      (expressions.dx || expressions.dy)
    ) {
      const u = normalize({ x: values.ux ?? 1, y: values.uy ?? 0 });
      const x = t.x ?? 0,
        y = t.y ?? 0;
      const along = x * u.x + y * u.y,
        across = -x * u.y + y * u.x;
      const first =
        expressions.dx && Math.abs(values.dx) > 1e-9
          ? `${along / values.dx}*(${expressions.dx})`
          : String(along);
      const second =
        expressions.dy && Math.abs(values.dy) > 1e-9
          ? `${across / values.dy}*(${expressions.dy})`
          : String(across);
      t.xExpression = `${u.x}*(${first})-(${u.y})*(${second})`;
      t.yExpression = `${u.y}*(${first})+${u.x}*(${second})`;
    }
    if (
      operation === "circularArray" &&
      expressions.angle &&
      Math.abs(values.angle) > 1e-9
    )
      t.angleExpression = `${(t.angle ?? 0) / values.angle}*(${expressions.angle})`;
  }
  return { document, sketch, removedConstraints: result.removedConstraints };
}

const geometryKey = (e: Entity) =>
  JSON.stringify([
    e.kind,
    e.points,
    e.radius,
    e.ry,
    e.fontSize,
    e.rotation,
    e.text,
    e.weight,
    e.construction,
  ]);
export function operationPreviewEntities(
  before: Sketch,
  after: Sketch,
  input: OperationInput,
): Entity[] {
  const previous = new Map(before.entities.map((e) => [e.id, e]));
  const selected = new Set(input.operation === "move" ? input.ids : []);
  return after.entities.filter((e) => {
    const source = previous.get(e.id);
    return (
      !source || selected.has(e.id) || geometryKey(source) !== geometryKey(e)
    );
  });
}

export function previewOperation(
  doc: Document,
  sketchId: string,
  command: CommandSession | null,
  solveCandidate: (candidate: Document) => void,
): OperationPreview {
  if (!hasOperationPreview(command)) return { entities: null, error: null };
  try {
    const input = resolveOperationInput(doc, sketchId, command!);
    const candidate = createOperationCandidate(doc, sketchId, input);
    solveCandidate(candidate.document);
    return {
      entities: operationPreviewEntities(
        doc.sketches.find((s) => s.id === sketchId)!,
        candidate.sketch,
        input,
      ),
      error: null,
    };
  } catch (error) {
    let message = (error as Error).message;
    for (const field of command!.fields)
      message = message.replace(`参数 ${field.key}`, field.label);
    return { entities: null, error: message };
  }
}
