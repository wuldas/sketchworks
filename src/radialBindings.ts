import {
  type Constraint,
  type Entity,
  type Point,
  type Sketch,
  type XY,
  findPoint,
} from "./model";
import { type SolverResult } from "./solver";

export type RadialDrag = XY & { pointId: string; exact?: boolean };
const TOL = 1e-7;
const pointRef = (s: Sketch, ref: string) =>
  findPoint(s, ref) ??
  s.entities.find((e) => e.id === ref && e.kind === "point")?.points[0];
const failure = (ids: string[], message: string): SolverResult => ({
  ok: false,
  dof: -1,
  status: "InvalidBinding",
  conflicting: ids,
  message,
});

/** Keep direction-only arc captures on the positive ray, without constraining radius. */
export function solveRadialBindings(
  sketch: Sketch,
  drag: RadialDrag | undefined,
  solve: (candidate: Sketch, driver?: RadialDrag) => SolverResult,
): SolverResult {
  const directional = sketch.constraints.filter((c) => c.sameRay === true);
  if (!directional.length) return solve(sketch, drag);
  const candidate = structuredClone(sketch);
  const points = candidate.entities.flatMap((e) => e.points);
  const parents = new Map(points.map((p) => [p.id, p.id]));
  const root = (id: string): string => {
    const parent = parents.get(id)!;
    if (parent === id) return id;
    const result = root(parent);
    parents.set(id, result);
    return result;
  };
  for (const c of candidate.constraints) {
    if (c.kind !== "coincident") continue;
    const a = pointRef(candidate, c.refs[0]),
      b = pointRef(candidate, c.refs[1]);
    if (a && b) parents.set(root(a.id), root(b.id));
  }
  const fixed = new Map<string, XY>();
  // Capture anchors before seeding a branch so an unanchored fixed endpoint
  // cannot accidentally adopt the projected guess as its permanent anchor.
  for (const c of candidate.constraints) {
    if (c.kind === "origin") {
      const p = pointRef(candidate, c.refs[0]);
      if (p) fixed.set(root(p.id), { x: 0, y: 0 });
    }
    if (c.kind !== "fixed") continue;
    const e = candidate.entities.find((e) => e.id === c.refs[0]);
    const targets =
      e?.points ??
      [pointRef(candidate, c.refs[0])].filter((p): p is Point => !!p);
    if (!c.anchors?.length) c.anchors = targets.map((p) => ({ ...p }));
    if (
      e &&
      (e.radius !== undefined || e.ry !== undefined || e.kind === "arc") &&
      !c.anchors.some((a) => a.id === e.id)
    ) {
      const radius =
        e.radius ??
        (e.kind === "arc"
          ? Math.hypot(
              e.points[1].x - e.points[0].x,
              e.points[1].y - e.points[0].y,
            )
          : 0);
      c.anchors.push({ id: e.id, x: radius, y: e.ry ?? radius });
    }
    for (const p of targets) {
      const anchor = c.anchors.find((a) => a.id === p.id);
      if (anchor) fixed.set(root(p.id), anchor);
    }
  }
  const groups = new Map<string, Point[]>();
  for (const p of points) {
    const key = root(p.id),
      group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  }
  const relations: { constraint: Constraint; ray: Entity; input: Point }[] = [];
  for (const c of candidate.constraints.filter((c) => c.sameRay === true)) {
    const ray = c.refs
      .map((id) =>
        candidate.entities.find((e) => e.id === id && e.kind === "line"),
      )
      .find(Boolean);
    const input = c.refs.map((id) => pointRef(candidate, id)).find(Boolean);
    if (c.kind !== "onLine" || !ray || !input || ray.points.length !== 2)
      return failure([c.id], "The radial direction references are invalid.");
    relations.push({ constraint: c, ray, input });
  }
  const position = (p: Point): XY => {
    const key = root(p.id);
    if (
      drag &&
      parents.has(drag.pointId) &&
      root(drag.pointId) === key &&
      (!fixed.has(key) || drag.exact === true)
    )
      return drag;
    return fixed.get(key) ?? p;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const { constraint: c, ray, input } of relations) {
      const [a, b] = ray.points,
        center = position(a),
        source = position(input);
      const dx = source.x - center.x,
        dy = source.y - center.y,
        length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length <= TOL)
        return failure(
          [c.id],
          "The captured direction must differ from the arc center.",
        );
      const radius = Math.hypot(b.x - a.x, b.y - a.y);
      if (!Number.isFinite(radius) || radius <= TOL)
        return failure([c.id], "The radial direction has a degenerate ray.");
      const endGroup = root(b.id);
      if (!fixed.has(endGroup)) {
        const projected = {
          x: center.x + (dx * radius) / length,
          y: center.y + (dy * radius) / length,
        };
        const affected = new Set([endGroup]);
        for (const e of candidate.entities) {
          if (e.kind === "arc" && root(e.points[0].id) === endGroup)
            e.points.forEach((p) => affected.add(root(p.id)));
        }
        const angle = Math.atan2(dy, dx) - Math.atan2(b.y - a.y, b.x - a.x);
        const cos = Math.cos(angle),
          sin = Math.sin(angle);
        const seeds = new Map<string, XY>();
        for (const group of affected) {
          if (fixed.has(group)) continue;
          const p = groups.get(group)![0],
            x = p.x - a.x,
            y = p.y - a.y;
          seeds.set(
            group,
            group === endGroup
              ? projected
              : {
                  x: center.x + x * cos - y * sin,
                  y: center.y + x * sin + y * cos,
                },
          );
        }
        for (const [group, seed] of seeds)
          for (const p of groups.get(group)!) Object.assign(p, seed);
      }
    }
    const result = solve(candidate, drag);
    if (!result.ok) return result;
    const wrong = relations.filter(({ ray, input }) => {
      const [a, b] = ray.points;
      const dx = input.x - a.x,
        dy = input.y - a.y,
        length = Math.hypot(dx, dy);
      const ex = b.x - a.x,
        ey = b.y - a.y,
        radius = Math.hypot(ex, ey);
      return (
        length <= TOL ||
        radius <= TOL ||
        (dx * ex + dy * ey) / (length * radius) < 0 ||
        Math.abs(dx * ey - dy * ex) / radius > TOL
      );
    });
    if (wrong.length) {
      if (
        attempt === 2 ||
        wrong.every(({ ray }) => fixed.has(root(ray.points[1].id)))
      )
        return failure(
          wrong.map(({ constraint }) => constraint.id),
          "The captured direction conflicts with the arc endpoint.",
        );
      continue;
    }
    const solved = new Map(candidate.entities.map((e) => [e.id, e]));
    for (const e of sketch.entities) {
      const next = solved.get(e.id)!;
      e.points.forEach((p, i) =>
        Object.assign(p, { x: next.points[i].x, y: next.points[i].y }),
      );
      if (next.radius !== undefined) e.radius = next.radius;
      if (next.ry !== undefined) e.ry = next.ry;
    }
    const constraints = new Map(candidate.constraints.map((c) => [c.id, c]));
    for (const c of sketch.constraints) {
      const anchors = constraints.get(c.id)?.anchors;
      if (anchors) c.anchors = anchors;
    }
    return result;
  }
  return failure(
    directional.map((c) => c.id),
    "The radial direction could not be solved.",
  );
}
