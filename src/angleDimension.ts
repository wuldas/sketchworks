import {
  type AngleSector,
  type Constraint,
  type Sketch,
  type XY,
} from "./model";
import { angleDimensionFrame, selectAngleSector } from "./geometry";

export function resolveAnglePlacement(
  sketch: Sketch,
  refs: readonly string[],
  position?: XY,
) {
  if (refs.length !== 2) return;
  const a = sketch.entities.find((e) => e.id === refs[0] && e.kind === "line"),
    b = sketch.entities.find((e) => e.id === refs[1] && e.kind === "line");
  if (!a || !b) return;
  const angleSector = selectAngleSector(a, b, position),
    frame = angleDimensionFrame(a, b, angleSector);
  return { angleSector, value: (Math.abs(frame.sweep) * 180) / Math.PI };
}

/** Native four-point angles measure the signed rotation between the selected rays. */
export function angleTargetRadians(value: number, sector: AngleSector) {
  const signed = ((sector.clockwise ? -value : value) * Math.PI) / 180;
  return Math.atan2(Math.sin(signed), Math.cos(signed));
}

/** Changing displayed sectors preserves the same underlying directed line-angle constraint. */
export function convertAngleSector(
  c: Pick<Constraint, "value" | "expression" | "angleSector">,
  next: AngleSector,
  measured: number,
) {
  if (c.value === undefined)
    return { angleSector: next, value: measured, expression: c.expression };
  const previous = c.angleSector,
    oldSign = previous?.clockwise ? -1 : 1,
    newSign = next.clockwise ? -1 : 1,
    oldShift = previous
      ? 180 * (Number(previous.reverseFirst) - Number(previous.reverseSecond))
      : 0,
    newShift = 180 * (Number(next.reverseSecond) - Number(next.reverseFirst)),
    slope = newSign * oldSign,
    intercept = newSign * (oldShift + newShift),
    base = slope * c.value + intercept,
    offset = intercept + 360 * Math.round((measured - base) / 360);
  let expression = c.expression;
  if (expression !== undefined && (slope !== 1 || offset !== 0))
    expression =
      offset === 0
        ? `-(${expression})`
        : `${offset} ${slope === 1 ? "+" : "-"} (${expression})`;
  return { angleSector: next, value: slope * c.value + offset, expression };
}
