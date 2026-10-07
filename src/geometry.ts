import paper from "paper";
import {
  type Entity,
  type XY,
  type Sketch,
  type Transform,
  clone,
  point,
} from "./model";
const scope = new paper.PaperScope();
scope.setup(new scope.Size(1, 1));
export const EPS = 1e-7;
export const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
export const add = (a: XY, b: XY): XY => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (p: XY, v: number): XY => ({ x: p.x * v, y: p.y * v });
export const dot = (a: XY, b: XY) => a.x * b.x + a.y * b.y;
export const cross = (a: XY, b: XY) => a.x * b.y - a.y * b.x;
export const normalize = (p: XY) => mul(p, 1 / (Math.hypot(p.x, p.y) || 1));
export const lerp = (a: XY, b: XY, t: number) => add(a, mul(sub(b, a), t));
export function arcInfo(e: Entity) {
  const [c, a, b] = e.points;
  const r = dist(c, a);
  const start = Math.atan2(a.y - c.y, a.x - c.x),
    end = Math.atan2(b.y - c.y, b.x - c.x);
  const tau = Math.PI * 2;
  let sweep = (end - start + tau) % tau;
  if (e.ccw === false) sweep = sweep - tau;
  return { c, r, start, end, sweep };
}
export function circleFromThree(
  a: XY,
  b: XY,
  c: XY,
): { center: XY; radius: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < EPS) return null;
  const aa = dot(a, a),
    bb = dot(b, b),
    cc = dot(c, c);
  const center = {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / d,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / d,
  };
  return { center, radius: dist(center, a) };
}
export function lineIntersection(a: XY, b: XY, c: XY, d: XY): XY | null {
  const r = sub(b, a),
    s = sub(d, c),
    den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  return add(a, mul(r, cross(sub(c, a), s) / den));
}
/** Perpendicular distance from a point to the infinite line through a and b. */
export function pointLineDistance(p: XY, a: XY, b: XY) {
  const d = sub(b, a),
    length = Math.hypot(d.x, d.y);
  return length ? Math.abs(cross(d, sub(p, a))) / length : 0;
}
export function angleDimensionFrame(a: Entity, b?: Entity) {
  const v = sub(a.points[1], a.points[0]);
  if (!b) return { vertex: a.points[0], start: 0, sweep: Math.atan2(v.y, v.x) };
  const w = sub(b.points[1], b.points[0]);
  return {
    vertex:
      lineIntersection(a.points[0], a.points[1], b.points[0], b.points[1]) ??
      a.points[0],
    start: Math.atan2(v.y, v.x),
    sweep: Math.atan2(cross(v, w), dot(v, w)),
  };
}
export function projection(p: XY, a: XY, b: XY, clamp = true) {
  const ab = sub(b, a),
    n = dot(ab, ab);
  let t = n ? dot(sub(p, a), ab) / n : 0;
  if (clamp) t = Math.min(1, Math.max(0, t));
  return { point: add(a, mul(ab, t)), t };
}
const pp = (p: XY) => new scope.Point(p.x, p.y);
export function splineBezierSegments(e: Entity): XY[][] {
  const path = new scope.Path({ segments: e.points.map(pp), insert: false });
  if (e.points.length > 2) path.smooth({ type: "continuous" });
  const result = path.curves.map((c) =>
    [c.point1, c.point1.add(c.handle1), c.point2.add(c.handle2), c.point2].map(
      (p) => ({ x: p.x, y: p.y }),
    ),
  );
  path.remove();
  return result;
}
export function bezierAt(p: XY[], t: number): XY {
  const u = 1 - t;
  return {
    x:
      u * u * u * p[0].x +
      3 * u * u * t * p[1].x +
      3 * u * t * t * p[2].x +
      t * t * t * p[3].x,
    y:
      u * u * u * p[0].y +
      3 * u * u * t * p[1].y +
      3 * u * t * t * p[2].y +
      t * t * t * p[3].y,
  };
}
export function conicAt(e: Entity, t: number): XY {
  const [a, b, c] = e.points,
    w = e.weight ?? 1,
    u = 1 - t,
    den = u * u + 2 * w * u * t + t * t;
  return {
    x: (u * u * a.x + 2 * w * u * t * b.x + t * t * c.x) / den,
    y: (u * u * a.y + 2 * w * u * t * b.y + t * t * c.y) / den,
  };
}
function adaptive(fn: (t: number) => XY, tol: number): XY[] {
  const out: XY[] = [fn(0)];
  function step(a: number, b: number, pa: XY, pb: XY, depth: number) {
    const m = (a + b) / 2,
      pm = fn(m);
    const deviation = Math.max(
      dist(pm, projection(pm, pa, pb).point),
      ...[0.25, 0.75].map((u) => {
        const p = fn(a + (b - a) * u);
        return dist(p, projection(p, pa, pb).point);
      }),
    );
    if (deviation > tol && depth < 20) {
      step(a, m, pa, pm, depth + 1);
      step(m, b, pm, pb, depth + 1);
    } else out.push(pb);
    if (out.length > 100000) throw new Error("曲线超出精度采样上限");
  }
  step(0, 1, out[0], fn(1), 0);
  return out;
}
export function sampleEntity(e: Entity, tolerance = 0.001): XY[] {
  const tol = Math.max(1e-6, tolerance);
  if (e.kind === "line" || e.kind === "point" || e.kind === "text")
    return e.points;
  if (e.kind === "bezier") return adaptive((t) => bezierAt(e.points, t), tol);
  if (e.kind === "conic") return adaptive((t) => conicAt(e, t), tol);
  if (e.kind === "spline")
    return splineBezierSegments(e).flatMap((ps, i) =>
      adaptive((t) => bezierAt(ps, t), tol).slice(i ? 1 : 0),
    );
  const c = e.points[0];
  let r = e.radius ?? 1,
    start = 0,
    sweep = Math.PI * 2,
    ry = r,
    angle = 0;
  if (e.kind === "arc") {
    const info = arcInfo(e);
    r = info.r;
    ry = r;
    start = info.start;
    sweep = info.sweep;
  }
  if (e.kind === "ellipse") {
    r = dist(c, e.points[1]);
    ry = e.ry ?? r / 2;
    angle = Math.atan2(e.points[1].y - c.y, e.points[1].x - c.x);
  }
  const n = Math.max(
    8,
    Math.ceil(
      Math.abs(sweep) /
        Math.max(
          0.00001,
          2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, ry))),
        ),
    ),
  );
  if (n > 100000) throw new Error("几何尺寸超出导出采样上限");
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = start + (sweep * i) / n;
    const x = r * Math.cos(t),
      y = ry * Math.sin(t);
    return {
      x: c.x + x * Math.cos(angle) - y * Math.sin(angle),
      y: c.y + x * Math.sin(angle) + y * Math.cos(angle),
    };
  });
}
export function entityPath(e: Entity): string {
  const ps = e.points;
  const xy = (p: XY) => `${p.x},${p.y}`;
  if (e.kind === "line") return `M${xy(ps[0])} L${xy(ps[1])}`;
  if (e.kind === "circle") {
    const c = ps[0],
      r = e.radius ?? 1;
    return `M${c.x - r},${c.y} a${r},${r} 0 1,0 ${r * 2},0 a${r},${r} 0 1,0 ${-r * 2},0`;
  }
  if (e.kind === "arc") {
    const { r, sweep } = arcInfo(e);
    return `M${xy(ps[1])} A${r},${r} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0},${e.ccw === false ? 0 : 1} ${xy(ps[2])}`;
  }
  if (e.kind === "ellipse") {
    const c = ps[0],
      a = ps[1],
      r = dist(c, a),
      rotation = (Math.atan2(a.y - c.y, a.x - c.x) * 180) / Math.PI,
      op = { x: 2 * c.x - a.x, y: 2 * c.y - a.y };
    return `M${xy(a)} A${r},${e.ry ?? r / 2} ${rotation} 1,1 ${xy(op)} A${r},${e.ry ?? r / 2} ${rotation} 1,1 ${xy(a)}`;
  }
  if (e.kind === "bezier")
    return `M${xy(ps[0])} C${ps.slice(1).map(xy).join(" ")}`;
  if (e.kind === "spline")
    return splineBezierSegments(e)
      .map(
        (p, i) => `${i ? "" : `M${xy(p[0])} `}C${p.slice(1).map(xy).join(" ")}`,
      )
      .join(" ");
  if (e.kind === "conic")
    return sampleEntity(e, 0.02)
      .map((p, i) => `${i ? "L" : "M"}${xy(p)}`)
      .join(" ");
  return "";
}
export function bounds(entities: Entity[]) {
  if (!entities.length) return { minX: -80, maxX: 80, minY: -55, maxY: 55 };
  const result = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  const include = (p: XY) => {
    result.minX = Math.min(result.minX, p.x);
    result.maxX = Math.max(result.maxX, p.x);
    result.minY = Math.min(result.minY, p.y);
    result.maxY = Math.max(result.maxY, p.y);
  };
  for (const e of entities) {
    if (e.kind === "text") {
      const p = e.points[0],
        h = e.fontSize ?? 6;
      const width =
        [...(e.text ?? "")].reduce(
          (w, c) => w + (c.charCodeAt(0) > 255 ? 1 : 0.65) * h,
          0,
        ) || h;
      const t: Transform = {
        kind: "rotate",
        x: p.x,
        y: p.y,
        angle: e.rotation ?? 0,
      };
      for (const x of [0, width])
        for (const y of [-h * 0.25, h])
          include(transformPoint({ x: p.x + x, y: p.y + y }, t));
    } else if (e.kind === "circle") {
      const c = e.points[0],
        r = e.radius ?? 1;
      include({ x: c.x - r, y: c.y - r });
      include({ x: c.x + r, y: c.y + r });
    } else for (const p of sampleEntity(e, 0.05)) include(p);
  }
  return result;
}
export function transformPoint(p: XY, t: Transform): XY {
  if (t.kind === "translate")
    return { x: p.x + (t.x ?? 0), y: p.y + (t.y ?? 0) };
  const c = { x: t.x ?? 0, y: t.y ?? 0 };
  if (t.kind === "rotate") {
    const a = ((t.angle ?? 0) * Math.PI) / 180,
      q = sub(p, c);
    return {
      x: c.x + q.x * Math.cos(a) - q.y * Math.sin(a),
      y: c.y + q.x * Math.sin(a) + q.y * Math.cos(a),
    };
  }
  const a = { x: t.ax ?? 0, y: t.ay ?? 0 },
    b = { x: t.bx ?? 1, y: t.by ?? 0 };
  const foot = projection(p, a, b, false).point;
  return sub(mul(foot, 2), p);
}
export function transformedEntity(
  e: Entity,
  t: Transform,
  newIds = false,
): Entity {
  const copy = clone(e);
  copy.points = e.points.map((p) => ({
    ...transformPoint(p, t),
    id: newIds ? point(0, 0).id : p.id,
  }));
  if (t.kind === "mirror" && e.kind === "arc") copy.ccw = e.ccw === false;
  if (e.kind === "text")
    copy.rotation =
      (e.rotation ?? 0) + (t.kind === "rotate" ? (t.angle ?? 0) : 0);
  return copy;
}
export function blendEntity(a: Entity, b: Entity): Entity {
  const tangent = (e: Entity, end: boolean): XY => {
    if (e.kind === "line") return normalize(sub(e.points[1], e.points[0]));
    if (e.kind === "bezier")
      return normalize(
        end ? sub(e.points[3], e.points[2]) : sub(e.points[1], e.points[0]),
      );
    if (e.kind === "arc") {
      const r = sub(e.points[end ? 2 : 1], e.points[0]);
      return normalize(mul({ x: -r.y, y: r.x }, e.ccw === false ? -1 : 1));
    }
    throw new Error("过渡曲线支持直线、圆弧与贝塞尔端点");
  };
  const start = a.points.at(-1)!,
    end = b.points[b.kind === "arc" ? 1 : 0],
    length = dist(start, end) / 3;
  if (length < EPS) throw new Error("过渡端点必须分离");
  const controls = [
    start,
    add(start, mul(tangent(a, true), length)),
    sub(end, mul(tangent(b, false), length)),
    end,
  ];
  return {
    id: "",
    kind: "bezier",
    name: "过渡曲线",
    points: controls.map((p) => point(p.x, p.y)),
  };
}
export function updateDerived(sketch: Sketch) {
  for (const e of sketch.entities) {
    if (!e.sourceId || !e.transform) continue;
    const source = sketch.entities.find((s) => s.id === e.sourceId);
    if (!source || source.sourceId) throw new Error("派生源对象缺失或非法");
    const t = e.transform;
    if (t.kind === "blend") {
      const second = sketch.entities.find((s) => s.id === t.secondarySourceId);
      if (!second || second.sourceId) throw new Error("过渡曲线源对象缺失");
      const updated = blendEntity(source, second);
      e.points = updated.points.map((p, i) => ({
        ...p,
        id: e.points[i]?.id ?? point(0, 0).id,
      }));
      continue;
    }
    if (t.axisId) {
      const axis = sketch.entities.find((a) => a.id === t.axisId);
      if (
        !axis ||
        axis.kind !== "line" ||
        dist(axis.points[0], axis.points[1]) < EPS
      )
        throw new Error("镜像轴缺失或退化");
      Object.assign(t, {
        ax: axis.points[0].x,
        ay: axis.points[0].y,
        bx: axis.points[1].x,
        by: axis.points[1].y,
      });
    }
    const updated = transformedEntity(source, t),
      ids = e.points.map((p) => p.id),
      construction = e.construction;
    Object.assign(e, updated, {
      id: e.id,
      name: e.name,
      sourceId: source.id,
      transform: t,
      construction,
    });
    e.points = e.points.map((p, i) => ({ ...p, id: ids[i] ?? point(0, 0).id }));
  }
}
export function nearestOnEntity(
  e: Entity,
  p: XY,
): { point: XY; t: number; distance: number } {
  const pts = sampleEntity(e, 0.05);
  if (pts.length === 1)
    return { point: pts[0], t: 0, distance: dist(p, pts[0]) };
  let best = { point: pts[0], t: 0, distance: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const proj = projection(p, pts[i], pts[i + 1]);
    const distance = dist(p, proj.point);
    if (distance < best.distance)
      best = {
        point: proj.point,
        t: (i + proj.t) / (pts.length - 1),
        distance,
      };
  }
  return best;
}
export function paperPath(e: Entity) {
  if (e.kind === "text" || e.kind === "point")
    return new scope.Path({ segments: e.points.map(pp), insert: false });
  return new scope.Path({ pathData: entityPath(e), insert: false });
}
export function intersections(a: Entity, b: Entity): XY[] {
  const pa = paperPath(a),
    pb = paperPath(b);
  const xs = pa
    .getIntersections(pb)
    .map((i) => ({ x: i.point.x, y: i.point.y }));
  pa.remove();
  pb.remove();
  return xs;
}
export function validGeometry(sketch: Sketch) {
  for (const e of sketch.entities) {
    if (
      e.points.some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          Math.abs(p.x) > 1e7 ||
          Math.abs(p.y) > 1e7,
      )
    )
      throw new Error("坐标越界");
    if (e.kind === "line" && dist(e.points[0], e.points[1]) < EPS)
      throw new Error("不能生成零长度线段");
    if (e.kind === "circle" && !(e.radius! > EPS))
      throw new Error("半径必须大于零");
    if (
      e.kind === "arc" &&
      (dist(e.points[0], e.points[1]) < EPS ||
        dist(e.points[1], e.points[2]) < EPS)
    )
      throw new Error("圆弧退化");
  }
}
