import { type Constraint, type Entity, type Sketch, type XY } from "./model";
import { angleDimensionFrame, dist, EPS, projection } from "./geometry";
import { convertAngleSector, resolveAnglePlacement } from "./angleDimension";

type PositionedDimension = Pick<
  Constraint,
  "kind" | "refs" | "labelPosition" | "labelOffset" | "angleSector"
>;
type References = {
  entity: (ref: string) => Entity | undefined;
  point: (ref: string) => XY | undefined;
};
type LabelFrame = { origin: XY; direction: XY };

export function dimensionReferences(sketch: Sketch): References {
  const entities = new Map(sketch.entities.map((e) => [e.id, e])),
    points = new Map(
      sketch.entities.flatMap((e) => e.points).map((p) => [p.id, p]),
    );
  return {
    entity: (ref) => entities.get(ref),
    point: (ref) => points.get(ref) ?? entities.get(ref)?.points[0],
  };
}
const midpoint = (a: XY, b: XY): XY => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
const direction = (a: XY, b: XY): XY => {
  const length = dist(a, b);
  return length > EPS
    ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
    : { x: 1, y: 0 };
};
function labelFrame(
  c: PositionedDimension,
  refs: References,
): LabelFrame | undefined {
  const e = refs.entity(c.refs[0]);
  switch (c.kind) {
    case "radius":
    case "diameter":
      if (e?.kind !== "circle" && e?.kind !== "arc") return;
      return {
        origin: e.points[0],
        direction:
          e.kind === "arc"
            ? direction(e.points[0], e.points[1])
            : { x: 1, y: 0 },
      };
    case "angle": {
      if (e?.kind !== "line") return;
      const other = c.refs[1] ? refs.entity(c.refs[1]) : undefined;
      if (c.refs[1] && other?.kind !== "line") return;
      const frame = angleDimensionFrame(e, other, c.angleSector),
        angle = frame.start + frame.sweep / 2;
      return {
        origin: frame.vertex,
        direction: { x: Math.cos(angle), y: Math.sin(angle) },
      };
    }
    case "lineDistance": {
      const lineRef = c.refs.find((ref) => refs.entity(ref)?.kind === "line"),
        line = lineRef ? refs.entity(lineRef) : undefined,
        pointRef = c.refs.find((ref) => ref !== lineRef),
        point = pointRef ? refs.point(pointRef) : undefined;
      if (!line || !point) return;
      const foot = projection(
        point,
        line.points[0],
        line.points[1],
        false,
      ).point;
      return {
        origin: midpoint(point, foot),
        direction: direction(line.points[0], line.points[1]),
      };
    }
    case "length":
    case "distanceX":
    case "distanceY": {
      const a = refs.point(c.refs[0]),
        b = c.refs[1] ? refs.point(c.refs[1]) : e?.points[1];
      if (!a || !b) return;
      return {
        origin: midpoint(a, b),
        direction: c.kind === "length" ? direction(a, b) : { x: 1, y: 0 },
      };
    }
    default:
      return;
  }
}
function localPosition(frame: LabelFrame, world: XY): XY {
  const x = world.x - frame.origin.x,
    y = world.y - frame.origin.y,
    u = frame.direction;
  return { x: x * u.x + y * u.y, y: -x * u.y + y * u.x };
}
function worldPosition(frame: LabelFrame, offset: XY): XY {
  const u = frame.direction;
  return {
    x: frame.origin.x + u.x * offset.x - u.y * offset.y,
    y: frame.origin.y + u.y * offset.x + u.x * offset.y,
  };
}
function validPosition(point: XY, limit: number) {
  if (
    ![point.x, point.y].every((n) => Number.isFinite(n) && Math.abs(n) <= limit)
  )
    throw new Error("尺寸标注位置越界");
}

/** Resolve saved placement against the current geometry, including unsolved previews of movement. */
export function dimensionLabelPosition(
  c: PositionedDimension,
  refs: References,
): XY | undefined {
  const frame = c.labelOffset ? labelFrame(c, refs) : undefined;
  return frame && c.labelOffset
    ? worldPosition(frame, c.labelOffset)
    : c.labelPosition;
}

/** Displayed label point, accounting for dimension-line projection when fitting the drawing. */
export function dimensionLabelAnchor(
  c: PositionedDimension,
  refs: References,
): XY | undefined {
  const position = dimensionLabelPosition(c, refs),
    frame = labelFrame(c, refs);
  if (!position || !frame) return;
  const offset = localPosition(frame, position);
  switch (c.kind) {
    case "length":
      return worldPosition(frame, { x: 0, y: offset.y });
    case "lineDistance":
      return worldPosition(frame, { x: offset.x, y: 0 });
    case "distanceX":
      return { x: frame.origin.x, y: position.y };
    case "distanceY":
      return { x: position.x, y: frame.origin.y };
    case "angle": {
      const radius = dist(frame.origin, position);
      return {
        x: frame.origin.x + frame.direction.x * radius,
        y: frame.origin.y + frame.direction.y * radius,
      };
    }
    default:
      return position;
  }
}

/** A label drag chooses a new offset; it does not retain the previous attachment. */
export function placeDimensionLabel(sketch: Sketch, c: Constraint, world: XY) {
  validPosition(world, 1e7);
  const placement =
      c.kind === "angle"
        ? resolveAnglePlacement(sketch, c.refs, world)
        : undefined,
    angles = placement
      ? convertAngleSector(c, placement.angleSector, placement.value)
      : undefined,
    frame = labelFrame(
      angles ? { ...c, ...angles } : c,
      dimensionReferences(sketch),
    );
  const offset = frame ? localPosition(frame, world) : undefined;
  if (offset) validPosition(offset, 3e7);
  if (angles) Object.assign(c, angles);
  c.labelPosition = { ...world };
  if (offset) c.labelOffset = offset;
  else delete c.labelOffset;
}

/** Capture old documents' absolute placements before an operation changes their geometry. */
export function prepareDimensionLabels(sketch: Sketch) {
  const refs = dimensionReferences(sketch),
    updates: { c: Constraint; offset: XY }[] = [];
  for (const c of sketch.constraints) {
    if (!c.labelPosition || c.labelOffset) continue;
    const frame = labelFrame(c, refs);
    if (!frame) continue;
    validPosition(c.labelPosition, 1e7);
    const offset = localPosition(frame, c.labelPosition);
    validPosition(offset, 3e7);
    updates.push({ c, offset });
  }
  for (const { c, offset } of updates) c.labelOffset = offset;
}

/** Keep the world-position cache useful for exports, history, and existing label editors. */
export function updateDimensionLabels(sketch: Sketch) {
  const refs = dimensionReferences(sketch),
    updates: { c: Constraint; offset: XY; world: XY }[] = [];
  for (const c of sketch.constraints) {
    if (!c.labelPosition && !c.labelOffset) continue;
    const frame = labelFrame(c, refs);
    if (!frame) continue;
    const offset = c.labelOffset ?? localPosition(frame, c.labelPosition!),
      world = c.labelOffset ? worldPosition(frame, offset) : c.labelPosition!;
    validPosition(offset, 3e7);
    validPosition(world, 1e7);
    updates.push({ c, offset, world });
  }
  for (const { c, offset, world } of updates) {
    if (!c.labelOffset) c.labelOffset = offset;
    // Avoid creating history changes from floating-point round trips alone.
    if (!c.labelPosition || dist(c.labelPosition, world) > EPS)
      c.labelPosition = world;
  }
}
