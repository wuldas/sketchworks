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
import { type SnapReference } from "./snapping";
export type Tool =
  | "select"
  | "line"
  | "midline"
  | "rectangle"
  | "centerRectangle"
  | "threeRectangle"
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
  threeRectangle: "三点矩形",
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
  threeRectangle: 3,
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
  /** Absolute orientation in degrees for angle-capable tools; undefined follows the picked orientation. */
  angle?: number;
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

const angleTools: Partial<Record<Tool, true>> = {
  midline: true,
  centerRectangle: true,
  polygon: true,
  ellipse: true,
  slot: true,
  centerArc: true,
  arcSlot: true,
};

export function creationSupportsAngle(tool: Tool): boolean {
  return angleTools[tool] === true;
}

/**
 * Picks a tool consumes for creation: for the rotatable angle tools with a
 * finite config.angle every point is rigidly rotated about the first pick so
 * the first-to-second direction matches the absolute angle. Auto (undefined
 * angle), centerRectangle and unsupported tools return the input array as-is;
 * a configured non-finite angle throws.
 */
export function creationInputPoints(
  tool: Tool,
  points: XY[],
  config: CreateConfig,
): XY[] {
  const angle = config.angle;
  if (
    angle !== undefined &&
    (typeof angle !== "number" || !Number.isFinite(angle))
  )
    throw new Error("角度值必须为有限数字");
  // centerRectangle keeps its raw picks: its geometry projects the corner onto
  // axes rotated to the absolute angle instead of moving the picked points.
  if (
    angle === undefined ||
    tool === "centerRectangle" ||
    !angleTools[tool] ||
    points.length < 2
  )
    return points;
  const delta =
    ((angle % 360) * Math.PI) / 180 -
    Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
  // Already-rotated picks must pass through unchanged, keeping the helper idempotent.
  if (
    Math.abs(delta) < 1e-12 ||
    Math.abs(Math.abs(delta) - Math.PI * 2) < 1e-12
  )
    return points;
  const cos = Math.cos(delta),
    sin = Math.sin(delta),
    [origin] = points;
  return points.map((p, i) =>
    i === 0
      ? p
      : {
          x: origin.x + (p.x - origin.x) * cos - (p.y - origin.y) * sin,
          y: origin.y + (p.x - origin.x) * sin + (p.y - origin.y) * cos,
        },
  );
}

export function createGeometry(
  tool: Tool,
  ps: XY[],
  config: CreateConfig,
): { entities: Entity[]; constraints: Constraint[] } {
  const entities: Entity[] = [],
    constraints: Constraint[] = [];
  // Center rectangle keeps the picked corner exactly: it consumes the raw picks
  // and projects them onto axes rotated to the absolute angle below. The helper
  // call stays unconditional so a configured non-finite angle always throws.
  const effective = creationInputPoints(tool, ps, config);
  const [a, b, c, d] = effective;
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
      const theta =
        tool === "centerRectangle" && typeof config.angle === "number"
          ? (config.angle * Math.PI) / 180
          : undefined;
      if (theta !== undefined) {
        const u = { x: Math.cos(theta), y: Math.sin(theta) },
          w = { x: -u.y, y: u.x },
          pu = (b.x - a.x) * u.x + (b.y - a.y) * u.y,
          pv = (b.x - a.x) * w.x + (b.y - a.y) * w.y,
          at = (su: number, sv: number) => add(a, add(mul(u, su), mul(w, sv)));
        closed([at(-pu, -pv), at(pu, -pv), b, at(-pu, pv)]);
        constrain("parallel", [entities[0].id, entities[2].id]);
        constrain("parallel", [entities[1].id, entities[3].id]);
        constrain("perpendicular", [entities[0].id, entities[1].id]);
      } else {
        const min = tool === "centerRectangle" ? sub(mul(a, 2), b) : a;
        closed([min, { x: b.x, y: min.y }, b, { x: min.x, y: b.y }], true);
      }
      break;
    }
    case "threeRectangle": {
      const base = dist(b, a);
      if (base < 1e-6) throw new Error("矩形基线长度不能为零");
      const n = mul({ x: a.y - b.y, y: b.x - a.x }, 1 / base);
      const h = (c.x - a.x) * n.x + (c.y - a.y) * n.y;
      if (Math.abs(h) < 1e-6) throw new Error("矩形高度不能为零");
      closed([a, b, add(b, mul(n, h)), add(a, mul(n, h))]);
      constrain("parallel", [entities[0].id, entities[2].id]);
      constrain("parallel", [entities[1].id, entities[3].id]);
      constrain("perpendicular", [entities[0].id, entities[1].id]);
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
      const angle =
          Math.atan2(b.y - a.y, b.x - a.x) -
          (config.polygonOuter ? Math.PI / sides : 0),
        r = dist(a, b) / (config.polygonOuter ? Math.cos(Math.PI / sides) : 1);
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
export interface CreationCapture {
  pointIndex: number;
  ref: SnapReference;
  point?: XY;
}

export function appendGeometry(
  sketch: Sketch,
  result: ReturnType<typeof createGeometry>,
  snaps: CreationCapture[],
  auto: boolean,
  tool?: Tool,
) {
  sketch.entities.push(...result.entities);
  sketch.constraints.push(...result.constraints);
  if (!auto) return;
  const constrain = (kind: Constraint["kind"], refs: string[]) => {
    if (
      !sketch.constraints.some(
        (c) =>
          c.kind === kind &&
          c.refs.length === refs.length &&
          refs.every((ref) => c.refs.includes(ref)),
      )
    )
      sketch.constraints.push({ id: uid("c"), kind, refs });
  };
  const helper = (coords: XY, owner: Entity) => {
    const e = entity("point", [coords], {
      construction: true,
      ownerId: owner.id,
    });
    sketch.entities.push(e);
    return e.points[0];
  };
  const perimeter = (coords: XY, owner: Entity) => {
    const p = helper(coords, owner);
    constrain("onCurve", [p.id, owner.id]);
    return p;
  };
  const radialCapture = (
    coords: XY,
    owner: Entity,
    end: XY & { id: string },
  ) => {
    const ray = entity("line", [owner.points[0], end], {
      construction: true,
      ownerId: owner.id,
    });
    sketch.entities.push(ray);
    constrain("coincident", [ray.points[0].id, owner.points[0].id]);
    constrain("coincident", [ray.points[1].id, end.id]);
    const p = helper(coords, owner);
    sketch.constraints.push({
      id: uid("c"),
      kind: "onLine",
      refs: [p.id, ray.id],
      sameRay: true,
    });
    return p;
  };
  let polygonCircle: Entity | undefined;
  const polygonControl = () => {
    if (polygonCircle) return polygonCircle;
    const es = result.entities,
      info = circleFromThree(es[0].points[0], es[1].points[0], es[2].points[0]);
    if (!info) return;
    polygonCircle = entity("circle", [info.center], {
      radius: info.radius,
      construction: true,
      ownerId: es[0].id,
    });
    sketch.entities.push(polygonCircle);
    for (const side of es)
      constrain("onCurve", [side.points[0].id, polygonCircle.id]);
    return polygonCircle;
  };
  // Input clicks are not generally in the same order as an entity's control points.
  const destination = (snap: CreationCapture) => {
    const es = result.entities,
      e = es[0],
      i = snap.pointIndex,
      coords = snap.point;
    if (!e) return;
    switch (tool) {
      case "line":
      case "spline":
      case "bezier":
      case "conic":
      case "point":
      case "text":
        return e.points[i];
      case "midline":
        return i === 0 ? es[1].points[0] : e.points[1];
      case "rectangle":
        return i === 0 ? e.points[0] : es[1].points[1];
      case "centerRectangle": {
        if (i === 1) return es[1].points[1];
        if (!coords) return;
        const p = helper(coords, e);
        constrain("symmetric", [e.points[0].id, es[1].points[1].id, p.id]);
        return p;
      }
      case "threeRectangle":
        if (i < 2) return e.points[i];
        if (coords) {
          const p = helper(coords, e);
          constrain("onLine", [p.id, es[2].id]);
          return p;
        }
        return;
      case "circle":
        return i === 0
          ? e.points[0]
          : coords
            ? perimeter(coords, e)
            : undefined;
      case "threeCircle":
        return coords ? perimeter(coords, e) : undefined;
      case "arc":
        return i === 0
          ? e.points[1]
          : i === 2
            ? e.points[2]
            : coords
              ? perimeter(coords, e)
              : undefined;
      case "centerArc":
        return i < 2
          ? e.points[i]
          : coords
            ? radialCapture(coords, e, e.points[2])
            : undefined;
      case "polygon": {
        if (!coords) return;
        if (i === 0) return polygonControl()?.points[0];
        const vertex = es
          .flatMap((part) => part.points)
          .find((p) => dist(p, coords) <= EPS);
        if (vertex) return vertex;
        if (i !== 1) return;
        // 内切圆 sizing click: the pick is the edge-0 tangency midpoint.
        const p = helper(coords, e);
        constrain("midpoint", [p.id, es[0].id]);
        return p;
      }
      case "ellipse": {
        if (i < 2) return e.points[i];
        if (!coords) return;
        const axis = entity("line", [e.points[0], e.points[1]], {
            construction: true,
            ownerId: e.id,
          }),
          width = entity(
            "line",
            [coords, add(coords, sub(e.points[1], e.points[0]))],
            { construction: true, ownerId: e.id },
          ),
          circle = entity("circle", [e.points[0]], {
            radius: e.ry,
            construction: true,
            ownerId: e.id,
          });
        sketch.entities.push(axis, width, circle);
        constrain("coincident", [axis.points[0].id, e.points[0].id]);
        constrain("coincident", [axis.points[1].id, e.points[1].id]);
        constrain("coincident", [circle.points[0].id, e.points[0].id]);
        constrain("parallel", [axis.id, width.id]);
        constrain("tangent", [width.id, circle.id]);
        constrain("ellipseWidth", [e.id, circle.id]);
        return width.points[0];
      }
      case "slot":
        if (i < 2) return es[i === 0 ? 3 : 1].points[0];
        if (coords) {
          const side =
              cross(
                sub(es[1].points[0], es[3].points[0]),
                sub(coords, es[1].points[0]),
              ) >= 0
                ? es[0]
                : es[2],
            p = helper(coords, side);
          constrain("onLine", [p.id, side.id]);
          return p;
        }
        return;
      case "arcSlot":
        if (i === 0) return e.points[0];
        if (i === 1) return es[2].points[0];
        if (i === 2 && coords) return radialCapture(coords, e, es[3].points[0]);
        if (!coords) return;
        const boundary =
            Math.abs(dist(coords, e.points[0]) - (e.radius ?? 0)) <= EPS
              ? e
              : es[1],
          circle = entity("circle", [boundary.points[0]], {
            radius: boundary.radius,
            construction: true,
            ownerId: e.id,
          });
        sketch.entities.push(circle);
        constrain("concentric", [circle.id, boundary.id]);
        constrain("equal", [circle.id, boundary.id]);
        const p = helper(coords, e);
        constrain("onCurve", [p.id, circle.id]);
        return p;
      default:
        return coords
          ? es
              .flatMap((part) => part.points)
              .find((p) => dist(p, coords) <= EPS)
          : e.points[i];
    }
  };
  for (const snap of snaps) {
    const ref = snap.ref;
    const refs = typeof ref === "string" ? [ref] : ref.refs;
    if (
      refs.some(
        (id) =>
          !sketch.entities.some(
            (e) =>
              !e.sourceId &&
              (typeof ref === "string"
                ? e.points.some((p) => p.id === id)
                : e.id === id),
          ),
      )
    )
      continue;
    const p = destination(snap);
    if (!p) continue;
    if (typeof ref === "string") {
      if (p.id !== ref) constrain("coincident", [p.id, ref]);
    } else if (ref.kind === "tangent") {
      constrain("onCurve", [p.id, ...ref.refs]);
      const line = result.entities[0];
      if (line.kind === "line" && (tool === "line" || tool === "midline"))
        constrain("tangent", [line.id, ...ref.refs]);
    } else {
      constrain(ref.kind, [p.id, ...ref.refs]);
    }
  }
}
