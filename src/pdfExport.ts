import {
  PDFDocument,
  StandardFonts,
  LineCapStyle,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { ExportOptions } from "./export";
import type { Document, Entity, Sketch, XY } from "./model";
import {
  angleDimensionFrame,
  arcInfo,
  bounds,
  dist,
  entityPath,
  projection,
} from "./geometry";
import { dimensionLabelAnchor, dimensionReferences } from "./dimensionLabel";
import { circularDimensionEndpoints } from "./circularDimension";

const PT_PER_MM = 72 / 25.4;
const MARGIN = 12 * PT_PER_MM;
const LABEL_SIZE = 9;
const ink = rgb(0.12, 0.15, 0.18);
const dimensionInk = rgb(0.25, 0.32, 0.35);
const dimensionKinds = new Set([
  "length",
  "lineDistance",
  "distanceX",
  "distanceY",
  "radius",
  "diameter",
  "angle",
]);
type Extents = { minX: number; minY: number; maxX: number; maxY: number };
type Dimension = {
  label: XY;
  text: string;
  lines: [XY, XY][];
  a: XY;
  b: XY;
  arc?: Entity;
};
type TextRun = {
  text: string;
  width: number;
  image?: PDFImage;
  bottom?: number;
  height?: number;
  left?: number;
};
type TextLine = { origin: XY; size: number; rotation: number; runs: TextRun[] };
const midpoint = (a: XY, b: XY): XY => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
const shift = (p: XY, v: XY, amount: number): XY => ({
  x: p.x + v.x * amount,
  y: p.y + v.y * amount,
});
const direction = (a: XY, b: XY): XY => {
  const length = dist(a, b) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
};
function finitePoint(p: XY) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
    throw new Error("Invalid export geometry");
}
function validateEntity(e: Entity) {
  const minimum = {
    line: 2,
    circle: 1,
    arc: 3,
    ellipse: 2,
    bezier: 4,
    spline: 2,
    conic: 3,
    point: 1,
    text: 1,
  };
  if (!e.points || e.points.length < minimum[e.kind])
    throw new Error("Invalid export geometry");
  e.points.forEach(finitePoint);
  if (
    [e.radius, e.ry, e.fontSize, e.weight, e.rotation].some(
      (n) => n !== undefined && !Number.isFinite(n),
    )
  )
    throw new Error("Invalid export parameter");
  if (
    [e.radius, e.ry, e.fontSize, e.weight].some(
      (n) => n !== undefined && n <= 0,
    )
  )
    throw new Error("Invalid export parameter");
  if (e.kind === "ellipse" && !(dist(e.points[0], e.points[1]) > 0))
    throw new Error("Invalid ellipse axes");
}
function dimensions(sketch: Sketch, doc: Document): Dimension[] {
  const refs = dimensionReferences(sketch);
  const selected = new Set(
    sketch.entities.flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
  );
  const format = (value: number) =>
    Number(
      (doc.unit === "in" ? value / 25.4 : value).toFixed(
        doc.unit === "in" ? 3 : 2,
      ),
    ).toString();
  const result: Dimension[] = [];
  for (const c of sketch.constraints) {
    if (
      !dimensionKinds.has(c.kind) ||
      !c.refs.every((ref) => selected.has(ref))
    )
      continue;
    if (c.value !== undefined && !Number.isFinite(c.value))
      throw new Error("Invalid export parameter");
    for (const position of [c.labelPosition, c.labelOffset])
      if (position) finitePoint(position);
    const e = refs.entity(c.refs[0]);
    const saved = dimensionLabelAnchor(c, refs);
    if (saved) finitePoint(saved);
    if (c.kind === "radius" || c.kind === "diameter") {
      if (!e || (e.kind !== "circle" && e.kind !== "arc")) continue;
      const center = e.points[0],
        radius = e.kind === "arc" ? arcInfo(e).r : (e.radius ?? 1);
      const { a, b } = circularDimensionEndpoints(
        center,
        radius,
        c.kind,
        saved,
      );
      const label = saved ?? shift(b, direction(center, b), 7);
      result.push({
        a,
        b,
        label,
        text: `${c.kind === "radius" ? "R" : "Ø"}${format(c.value ?? radius * (c.kind === "diameter" ? 2 : 1))}`,
        lines: [
          [a, b],
          [b, label],
        ],
      });
      continue;
    }
    if (c.kind === "angle") {
      if (e?.kind !== "line") continue;
      const other = c.refs[1] ? refs.entity(c.refs[1]) : undefined;
      if (c.refs[1] && other?.kind !== "line") continue;
      const frame = angleDimensionFrame(e, other, c.angleSector);
      const middle = frame.start + frame.sweep / 2;
      const label =
        saved ??
        shift(frame.vertex, { x: Math.cos(middle), y: Math.sin(middle) }, 8);
      const radius = Math.max(1, dist(frame.vertex, label) - 3);
      const a = shift(
        frame.vertex,
        { x: Math.cos(frame.start), y: Math.sin(frame.start) },
        radius,
      );
      const b = shift(
        frame.vertex,
        {
          x: Math.cos(frame.start + frame.sweep),
          y: Math.sin(frame.start + frame.sweep),
        },
        radius,
      );
      const value =
        c.value ??
        ((c.angleSector ? Math.abs(frame.sweep) : frame.sweep) * 180) / Math.PI;
      result.push({
        a,
        b,
        label,
        text: `${Number(value.toFixed(2))}°`,
        lines: [
          [frame.vertex, a],
          [frame.vertex, b],
        ],
        arc:
          Math.abs(frame.sweep) > 1e-9
            ? {
                id: c.id,
                name: "",
                kind: "arc",
                ccw: frame.sweep > 0,
                points: [frame.vertex, a, b].map((p, i) => ({
                  ...p,
                  id: `${c.id}_${i}`,
                })),
              }
            : undefined,
      });
      continue;
    }
    let a: XY | undefined, b: XY | undefined;
    if (c.kind === "lineDistance") {
      const lineRef = c.refs.find((ref) => refs.entity(ref)?.kind === "line");
      const line = lineRef ? refs.entity(lineRef) : undefined;
      const pointRef = c.refs.find((ref) => ref !== lineRef);
      a = pointRef ? refs.point(pointRef) : undefined;
      b =
        a && line
          ? projection(a, line.points[0], line.points[1], false).point
          : undefined;
    } else {
      a = refs.point(c.refs[0]);
      b = c.refs[1] ? refs.point(c.refs[1]) : e?.points[1];
    }
    if (!a || !b) continue;
    const middle = midpoint(a, b),
      u = direction(a, b),
      normal = { x: -u.y, y: u.x };
    let label: XY, da: XY, db: XY;
    if (c.kind === "distanceX") {
      label = saved ?? { x: middle.x, y: Math.min(a.y, b.y) - 7 };
      da = { x: a.x, y: label.y };
      db = { x: b.x, y: label.y };
    } else if (c.kind === "distanceY") {
      label = saved ?? { x: Math.max(a.x, b.x) + 7, y: middle.y };
      da = { x: label.x, y: a.y };
      db = { x: label.x, y: b.y };
    } else {
      label = saved ?? shift(middle, normal, 7);
      const offset =
        (label.x - middle.x) * normal.x + (label.y - middle.y) * normal.y;
      da = shift(a, normal, offset);
      db = shift(b, normal, offset);
    }
    const value =
      c.value ??
      (c.kind === "distanceX"
        ? b.x - a.x
        : c.kind === "distanceY"
          ? b.y - a.y
          : dist(a, b));
    result.push({
      a: da,
      b: db,
      label,
      text: format(value),
      lines: [
        [a, da],
        [b, db],
        [da, db],
      ],
    });
  }
  return result;
}
function encodable(font: PDFFont, text: string) {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}
/** Only glyphs outside the standard PDF font use local browser font rendering. */
async function rasterRun(
  pdf: PDFDocument,
  text: string,
  size: number,
): Promise<TextRun> {
  if (typeof document === "undefined")
    throw new Error("Unicode PDF text requires browser canvas support");
  const canvas = document.createElement("canvas"),
    context = canvas.getContext("2d");
  if (!context)
    throw new Error("Unicode PDF text requires browser canvas support");
  const pixels = 96;
  context.font = `${pixels}px sans-serif`;
  const metrics = context.measureText(text);
  const left = Math.max(0, metrics.actualBoundingBoxLeft || 0);
  const ascent = Math.max(pixels, metrics.actualBoundingBoxAscent || pixels);
  const descent = Math.max(pixels * 0.3, metrics.actualBoundingBoxDescent || 0);
  const right = Math.max(
    metrics.width,
    metrics.actualBoundingBoxRight || metrics.width,
  );
  const padding = 3;
  canvas.width = Math.ceil(left + right + 2 * padding);
  canvas.height = Math.ceil(ascent + descent + 2 * padding);
  // A bounded canvas avoids silently producing a blank PNG for oversized imported text.
  if (
    canvas.width > 16384 ||
    canvas.height > 16384 ||
    canvas.width * canvas.height > 16_000_000
  )
    throw new Error("Unicode PDF text exceeds browser canvas limits");
  context.font = `${pixels}px sans-serif`;
  context.fillStyle = "#1f262e";
  context.textBaseline = "alphabetic";
  context.fillText(text, left + padding, ascent + padding);
  const image = await pdf.embedPng(canvas.toDataURL("image/png"));
  const factor = size / pixels;
  return {
    text,
    image,
    width: metrics.width * factor,
    left: -(left + padding) * factor,
    bottom: -(descent + padding) * factor,
    height: canvas.height * factor,
  };
}
async function textLines(
  pdf: PDFDocument,
  font: PDFFont,
  entities: Entity[],
): Promise<TextLine[]> {
  const output: TextLine[] = [];
  for (const e of entities.filter((e) => e.kind === "text")) {
    const size = e.fontSize ?? 6,
      rotation = e.rotation ?? 0;
    const angle = (rotation * Math.PI) / 180;
    for (const [i, raw] of (e.text ?? "").split(/\r?\n/).entries()) {
      const text = raw.replace(/[\r\u0000]/g, "").replace(/\t/g, "    ");
      const groups: { text: string; standard: boolean }[] = [];
      for (const char of text) {
        const standard = encodable(font, char),
          last = groups.at(-1);
        if (last?.standard === standard) last.text += char;
        else groups.push({ text: char, standard });
      }
      const runs: TextRun[] = [];
      for (const group of groups)
        runs.push(
          group.standard
            ? {
                text: group.text,
                width: font.widthOfTextAtSize(group.text, size),
              }
            : await rasterRun(pdf, group.text, size),
        );
      const offset = i * size * 1.25;
      output.push({
        origin: {
          x: e.points[0].x + Math.sin(angle) * offset,
          y: e.points[0].y - Math.cos(angle) * offset,
        },
        rotation,
        size,
        runs,
      });
    }
  }
  return output;
}
function include(extents: Extents, point: XY) {
  finitePoint(point);
  extents.minX = Math.min(extents.minX, point.x);
  extents.maxX = Math.max(extents.maxX, point.x);
  extents.minY = Math.min(extents.minY, point.y);
  extents.maxY = Math.max(extents.maxY, point.y);
}
function textBounds(extents: Extents, line: TextLine) {
  const angle = (line.rotation * Math.PI) / 180;
  let offset = 0;
  for (const run of line.runs) {
    const left = offset + (run.left ?? 0),
      width = run.image ? (run.image.width * line.size) / 96 : run.width;
    const bottom = run.bottom ?? -line.size * 0.3,
      height = run.height ?? line.size * 1.3;
    for (const x of [left, left + width])
      for (const y of [bottom, bottom + height])
        include(extents, {
          x: line.origin.x + x * Math.cos(angle) - y * Math.sin(angle),
          y: line.origin.y + x * Math.sin(angle) + y * Math.cos(angle),
        });
    offset += run.width;
  }
}
function strokePath(
  page: PDFPage,
  path: string,
  scale: number,
  construction = false,
  dimension = false,
) {
  if (!path) return;
  // pdf-lib flips SVG Y internally. Cancel that flip to retain the CAD's Y-up coordinates.
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(1, 0, 0, -1, 0, 0),
  );
  page.drawSvgPath(path, {
    borderColor: construction
      ? rgb(0.5, 0.53, 0.56)
      : dimension
        ? dimensionInk
        : ink,
    borderWidth: (dimension ? 0.45 : 0.65) / scale,
    borderDashArray: construction ? [2, 1] : [],
    borderLineCap: LineCapStyle.Round,
  });
  page.pushOperators(popGraphicsState());
}
const linePath = (a: XY, b: XY) => `M${a.x},${a.y} L${b.x},${b.y}`;
function drawTextLine(page: PDFPage, font: PDFFont, line: TextLine) {
  const angle = (line.rotation * Math.PI) / 180;
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(
      Math.cos(angle),
      Math.sin(angle),
      -Math.sin(angle),
      Math.cos(angle),
      line.origin.x,
      line.origin.y,
    ),
  );
  let offset = 0;
  for (const run of line.runs) {
    if (run.image)
      page.drawImage(run.image, {
        x: offset + run.left!,
        y: run.bottom!,
        width: (run.image.width * line.size) / 96,
        height: run.height!,
      });
    else if (run.text)
      page.drawText(run.text, {
        x: offset,
        y: 0,
        size: line.size,
        font,
        color: ink,
      });
    offset += run.width;
  }
  page.pushOperators(popGraphicsState());
}

/** Export a single vector A4 sheet. Document coordinates are always millimeters, regardless of display unit. */
export async function exportPdf(
  doc: Document,
  options: ExportOptions = {},
): Promise<Uint8Array> {
  const visible = doc.sketches.filter((s) => s.visible);
  const sketches = (
    options.allVisible === false ? visible.slice(0, 1) : visible
  ).map((s) => ({
    ...s,
    entities: s.entities.filter((e) => options.construction || !e.construction),
  }));
  const entities = sketches.flatMap((s) => s.entities);
  entities.forEach(validateEntity);
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.name);
  pdf.setCreator("Sketch Workbench");
  pdf.setProducer("Sketch Workbench / pdf-lib");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const labels = sketches.flatMap((sketch) => dimensions(sketch, doc));
  const texts = await textLines(pdf, font, entities);
  const geometry = entities.filter((e) => e.kind !== "text");
  const extents: Extents = geometry.length
    ? bounds(geometry)
    : { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const line of texts) textBounds(extents, line);
  for (const d of labels) {
    include(extents, d.label);
    for (const pair of d.lines) pair.forEach((p) => include(extents, p));
    if (d.arc) {
      const b = bounds([d.arc]);
      include(extents, { x: b.minX, y: b.minY });
      include(extents, { x: b.maxX, y: b.maxY });
    }
  }
  if (extents.minX === Infinity)
    Object.assign(extents, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
  Object.values(extents).forEach((value) => {
    if (!Number.isFinite(value))
      throw new Error("Non-finite export coordinate");
  });
  // Fixed page-space label allowance keeps dimension text at 9pt even when a large drawing is reduced.
  const labelPadX = Math.max(
    1 * PT_PER_MM,
    ...labels.map(
      (d) => font.widthOfTextAtSize(d.text, LABEL_SIZE) / 2 + 2 * PT_PER_MM,
    ),
  );
  const labelPadY = labels.length ? LABEL_SIZE + 2 * PT_PER_MM : 1 * PT_PER_MM;
  const width = Math.max(1, extents.maxX - extents.minX),
    height = Math.max(1, extents.maxY - extents.minY);
  const layouts = [
    [210, 297],
    [297, 210],
  ].map(([w, h]) => ({
    w: w * PT_PER_MM,
    h: h * PT_PER_MM,
    scale: Math.min(
      PT_PER_MM,
      (w * PT_PER_MM - 2 * (MARGIN + labelPadX)) / width,
      (h * PT_PER_MM - 2 * (MARGIN + labelPadY)) / height,
    ),
  }));
  // Prefer the natural orientation unless the alternative fits at a larger scale.
  const preferred = width > height ? layouts[1] : layouts[0],
    alternative = width > height ? layouts[0] : layouts[1];
  const layout =
    alternative.scale > preferred.scale + 1e-9 ? alternative : preferred;
  if (!(layout.scale > 0))
    throw new Error("PDF labels exceed available page size");
  const page = pdf.addPage([layout.w, layout.h]);
  const tx =
    (layout.w - width * layout.scale) / 2 - extents.minX * layout.scale;
  const ty =
    (layout.h - height * layout.scale) / 2 - extents.minY * layout.scale;
  if (![tx, ty, layout.scale].every(Number.isFinite))
    throw new Error("Non-finite export coordinate");
  const screen = (p: XY): XY => ({
    x: p.x * layout.scale + tx,
    y: p.y * layout.scale + ty,
  });
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(layout.scale, 0, 0, layout.scale, tx, ty),
  );
  for (const e of geometry) {
    if (e.kind === "point")
      page.drawCircle({
        x: e.points[0].x,
        y: e.points[0].y,
        size: 0.3,
        color: e.construction ? rgb(0.5, 0.53, 0.56) : ink,
      });
    else strokePath(page, entityPath(e), layout.scale, !!e.construction);
  }
  for (const line of texts) drawTextLine(page, font, line);
  for (const d of labels) {
    for (const [a, b] of d.lines)
      if (dist(a, b) > 1e-9)
        strokePath(page, linePath(a, b), layout.scale, false, true);
    if (d.arc) strokePath(page, entityPath(d.arc), layout.scale, false, true);
  }
  page.pushOperators(popGraphicsState());
  for (const d of labels) {
    const a = screen(d.a),
      b = screen(d.b),
      u = direction(a, b);
    const tick = { x: (u.x - u.y) * 2, y: (u.y + u.x) * 2 };
    for (const p of [a, b])
      page.drawLine({
        start: shift(p, tick, -1),
        end: shift(p, tick, 1),
        thickness: 0.45,
        color: dimensionInk,
      });
    const p = screen(d.label),
      textWidth = font.widthOfTextAtSize(d.text, LABEL_SIZE);
    page.drawRectangle({
      x: p.x - textWidth / 2 - 2,
      y: p.y - 5,
      width: textWidth + 4,
      height: 12,
      color: rgb(1, 1, 1),
    });
    page.drawText(d.text, {
      x: p.x - textWidth / 2,
      y: p.y - 3,
      size: LABEL_SIZE,
      font,
      color: dimensionInk,
      rotate: degrees(0),
    });
  }
  return pdf.save();
}
