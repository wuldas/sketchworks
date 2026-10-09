import Drawing from "dxf-writer";
import type { Document, Entity, XY } from "./model";
import { bounds, sampleEntity, splineBezierSegments } from "./geometry";

export interface ExportOptions {
  allVisible?: boolean;
  construction?: boolean;
}
// The package implements these methods but omits them from its bundled types.
interface NativeDrawing extends Drawing {
  drawEllipse(
    x: number,
    y: number,
    majorX: number,
    majorY: number,
    ratio: number,
    start?: number,
    end?: number,
  ): Drawing;
  drawSpline(
    points: [number, number][],
    degree?: number,
    knots?: number[] | null,
    weights?: number[] | null,
    fitPoints?: [number, number][],
  ): Drawing;
}
const radians = (a: number) => (a * Math.PI) / 180;
const degrees = (a: number) => (a * 180) / Math.PI;
const angle = (c: XY, p: XY) => Math.atan2(p.y - c.y, p.x - c.x);
const tuple = (p: XY): [number, number] => [p.x, p.y];
const escapeXml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const number = (n: number) => {
  if (!Number.isFinite(n)) throw new Error("Non-finite export coordinate");
  return String(Number(n.toFixed(9)));
};
function sketches(doc: Document, options: ExportOptions) {
  const visible = doc.sketches.filter((s) => s.visible);
  return options.allVisible === false ? visible.slice(0, 1) : visible;
}
function entities(doc: Document, options: ExportOptions) {
  return sketches(doc, options).flatMap((s) =>
    s.entities.filter((e) => options.construction || !e.construction),
  );
}
function ellipse(e: Entity) {
  const [c, p] = e.points;
  const dx = p.x - c.x,
    dy = p.y - c.y;
  const a = Math.hypot(dx, dy),
    b = e.ry ?? a / 2;
  if (!(a > 0 && b > 0)) throw new Error("Invalid ellipse axes");
  return {
    c,
    a,
    b,
    rotation: angle(c, p),
    vector: b > a ? { x: (-dy * b) / a, y: (dx * b) / a } : { x: dx, y: dy },
    ratio: Math.min(a, b) / Math.max(a, b),
  };
}
function validate(e: Entity) {
  if (
    !e.points.length ||
    e.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    throw new Error("Invalid export geometry");
  if (
    [e.radius, e.ry, e.fontSize, e.weight, e.rotation].some(
      (n) => n !== undefined && !Number.isFinite(n),
    )
  )
    throw new Error("Invalid export parameter");
}

export function exportDxf(doc: Document, options: ExportOptions = {}): string {
  const drawing = new Drawing() as NativeDrawing;
  drawing.setUnits("Millimeters");
  for (const sketch of sketches(doc, options)) {
    // IDs avoid invalid or duplicate user-supplied layer names.
    const layer = `sketch_${sketch.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    drawing.addLayer(layer, 7, "CONTINUOUS");
    const constructionLayer = `${layer}_construction`;
    if (options.construction && sketch.entities.some((e) => e.construction))
      drawing.addLayer(constructionLayer, 8, "DASHED");
    for (const e of sketch.entities) {
      if (e.construction && !options.construction) continue;
      drawing.setActiveLayer(e.construction ? constructionLayer : layer);
      validate(e);
      const [p, q, r] = e.points;
      switch (e.kind) {
        case "line":
          drawing.drawLine(p.x, p.y, q.x, q.y);
          break;
        case "circle":
          drawing.drawCircle(p.x, p.y, e.radius ?? 1);
          break;
        case "arc": {
          let start = degrees(angle(p, q)),
            end = degrees(angle(p, r));
          if (e.ccw === false) [start, end] = [end, start];
          drawing.drawArc(
            p.x,
            p.y,
            Math.hypot(q.x - p.x, q.y - p.y),
            (start + 360) % 360,
            (end + 360) % 360,
          );
          break;
        }
        case "ellipse": {
          const a = ellipse(e);
          drawing.drawEllipse(a.c.x, a.c.y, a.vector.x, a.vector.y, a.ratio);
          break;
        }
        case "bezier":
          drawing.drawSpline(
            e.points.slice(0, 4).map(tuple),
            3,
            [0, 0, 0, 0, 1, 1, 1, 1],
          );
          break;
        case "spline": {
          for (const segment of splineBezierSegments(e)) {
            if (segment.length === 4)
              drawing.drawSpline(
                segment.map(tuple),
                3,
                [0, 0, 0, 0, 1, 1, 1, 1],
              );
            else if (segment.length >= 2)
              drawing.drawPolyline(segment.map(tuple));
          }
          break;
        }
        case "conic":
          drawing.drawSpline(
            e.points.slice(0, 3).map(tuple),
            2,
            [0, 0, 0, 1, 1, 1],
            [1, e.weight ?? 1, 1],
          );
          break;
        case "point":
          drawing.drawPoint(p.x, p.y);
          break;
        case "text": {
          const height = e.fontSize ?? 6,
            rotation = e.rotation ?? 0;
          (e.text ?? "").split(/\r?\n/).forEach((line, i) => {
            const offset = i * height * 1.25,
              a = radians(rotation);
            drawing.drawText(
              p.x + Math.sin(a) * offset,
              p.y - Math.cos(a) * offset,
              height,
              rotation,
              line.replace(/[\r\u0000]/g, ""),
            );
          });
          break;
        }
      }
    }
  }
  return drawing.toDxfString();
}

function svgEntity(e: Entity): string {
  validate(e);
  const [p, q, r] = e.points;
  const xy = (v: XY) => `${number(v.x)} ${number(v.y)}`;
  const path = (d: string) => `<path d="${d}"/>`;
  switch (e.kind) {
    case "line":
      return `<line x1="${number(p.x)}" y1="${number(p.y)}" x2="${number(q.x)}" y2="${number(q.y)}"/>`;
    case "circle":
      return `<circle cx="${number(p.x)}" cy="${number(p.y)}" r="${number(e.radius ?? 1)}"/>`;
    case "ellipse": {
      const a = ellipse(e);
      return `<ellipse cx="${number(p.x)}" cy="${number(p.y)}" rx="${number(a.a)}" ry="${number(a.b)}" transform="rotate(${number(degrees(a.rotation))} ${xy(p)})"/>`;
    }
    case "arc": {
      const radius = Math.hypot(q.x - p.x, q.y - p.y),
        ccw = e.ccw !== false;
      const tau = 2 * Math.PI;
      const sweep =
        (((ccw ? angle(p, r) - angle(p, q) : angle(p, q) - angle(p, r)) % tau) +
          tau) %
        tau;
      return path(
        `M ${xy(q)} A ${number(radius)} ${number(radius)} 0 ${sweep > Math.PI ? 1 : 0} ${ccw ? 1 : 0} ${xy(r)}`,
      );
    }
    case "bezier":
      return path(`M ${xy(p)} C ${xy(q)} ${xy(r)} ${xy(e.points[3])}`);
    case "spline":
      return splineBezierSegments(e)
        .map((s) =>
          s.length === 4
            ? path(`M ${xy(s[0])} C ${xy(s[1])} ${xy(s[2])} ${xy(s[3])}`)
            : path(s.map((v, i) => `${i ? "L" : "M"} ${xy(v)}`).join(" ")),
        )
        .join("\n");
    case "conic":
      return path(
        sampleEntity(e, 0.001)
          .map((v, i) => `${i ? "L" : "M"} ${xy(v)}`)
          .join(" "),
      );
    case "point":
      return `<circle cx="${number(p.x)}" cy="${number(p.y)}" r="0.3" fill="currentColor"/>`;
    case "text": {
      const lines = (e.text ?? "").split(/\r?\n/);
      const size = e.fontSize ?? 6;
      return `<text transform="translate(${xy(p)}) rotate(${number(e.rotation ?? 0)}) scale(1 -1)" font-size="${number(size)}" font-family="sans-serif" fill="currentColor" stroke="none">${lines.map((s, i) => `<tspan x="0" dy="${i ? number(size * 1.25) : 0}">${escapeXml(s)}</tspan>`).join("")}</text>`;
    }
  }
}
export function exportSvg(doc: Document, options: ExportOptions = {}): string {
  const selected = entities(doc, options);
  const b = selected.length
    ? bounds(selected)
    : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const margin = 2;
  const width = Math.max(1, b.maxX - b.minX) + 2 * margin,
    height = Math.max(1, b.maxY - b.minY) + 2 * margin;
  const unit = "mm";
  const regular = selected
    .filter((e) => !e.construction)
    .map(svgEntity)
    .join("\n");
  const construction = selected
    .filter((e) => e.construction)
    .map(svgEntity)
    .join("\n");
  const groups = `<g id="geometry">${regular}</g>${construction ? `<g id="construction" stroke-dasharray="2 1">${construction}</g>` : ""}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}${unit}" height="${number(height)}${unit}" viewBox="${number(b.minX - margin)} ${number(-b.maxY - margin)} ${number(width)} ${number(height)}"><title>${escapeXml(doc.name)}</title><g transform="scale(1 -1)" fill="none" stroke="currentColor" stroke-width="0.25" stroke-linecap="round" stroke-linejoin="round">${groups}</g></svg>`;
}
export function exportJson(doc: Document): string {
  return JSON.stringify(doc, null, 2);
}
export function download(
  name: string,
  contents: string | Uint8Array,
  mime: string,
): void {
  const data =
    typeof contents === "string" ? contents : new Uint8Array(contents);
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Keep the object URL alive until the browser has begun the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
