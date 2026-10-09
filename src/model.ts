export type XY = { x: number; y: number };
export type Point = XY & { id: string };
export type EntityKind =
  | "line"
  | "circle"
  | "arc"
  | "ellipse"
  | "spline"
  | "bezier"
  | "conic"
  | "point"
  | "text";
export type Transform = {
  kind: "translate" | "rotate" | "mirror" | "blend";
  secondarySourceId?: string;
  x?: number;
  y?: number;
  angle?: number;
  ax?: number;
  ay?: number;
  bx?: number;
  by?: number;
  axisId?: string;
  xExpression?: string;
  yExpression?: string;
  angleExpression?: string;
};
export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  points: Point[];
  radius?: number;
  ry?: number;
  ccw?: boolean;
  weight?: number;
  text?: string;
  fontSize?: number;
  rotation?: number;
  construction?: boolean;
  ownerId?: string;
  sourceId?: string;
  transform?: Transform;
}
export type ConstraintKind =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "fixed"
  | "onLine"
  | "onCurve"
  | "intersection"
  | "origin"
  | "tangent"
  | "concentric"
  | "midpoint"
  | "symmetric"
  | "collinear"
  | "length"
  | "lineDistance"
  | "distanceX"
  | "distanceY"
  | "radius"
  | "ellipseWidth"
  | "diameter"
  | "angle";
export interface AngleSector {
  reverseFirst: boolean;
  reverseSecond: boolean;
  clockwise: boolean;
}
export interface Constraint {
  id: string;
  kind: ConstraintKind;
  refs: string[];
  value?: number;
  expression?: string;
  angleSector?: AngleSector;
  labelPosition?: XY;
  labelOffset?: XY;
  anchors?: Point[];
  /** The onLine point must lie on the positive ray from line.points[0] to line.points[1]. */
  sameRay?: boolean;
}
export interface Sketch {
  id: string;
  name: string;
  visible: boolean;
  entities: Entity[];
  constraints: Constraint[];
}
export interface Parameter {
  name: string;
  expression: string;
  unit: "mm" | "deg" | "scalar";
}
export interface Document {
  version: 1;
  name: string;
  unit: "mm" | "in";
  sketches: Sketch[];
  parameters: Parameter[];
}
export interface Selection {
  entityId: string;
  pointId?: string;
}
export const uid = (prefix = "e") =>
  `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
export const point = (x: number, y: number): Point => ({ id: uid("p"), x, y });
export const entity = (
  kind: EntityKind,
  coords: XY[],
  extra: Partial<Entity> = {},
): Entity => ({
  id: uid(),
  kind,
  name: kindLabels[kind],
  points: coords.map((p) => point(p.x, p.y)),
  ...extra,
});
export const kindLabels: Record<EntityKind, string> = {
  line: "直线",
  circle: "圆",
  arc: "圆弧",
  ellipse: "椭圆",
  spline: "样条曲线",
  bezier: "贝塞尔曲线",
  conic: "圆锥曲线",
  point: "点",
  text: "文本",
};
export const constraintLabels: Record<ConstraintKind, string> = {
  coincident: "重合",
  horizontal: "水平",
  vertical: "竖直",
  parallel: "平行",
  perpendicular: "垂直",
  equal: "相等",
  fixed: "固定",
  onLine: "点在线上",
  onCurve: "点在曲线上",
  intersection: "交点重合",
  origin: "原点重合",
  tangent: "相切",
  concentric: "同心",
  midpoint: "中点",
  symmetric: "对称",
  collinear: "共线",
  length: "长度",
  lineDistance: "线间/点线距离",
  distanceX: "水平距离",
  distanceY: "垂直距离",
  radius: "半径",
  ellipseWidth: "短轴关联",
  diameter: "直径",
  angle: "角度",
};
export const emptyDocument = (): Document => ({
  version: 1,
  name: "未命名草图",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: uid("sk"),
      name: "草图 1",
      visible: true,
      entities: [],
      constraints: [],
    },
  ],
});
export const clone = <T>(v: T): T => structuredClone(v);
export function findPoint(sketch: Sketch, id: string) {
  return sketch.entities.flatMap((e) => e.points).find((p) => p.id === id);
}
export function resolveEntity(sketch: Sketch, ref: string) {
  return sketch.entities.find(
    (e) => e.id === ref || e.points.some((p) => p.id === ref),
  );
}
export function referencePoint(sketch: Sketch, ref: string): Point | undefined {
  return (
    findPoint(sketch, ref) ??
    sketch.entities.find((e) => e.id === ref)?.points[0]
  );
}
export function deleteEntities(sketch: Sketch, ids: string[]) {
  const all = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of sketch.entities)
      if (
        ((e.ownerId && all.has(e.ownerId)) ||
          (e.sourceId && all.has(e.sourceId)) ||
          (e.transform?.axisId && all.has(e.transform.axisId)) ||
          (e.transform?.secondarySourceId &&
            all.has(e.transform.secondarySourceId))) &&
        !all.has(e.id)
      ) {
        all.add(e.id);
        changed = true;
      }
  }
  const refs = new Set(
    sketch.entities
      .filter((e) => all.has(e.id))
      .flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
  );
  sketch.entities = sketch.entities.filter((e) => !all.has(e.id));
  sketch.constraints = sketch.constraints.filter(
    (c) => !c.refs.some((r) => refs.has(r)),
  );
}
export function validateDocument(raw: unknown): Document {
  if (!raw || typeof raw !== "object") throw new Error("不是有效草图文档");
  const d = raw as Document;
  if (
    d.version !== 1 ||
    !["mm", "in"].includes(d.unit) ||
    typeof d.name !== "string" ||
    !Array.isArray(d.sketches) ||
    !Array.isArray(d.parameters)
  )
    throw new Error("文档格式或版本不支持");
  if (
    d.sketches.length < 1 ||
    d.sketches.length > 100 ||
    d.parameters.length > 500
  )
    throw new Error("文档规模超出限制");
  const ids = new Set<string>();
  const addId = (id: string) => {
    if (typeof id !== "string" || ids.has(id))
      throw new Error("对象 ID 重复或无效");
    ids.add(id);
  };
  for (const sk of d.sketches) {
    addId(sk.id);
    if (
      typeof sk.name !== "string" ||
      typeof sk.visible !== "boolean" ||
      !Array.isArray(sk.entities) ||
      !Array.isArray(sk.constraints) ||
      sk.entities.length > 10000 ||
      sk.constraints.length > 20000
    )
      throw new Error("草图数据无效或过大");
    const local = new Set<string>();
    for (const e of sk.entities) {
      addId(e.id);
      local.add(e.id);
      if (
        !Object.hasOwn(kindLabels, e.kind) ||
        typeof e.name !== "string" ||
        !Array.isArray(e.points) ||
        !e.points.length ||
        e.points.length > 1000
      )
        throw new Error("几何类型无效");
      const minPoints: Record<EntityKind, number> = {
        line: 2,
        circle: 1,
        arc: 3,
        ellipse: 2,
        spline: 2,
        bezier: 4,
        conic: 3,
        point: 1,
        text: 1,
      };
      if (e.points.length < minPoints[e.kind])
        throw new Error("几何控制点不足");
      for (const p of e.points) {
        addId(p.id);
        local.add(p.id);
        if (
          ![p.x, p.y].every(
            (n) =>
              typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e7,
          )
        )
          throw new Error("几何坐标无效");
      }
      for (const v of [e.radius, e.ry, e.weight, e.fontSize, e.rotation])
        if (v !== undefined && (!Number.isFinite(v) || Math.abs(v) > 1e7))
          throw new Error("几何参数无效");
      if (
        (e.radius !== undefined && e.radius <= 0) ||
        (e.ry !== undefined && e.ry <= 0) ||
        (e.weight !== undefined && e.weight <= 0) ||
        (e.fontSize !== undefined && e.fontSize <= 0)
      )
        throw new Error("半径、权重或文字高度必须为正");
      if (
        e.kind === "text" &&
        (typeof e.text !== "string" || e.text.length > 10000)
      )
        throw new Error("文本内容无效");
    }
    for (const e of sk.entities) {
      if (
        e.ownerId !== undefined &&
        (typeof e.ownerId !== "string" ||
          e.ownerId === e.id ||
          !sk.entities.some(
            (owner) =>
              owner.id === e.ownerId && !owner.ownerId && !owner.sourceId,
          ))
      )
        throw new Error("辅助几何所属对象无效");
      if (
        e.sourceId &&
        (!sk.entities.some((s) => s.id === e.sourceId && !s.sourceId) ||
          !e.transform)
      )
        throw new Error("派生关系无效");
      if (e.transform) {
        const t = e.transform;
        if (
          !e.sourceId ||
          !["translate", "rotate", "mirror", "blend"].includes(t.kind) ||
          ["x", "y", "angle", "ax", "ay", "bx", "by"].some((key) => {
            const v = t[key as "x"];
            return (
              v !== undefined &&
              (typeof v !== "number" ||
                !Number.isFinite(v) ||
                Math.abs(v) > 1e7)
            );
          })
        )
          throw new Error("变换参数无效");
        if (
          t.axisId &&
          !sk.entities.some(
            (axis) =>
              axis.id === t.axisId && axis.kind === "line" && !axis.sourceId,
          )
        )
          throw new Error("镜像轴引用无效");
        if (
          t.kind === "blend" &&
          (!sk.entities.some(
            (s) => s.id === t.secondarySourceId && !s.sourceId,
          ) ||
            e.kind !== "bezier")
        )
          throw new Error("过渡曲线引用无效");
        for (const expr of [t.xExpression, t.yExpression, t.angleExpression])
          if (
            expr !== undefined &&
            (typeof expr !== "string" || expr.length > 500)
          )
            throw new Error("变换表达式无效");
      }
    }
    for (const c of sk.constraints) {
      addId(c.id);
      if (
        !Object.hasOwn(constraintLabels, c.kind) ||
        !Array.isArray(c.refs) ||
        !c.refs.length ||
        c.refs.some((r) => !local.has(r)) ||
        (c.value !== undefined && !Number.isFinite(c.value)) ||
        (c.expression !== undefined &&
          (typeof c.expression !== "string" || c.expression.length > 500))
      )
        throw new Error("约束或引用无效");
      if (
        c.angleSector !== undefined &&
        (c.kind !== "angle" ||
          c.refs.length !== 2 ||
          !c.angleSector ||
          typeof c.angleSector.reverseFirst !== "boolean" ||
          typeof c.angleSector.reverseSecond !== "boolean" ||
          typeof c.angleSector.clockwise !== "boolean" ||
          !c.refs.every((ref) =>
            sk.entities.some(
              (e) => e.id === ref && e.kind === "line" && !e.sourceId,
            ),
          ))
      )
        throw new Error("角度方向或射线引用无效");
      if (c.sameRay !== undefined) {
        const pointOwner = (ref: string) =>
          sk.entities.find(
            (e) =>
              !e.sourceId &&
              (e.points.some((p) => p.id === ref) ||
                (e.kind === "point" && e.id === ref)),
          );
        if (
          typeof c.sameRay !== "boolean" ||
          c.kind !== "onLine" ||
          c.refs.length !== 2 ||
          new Set(c.refs).size !== 2 ||
          !c.refs.some(
            (ref, i) =>
              !!pointOwner(ref) &&
              sk.entities.some(
                (e) =>
                  e.id === c.refs[1 - i] && e.kind === "line" && !e.sourceId,
              ),
          )
        )
          throw new Error("径向方向绑定或射线引用无效");
      }
      if (c.kind === "ellipseWidth") {
        const targets = c.refs.map((id) =>
          sk.entities.find((e) => e.id === id && !e.sourceId),
        );
        if (
          c.refs.length !== 2 ||
          targets[0]?.kind !== "ellipse" ||
          targets[1]?.kind !== "circle"
        )
          throw new Error("尺寸关联引用无效");
      }
      if (["origin", "onCurve", "intersection", "midpoint"].includes(c.kind)) {
        const pointOwner = (ref: string) =>
          sk.entities.find(
            (e) =>
              e.points.some((p) => p.id === ref) ||
              (e.kind === "point" && e.id === ref),
          );
        const curve = (ref: string) =>
          sk.entities.find(
            (e) =>
              e.id === ref &&
              e.kind !== "point" &&
              e.kind !== "text" &&
              !e.sourceId,
          );
        const valid =
          new Set(c.refs).size === c.refs.length &&
          (c.kind === "origin"
            ? c.refs.length === 1 &&
              !!pointOwner(c.refs[0]) &&
              !pointOwner(c.refs[0])?.sourceId
            : c.kind === "onCurve" || c.kind === "midpoint"
              ? c.refs.length === 2 &&
                c.refs.some((ref, i) => {
                  const source = curve(c.refs[1 - i]);
                  return (
                    !!pointOwner(ref) &&
                    !pointOwner(ref)?.sourceId &&
                    !!source &&
                    (c.kind !== "midpoint" ||
                      ["line", "arc", "spline", "bezier", "conic"].includes(
                        source.kind,
                      ))
                  );
                })
              : c.refs.length === 3 &&
                !!pointOwner(c.refs[0]) &&
                !pointOwner(c.refs[0])?.sourceId &&
                c.refs.slice(1).every((ref) => !!curve(ref)));
        if (!valid) throw new Error("绑定约束引用无效");
      }
      if (
        c.labelPosition !== undefined &&
        (!c.labelPosition ||
          ![c.labelPosition.x, c.labelPosition.y].every(
            (v) =>
              typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e7,
          ))
      )
        throw new Error("尺寸标注位置无效");
      if (
        c.labelOffset !== undefined &&
        (!c.labelOffset ||
          ![c.labelOffset.x, c.labelOffset.y].every(
            (v) =>
              typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 3e7,
          ))
      )
        throw new Error("尺寸标注相对偏移无效");
      if (
        c.anchors !== undefined &&
        (!Array.isArray(c.anchors) ||
          c.anchors.length > 1000 ||
          c.anchors.some(
            (p) =>
              !local.has(p.id) ||
              ![p.x, p.y].every(
                (v) =>
                  typeof v === "number" &&
                  Number.isFinite(v) &&
                  Math.abs(v) <= 1e7,
              ),
          ))
      )
        throw new Error("固定约束锚点无效");
    }
  }
  for (const p of d.parameters)
    if (
      !p ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(p.name) ||
      typeof p.expression !== "string" ||
      p.expression.length > 500 ||
      !["mm", "deg", "scalar"].includes(p.unit)
    )
      throw new Error("参数定义无效");
  return clone(d);
}
export function demoDocument(): Document {
  const d = emptyDocument();
  d.name = "连接板";
  const s = d.sketches[0];
  const coords = [
    { x: -60, y: -36 },
    { x: 60, y: -36 },
    { x: 60, y: 36 },
    { x: -60, y: 36 },
  ];
  for (let i = 0; i < 4; i++)
    s.entities.push(
      entity("line", [coords[i], coords[(i + 1) % 4]], {
        name: `轮廓 ${i + 1}`,
      }),
    );
  for (let i = 0; i < 4; i++) {
    const a = s.entities[i],
      b = s.entities[(i + 1) % 4];
    s.constraints.push(
      { id: uid("c"), kind: i % 2 ? "vertical" : "horizontal", refs: [a.id] },
      {
        id: uid("c"),
        kind: "coincident",
        refs: [a.points[1].id, b.points[0].id],
      },
    );
  }
  s.constraints.push(
    { id: uid("c"), kind: "length", refs: [s.entities[0].id], value: 120 },
    { id: uid("c"), kind: "length", refs: [s.entities[1].id], value: 72 },
  );
  for (const x of [-42, 42])
    for (const y of [-20, 20]) {
      const e = entity("circle", [{ x, y }], { radius: 5, name: "安装孔" });
      s.entities.push(e);
      s.constraints.push({
        id: uid("c"),
        kind: "radius",
        refs: [e.id],
        value: 5,
      });
    }
  s.entities.push(
    entity("circle", [{ x: 0, y: 0 }], { radius: 19, name: "中心孔" }),
  );
  s.entities.push(
    entity(
      "line",
      [
        { x: -75, y: 0 },
        { x: 75, y: 0 },
      ],
      { construction: true, name: "水平中心线" },
    ),
    entity(
      "line",
      [
        { x: 0, y: -48 },
        { x: 0, y: 48 },
      ],
      { construction: true, name: "垂直中心线" },
    ),
  );
  return d;
}
