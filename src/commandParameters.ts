import {
  type ConstraintKind,
  type Selection,
  type Sketch,
  type XY,
} from "./model";

export interface CommandField {
  key: string;
  label: string;
  value: string;
  unit?: string;
  type?: "text" | "textarea" | "select";
  options?: string[];
}
type GeometryKind =
  | "entity"
  | "line"
  | "point"
  | "curve"
  | "round"
  | "nativeCurve"
  | "pointOrLine"
  | "pointOrEntity"
  | "position";
export interface GeometryParameter {
  key: string;
  label: string;
  hint: string;
  kind: GeometryKind;
  multiple?: boolean;
  min?: number;
  max?: number;
  optional?: boolean;
  allowDerived?: boolean;
  allowShared?: boolean;
  selections: Selection[];
  position?: XY;
}
export interface CommandSession {
  type: "operation" | "constraint";
  name: string;
  title: string;
  geometry: GeometryParameter[];
  fields: CommandField[];
  values: Record<string, string>;
  active: number;
  previousSelection: Selection[];
}
const parameter = (
  key: string,
  label: string,
  kind: GeometryKind,
  hint: string,
  options: Partial<GeometryParameter> = {},
): GeometryParameter => ({
  key,
  label,
  kind,
  hint,
  selections: [],
  ...options,
});
const objects = (options: Partial<GeometryParameter> = {}) =>
  parameter("objects", "对象", "entity", "点击对象增删选择，也可框选多个对象", {
    multiple: true,
    ...options,
  });
const position = (label: string, optional = false) =>
  parameter("position", label, "position", "在绘图区点击位置", { optional });

export function operationGeometry(name: string): GeometryParameter[] {
  switch (name) {
    case "mirror":
      return [
        objects(),
        parameter("axis", "镜像线", "line", "选择一条未关联的直线作为镜像线"),
      ];
    case "rectangularArray":
      return [
        objects(),
        parameter(
          "direction",
          "方向",
          "line",
          "选择直线作为第一方向，第二方向与其垂直；留空使用 X / Y 轴",
          { optional: true, allowDerived: true, allowShared: true },
        ),
      ];
    case "rotate":
    case "circularArray":
      return [objects(), position("中心点", true)];
    case "scale":
      return [objects(), position("基点", true)];
    case "trim":
    case "extend":
    case "break":
      return [
        objects({ multiple: false, hint: "选择要修改的曲线" }),
        position(
          name === "break"
            ? "断开位置"
            : name === "trim"
              ? "修剪位置"
              : "延伸端点",
        ),
      ];
    case "blend":
    case "fillet":
    case "chamfer":
      return [
        objects({ min: 2, max: 2, hint: "选择两个对象，点击已选对象可移除" }),
      ];
    case "copy":
    case "offset":
    case "detach":
      return [objects({ allowDerived: true })];
    default:
      return [objects()];
  }
}
export function constraintGeometry(kind: ConstraintKind): GeometryParameter[] {
  const point = (key: string, label: string) =>
    parameter(key, label, "point", "选择端点、控制点、独立点或圆（按圆心）");
  const line = (key: string, label: string) =>
    parameter(key, label, "line", "选择一条直线");
  const curve = (key: string, label: string) =>
    parameter(key, label, "curve", "选择一条曲线");
  switch (kind) {
    case "horizontal":
    case "vertical":
      return [
        parameter(
          "objects",
          "直线或两点",
          "pointOrLine",
          "选择一条直线，或依次选择两个点（圆按圆心）",
          { multiple: true, max: 2 },
        ),
      ];
    case "fixed":
      return [
        parameter("objects", "对象或点", "pointOrEntity", "选择一个对象或点"),
      ];
    case "origin":
      return [point("point", "点")];
    case "coincident":
      return [point("first", "点 1"), point("second", "点 2")];
    case "parallel":
    case "perpendicular":
    case "collinear":
      return [line("first", "直线 1"), line("second", "直线 2")];
    case "onLine":
    case "lineDistance":
      return [point("point", "点"), line("line", "直线")];
    case "onCurve":
    case "midpoint":
      return [point("point", "点"), curve("curve", "曲线")];
    case "intersection":
      return [
        point("point", "点"),
        curve("first", "曲线 1"),
        curve("second", "曲线 2"),
      ];
    case "symmetric":
      return [
        point("first", "点 1"),
        point("second", "点 2"),
        parameter(
          "axis",
          "对称线或中心点",
          "pointOrLine",
          "选择对称直线或中心点（圆按圆心）",
        ),
      ];
    case "concentric":
      return [
        parameter("first", "圆 / 圆弧 1", "round", "选择圆或圆弧"),
        parameter("second", "圆 / 圆弧 2", "round", "选择圆或圆弧"),
      ];
    case "tangent":
      return [
        parameter("first", "对象 1", "nativeCurve", "选择直线、圆或圆弧"),
        parameter("second", "对象 2", "nativeCurve", "选择直线、圆或圆弧"),
      ];
    case "equal":
      return [objects({ min: 2, max: 2, hint: "选择两条直线或两个圆 / 圆弧" })];
    default:
      return [objects({ max: 2 })];
  }
}
export const selectionKey = (selection: Selection) =>
  selection.pointId ?? selection.entityId;
export function normalizeParameterSelection(
  sketch: Sketch,
  parameter: GeometryParameter,
  picked: Selection,
): Selection | null {
  const entity = sketch.entities.find((e) => e.id === picked.entityId);
  if (!entity || (!parameter.allowDerived && entity.sourceId)) return null;
  if (picked.pointId && !entity.points.some((p) => p.id === picked.pointId))
    return null;
  const explicitPoint =
    picked.pointId && entity.points.some((p) => p.id === picked.pointId);
  // Point inputs accept a circle's native center; whole-object and curve inputs keep the circle.
  const circleCenter =
    entity.kind === "circle" &&
    (parameter.kind === "point" || parameter.kind === "pointOrLine");
  const isPoint = explicitPoint || entity.kind === "point" || circleCenter;
  switch (parameter.kind) {
    case "position":
      return null;
    case "point":
      if (!isPoint) return null;
      break;
    case "pointOrLine":
      if (!isPoint && entity.kind !== "line") return null;
      break;
    case "line":
      if (entity.kind !== "line") return null;
      break;
    case "curve":
      if (["point", "text"].includes(entity.kind)) return null;
      break;
    case "round":
      if (!["circle", "arc"].includes(entity.kind)) return null;
      break;
    case "nativeCurve":
      if (!["line", "circle", "arc"].includes(entity.kind)) return null;
      break;
  }
  const pointParameter = ["point", "pointOrLine", "pointOrEntity"].includes(
    parameter.kind,
  );
  const pointId = pointParameter
    ? (picked.pointId ??
      (entity.kind === "point" || circleCenter
        ? entity.points[0]?.id
        : undefined))
    : undefined;
  return { entityId: entity.id, ...(pointId ? { pointId } : {}) };
}
export function createCommandSession(
  type: CommandSession["type"],
  name: string,
  title: string,
  geometry: GeometryParameter[],
  fields: CommandField[],
  sketch: Sketch,
  previousSelection: Selection[],
): CommandSession {
  const session: CommandSession = {
    type,
    name,
    title,
    geometry: geometry.map((p) => ({ ...p, selections: [] })),
    fields,
    values: Object.fromEntries(fields.map((f) => [f.key, f.value])),
    active: 0,
    previousSelection: previousSelection.map((s) => ({ ...s })),
  };
  for (const picked of previousSelection) {
    // Operation preselection always belongs to the object parameter; mirror axes
    // are picked explicitly after opening the panel.
    const candidates =
      type === "operation" ? session.geometry.slice(0, 1) : session.geometry;
    for (const p of candidates) {
      const normalized = normalizeParameterSelection(sketch, p, picked);
      if (
        !normalized ||
        p.selections.length >= (p.max ?? (p.multiple ? Infinity : 1))
      )
        continue;
      const key = selectionKey(normalized);
      if (
        session.geometry.some((other) =>
          other.selections.some((s) => selectionKey(s) === key),
        )
      )
        break;
      p.selections.push(normalized);
      break;
    }
  }
  const missing = session.geometry.findIndex(
    (p) => !p.selections.length && !p.position,
  );
  session.active = missing >= 0 ? missing : 0;
  return session;
}
export function commandSelections(session: CommandSession): Selection[] {
  return session.geometry.flatMap((p) => p.selections);
}
export function commandGeometryError(session: CommandSession): string | null {
  for (const p of session.geometry) {
    if (p.optional) continue;
    if (
      p.kind === "position" ? !p.position : p.selections.length < (p.min ?? 1)
    )
      return `请选择${p.label}${p.min ? `（${p.min} 个）` : ""}`;
  }
  return null;
}
export function updateCommandSelection(
  session: CommandSession,
  sketch: Sketch,
  picks: Selection[],
  mode: "toggle" | "replace" | "append" = "toggle",
): { session: CommandSession; error?: string } {
  const active = session.geometry[session.active];
  if (!active || active.kind === "position") return { session };
  const normalized = picks
    .map((pick) => normalizeParameterSelection(sketch, active, pick))
    .filter((s): s is Selection => !!s);
  if (picks.length && !normalized.length)
    return { session, error: active.hint };
  const otherKeys = new Set(
    session.geometry
      .filter((p, i) => i !== session.active && !p.allowShared)
      .flatMap((p) => p.selections.map(selectionKey)),
  );
  if (
    !active.allowShared &&
    normalized.some((s) => otherKeys.has(selectionKey(s)))
  )
    return { session, error: "不同参数不能选择同一个对象或点" };
  let selected = mode === "replace" ? [] : [...active.selections];
  for (const item of normalized) {
    const index = selected.findIndex(
      (s) => selectionKey(s) === selectionKey(item),
    );
    if (index >= 0) {
      if (mode === "toggle") selected.splice(index, 1);
    } else if (active.multiple) selected.push(item);
    else selected = [item];
  }
  if (active.max && selected.length > active.max)
    return { session, error: `${active.label}最多选择 ${active.max} 个` };
  const geometry = session.geometry.map((p, i) =>
    i === session.active ? { ...p, selections: selected } : p,
  );
  // Single references advance to the next empty parameter. An already filled
  // reference remains editable without changing any of the other parameters.
  const next =
    selected.length && !active.multiple
      ? geometry.findIndex(
          (p, i) =>
            i > session.active &&
            !p.optional &&
            !p.selections.length &&
            !p.position,
        )
      : -1;
  return {
    session: {
      ...session,
      geometry,
      active: next >= 0 ? next : session.active,
    },
  };
}
