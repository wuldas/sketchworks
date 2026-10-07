import {
  make_gcs_wrapper,
  SolveStatus,
  type GcsWrapper,
  type SketchPrimitive,
} from "@salusoft89/planegcs";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import {
  findPoint,
  type Sketch,
  type ConstraintKind,
  type Entity,
  type Point,
} from "./model";

let solver: GcsWrapper | undefined;
let initialization: Promise<void> | undefined;
export function initSolver(path = wasmUrl): Promise<void> {
  return (initialization ??= make_gcs_wrapper(path)
    .then((w) => {
      solver = w;
    })
    .catch((error) => {
      initialization = undefined;
      throw error;
    }));
}
export interface SolverResult {
  ok: boolean;
  dof: number;
  status: string;
  conflicting: string[];
  message?: string;
}
type Drag = { pointId: string; x: number; y: number; exact?: boolean };
const DRAG_TOLERANCE = 1e-7;
const round = (e: Entity | undefined) =>
  e?.kind === "circle" || e?.kind === "arc";
const entityRef = (s: Sketch, id: string) =>
  s.entities.find((e) => e.id === id);
const pointRef = (s: Sketch, id: string) =>
  findPoint(s, id) ??
  (entityRef(s, id)?.kind === "point"
    ? entityRef(s, id)?.points[0]
    : undefined);
const lineRef = (s: Sketch, id: string) => {
  const e = entityRef(s, id);
  return e?.kind === "line" ? e : undefined;
};
function pairPoints(s: Sketch, refs: string[]): Point[] | undefined {
  const line = refs.length === 1 ? lineRef(s, refs[0]) : undefined;
  if (line) return line.points.slice(0, 2);
  if (refs.length !== 2) return;
  const points = refs.map((r) => pointRef(s, r));
  return points.every(Boolean) ? (points as Point[]) : undefined;
}
function pointAndLine(s: Sketch, refs: string[]): [Point, Entity] | undefined {
  if (refs.length !== 2) return;
  for (const [a, b] of [
    [refs[0], refs[1]],
    [refs[1], refs[0]],
  ]) {
    const p = pointRef(s, a),
      l = lineRef(s, b);
    if (p && l) return [p, l];
  }
}
export function canConstrain(
  s: Sketch,
  kind: ConstraintKind,
  refs: string[],
): string | null {
  if (new Set(refs).size !== refs.length) return "Select distinct references.";
  if (refs.some((r) => !findPoint(s, r) && !entityRef(s, r)))
    return "A referenced object no longer exists.";
  if (
    kind !== "fixed" &&
    kind !== "coincident" &&
    refs.some((r) => {
      const owner = s.entities.find((e) => e.points.some((p) => p.id === r));
      return owner && !["point", "line", "circle", "arc"].includes(owner.kind);
    })
  )
    return "Curve control points support fixed and coincident constraints only.";
  const entities = refs.map((r) => entityRef(s, r));
  const twoLines = refs.length === 2 && refs.every((r) => lineRef(s, r));
  switch (kind) {
    case "fixed":
      return refs.length === 1 ? null : "Select one point or entity to fix.";
    case "coincident":
      return refs.length === 2 && refs.every((r) => pointRef(s, r))
        ? null
        : "Coincidence requires two explicit points.";
    case "horizontal":
    case "vertical":
    case "length":
    case "lineDistance":
    case "distanceX":
    case "distanceY":
      return kind === "lineDistance"
        ? pointAndLine(s, refs)
          ? null
          : "Select one explicit point and one line."
        : pairPoints(s, refs)
          ? null
          : "Select a line or two explicit points.";
    case "parallel":
    case "perpendicular":
    case "collinear":
      return twoLines ? null : "Select two lines.";
    case "equal":
      return twoLines || (refs.length === 2 && entities.every((e) => round(e)))
        ? null
        : "Select two lines or two circular curves.";
    case "onLine":
    case "midpoint":
      return pointAndLine(s, refs)
        ? null
        : "Select one explicit point and one line.";
    case "concentric":
      return refs.length === 2 && entities.every((e) => round(e))
        ? null
        : "Select two circular curves.";
    case "tangent":
      return refs.length === 2 &&
        entities.every((e) => e?.kind === "line" || round(e)) &&
        entities.some((e) => round(e))
        ? null
        : "Tangency supports a line and a circular curve, or two circular curves.";
    case "radius":
    case "diameter":
      return refs.length === 1 && round(entities[0])
        ? null
        : "Select one circle or circular arc.";
    case "angle":
      return twoLines || (refs.length === 1 && lineRef(s, refs[0]))
        ? null
        : "Select one line or two lines.";
    case "symmetric":
      return refs.length === 3 &&
        pointRef(s, refs[0]) &&
        pointRef(s, refs[1]) &&
        (pointRef(s, refs[2]) || lineRef(s, refs[2]))
        ? null
        : "Select two points, then a symmetry center or axis line.";
  }
}

export function solveSketch(s: Sketch, drag?: Drag): SolverResult {
  const fail = (
    message: string,
    conflicting: string[] = [],
    status = "Failed",
  ): SolverResult => ({ ok: false, dof: -1, status, conflicting, message });
  if (!solver)
    return fail("The geometry solver has not initialized.", [], "NotReady");
  const w = solver;
  const primitives: SketchPrimitive[] = [];
  const tagOwners = new Map<string, string>();
  const anchorUpdates = new Map<string, Point[]>();
  const fixed = new Map<string, Point>();
  const fixedScalars = new Map<string, Point>();
  const points = new Map(
    s.entities.flatMap((e) => e.points).map((p) => [p.id, p]),
  );
  const dimensions = new Set<ConstraintKind>([
    "length",
    "distanceX",
    "distanceY",
    "radius",
    "diameter",
    "angle",
  ]);
  try {
    for (const c of s.constraints) {
      const invalid = canConstrain(s, c.kind, c.refs);
      if (invalid) return fail(invalid, [c.id], "Unsupported");
      if (
        dimensions.has(c.kind) &&
        (c.value === undefined || !Number.isFinite(c.value))
      )
        return fail("Dimension must have a finite evaluated value.", [c.id]);
      if (["length", "radius", "diameter"].includes(c.kind) && c.value! <= 0)
        return fail("Length and radius dimensions must be positive.", [c.id]);
      if (c.kind !== "fixed") continue;
      const e = entityRef(s, c.refs[0]);
      const targets = e ? e.points : [pointRef(s, c.refs[0])!];
      const anchors = c.anchors?.length
        ? c.anchors.map((p) => ({ ...p }))
        : targets.map((p) => ({ ...p }));
      if (
        e &&
        !anchors.some((p) => p.id === e.id) &&
        (round(e) || e.radius !== undefined || e.ry !== undefined)
      ) {
        const center = anchors.find((p) => p.id === e.points[0].id)!,
          start = anchors.find((p) => p.id === e.points[1]?.id);
        const radius =
          e.radius ??
          (e.kind === "arc" && start
            ? Math.hypot(start.x - center.x, start.y - center.y)
            : 0);
        anchors.push({ id: e.id, x: radius, y: e.ry ?? radius });
      }
      for (const p of targets) {
        const anchor = anchors.find((a) => a.id === p.id);
        if (!anchor)
          return fail("A fixed constraint is missing a point anchor.", [c.id]);
        const prior = fixed.get(p.id);
        if (prior && (prior.x !== anchor.x || prior.y !== anchor.y))
          return fail("Fixed anchors disagree.", [c.id]);
        fixed.set(p.id, anchor);
      }
      if (e) {
        const scalar = anchors.find((a) => a.id === e.id);
        if (scalar) fixedScalars.set(e.id, scalar);
      }
      anchorUpdates.set(c.id, anchors);
    }
    if (drag?.exact === true) {
      if (!points.has(drag.pointId))
        return fail(
          "The drag point no longer exists.",
          ["__drag"],
          "InvalidDrag",
        );
      if (
        ![drag.x, drag.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 1e7)
      )
        return fail(
          "The exact drag target is invalid or out of bounds.",
          ["__drag"],
          "InvalidDrag",
        );
      const anchor = fixed.get(drag.pointId);
      if (
        anchor &&
        Math.hypot(anchor.x - drag.x, anchor.y - drag.y) > DRAG_TOLERANCE
      )
        return fail(
          "The drag target conflicts with a fixed point.",
          ["__drag"],
          "ConflictingDrag",
        );
    }
    for (const p of points.values()) {
      const value = fixed.get(p.id) ?? (drag?.pointId === p.id ? drag : p);
      if (![value.x, value.y].every(Number.isFinite))
        return fail("Point coordinates must be finite.");
      primitives.push({
        id: p.id,
        type: "point",
        x: value.x,
        y: value.y,
        fixed: fixed.has(p.id),
      });
    }
    const add = (owner: string, body: Record<string, unknown>) => {
      const id = `__solver_${owner}_${primitives.length}`;
      tagOwners.set(id, owner);
      primitives.push({ id, ...body } as SketchPrimitive);
    };
    for (const e of s.entities) {
      if (e.kind === "line")
        primitives.push({
          id: e.id,
          type: "line",
          p1_id: e.points[0].id,
          p2_id: e.points[1].id,
        });
      if (e.kind === "circle" || e.kind === "arc") {
        const radius =
          fixedScalars.get(e.id)?.x ??
          e.radius ??
          (e.kind === "arc"
            ? Math.hypot(
                e.points[1].x - e.points[0].x,
                e.points[1].y - e.points[0].y,
              )
            : 0);
        if (!(radius > 0) || !Number.isFinite(radius))
          return fail("Circular geometry must have a positive radius.");
        if (e.kind === "circle")
          primitives.push({
            id: e.id,
            type: "circle",
            c_id: e.points[0].id,
            radius,
          });
        else {
          const [center, start, end] = e.points.map(
            (p) => fixed.get(p.id) ?? p,
          );
          primitives.push({
            id: e.id,
            type: "arc",
            c_id: center.id,
            start_id: start.id,
            end_id: end.id,
            radius,
            start_angle: Math.atan2(start.y - center.y, start.x - center.x),
            end_angle: Math.atan2(end.y - center.y, end.x - center.x),
          });
        }
      }
    }
    for (const e of s.entities) {
      if (e.kind === "arc") add(e.id, { type: "arc_rules", a_id: e.id });
      if (fixedScalars.has(e.id) && round(e))
        add(e.id, {
          type: e.kind === "circle" ? "circle_radius" : "arc_radius",
          [e.kind === "circle" ? "c_id" : "a_id"]: e.id,
          radius: fixedScalars.get(e.id)!.x,
        });
    }
    for (const c of s.constraints) {
      const [a, b, axis] = c.refs;
      const [e1, e2] = [entityRef(s, a), entityRef(s, b)];
      const pp = pairPoints(s, c.refs);
      const emit = (body: Record<string, unknown>) => add(c.id, body);
      const ids = pp ? { p1_id: pp[0].id, p2_id: pp[1].id } : {};
      switch (c.kind) {
        case "fixed":
          break;
        case "coincident":
          emit({
            type: "p2p_coincident",
            p1_id: pointRef(s, a)!.id,
            p2_id: pointRef(s, b)!.id,
          });
          break;
        case "horizontal":
        case "vertical":
          emit({ type: `${c.kind}_pp`, ...ids });
          break;
        case "parallel":
          emit({ type: "parallel", l1_id: a, l2_id: b });
          break;
        case "perpendicular":
          emit({ type: "perpendicular_ll", l1_id: a, l2_id: b });
          break;
        case "collinear":
          emit({ type: "parallel", l1_id: a, l2_id: b });
          emit({ type: "point_on_line_pl", p_id: e2!.points[0].id, l_id: a });
          break;
        case "equal":
          if (e1!.kind === "line")
            emit({ type: "equal_length", l1_id: a, l2_id: b });
          else
            emit({
              type: "equal",
              param1: { o_id: a, prop: "radius" },
              param2: { o_id: b, prop: "radius" },
            });
          break;
        case "onLine":
        case "midpoint": {
          const [p, l] = pointAndLine(s, c.refs)!;
          emit(
            c.kind === "onLine"
              ? { type: "point_on_line_pl", p_id: p.id, l_id: l.id }
              : {
                  type: "p2p_symmetric_ppp",
                  p1_id: l.points[0].id,
                  p2_id: l.points[1].id,
                  p_id: p.id,
                },
          );
          break;
        }
        case "concentric":
          emit({
            type: "p2p_coincident",
            p1_id: e1!.points[0].id,
            p2_id: e2!.points[0].id,
          });
          break;
        case "tangent": {
          const kinds = [e1!.kind, e2!.kind];
          if (kinds.includes("line")) {
            const line = e1!.kind === "line" ? e1! : e2!,
              curve = e1!.kind === "line" ? e2! : e1!;
            emit({
              type: curve.kind === "circle" ? "tangent_lc" : "tangent_la",
              l_id: line.id,
              [curve.kind === "circle" ? "c_id" : "a_id"]: curve.id,
            });
          } else if (kinds.every((k) => k === "circle"))
            emit({ type: "tangent_cc", c1_id: a, c2_id: b });
          else if (kinds.every((k) => k === "arc"))
            emit({ type: "tangent_aa", a1_id: a, a2_id: b });
          else {
            const circle = e1!.kind === "circle" ? e1! : e2!,
              arc = e1!.kind === "arc" ? e1! : e2!;
            emit({ type: "tangent_ca", c_id: circle.id, a_id: arc.id });
          }
          break;
        }
        case "symmetric":
          emit(
            lineRef(s, axis)
              ? {
                  type: "p2p_symmetric_ppl",
                  p1_id: pointRef(s, a)!.id,
                  p2_id: pointRef(s, b)!.id,
                  l_id: axis,
                }
              : {
                  type: "p2p_symmetric_ppp",
                  p1_id: pointRef(s, a)!.id,
                  p2_id: pointRef(s, b)!.id,
                  p_id: pointRef(s, axis)!.id,
                },
          );
          break;
        case "length":
          emit({ type: "p2p_distance", ...ids, distance: c.value });
          break;
        case "lineDistance": {
          const [point, line] = pointAndLine(s, c.refs)!;
          emit({
            type: "p2l_distance",
            p_id: point.id,
            l_id: line.id,
            distance: c.value,
          });
          break;
        }
        case "distanceX":
        case "distanceY": {
          const prop = c.kind === "distanceX" ? "x" : "y";
          emit({
            type: "difference",
            param1: { o_id: pp![0].id, prop },
            param2: { o_id: pp![1].id, prop },
            difference: c.value,
          });
          break;
        }
        case "radius":
        case "diameter":
          emit({
            type: `${e1!.kind}_${c.kind}`,
            [e1!.kind === "circle" ? "c_id" : "a_id"]: a,
            [c.kind]: c.value,
          });
          break;
        case "angle":
          emit(
            c.refs.length === 1
              ? {
                  type: "p2p_angle",
                  p1_id: e1!.points[0].id,
                  p2_id: e1!.points[1].id,
                  angle: (c.value! * Math.PI) / 180,
                }
              : {
                  type: "l2l_angle_ll",
                  l1_id: a,
                  l2_id: b,
                  angle: (c.value! * Math.PI) / 180,
                },
          );
          break;
      }
    }
    if (drag && points.has(drag.pointId) && !fixed.has(drag.pointId)) {
      add("__drag", {
        type: "coordinate_x",
        p_id: drag.pointId,
        x: drag.x,
        temporary: drag.exact !== true,
      });
      add("__drag", {
        type: "coordinate_y",
        p_id: drag.pointId,
        y: drag.y,
        temporary: drag.exact !== true,
      });
    }
    w.clear_data();
    w.push_primitives_and_params(primitives);
    const code = w.solve();
    const conflicting = [
      ...new Set(
        w
          .get_gcs_conflicting_constraints()
          .map((id) => tagOwners.get(id) ?? id),
      ),
    ];
    const status =
      Object.entries(SolveStatus).find(([, v]) => v === code)?.[0] ??
      `Unknown(${code})`;
    if (
      (code !== SolveStatus.Success && code !== SolveStatus.Converged) ||
      conflicting.length
    )
      return fail("Constraints could not be satisfied.", conflicting, status);
    w.apply_solution();
    const solved = w.sketch_index.get_primitives();
    if (
      solved.some(
        (p) =>
          (p.type === "point" &&
            ![p.x, p.y].every(
              (n) => Number.isFinite(n) && Math.abs(n) <= 1e7,
            )) ||
          ((p.type === "circle" || p.type === "arc") &&
            (!Number.isFinite(p.radius) || p.radius <= 1e-7)),
      )
    )
      return fail("Solver produced invalid geometry.");
    const solvedPoints = new Map(
      solved.filter((p) => p.type === "point").map((p) => [p.id, p]),
    );
    if (drag?.exact === true) {
      const target = solvedPoints.get(drag.pointId);
      if (
        !target ||
        Math.hypot(target.x - drag.x, target.y - drag.y) > DRAG_TOLERANCE
      )
        return fail(
          "The exact drag target could not be reached.",
          ["__drag"],
          "ConflictingDrag",
        );
    }
    for (const e of s.entities) {
      const ps = e.points.map((p) => solvedPoints.get(p.id)!);
      if (
        (e.kind === "line" &&
          Math.hypot(ps[1].x - ps[0].x, ps[1].y - ps[0].y) < 1e-7) ||
        (e.kind === "arc" &&
          Math.hypot(ps[2].x - ps[1].x, ps[2].y - ps[1].y) < 1e-7)
      )
        return fail(
          "Constraints produced degenerate geometry.",
          [],
          "InvalidGeometry",
        );
    }
    for (const p of solved) {
      if (p.type === "point") {
        const target = points.get(p.id);
        if (target) {
          target.x = p.x;
          target.y = p.y;
        }
      } else if (p.type === "circle" || p.type === "arc") {
        const e = entityRef(s, p.id);
        if (e) e.radius = p.radius;
      }
    }
    for (const [id, scalar] of fixedScalars) {
      const e = entityRef(s, id)!;
      if (e.radius !== undefined) e.radius = scalar.x;
      if (e.ry !== undefined) e.ry = scalar.y;
    }
    for (const c of s.constraints) {
      const anchors = anchorUpdates.get(c.id);
      if (anchors) c.anchors = anchors;
    }
    return { ok: true, dof: w.gcs.dof(), status, conflicting: [] };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
