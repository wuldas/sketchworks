import {
  type Sketch,
  type XY,
  type Entity,
  entity,
  uid,
  type Constraint,
} from "./model";
import {
  dist,
  sub,
  add,
  mul,
  normalize,
  circleFromThree,
  cross,
  arcInfo,
  EPS,
} from "./geometry";
export type Tool =
  | "select"
  | "line"
  | "midline"
  | "rectangle"
  | "centerRectangle"
  | "circle"
  | "threeCircle"
  | "arc"
  | "centerArc"
  | "polygon"
  | "ellipse"
  | "slot"
  | "arcSlot"
  | "spline"
  | "bezier"
  | "conic"
  | "point"
  | "text";
export const toolLabels: Record<Tool, string> = {
  select: "选择",
  line: "直线",
  midline: "中点线",
  rectangle: "两点矩形",
  centerRectangle: "中心矩形",
  circle: "圆心圆",
  threeCircle: "三点圆",
  arc: "三点圆弧",
  centerArc: "圆心圆弧",
  polygon: "多边形",
  ellipse: "椭圆",
  slot: "直线槽",
  arcSlot: "圆弧槽",
  spline: "拟合点样条",
  bezier: "控制点曲线",
  conic: "圆锥曲线",
  point: "点",
  text: "文本",
};
export const toolClicks: Record<Tool, number> = {
  select: 0,
  line: 2,
  midline: 2,
  rectangle: 2,
  centerRectangle: 2,
  circle: 2,
  threeCircle: 3,
  arc: 3,
  centerArc: 3,
  polygon: 2,
  ellipse: 3,
  slot: 3,
  arcSlot: 4,
  spline: Infinity,
  bezier: 4,
  conic: 3,
  point: 1,
  text: 1,
};
export interface CreateConfig {
  construction: boolean;
  autoConstraint: boolean;
  preserveCapturedCoordinates?: boolean;
  sides: number;
  polygonOuter: boolean;
  text: string;
  fontSize: number;
  weight: number;
}
export const defaultConfig: CreateConfig = {
  construction: false,
  autoConstraint: true,
  sides: 6,
  polygonOuter: false,
  text: "SketchWorks",
  fontSize: 6,
  weight: 0.65,
};
export function createGeometry(
  tool: Tool,
  ps: XY[],
  config: CreateConfig,
): { entities: Entity[]; constraints: Constraint[] } {
  const entities: Entity[] = [],
    constraints: Constraint[] = [];
  const push = (
    kind: Entity["kind"],
    coords: XY[],
    extra: Partial<Entity> = {},
  ) => {
    const e = entity(kind, coords, {
      construction: config.construction,
      ...extra,
    });
    entities.push(e);
    return e;
  };
  const constrain = (
    kind: Constraint["kind"],
    refs: string[],
    value?: number,
  ) => constraints.push({ id: uid("c"), kind, refs, value });
  const closed = (coords: XY[], orthogonal = false) => {
    for (let i = 0; i < coords.length; i++)
      push("line", [coords[i], coords[(i + 1) % coords.length]]);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i],
        next = entities[(i + 1) % entities.length];
      constrain("coincident", [e.points[1].id, next.points[0].id]);
      if (orthogonal) constrain(i % 2 ? "vertical" : "horizontal", [e.id]);
    }
  };
  const [a, b, c, d] = ps;
  switch (tool) {
    case "line": {
      const e = push("line", [a, b]);
      if (config.autoConstraint) {
        const v = sub(b, a);
        if (
          config.preserveCapturedCoordinates
            ? Math.abs(v.y) <= EPS
            : Math.abs(v.y) < Math.abs(v.x) * 0.015
        )
          constrain("horizontal", [e.id]);
        else if (
          config.preserveCapturedCoordinates
            ? Math.abs(v.x) <= EPS
            : Math.abs(v.x) < Math.abs(v.y) * 0.015
        )
          constrain("vertical", [e.id]);
      }
      break;
    }
    case "midline": {
      const v = sub(b, a),
        e = push("line", [sub(a, v), b]),
        p = push("point", [a], { construction: true });
      constrain("midpoint", [p.points[0].id, e.id]);
      break;
    }
    case "rectangle":
    case "centerRectangle": {
      const min = tool === "centerRectangle" ? sub(mul(a, 2), b) : a;
      closed([min, { x: b.x, y: min.y }, b, { x: min.x, y: b.y }], true);
      break;
    }
    case "circle":
      push("circle", [a], { radius: dist(a, b) });
      break;
    case "threeCircle": {
      const circle = circleFromThree(a, b, c);
      if (!circle) throw new Error("三点共线，无法创建圆");
      push("circle", [circle.center], { radius: circle.radius });
      break;
    }
    case "arc": {
      const circle = circleFromThree(a, b, c);
      if (!circle) throw new Error("三点共线，无法创建圆弧");
      push("arc", [circle.center, a, c], {
        radius: circle.radius,
        ccw: cross(sub(b, a), sub(c, b)) > 0,
      });
      break;
    }
    case "centerArc": {
      const r = dist(a, b),
        end = add(a, mul(normalize(sub(c, a)), r));
      push("arc", [a, b, end], { radius: r, ccw: true });
      break;
    }
    case "polygon": {
      const sides = Math.round(config.sides);
      if (sides < 3 || sides > 100) throw new Error("边数范围为 3–100");
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const r =
        dist(a, b) / (config.polygonOuter ? Math.cos(Math.PI / sides) : 1);
      closed(
        Array.from({ length: sides }, (_, i) =>
          add(a, {
            x: r * Math.cos(angle + (Math.PI * 2 * i) / sides),
            y: r * Math.sin(angle + (Math.PI * 2 * i) / sides),
          }),
        ),
      );
      for (let i = 1; i < entities.length; i++)
        constrain("equal", [entities[0].id, entities[i].id]);
      break;
    }
    case "ellipse": {
      const axis = normalize(sub(b, a)),
        normal = { x: -axis.y, y: axis.x };
      const ry = Math.abs((c.x - a.x) * normal.x + (c.y - a.y) * normal.y);
      if (ry < 1e-6) throw new Error("短轴不能为零");
      push("ellipse", [a, b], { ry });
      break;
    }
    case "slot": {
      const dir = normalize(sub(b, a)),
        normal = { x: -dir.y, y: dir.x },
        r = Math.abs(cross(dir, sub(c, b)));
      if (r < 1e-6 || dist(a, b) < 1e-6) throw new Error("槽宽和长度必须为正");
      const a1 = add(a, mul(normal, r)),
        b1 = add(b, mul(normal, r)),
        a2 = sub(a, mul(normal, r)),
        b2 = sub(b, mul(normal, r));
      const l1 = push("line", [a1, b1]),
        arc1 = push("arc", [b, b2, b1], { radius: r, ccw: true }),
        l2 = push("line", [b2, a2]),
        arc2 = push("arc", [a, a1, a2], { radius: r, ccw: true });
      constrain("parallel", [l1.id, l2.id]);
      for (const [ln, ar] of [
        [l1, arc1],
        [l2, arc1],
        [l1, arc2],
        [l2, arc2],
      ])
        constrain("tangent", [ln.id, ar.id]);
      constrain("coincident", [l1.points[1].id, arc1.points[2].id]);
      constrain("coincident", [l2.points[0].id, arc1.points[1].id]);
      constrain("coincident", [l1.points[0].id, arc2.points[1].id]);
      constrain("coincident", [l2.points[1].id, arc2.points[2].id]);
      constrain("equal", [arc1.id, arc2.id]);
      break;
    }
    case "arcSlot": {
      const r = dist(a, b),
        width = dist(a, d) - r;
      if (Math.abs(width) < 1e-6 || r - Math.abs(width) <= 0)
        throw new Error("槽宽无效");
      const half = Math.abs(width),
        start = normalize(sub(b, a)),
        end = normalize(sub(c, a)),
        bo = add(a, mul(start, r + half)),
        bi = add(a, mul(start, r - half)),
        co = add(a, mul(end, r + half)),
        ci = add(a, mul(end, r - half));
      const capStart = add(a, mul(start, r)),
        capEnd = add(a, mul(end, r));
      const outer = push("arc", [a, bo, co], { radius: r + half, ccw: true }),
        inner = push("arc", [a, ci, bi], { radius: r - half, ccw: false }),
        cap1 = push("arc", [capStart, bi, bo], { radius: half, ccw: true }),
        cap2 = push("arc", [capEnd, co, ci], { radius: half, ccw: true });
      constrain("concentric", [outer.id, inner.id]);
      for (const [ar, cap] of [
        [outer, cap1],
        [inner, cap1],
        [outer, cap2],
        [inner, cap2],
      ])
        constrain("tangent", [ar.id, cap.id]);
      constrain("coincident", [outer.points[1].id, cap1.points[2].id]);
      constrain("coincident", [inner.points[2].id, cap1.points[1].id]);
      constrain("coincident", [outer.points[2].id, cap2.points[1].id]);
      constrain("coincident", [inner.points[1].id, cap2.points[2].id]);
      constrain("equal", [cap1.id, cap2.id]);
      break;
    }
    case "spline":
      if (ps.length < 2) throw new Error("样条曲线至少需要两个点");
      push("spline", ps);
      break;
    case "bezier":
      push("bezier", ps);
      break;
    case "conic":
      if (config.weight <= 0) throw new Error("权重必须为正");
      push("conic", ps, { weight: config.weight });
      break;
    case "point":
      push("point", [a]);
      break;
    case "text":
      if (!config.text.trim() || config.fontSize <= 0)
        throw new Error("文本内容和高度无效");
      push("text", [a], {
        text: config.text,
        fontSize: config.fontSize,
        rotation: 0,
      });
      break;
  }
  return { entities, constraints };
}
export function appendGeometry(
  sketch: Sketch,
  result: ReturnType<typeof createGeometry>,
  snaps: { pointIndex: number; ref: string }[],
  auto: boolean,
) {
  sketch.entities.push(...result.entities);
  sketch.constraints.push(...result.constraints);
  if (!auto) return;
  for (const snap of snaps) {
    const p = result.entities[0]?.points[snap.pointIndex];
    if (
      p &&
      p.id !== snap.ref &&
      sketch.entities.some((e) => e.points.some((q) => q.id === snap.ref))
    )
      sketch.constraints.push({
        id: uid("c"),
        kind: "coincident",
        refs: [p.id, snap.ref],
      });
  }
}
