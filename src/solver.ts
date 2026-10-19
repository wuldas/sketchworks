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
  type XY,
} from "./model";
import {
  arcInfo,
  angleDimensionFrame,
  intersections,
  paperPath,
  pointLineDistance,
} from "./geometry";
import { pathMidpoint } from "./snapping";
import { solveRadialBindings } from "./radialBindings";
import { angleTargetRadians } from "./angleDimension";

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
const curveRef = (s: Sketch, id: string) => {
  const e = entityRef(s, id);
  return e && e.kind !== "point" && e.kind !== "text" ? e : undefined;
};
const nativeCurve = (e: Entity) => e.kind === "line" || round(e);
function pointAndCurve(s: Sketch, refs: string[]): [Point, Entity] | undefined {
  if (refs.length !== 2) return;
  for (const [a, b] of [
    [refs[0], refs[1]],
    [refs[1], refs[0]],
  ]) {
    const p = pointRef(s, a),
      curve = curveRef(s, b);
    if (p && curve) return [p, curve];
  }
}
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
  const canonical = refs.map((ref) => pointRef(s, ref)?.id ?? ref);
  if (new Set(canonical).size !== refs.length)
    return "Select distinct references.";
  if (refs.some((r) => !findPoint(s, r) && !entityRef(s, r)))
    return "A referenced object no longer exists.";
  if (
    refs.some((r) =>
      s.entities.some(
        (e) => e.sourceId && (e.id === r || e.points.some((p) => p.id === r)),
      ),
    )
  )
    return "Derived geometry cannot be constrained directly.";
  if (
    ![
      "fixed",
      "coincident",
      "onLine",
      "onCurve",
      "midpoint",
      "intersection",
      "origin",
    ].includes(kind) &&
    refs.some((r) => {
      const owner = s.entities.find((e) => e.points.some((p) => p.id === r));
      return owner && !["point", "line", "circle", "arc"].includes(owner.kind);
    })
  )
    return "Curve control points support positional constraints only.";
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
      return pointAndLine(s, refs)
        ? null
        : "Select one explicit point and one line.";
    case "onCurve":
      return pointAndCurve(s, refs)
        ? null
        : "Select one explicit point and one curve.";
    case "midpoint": {
      const pair = pointAndCurve(s, refs);
      return pair &&
        ["line", "arc", "spline", "bezier", "conic"].includes(pair[1].kind)
        ? null
        : "Select one explicit point and one open curve.";
    }
    case "intersection":
      return refs.length === 3 &&
        pointRef(s, refs[0]) &&
        curveRef(s, refs[1]) &&
        curveRef(s, refs[2])
        ? null
        : "Select one explicit point, then two curves.";
    case "origin":
      return refs.length === 1 && pointRef(s, refs[0])
        ? null
        : "Select one explicit point to bind to the origin.";
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
    case "ellipseWidth":
      return refs.length === 2 &&
        entities[0]?.kind === "ellipse" &&
        entities[1]?.kind === "circle"
        ? null
        : "An ellipse width control requires an ellipse and its construction circle.";
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

type ComputedBinding = {
  id: string;
  kind: "midpoint" | "onCurve" | "intersection";
  pointId: string;
  curveIds: string[];
};
type ComputedPoint = { pointId: string; point: XY; tangent?: XY };
const BINDING_TOLERANCE = 1e-7;
const MAX_BINDING_SOLVES = 8;
const MAX_CURVE_BINDING_SOLVES = 24;
const samePosition = (a: XY, b: XY) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= BINDING_TOLERANCE;
function withinCurveBounds(p: XY, curve: Entity, finiteLine = false): boolean {
  if (curve.kind === "line") {
    if (
      pointLineDistance(p, curve.points[0], curve.points[1]) > BINDING_TOLERANCE
    )
      return false;
    if (!finiteLine) return true;
    const [a, b] = curve.points,
      dx = b.x - a.x,
      dy = b.y - a.y,
      length = Math.hypot(dx, dy),
      along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
    return along >= -BINDING_TOLERANCE && along <= length + BINDING_TOLERANCE;
  }
  if (!round(curve)) {
    const projection = bindingProjection(curve, p);
    return !!projection && samePosition(p, projection.point);
  }
  const center = curve.points[0],
    radius = curve.radius ?? (curve.kind === "arc" ? arcInfo(curve).r : NaN);
  if (
    !(radius > 0) ||
    Math.abs(Math.hypot(p.x - center.x, p.y - center.y) - radius) >
      BINDING_TOLERANCE
  )
    return false;
  if (curve.kind !== "arc") return true;
  const { c, r, start, sweep } = arcInfo(curve),
    angle = Math.atan2(p.y - c.y, p.x - c.x),
    tau = Math.PI * 2,
    travel = (((sweep < 0 ? start - angle : angle - start) % tau) + tau) % tau,
    tolerance = BINDING_TOLERANCE / Math.max(1, r);
  return travel <= Math.abs(sweep) + tolerance || tau - travel <= tolerance;
}
const fail = (
  message: string,
  conflicting: string[] = [],
  status = "Failed",
): SolverResult => ({ ok: false, dof: -1, status, conflicting, message });

function computedBindings(s: Sketch): ComputedBinding[] {
  const bindings: ComputedBinding[] = [];
  for (const c of s.constraints) {
    if (c.kind === "midpoint" || c.kind === "onCurve") {
      const pair = pointAndCurve(s, c.refs);
      if (
        pair &&
        (c.kind === "midpoint"
          ? pair[1].kind !== "line"
          : !nativeCurve(pair[1]))
      )
        bindings.push({
          id: c.id,
          kind: c.kind,
          pointId: pair[0].id,
          curveIds: [pair[1].id],
        });
    } else if (c.kind === "intersection") {
      const p = pointRef(s, c.refs[0]),
        a = curveRef(s, c.refs[1]),
        b = curveRef(s, c.refs[2]);
      if (p && a && b && (!nativeCurve(a) || !nativeCurve(b)))
        bindings.push({
          id: c.id,
          kind: c.kind,
          pointId: p.id,
          curveIds: [a.id, b.id],
        });
    }
  }
  return bindings;
}

// Paper represents rounds with cubic Beziers. Its intersections are only seeds
// until the general curve also meets the native circle's exact radius and bounds.
function bindingIntersections(a: Entity, b: Entity): XY[] {
  const seeds = intersections(a, b),
    circular = round(a) ? a : round(b) ? b : undefined;
  if (!circular) return seeds;
  const general = circular === a ? b : a,
    path = paperPath(general),
    center = circular.points[0],
    radius =
      circular.radius ?? (circular.kind === "arc" ? arcInfo(circular).r : NaN);
  try {
    const refined: XY[] = [];
    for (const seed of seeds) {
      const location = path.getNearestLocation([seed.x, seed.y]);
      if (!location) continue;
      const curve = location.curve;
      let time = location.time;
      for (let iteration = 0; iteration < 40; iteration++) {
        const p = curve.getPointAtTime(time),
          dx = p.x - center.x,
          dy = p.y - center.y,
          distance = Math.hypot(dx, dy);
        if (Math.abs(distance - radius) <= BINDING_TOLERANCE / 4) break;
        const tangent = curve.getWeightedTangentAtTime(time),
          derivative = (dx * tangent.x + dy * tangent.y) / distance;
        if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;
        const next = Math.max(
          0,
          Math.min(1, time - (distance - radius) / derivative),
        );
        if (next === time) break;
        time = next;
      }
      const p = curve.getPointAtTime(time);
      if (
        withinCurveBounds(p, circular, true) &&
        withinCurveBounds(p, general, true) &&
        !refined.some((previous) => samePosition(p, previous))
      )
        refined.push({ x: p.x, y: p.y });
    }
    return refined;
  } finally {
    path.remove();
  }
}

function bindingProjection(curve: Entity, reference: XY) {
  const path = paperPath(curve);
  try {
    const location = path.getNearestLocation([reference.x, reference.y]);
    if (!location) return;
    const curve = location.curve,
      values = curve.values;
    let time = location.time;
    // Paper's nearest parameter is approximate; finish the nearest-point solve
    // before using the projection to test incidence at solver precision.
    for (let iteration = 0; iteration < 8; iteration++) {
      const p = curve.getPointAtTime(time),
        tangent = curve.getWeightedTangentAtTime(time),
        dx = p.x - reference.x,
        dy = p.y - reference.y,
        ax =
          6 *
          ((1 - time) * (values[4] - 2 * values[2] + values[0]) +
            time * (values[6] - 2 * values[4] + values[2])),
        ay =
          6 *
          ((1 - time) * (values[5] - 2 * values[3] + values[1]) +
            time * (values[7] - 2 * values[5] + values[3])),
        denominator = tangent.x ** 2 + tangent.y ** 2 + dx * ax + dy * ay;
      if (!(denominator > 0)) break;
      const next = Math.max(
        0,
        Math.min(1, time - (dx * tangent.x + dy * tangent.y) / denominator),
      );
      if (Math.abs(next - time) < 1e-14) break;
      time = next;
    }
    const point = curve.getPointAtTime(time),
      tangent = curve.getTangentAtTime(time);
    if (!tangent || !Math.hypot(tangent.x, tangent.y)) return;
    return {
      point: { x: point.x, y: point.y },
      tangent: { x: tangent.x, y: tangent.y },
    };
  } finally {
    path.remove();
  }
}

function bindingPosition(
  s: Sketch,
  binding: ComputedBinding,
  drag?: Drag,
): XY | undefined {
  const curve = entityRef(s, binding.curveIds[0])!,
    target = pointRef(s, binding.pointId)!,
    reference = drag?.pointId === target.id ? drag : target;
  if (binding.kind === "midpoint") return pathMidpoint(curve);
  if (binding.kind === "intersection")
    return bindingIntersections(
      curve,
      entityRef(s, binding.curveIds[1])!,
    ).reduce<XY | undefined>(
      (nearest, p) =>
        !nearest ||
        Math.hypot(p.x - reference.x, p.y - reference.y) <
          Math.hypot(nearest.x - reference.x, nearest.y - reference.y)
          ? p
          : nearest,
      undefined,
    );
  return bindingProjection(curve, reference)?.point;
}

export function solveSketch(s: Sketch, drag?: Drag): SolverResult {
  return solveRadialBindings(s, drag, solveSketchBindings);
}

function solveSketchBindings(s: Sketch, drag?: Drag): SolverResult {
  const bindings = computedBindings(s);
  if (!bindings.length) return solveNative(s, drag);
  if (!solver)
    return fail("The geometry solver has not initialized.", [], "NotReady");
  for (const c of s.constraints) {
    const invalid = canConstrain(s, c.kind, c.refs);
    if (invalid) return fail(invalid, [c.id], "Unsupported");
  }
  if (drag?.exact === true) {
    if (!findPoint(s, drag.pointId))
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
  }
  try {
    // Intermediate solutions and newly captured anchors stay private until every binding settles.
    const candidate = structuredClone(s),
      fixedIds = new Set<string>();
    for (const c of candidate.constraints) {
      if (c.kind !== "fixed") continue;
      const e = entityRef(candidate, c.refs[0]),
        targets = e ? e.points : [pointRef(candidate, c.refs[0])!];
      for (const p of targets) {
        fixedIds.add(p.id);
        const anchor = c.anchors?.find((a) => a.id === p.id);
        if (anchor) Object.assign(p, { x: anchor.x, y: anchor.y });
      }
      const scalar = e && c.anchors?.find((a) => a.id === e.id);
      if (e && scalar) {
        if (round(e) || e.radius !== undefined) e.radius = scalar.x;
        if (e.ry !== undefined) e.ry = scalar.y;
      }
    }
    if (
      drag &&
      !fixedIds.has(drag.pointId) &&
      [drag.x, drag.y].every(Number.isFinite)
    ) {
      const p = findPoint(candidate, drag.pointId);
      if (p) Object.assign(p, { x: drag.x, y: drag.y });
    }
    const bindingDrag =
      drag && fixedIds.has(drag.pointId) && drag.exact !== true
        ? undefined
        : drag;
    let unsettled: string[] = [];
    const maxSolves = bindings.some((b) => b.kind === "onCurve")
      ? MAX_CURVE_BINDING_SOLVES
      : MAX_BINDING_SOLVES;
    for (let attempt = 0; attempt < maxSolves; attempt++) {
      const computed = new Map<string, ComputedPoint>();
      for (const binding of bindings) {
        const projection =
            binding.kind === "onCurve"
              ? bindingProjection(
                  entityRef(candidate, binding.curveIds[0])!,
                  pointRef(candidate, binding.pointId)!,
                )
              : undefined,
          p =
            binding.kind === "onCurve"
              ? projection?.point
              : bindingPosition(candidate, binding, bindingDrag);
        if (
          !p ||
          ![p.x, p.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 1e7)
        )
          return fail(
            binding.kind === "intersection"
              ? "The referenced curves no longer have an intersection."
              : "The curve binding could not be evaluated.",
            [binding.id],
            "InvalidBinding",
          );
        computed.set(binding.id, {
          pointId: binding.pointId,
          point: p,
          tangent: projection?.tangent,
        });
        // Seed free targets at the nearest point, then let native dimensions
        // move them along the local tangent instead of fixing both coordinates.
        if (
          projection &&
          !fixedIds.has(binding.pointId) &&
          !(drag?.exact === true && drag.pointId === binding.pointId)
        )
          Object.assign(pointRef(candidate, binding.pointId)!, p);
      }
      const draggedBinding =
          drag?.exact !== true &&
          bindings.find(
            (b) => b.kind === "onCurve" && b.pointId === drag?.pointId,
          ),
        nativeDrag =
          drag && draggedBinding
            ? { ...drag, ...computed.get(draggedBinding.id)!.point }
            : drag,
        result = solveNative(candidate, nativeDrag, computed);
      if (!result.ok) return result;
      unsettled = [];
      for (const binding of bindings) {
        const p = bindingPosition(
            candidate,
            binding,
            binding.kind === "onCurve" ? undefined : bindingDrag,
          ),
          target = pointRef(candidate, binding.pointId)!,
          previous = computed.get(binding.id)!.point;
        if (
          !p ||
          ![p.x, p.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 1e7)
        )
          return fail(
            binding.kind === "intersection"
              ? "The referenced curves no longer have an intersection."
              : "The curve binding could not be evaluated.",
            [binding.id],
            "InvalidBinding",
          );
        if (
          (binding.kind !== "onCurve" && !samePosition(p, previous)) ||
          !samePosition(p, target)
        )
          unsettled.push(binding.id);
        else if (
          binding.kind !== "midpoint" &&
          !binding.curveIds.every((id) =>
            withinCurveBounds(target, entityRef(candidate, id)!, true),
          )
        )
          return fail(
            "The point does not lie on the referenced curves.",
            [binding.id],
            "InvalidBinding",
          );
      }
      if (unsettled.length) continue;
      const solvedEntities = new Map(candidate.entities.map((e) => [e.id, e]));
      for (const e of s.entities) {
        const solved = solvedEntities.get(e.id)!;
        for (let i = 0; i < e.points.length; i++)
          Object.assign(e.points[i], {
            x: solved.points[i].x,
            y: solved.points[i].y,
          });
        if (solved.radius !== undefined) e.radius = solved.radius;
        if (solved.ry !== undefined) e.ry = solved.ry;
      }
      for (let i = 0; i < s.constraints.length; i++) {
        const anchors = candidate.constraints[i].anchors;
        if (anchors) s.constraints[i].anchors = anchors;
      }
      return result;
    }
    return fail(
      "Computed geometry bindings did not converge.",
      unsettled,
      "BindingNotConverged",
    );
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      bindings.map((b) => b.id),
    );
  }
}

function solveNative(
  s: Sketch,
  drag?: Drag,
  computed?: Map<string, ComputedPoint>,
): SolverResult {
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
      if (
        c.angleSector &&
        (c.kind !== "angle" ||
          c.refs.length !== 2 ||
          typeof c.angleSector.reverseFirst !== "boolean" ||
          typeof c.angleSector.reverseSecond !== "boolean" ||
          typeof c.angleSector.clockwise !== "boolean" ||
          c.value! < 0 ||
          c.value! >= 360)
      )
        return fail(
          "Selected-ray angles must be between 0 and 360 degrees (excluding 360).",
          [c.id],
          "InvalidAngle",
        );
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
      const binding = computed?.get(c.id);
      if (binding) {
        const id = `__solver_${c.id}_binding_${primitives.length}`;
        primitives.push({ id, type: "point", ...binding.point, fixed: true });
        if (binding.tangent) {
          const tangentId = `${id}_tangent`;
          primitives.push({
            id: tangentId,
            type: "point",
            x: binding.point.x + binding.tangent.x,
            y: binding.point.y + binding.tangent.y,
            fixed: true,
          });
          emit({
            type: "point_on_line_ppp",
            p_id: binding.pointId,
            lp1_id: id,
            lp2_id: tangentId,
          });
        } else
          emit({ type: "p2p_coincident", p1_id: binding.pointId, p2_id: id });
        continue;
      }
      const incidence = (p: Point, curve: Entity) => {
        if (curve.kind === "line")
          emit({ type: "point_on_line_pl", p_id: p.id, l_id: curve.id });
        else if (curve.kind === "circle")
          emit({ type: "point_on_circle", p_id: p.id, c_id: curve.id });
        else if (curve.kind === "arc")
          emit({ type: "point_on_arc", p_id: p.id, a_id: curve.id });
        else throw new Error("This curve requires a computed binding.");
      };
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
        case "ellipseWidth": {
          const scalar = fixedScalars.get(a);
          if (scalar)
            emit({ type: "circle_radius", c_id: b, radius: scalar.y });
          break;
        }
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
        case "onCurve": {
          const [p, curve] = pointAndCurve(s, c.refs)!;
          incidence(p, curve);
          break;
        }
        case "intersection": {
          const p = pointRef(s, a)!;
          incidence(p, curveRef(s, b)!);
          incidence(p, curveRef(s, axis)!);
          break;
        }
        case "origin": {
          const p = pointRef(s, a)!;
          emit({ type: "coordinate_x", p_id: p.id, x: 0 });
          emit({ type: "coordinate_y", p_id: p.id, y: 0 });
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
            let contact: Point | undefined;
            for (const binding of s.constraints) {
              if (binding.kind === "onCurve") {
                const pair = pointAndCurve(s, binding.refs);
                if (pair && pair[1].id === curve.id)
                  contact = line.points.find((p) => p.id === pair[0].id);
              } else if (
                curve.kind === "arc" &&
                binding.kind === "coincident"
              ) {
                const first = pointRef(s, binding.refs[0]),
                  second = pointRef(s, binding.refs[1]);
                for (const p of line.points) {
                  const other =
                    first?.id === p.id
                      ? second
                      : second?.id === p.id
                        ? first
                        : undefined;
                  if (
                    other &&
                    (other.id === curve.points[1].id ||
                      other.id === curve.points[2].id)
                  ) {
                    contact = p;
                    break;
                  }
                }
              }
              if (contact) break;
            }
            if (!contact && curve.kind === "arc")
              contact = line.points.find(
                (p) =>
                  p.id === curve.points[1].id || p.id === curve.points[2].id,
              );
            if (contact) {
              // A contact radius avoids the dependent incidence/distance-tangency gradients.
              const id = `__solver_${c.id}_contact_${primitives.length}`;
              primitives.push({
                id,
                type: "line",
                p1_id: curve.points[0].id,
                p2_id: contact.id,
              });
              emit({ type: "perpendicular_ll", l1_id: line.id, l2_id: id });
            } else
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
        case "angle": {
          if (c.angleSector && c.refs.length === 2) {
            const sector = c.angleSector,
              first = sector.reverseFirst
                ? [e1!.points[1], e1!.points[0]]
                : e1!.points,
              second = sector.reverseSecond
                ? [e2!.points[1], e2!.points[0]]
                : e2!.points;
            emit({
              type: "l2l_angle_pppp",
              l1p1_id: first[0].id,
              l1p2_id: first[1].id,
              l2p1_id: second[0].id,
              l2p2_id: second[1].id,
              angle: angleTargetRadians(c.value!, sector),
            });
          } else {
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
          }
          break;
        }
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
    ) {
      const anchoredCurve = (id: string): Entity | undefined => {
        const e = curveRef(s, id);
        if (!e || !nativeCurve(e)) return;
        const anchors = e.points.map((p) => fixed.get(p.id));
        if (!anchors.every(Boolean)) return;
        const dimension = s.constraints.find(
          (c) =>
            (c.kind === "radius" || c.kind === "diameter") && c.refs[0] === id,
        );
        const radius =
          fixedScalars.get(id)?.x ??
          (dimension &&
            dimension.value! / (dimension.kind === "diameter" ? 2 : 1));
        if (round(e) && radius === undefined) return;
        return { ...e, points: anchors as Point[], radius: radius ?? e.radius };
      };
      for (const c of s.constraints) {
        if (c.kind !== "intersection") continue;
        const a = anchoredCurve(c.refs[1]),
          b = anchoredCurve(c.refs[2]);
        if (
          a &&
          b &&
          !intersections(a, b).length &&
          !conflicting.includes(c.id)
        )
          conflicting.push(c.id);
      }
      return fail("Constraints could not be satisfied.", conflicting, status);
    }
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
    const solvedEntities = new Map<string, Entity>();
    const solvedRounds = new Map(
      solved
        .filter((p) => p.type === "circle" || p.type === "arc")
        .map((p) => [p.id, p]),
    );
    const ellipseWidths = new Map(
      s.constraints
        .filter((c) => c.kind === "ellipseWidth")
        .map((c) => [c.refs[0], c.refs[1]]),
    );
    const solvedEntity = (id: string) => {
      let e = solvedEntities.get(id);
      if (!e) {
        const original = entityRef(s, id)!;
        e = {
          ...original,
          radius: solvedRounds.get(id)?.radius ?? original.radius,
          ry: ellipseWidths.has(id)
            ? solvedRounds.get(ellipseWidths.get(id)!)?.radius
            : original.ry,
          points: original.points.map((p) => {
            const next = solvedPoints.get(p.id)!;
            return { id: p.id, x: next.x, y: next.y };
          }),
        };
        solvedEntities.set(id, e);
      }
      return e;
    };
    // PlaneGCS can report success for unsatisfied constraints with only fixed parameters.
    for (const c of s.constraints) {
      const binding = computed?.get(c.id);
      let satisfied = true;
      if (binding) {
        const p = solvedPoints.get(binding.pointId)!;
        satisfied = binding.tangent
          ? pointLineDistance(p, binding.point, {
              x: binding.point.x + binding.tangent.x,
              y: binding.point.y + binding.tangent.y,
            }) <= BINDING_TOLERANCE
          : samePosition(p, binding.point);
      } else if (c.kind === "angle" && c.angleSector) {
        const frame = angleDimensionFrame(
          solvedEntity(c.refs[0]),
          solvedEntity(c.refs[1]),
          c.angleSector,
        );
        satisfied =
          Math.abs((Math.abs(frame.sweep) * 180) / Math.PI - c.value!) <= 1e-5;
      } else if (c.kind === "coincident") {
        satisfied = samePosition(
          solvedPoints.get(pointRef(s, c.refs[0])!.id)!,
          solvedPoints.get(pointRef(s, c.refs[1])!.id)!,
        );
      } else if (c.kind === "origin") {
        satisfied = samePosition(
          solvedPoints.get(pointRef(s, c.refs[0])!.id)!,
          { x: 0, y: 0 },
        );
      } else if (c.kind === "midpoint") {
        const [p, curve] = pointAndLine(s, c.refs)!;
        satisfied = samePosition(
          solvedPoints.get(p.id)!,
          pathMidpoint(solvedEntity(curve.id))!,
        );
      } else if (c.kind === "onLine" || c.kind === "onCurve") {
        const [p, curve] = pointAndCurve(s, c.refs)!;
        if (!withinCurveBounds(solvedPoints.get(p.id)!, solvedEntity(curve.id)))
          return fail(
            "The point does not lie on the referenced curve.",
            [c.id],
            "InvalidBinding",
          );
      } else if (c.kind === "intersection") {
        const p = solvedPoints.get(pointRef(s, c.refs[0])!.id)!;
        if (
          !c.refs
            .slice(1)
            .every((id) => withinCurveBounds(p, solvedEntity(id), true))
        )
          return fail(
            "The referenced finite curves no longer have this intersection.",
            [c.id],
            "InvalidBinding",
          );
      }
      if (!satisfied)
        return fail(
          "The positional binding could not be satisfied.",
          [c.id],
          "ConflictingBinding",
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
    for (const [id, circleId] of ellipseWidths) {
      entityRef(s, id)!.ry = solvedRounds.get(circleId)!.radius;
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
