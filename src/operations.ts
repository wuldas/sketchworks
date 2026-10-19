import ClipperLib from "clipper-lib";
import {
  type Constraint,
  type Entity,
  type Sketch,
  type Transform,
  type XY,
  clone,
  deleteEntities,
  entity,
  uid,
} from "./model";
import {
  EPS,
  add,
  arcInfo,
  cross,
  dist,
  dot,
  lerp,
  lineIntersection,
  mul,
  normalize,
  paperPath,
  projection,
  sampleEntity,
  sub,
  transformPoint,
  transformedEntity,
  updateDerived,
  validGeometry,
} from "./geometry";
import {
  prepareDimensionLabels,
  updateDimensionLabels,
} from "./dimensionLabel";

const TOL = 0.001;
const TAU = Math.PI * 2;
const SCALE = 1e6;
const LIMIT = 10000;
const mod = (a: number) => ((a % TAU) + TAU) % TAU;
function fail(message: string): never {
  throw new Error(message);
}
const number = (
  values: Record<string, number>,
  key: string,
  fallback?: number,
) => {
  const n = values[key] ?? fallback;
  if (n === undefined || !Number.isFinite(n))
    return fail(`参数 ${key} 必须是有限数值`);
  return n;
};
const positive = (
  values: Record<string, number>,
  key: string,
  fallback?: number,
) => {
  const n = number(values, key, fallback);
  if (n <= EPS) return fail(`参数 ${key} 必须大于零`);
  return n;
};
const integer = (
  values: Record<string, number>,
  key: string,
  fallback: number,
) => {
  const n = positive(values, key, fallback);
  if (!Number.isSafeInteger(n) || n > LIMIT)
    return fail(`参数 ${key} 必须是 1 到 ${LIMIT} 的整数`);
  return n;
};
function capacity(sketch: Sketch, extra: number) {
  if (sketch.entities.length + extra > LIMIT)
    fail("操作后对象总数不能超过 10000");
}
function plainTopology(sketch: Sketch, entities: Entity[]) {
  if (
    entities.some(
      (e) =>
        e.sourceId ||
        sketch.entities.some(
          (d) =>
            d.sourceId === e.id ||
            d.transform?.axisId === e.id ||
            d.transform?.secondarySourceId === e.id,
        ),
    )
  )
    fail("派生对象或含派生副本的源对象不能直接修改拓扑，请先解除派生关系");
}
function notFixed(sketch: Sketch, entities: Entity[]) {
  const ids = new Set(entities.map((e) => e.id));
  const affected = sketch.entities.filter(
    (e) =>
      ids.has(e.id) ||
      (e.ownerId && ids.has(e.ownerId)) ||
      (e.sourceId && ids.has(e.sourceId)) ||
      (e.transform?.axisId && ids.has(e.transform.axisId)) ||
      (e.transform?.secondarySourceId &&
        ids.has(e.transform.secondarySourceId)),
  );
  const refs = new Set(
    affected.flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
  );
  if (
    sketch.constraints.some(
      (c) =>
        (c.kind === "fixed" || c.kind === "origin") &&
        c.refs.some((r) => refs.has(r)),
    )
  )
    fail("固定对象不能修改，请先解除固定约束");
}
function removeAffected(
  sketch: Sketch,
  changed: Entity[],
  points: string[],
  removed: Set<string>,
  preserve?: (constraint: Constraint) => boolean,
) {
  const refs = new Set([...changed.map((e) => e.id), ...points]);
  sketch.constraints = sketch.constraints.filter((c) => {
    if (!c.refs.some((r) => refs.has(r)) || preserve?.(c)) return true;
    removed.add(c.id);
    return false;
  });
}
function replace(
  sketch: Sketch,
  old: Entity,
  replacements: Entity[],
  removed: Set<string>,
) {
  capacity(sketch, replacements.length - 1);
  const before = sketch.constraints.map((c) => c.id);
  deleteEntities(sketch, [old.id]);
  const remaining = new Set(sketch.constraints.map((c) => c.id));
  before.filter((id) => !remaining.has(id)).forEach((id) => removed.add(id));
  sketch.entities.push(...replacements);
}
function withOwned(sketch: Sketch, sources: Entity[]) {
  const ids = new Set(sources.map((e) => e.id));
  return [
    ...sources,
    ...sketch.entities.filter(
      (e) => e.ownerId && ids.has(e.ownerId) && !ids.has(e.id),
    ),
  ];
}
function cloneBatch(sketch: Sketch, sources: Entity[], transform: Transform) {
  sources = withOwned(sketch, sources);
  capacity(sketch, sources.length);
  const mapping = new Map<string, string>();
  const copies = sources.map((source) => {
    const copy = transformedEntity(source, transform, true);
    copy.id = uid();
    copy.name = `${source.name} 副本`;
    delete copy.sourceId;
    delete copy.transform;
    mapping.set(source.id, copy.id);
    source.points.forEach((p, i) => mapping.set(p.id, copy.points[i].id));
    return copy;
  });
  for (let i = 0; i < copies.length; i++) {
    const ownerId = sources[i].ownerId;
    if (ownerId && mapping.has(ownerId))
      copies[i].ownerId = mapping.get(ownerId);
    else delete copies[i].ownerId;
  }
  const constraints = sketch.constraints
    .filter(
      (c) =>
        c.kind !== "fixed" &&
        c.kind !== "origin" &&
        !c.anchors?.length &&
        c.refs.every((r) => mapping.has(r)),
    )
    .map((c) => {
      const copy = {
        ...clone(c),
        id: uid("c"),
        refs: c.refs.map((r) => mapping.get(r)!),
      };
      if (copy.labelPosition)
        copy.labelPosition = transformPoint(copy.labelPosition, transform);
      return copy;
    });
  if (sketch.constraints.length + constraints.length > 20000)
    fail("操作后约束总数不能超过 20000");
  sketch.entities.push(...copies);
  sketch.constraints.push(...constraints);
}
function derivedBatch(sketch: Sketch, sources: Entity[], transform: Transform) {
  if (sources.some((e) => e.sourceId))
    fail("不能再次派生关联对象，请先解除派生关系");
  capacity(sketch, sources.length);
  for (const source of sources) {
    const copy = transformedEntity(source, transform, true);
    copy.id = uid();
    copy.name = `${source.name} 关联副本`;
    delete copy.ownerId;
    copy.sourceId = source.id;
    copy.transform = clone(transform);
    sketch.entities.push(copy);
  }
}
function parameter(e: Entity, p: XY): number {
  if (e.kind === "line")
    return projection(p, e.points[0], e.points[1], false).t;
  const c = e.points[0];
  const angle = Math.atan2(p.y - c.y, p.x - c.x);
  if (e.kind === "circle") return mod(angle) / TAU;
  const info = arcInfo(e),
    direction = info.sweep < 0 ? -1 : 1;
  return mod((angle - info.start) * direction) / Math.abs(info.sweep);
}
function at(e: Entity, t: number): XY {
  if (e.kind === "line") return lerp(e.points[0], e.points[1], t);
  const c = e.points[0],
    info =
      e.kind === "arc" ? arcInfo(e) : { r: e.radius!, start: 0, sweep: TAU };
  const angle = info.start + t * info.sweep;
  return {
    x: c.x + info.r * Math.cos(angle),
    y: c.y + info.r * Math.sin(angle),
  };
}
function piece(e: Entity, from: number, to: number): Entity {
  if (e.kind === "line")
    return entity("line", [at(e, from), at(e, to)], {
      name: e.name,
      construction: e.construction,
    });
  return entity("arc", [e.points[0], at(e, from), at(e, to)], {
    name: e.name,
    construction: e.construction,
    radius: e.kind === "circle" ? e.radius : arcInfo(e).r,
    ccw: e.kind === "circle" || e.ccw !== false,
  });
}
function supportedCurve(e: Entity) {
  if (!["line", "circle", "arc"].includes(e.kind))
    fail("此拓扑操作仅支持直线、圆和圆弧，不支持样条、椭圆或其他曲线");
}
function intersections(a: Entity, b: Entity, fullA = false): XY[] {
  supportedCurve(a);
  supportedCurve(b);
  let hits: XY[] = [];
  if (a.kind === "line" && b.kind === "line") {
    const hit = lineIntersection(
      a.points[0],
      a.points[1],
      b.points[0],
      b.points[1],
    );
    if (hit) hits = [hit];
  } else if (a.kind === "line" || b.kind === "line") {
    const line = a.kind === "line" ? a : b,
      circle = a.kind === "line" ? b : a;
    const c = circle.points[0],
      radius = circle.kind === "circle" ? circle.radius! : arcInfo(circle).r;
    const delta = sub(line.points[1], line.points[0]),
      q = sub(line.points[0], c);
    const aa = dot(delta, delta),
      bb = 2 * dot(q, delta),
      cc = dot(q, q) - radius * radius;
    const discriminant = bb * bb - 4 * aa * cc;
    if (aa > EPS * EPS && discriminant >= -EPS) {
      const root = Math.sqrt(Math.max(0, discriminant));
      hits = [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)].map((t) =>
        add(line.points[0], mul(delta, t)),
      );
    }
  } else {
    const c = a.points[0],
      d = b.points[0],
      r = a.kind === "circle" ? a.radius! : arcInfo(a).r,
      s = b.kind === "circle" ? b.radius! : arcInfo(b).r;
    const length = dist(c, d);
    if (
      length > EPS &&
      length <= r + s + EPS &&
      length >= Math.abs(r - s) - EPS
    ) {
      const along = (r * r - s * s + length * length) / (2 * length);
      const height = Math.sqrt(Math.max(0, r * r - along * along));
      const u = normalize(sub(d, c)),
        foot = add(c, mul(u, along)),
        normal = { x: -u.y, y: u.x };
      hits = [add(foot, mul(normal, height)), add(foot, mul(normal, -height))];
    }
  }
  const on = (e: Entity, p: XY, full: boolean) =>
    e.kind === "circle" ||
    full ||
    (parameter(e, p) >= -EPS && parameter(e, p) <= 1 + EPS) ||
    (e.kind === "arc" && dist(p, e.points[1]) < EPS);
  return hits.filter(
    (p, i) =>
      on(a, p, fullA) &&
      on(b, p, false) &&
      !hits.slice(0, i).some((q) => dist(p, q) < EPS),
  );
}
function boundaries(sketch: Sketch, excluded: Set<string>): Entity[] {
  const result = sketch.entities.filter(
    (e) => !excluded.has(e.id) && !["point", "text"].includes(e.kind),
  );
  result.forEach(supportedCurve);
  if (!result.length) fail("没有可用的边界对象");
  return result;
}
function corner(
  sketch: Sketch,
  selected: Entity[],
  values: Record<string, number>,
  fillet: boolean,
  removed: Set<string>,
) {
  if (selected.length !== 2 || selected.some((e) => e.kind !== "line"))
    fail("圆角或倒角必须选择两条相交直线");
  plainTopology(sketch, selected);
  notFixed(sketch, selected);
  const [a, b] = selected;
  const vertex = lineIntersection(
    a.points[0],
    a.points[1],
    b.points[0],
    b.points[1],
  );
  if (
    !vertex ||
    selected.some((e) => {
      const t = parameter(e, vertex);
      return t < -EPS || t > 1 + EPS;
    })
  )
    fail("两条线段必须相交且不能平行");
  const endpoint = selected.map((e) =>
    dist(e.points[0], vertex) <= dist(e.points[1], vertex) ? 0 : 1,
  );
  const far = selected.map((e, i) => e.points[1 - endpoint[i]]);
  const lengths = far.map((p) => dist(p, vertex));
  const [u, v] = far.map((p) => normalize(sub(p, vertex)));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  if (theta < EPS || Math.PI - theta < EPS)
    fail("相交角度无法生成有效圆角或倒角");
  let d1: number, d2: number, added: Entity;
  if (fillet) {
    const r = positive(values, "radius");
    d1 = d2 = r / Math.tan(theta / 2);
    const p = add(vertex, mul(u, d1)),
      q = add(vertex, mul(v, d2));
    const center = add(
      vertex,
      mul(normalize(add(u, v)), r / Math.sin(theta / 2)),
    );
    added = entity("arc", [center, p, q], {
      radius: r,
      ccw: cross(sub(p, center), sub(q, center)) > 0,
    });
  } else {
    d1 = positive(values, "distance");
    if (values.angle !== undefined && values.distance2 !== undefined)
      fail("倒角请使用第二距离或角度，不能同时使用");
    if (values.angle !== undefined) {
      const angle = (positive(values, "angle") * Math.PI) / 180;
      if (theta + angle >= Math.PI - EPS) fail("倒角角度与两线夹角不相容");
      d2 = (d1 * Math.sin(angle)) / Math.sin(theta + angle);
    } else d2 = positive(values, "distance2", d1);
    added = entity("line", [add(vertex, mul(u, d1)), add(vertex, mul(v, d2))]);
  }
  if (d1 >= lengths[0] - EPS || d2 >= lengths[1] - EPS)
    fail("圆角半径或倒角距离过大，会生成零长度线段");
  capacity(sketch, 1);
  const movedPoints = selected.map((e, i) => e.points[endpoint[i]].id);
  removeAffected(
    sketch,
    selected,
    movedPoints,
    removed,
    fillet
      ? (constraint) => {
          if (constraint.refs.some((ref) => movedPoints.includes(ref)))
            return false;
          // Shortening a line leaves its support line and far-end contact unchanged.
          if (
            [
              "horizontal",
              "vertical",
              "parallel",
              "perpendicular",
              "collinear",
              "angle",
            ].includes(constraint.kind)
          )
            return true;
          if (constraint.kind !== "tangent") return false;
          return selected.some(
            (line, i) =>
              constraint.refs.includes(line.id) &&
              sketch.entities.some(
                (curve) =>
                  curve.kind === "arc" &&
                  constraint.refs.includes(curve.id) &&
                  curve.points.some(
                    (point, index) =>
                      index > 0 &&
                      (point.id === far[i].id ||
                        sketch.constraints.some(
                          (binding) =>
                            binding.kind === "coincident" &&
                            binding.refs.includes(point.id) &&
                            binding.refs.includes(far[i].id),
                        )),
                  ),
              ),
          );
        }
      : undefined,
  );
  selected.forEach((e, i) =>
    Object.assign(e.points[endpoint[i]], added.points[fillet ? i + 1 : i], {
      id: e.points[endpoint[i]].id,
    }),
  );
  sketch.entities.push(added);
  if (fillet)
    selected.forEach((line, i) =>
      sketch.constraints.push(
        {
          id: uid("c"),
          kind: "coincident",
          refs: [line.points[endpoint[i]].id, added.points[i + 1].id],
        },
        { id: uid("c"), kind: "tangent", refs: [line.id, added.id] },
      ),
    );
}
function orderedChain(
  selected: Entity[],
  distance: number,
): { points: XY[]; closed: boolean } {
  if (selected.some((e) => !["line", "arc"].includes(e.kind)))
    fail("偏移链只支持连续直线和圆弧");
  const ends = selected.map((e) =>
    e.kind === "line" ? [e.points[0], e.points[1]] : [e.points[1], e.points[2]],
  );
  const degree = (p: XY) => ends.flat().filter((q) => dist(p, q) <= TOL).length;
  if (ends.flat().some((p) => degree(p) > 2))
    fail("偏移链不能含分叉或重合端点");
  const openEnds = ends.flat().filter((p) => degree(p) === 1);
  if (openEnds.length !== 0 && openEnds.length !== 2)
    fail("选中的对象不是单一连续链");
  const closed = !openEnds.length;
  let current: XY = closed ? ends[0][0] : openEnds[0];
  const remaining = new Set(selected.map((_, i) => i));
  const points: XY[] = [current];
  while (remaining.size) {
    const index = [...remaining].find((i) =>
      ends[i].some((p) => dist(p, current) <= TOL),
    );
    if (index === undefined) fail("选中的对象必须组成单一连续链");
    const i = index!;
    const reverse = dist(ends[i][1], current) <= TOL;
    let samples: XY[];
    if (selected[i].kind === "arc") {
      const info = arcInfo(selected[i]);
      samples = sampleEntity(
        selected[i],
        (TOL * info.r) / (info.r + Math.abs(distance)),
      );
      const t = Math.min(
        1 / (2 * (samples.length - 1)),
        TOL / (2 * Math.abs(distance) * Math.abs(info.sweep)),
      );
      samples = [
        samples[0],
        at(selected[i], t),
        ...samples.slice(1, -1),
        at(selected[i], 1 - t),
        samples[samples.length - 1],
      ];
    } else samples = sampleEntity(selected[i], TOL);
    if (reverse) samples = [...samples].reverse();
    points.push(...samples.slice(1));
    current = points[points.length - 1];
    remaining.delete(i);
    if (points.length > 100000) fail("偏移曲线采样数量过大");
  }
  if (closed) {
    if (dist(points[0], points[points.length - 1]) > TOL)
      fail("闭合链端点不连续");
    points.pop();
  }
  return { points, closed };
}
function clipperOffset(
  selected: Entity[],
  distance: number,
  sampled?: { points: XY[]; closed: boolean },
): Entity[] {
  const { points, closed } = sampled ?? orderedChain(selected, distance);
  if (points.length < (closed ? 3 : 2)) fail("偏移链退化");
  // At scale 1e6, allowed model coordinates stay well below Clipper's 2^53 limit.
  const path = points.map((p) => {
    if (Math.max(Math.abs(p.x), Math.abs(p.y)) + Math.abs(distance) > 1e7)
      fail("偏移坐标越界");
    return { X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) };
  });
  const solution: ClipperLib.Paths = [];
  const offset = new ClipperLib.ClipperOffset(2, TOL * SCALE);
  if (closed) {
    const simple = ClipperLib.Clipper.SimplifyPolygons(
      [path],
      ClipperLib.PolyFillType.pftEvenOdd,
    );
    if (!simple.length) fail("偏移链面积为零");
    for (const ring of simple) {
      if (ClipperLib.Clipper.Area(ring) < 0) ring.reverse();
      offset.AddPath(
        ring,
        ClipperLib.JoinType.jtMiter,
        ClipperLib.EndType.etClosedPolygon,
      );
    }
    offset.Execute(solution, distance * SCALE);
  } else {
    offset.AddPath(
      path,
      ClipperLib.JoinType.jtMiter,
      ClipperLib.EndType.etOpenButt,
    );
    offset.Execute(solution, Math.abs(distance) * SCALE);
  }
  if (!solution.length) fail("偏移距离使轮廓完全消失");
  let paths: XY[][] = solution.map((ring) =>
    ring.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE })),
  );
  if (!closed) {
    // Clipper clips a two-sided open stroke. Extract its requested signed side.
    const shifted = (p: XY, q: XY, origin: XY) => {
      const u = normalize(sub(q, p));
      return add(origin, mul({ x: -u.y, y: u.x }, distance));
    };
    const start = shifted(points[0], points[1], points[0]);
    const end = shifted(
      points[points.length - 2],
      points[points.length - 1],
      points[points.length - 1],
    );
    const oppositeStart = sub(mul(points[0], 2), start);
    const oppositeEnd = sub(mul(points[points.length - 1], 2), end);
    const endpointTolerance = Math.min(TOL, Math.abs(distance) / 4);
    let candidates: XY[][] = [];
    for (const ring of paths) {
      const a = ring.findIndex((p) => dist(p, start) <= endpointTolerance),
        b = ring.findIndex((p) => dist(p, end) <= endpointTolerance);
      if (a < 0 || b < 0 || a === b) continue;
      for (const direction of [1, -1]) {
        const side: XY[] = [ring[a]];
        for (
          let i = (a + direction + ring.length) % ring.length;
          i !== a;
          i = (i + direction + ring.length) % ring.length
        ) {
          side.push(ring[i]);
          if (i === b) break;
        }
        if (
          dist(side[side.length - 1], end) <= endpointTolerance &&
          !side
            .slice(1, -1)
            .some(
              (p) =>
                dist(p, oppositeStart) <= endpointTolerance ||
                dist(p, oppositeEnd) <= endpointTolerance,
            )
        )
          candidates.push(side);
      }
    }
    const length = (ps: XY[]) =>
      ps.slice(1).reduce((sum, p, i) => sum + dist(ps[i], p), 0);
    candidates = candidates.sort((a, b) => length(a) - length(b));
    if (!candidates.length)
      fail("此开放链偏移后发生分裂，无法保持单侧连续轮廓");
    paths = [candidates[0]];
  }
  const result: Entity[] = [];
  for (const ps of paths) {
    const count = closed ? ps.length : ps.length - 1;
    if (result.length + count > LIMIT) fail("偏移结果对象过多");
    for (let i = 0; i < count; i++) {
      const a = ps[i],
        b = ps[(i + 1) % ps.length];
      if (dist(a, b) > EPS)
        result.push(
          entity("line", [a, b], {
            construction: selected.every((e) => e.construction),
          }),
        );
    }
  }
  return result;
}
function offsetEntities(
  sketch: Sketch,
  selected: Entity[],
  values: Record<string, number>,
) {
  const distance = number(values, "distance");
  if (Math.abs(distance) < EPS) fail("偏移距离不能为零");
  let copies: Entity[];
  if (selected.length > 1) copies = clipperOffset(selected, distance);
  else {
    const e = selected[0];
    if (e.kind === "line") {
      const u = normalize(sub(e.points[1], e.points[0]));
      const shift = mul({ x: -u.y, y: u.x }, distance);
      copies = [
        entity(
          "line",
          e.points.map((p) => add(p, shift)),
          { name: e.name, construction: e.construction },
        ),
      ];
    } else if (e.kind === "circle" || e.kind === "arc") {
      const old = e.kind === "circle" ? e.radius! : arcInfo(e).r,
        radius = old + distance;
      if (radius <= EPS) fail("偏移后半径必须大于零");
      const coords =
        e.kind === "circle"
          ? [e.points[0]]
          : [
              e.points[0],
              ...e.points
                .slice(1)
                .map((p) =>
                  add(e.points[0], mul(sub(p, e.points[0]), radius / old)),
                ),
            ];
      copies = [
        entity(e.kind, coords, {
          radius,
          ccw: e.ccw,
          name: e.name,
          construction: e.construction,
        }),
      ];
    } else if (["ellipse", "spline", "bezier", "conic"].includes(e.kind)) {
      const points = sampleEntity(e, TOL);
      const closed =
        e.kind === "ellipse" ||
        dist(points[0], points[points.length - 1]) <= TOL;
      if (closed) points.pop();
      copies = clipperOffset(selected, distance, { points, closed });
      copies.forEach((copy) => {
        copy.name = "偏移（近似）";
      });
    } else return fail("此对象不支持偏移");
  }
  capacity(sketch, copies.length);
  sketch.entities.push(...copies);
}
function trim(
  sketch: Sketch,
  target: Entity,
  pick: XY | undefined,
  removed: Set<string>,
) {
  if (!pick) fail("修剪需要指定拾取位置");
  supportedCurve(target);
  plainTopology(sketch, [target]);
  notFixed(sketch, [target]);
  const intersectionsAt = boundaries(sketch, new Set([target.id])).flatMap(
    (b) => intersections(target, b),
  );
  const cuts = intersectionsAt
    .map((p) => parameter(target, p))
    .sort((a, b) => a - b)
    .filter((t, i, ts) => i === 0 || t - ts[i - 1] > EPS);
  const t = parameter(target, pick!);
  if (target.kind === "circle") {
    if (cuts.length < 2) fail("修剪圆需要至少两个不同交点");
    let lower =
      [...cuts].reverse().find((x) => x < t - EPS) ?? cuts[cuts.length - 1] - 1;
    const upper = cuts.find((x) => x > t + EPS) ?? cuts[0] + 1;
    if (cuts.some((x) => Math.abs(x - t) < EPS))
      fail("拾取位置不能位于交点，请选择要删除的区段");
    if (upper - lower >= 1 - EPS) fail("没有可修剪的圆区段");
    replace(sketch, target, [piece(target, upper, lower + 1)], removed);
  } else {
    if (t < -EPS || t > 1 + EPS) fail("拾取位置不在所选曲线区段上");
    const interior = cuts.filter((x) => x > EPS && x < 1 - EPS);
    if (!interior.length) fail("所选对象没有可用于修剪的内部交点");
    if (interior.some((x) => Math.abs(x - t) < EPS))
      fail("拾取位置不能位于交点，请选择要删除的区段");
    const lower = [...interior].reverse().find((x) => x < t) ?? 0;
    const upper = interior.find((x) => x > t) ?? 1;
    const keep: Entity[] = [];
    if (lower > EPS) keep.push(piece(target, 0, lower));
    if (upper < 1 - EPS) keep.push(piece(target, upper, 1));
    replace(sketch, target, keep, removed);
  }
}
function extend(
  sketch: Sketch,
  selected: Entity[],
  pick: XY | undefined,
  removed: Set<string>,
) {
  if (selected.length !== 1 || !["line", "arc"].includes(selected[0].kind))
    fail("延伸必须选择一条直线或圆弧");
  const target = selected[0];
  plainTopology(sketch, selected);
  notFixed(sketch, selected);
  const bs = boundaries(sketch, new Set(selected.map((e) => e.id)));
  const hits = bs.flatMap((b) => intersections(target, b, true));
  const startIndex = target.kind === "line" ? 0 : 1,
    endIndex = target.kind === "line" ? 1 : 2;
  const endpoint =
    pick &&
    dist(pick, target.points[startIndex]) < dist(pick, target.points[endIndex])
      ? startIndex
      : endIndex;
  let choices: { p: XY; amount: number }[];
  if (target.kind === "line") {
    choices = hits
      .map((p) => ({
        p,
        amount:
          endpoint === 0 ? -parameter(target, p) : parameter(target, p) - 1,
      }))
      .filter((c) => c.amount > EPS);
  } else {
    const info = arcInfo(target),
      sweep = Math.abs(info.sweep),
      direction = info.sweep < 0 ? -1 : 1;
    choices = hits
      .map((p) => {
        const raw = mod(
          (Math.atan2(p.y - info.c.y, p.x - info.c.x) - info.start) * direction,
        );
        return { p, amount: endpoint === 1 ? TAU - raw : raw - sweep };
      })
      .filter((c) => c.amount > EPS && c.amount < TAU - sweep - EPS);
  }
  choices.sort((a, b) => a.amount - b.amount);
  if (!choices.length) fail("所选端点的延伸方向没有可达边界");
  removeAffected(sketch, selected, [target.points[endpoint].id], removed);
  Object.assign(target.points[endpoint], choices[0].p);
}

/** Mutates the supplied candidate only after a complete, valid operation succeeds.
 * Angles are degrees; positive single-line/open-chain offsets lie to the left.
 * Positive circle/arc/closed-chain offsets expand. Arrays include originals.
 * Removed topology constraints must be confirmed by the caller before commit.
 */
export function modifySketch(
  sketch: Sketch,
  selected: string[],
  operation: string,
  values: Record<string, number>,
  pick?: XY,
): { removedConstraints: string[] } {
  const candidate = clone(sketch),
    removed = new Set<string>();
  const ids = [...new Set(selected)];
  const entities = ids.map(
    (id) =>
      candidate.entities.find((e) => e.id === id) ?? fail("选中的对象不存在"),
  );
  if (!entities.length) fail("请先选择对象");
  if (pick && ![pick.x, pick.y].every(Number.isFinite)) fail("拾取坐标无效");
  validGeometry(candidate);
  prepareDimensionLabels(candidate);
  const center = () => ({
    x: number(values, "cx", 0),
    y: number(values, "cy", 0),
  });
  switch (operation) {
    case "move":
    case "rotate":
    case "scale": {
      const moving = withOwned(candidate, entities);
      if (moving.some((e) => e.sourceId))
        fail("派生对象不能直接变换，请先解除派生关系");
      notFixed(candidate, moving);
      if (operation === "scale") {
        const factor = positive(values, "factor"),
          c = center();
        for (const e of moving) {
          e.points.forEach((p) =>
            Object.assign(p, add(c, mul(sub(p, c), factor))),
          );
          for (const key of ["radius", "ry", "fontSize"] as const)
            if (e[key] !== undefined) e[key]! *= factor;
        }
      } else {
        const c = center();
        const transform: Transform =
          operation === "move"
            ? {
                kind: "translate",
                x: number(values, "dx", 0),
                y: number(values, "dy", 0),
              }
            : {
                kind: "rotate",
                x: c.x,
                y: c.y,
                angle: number(values, "angle"),
              };
        moving.forEach((e) =>
          Object.assign(e, transformedEntity(e, transform)),
        );
      }
      break;
    }
    case "copy":
      cloneBatch(candidate, entities, {
        kind: "translate",
        x: number(values, "dx", 0),
        y: number(values, "dy", 0),
      });
      break;
    case "fillet":
    case "chamfer":
      corner(candidate, entities, values, operation === "fillet", removed);
      break;
    case "offset":
      offsetEntities(candidate, entities, values);
      break;
    case "trim":
      trim(candidate, entities[0], pick, removed);
      break;
    case "extend":
      extend(candidate, entities, pick, removed);
      break;
    case "break": {
      if (
        entities.length !== 1 ||
        !["line", "arc", "bezier"].includes(entities[0].kind)
      )
        fail("打断仅支持单条直线、圆弧或三次贝塞尔曲线");
      const e = entities[0];
      plainTopology(candidate, entities);
      notFixed(candidate, entities);
      if (!pick) fail("打断需要指定拾取位置");
      let t: number;
      if (e.kind === "bezier") {
        if (e.points.length !== 4) fail("贝塞尔打断需要四个控制点");
        const path = paperPath(e);
        try {
          t =
            path.getNearestLocation([pick!.x, pick!.y])?.time ??
            fail("无法确定贝塞尔打断位置");
        } finally {
          path.remove();
        }
      } else t = parameter(e, pick!);
      if (t <= EPS || t >= 1 - EPS)
        fail("打断位置必须在曲线内部，不能位于端点");
      if (e.kind === "bezier") {
        const [a, b, c, d] = e.points;
        const ab = lerp(a, b, t),
          bc = lerp(b, c, t),
          cd = lerp(c, d, t);
        const abc = lerp(ab, bc, t),
          bcd = lerp(bc, cd, t),
          middle = lerp(abc, bcd, t);
        const extra = { name: e.name, construction: e.construction };
        replace(
          candidate,
          e,
          [
            entity("bezier", [a, ab, abc, middle], extra),
            entity("bezier", [middle, bcd, cd, d], extra),
          ],
          removed,
        );
      } else replace(candidate, e, [piece(e, 0, t), piece(e, t, 1)], removed);
      break;
    }
    case "mirror": {
      if (entities.length < 2)
        fail("镜像需要选择源对象，并最后选择一条镜像轴直线");
      const axis = entities[entities.length - 1],
        sources = entities.slice(0, -1);
      if (axis.kind !== "line") fail("最后选中的对象必须是镜像轴直线");
      if (axis.sourceId) fail("镜像轴须先解除关联");
      if (sources.some((e) => e.sourceId))
        fail("不能再次派生镜像对象，请先解除派生关系");
      capacity(candidate, sources.length);
      const [a, b] = axis.points;
      const transform: Transform = {
        kind: "mirror",
        axisId: axis.id,
        ax: a.x,
        ay: a.y,
        bx: b.x,
        by: b.y,
      };
      derivedBatch(candidate, sources, transform);
      break;
    }
    case "rectangularArray": {
      if (entities.some((e) => e.sourceId))
        fail("不能再次派生关联对象，请先解除派生关系");
      const cols = integer(values, "cols", 2),
        rows = integer(values, "rows", 1);
      if (
        (values.direction1 === 0 && cols % 2 === 0) ||
        (values.direction2 === 0 && rows % 2 === 0)
      )
        fail("对称阵列的数量须为奇数（包含原对象）");
      const dx = number(values, "dx", 0),
        dy = number(values, "dy", 0);
      if ((cols > 1 && Math.abs(dx) < EPS) || (rows > 1 && Math.abs(dy) < EPS))
        fail("阵列间距不能为零");
      const direction = {
        x: number(values, "ux", 1),
        y: number(values, "uy", 0),
      };
      if (Math.hypot(direction.x, direction.y) < EPS) fail("阵列方向无效");
      const u = normalize(direction),
        v = { x: -u.y, y: u.x };
      const spacingX = values.range ? dx / Math.max(1, cols - 1) : dx;
      const spacingY = values.range ? dy / Math.max(1, rows - 1) : dy;
      const index = (i: number, count: number, mode = 1) =>
        mode === 0 ? i - Math.floor(count / 2) : mode === -1 ? -i : i;
      capacity(candidate, entities.length * (cols * rows - 1));
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
          const x = index(col, cols, values.direction1) * spacingX;
          const y = index(row, rows, values.direction2) * spacingY;
          if (x || y)
            derivedBatch(candidate, entities, {
              kind: "translate",
              x: u.x * x + v.x * y,
              y: u.y * x + v.y * y,
            });
        }
      break;
    }
    case "circularArray": {
      if (entities.some((e) => e.sourceId))
        fail("不能再次派生关联对象，请先解除派生关系");
      const count = integer(values, "count", 4),
        span = number(values, "angle", 360),
        c = center();
      if (Math.abs(span) <= EPS || Math.abs(span) > 360 + EPS)
        fail("圆周阵列角度必须非零且不超过 360 度");
      capacity(candidate, entities.length * (count - 1));
      const step =
        Math.abs(Math.abs(span) - 360) < EPS
          ? span / count
          : span / Math.max(1, count - 1);
      for (let i = 1; i < count; i++)
        derivedBatch(candidate, entities, {
          kind: "rotate",
          x: c.x,
          y: c.y,
          angle: step * i,
        });
      break;
    }
    case "detach":
      entities.forEach((e) => {
        delete e.sourceId;
        delete e.transform;
      });
      break;
    default:
      fail(`不支持的编辑操作：${operation}`);
  }
  updateDerived(candidate);
  validGeometry(candidate);
  for (const e of candidate.entities) {
    for (const key of [
      "radius",
      "ry",
      "weight",
      "fontSize",
      "rotation",
    ] as const) {
      const value = e[key];
      if (
        value !== undefined &&
        (!Number.isFinite(value) || Math.abs(value) > 1e7)
      )
        fail("操作后的几何参数越界");
      if (key !== "rotation" && value !== undefined && value <= 0)
        fail("操作后的半径、权重或文字高度必须大于零");
    }
  }
  if (candidate.entities.length > LIMIT) fail("操作后对象总数不能超过 10000");
  const live = new Set(
    candidate.entities.flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
  );
  if (candidate.constraints.some((c) => c.refs.some((r) => !live.has(r))))
    fail("操作产生了无效约束引用");
  updateDimensionLabels(candidate);
  sketch.entities = candidate.entities;
  sketch.constraints = candidate.constraints;
  return { removedConstraints: [...removed] };
}
