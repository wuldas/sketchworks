import { circularDimensionEndpoints } from "./circularDimension";
import RBush from "rbush";
import paper from "paper";
import {
  type Constraint,
  type Entity,
  type Point,
  type Selection,
  type Sketch,
  type XY,
} from "./model";
import {
  angleDimensionFrame,
  selectAngleSector,
  arcInfo,
  bounds as geometryBounds,
  dist,
  entityPath,
  intersections,
  pointLineDistance,
  paperPath,
  projection,
  splineBezierSegments,
} from "./geometry";
import {
  defaultSnapOptions,
  entitySnapPoints,
  isSnapEnabled,
  pathMidpoint,
  tangentPoints,
  snapPriority,
  snapRadius,
  type SnapKind,
  type SnapOptions,
  type SnapBinding,
} from "./snapping";
import { dimensionLabelPosition } from "./dimensionLabel";

export type CanvasView = { center: XY; scale: number };
export type CanvasSnap = {
  point: XY;
  ref?: string;
  binding?: SnapBinding;
  kind: SnapKind;
};
export type CanvasDimensionPreview = Pick<
  Constraint,
  "kind" | "refs" | "value" | "labelPosition" | "angleSector"
> & { fixed: boolean; constraintId?: string };
export interface CanvasFrame {
  width: number;
  height: number;
  dpr: number;
  view: CanvasView;
  selection: Selection[];
  grid: boolean;
  snapOptions?: SnapOptions;
  snapFrom?: XY;
  unit: "mm" | "in";
  drafts: XY[];
  preview: Entity[];
  operationPreview?: Entity[] | null;
  cursor: XY | null;
  snapPoint: CanvasSnap | null;
  marquee: { a: XY; b: XY } | null;
  dimensionSelection?: string | null;
  hoveredEntityId?: string | null;
  dimensionPreview?: CanvasDimensionPreview | null;
}
export interface CanvasHandle extends Selection {
  pointId: string;
  x: number;
  y: number;
  r: number;
  style: "center" | "endpoint" | "selected";
  selected: boolean;
}
export interface CanvasDimension {
  id: string;
  sketchId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: XY;
  rect: { x: number; y: number; width: number; height: number };
}
export interface CanvasMetadata {
  renderer: "canvas2d";
  width: number;
  height: number;
  dpr: number;
  origin: XY;
  scale: number;
  spacing: number;
  gridStep: number;
  gridVisible: boolean;
  hoveredEntityId: string | null;
  operationPreview: {
    entityCount: number;
    visibleEntities: number;
    cachedPaths: number;
    revision: number;
  } | null;
  snapOptions: SnapOptions;
  dimensions: {
    id: string;
    text: string;
    x: number;
    y: number;
    bounds: CanvasBounds;
    selected: boolean;
  }[];
  dimensionPreview:
    | (CanvasDimensionPreview & {
        text: string;
        x: number;
        y: number;
        bounds: CanvasBounds;
      })
    | null;
  handles: {
    entityId: string;
    pointId: string;
    x: number;
    y: number;
    radius: number;
  }[];
  snap: { kind: CanvasSnap["kind"]; ref?: string; x: number; y: number } | null;
  stats: {
    sceneEntities: number;
    visibleEntities: number;
    cachedPaths: number;
    compiledPaths: number;
    baseDraws: number;
    frames: number;
    renderMs: number;
    hitCandidates: number;
  };
}
export type CanvasBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
type Prepared = CanvasBounds & {
  entity: Entity;
  sketchId: string;
  order: number;
  signature: string;
  path?: Path2D;
  selectionBounds?: CanvasBounds;
  selectionMeasured?: boolean;
  midpoint?: XY | null;
};
type SnapItem = CanvasBounds &
  CanvasSnap & {
    entityId: string;
    sketchId: string;
    order: number;
    pointIds: string[];
  };
type DimensionPaint = CanvasDimension & {
  a?: XY;
  b?: XY;
  da?: XY;
  db?: XY;
  leader?: boolean;
  selected?: boolean;
  arc?: { center: XY; start: number; sweep: number; radius: number };
};

export const niceStep = (v: number) => {
  const power = 10 ** Math.floor(Math.log10(Math.max(v, 1e-10))),
    m = v / power;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power;
};
export const gridStepForScale = (scale: number) => niceStep(22 / scale);
export const worldToScreen = (
  p: XY,
  frame: Pick<CanvasFrame, "width" | "height" | "view">,
): XY => ({
  x: frame.width / 2 + (p.x - frame.view.center.x) * frame.view.scale,
  y: frame.height / 2 - (p.y - frame.view.center.y) * frame.view.scale,
});
export const screenToWorld = (
  p: XY,
  frame: Pick<CanvasFrame, "width" | "height" | "view">,
): XY => ({
  x: frame.view.center.x + (p.x - frame.width / 2) / frame.view.scale,
  y: frame.view.center.y - (p.y - frame.height / 2) / frame.view.scale,
});
const coordinateBounds = (points: XY[]): CanvasBounds => {
  const b = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const p of points) {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
};
export function canvasEntityBounds(e: Entity): CanvasBounds {
  const c = e.points[0];
  if (e.kind === "circle" || e.kind === "arc") {
    const r = e.kind === "arc" ? arcInfo(e).r : (e.radius ?? 1);
    return { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r };
  }
  if (e.kind === "ellipse") {
    const a = e.points[1],
      dx = a.x - c.x,
      dy = a.y - c.y,
      r = Math.hypot(dx, dy),
      ry = e.ry ?? r / 2;
    const rx = Math.hypot(dx, r ? (ry * dy) / r : 0),
      extentY = Math.hypot(dy, r ? (ry * dx) / r : 0);
    return {
      minX: c.x - rx,
      minY: c.y - extentY,
      maxX: c.x + rx,
      maxY: c.y + extentY,
    };
  }
  if (e.kind === "text") {
    const h = e.fontSize ?? 6,
      w = Math.max(1, [...(e.text ?? "")].length) * h * 1.4,
      a = ((e.rotation ?? 0) * Math.PI) / 180;
    return coordinateBounds(
      [0, w].flatMap((x) =>
        [-h * 0.4, h * 1.3].map((y) => ({
          x: c.x + x * Math.cos(a) - y * Math.sin(a),
          y: c.y + x * Math.sin(a) + y * Math.cos(a),
        })),
      ),
    );
  }
  if (e.kind === "spline")
    return coordinateBounds(splineBezierSegments(e).flat());
  return coordinateBounds(e.points);
}
const signature = (e: Entity) =>
  JSON.stringify([
    e.kind,
    e.points.map((p) => [p.x, p.y]),
    e.radius,
    e.ry,
    e.ccw,
    e.weight,
    e.text,
    e.fontSize,
    e.rotation,
  ]);
const inBox = (p: XY, b: CanvasBounds, t = 0) =>
  p.x >= b.minX - t &&
  p.x <= b.maxX + t &&
  p.y >= b.minY - t &&
  p.y <= b.maxY + t;
const circle = (
  ctx: CanvasRenderingContext2D,
  p: XY,
  r: number,
  fill?: string,
  stroke?: string,
) => {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
};
const segments = (ctx: CanvasRenderingContext2D, lines: XY[][]) => {
  ctx.beginPath();
  for (const ps of lines) {
    if (!ps.length) continue;
    ctx.moveTo(ps[0].x, ps[0].y);
    for (const p of ps.slice(1)) ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
};
function profileCoordinates(entities: Entity[]): XY[][] {
  const lines = entities.filter((e) => e.kind === "line" && !e.construction),
    adjacency = new Map<string, Entity[]>(),
    cursors = new Map<string, number>(),
    used = new Set<string>(),
    polygons: XY[][] = [];
  const key = (p: XY) => `${p.x},${p.y}`;
  for (const line of lines)
    for (const p of line.points) {
      const k = key(p),
        list = adjacency.get(k);
      if (list) list.push(line);
      else adjacency.set(k, [line]);
    }
  const nextAt = (k: string) => {
    const list = adjacency.get(k) ?? [];
    let i = cursors.get(k) ?? 0;
    while (i < list.length && used.has(list[i].id)) i++;
    cursors.set(k, i + 1);
    return list[i];
  };
  for (const first of lines) {
    if (used.has(first.id)) continue;
    const points = [first.points[0], first.points[1]],
      start = key(points[0]);
    used.add(first.id);
    let end = key(points[1]);
    while (end !== start) {
      const next = nextAt(end);
      if (!next) break;
      used.add(next.id);
      const p = key(next.points[0]) === end ? next.points[1] : next.points[0];
      points.push(p);
      end = key(p);
    }
    if (end === start && points.length >= 4) polygons.push(points);
  }
  return polygons;
}

export class CanvasRenderer {
  private prepared = new Map<string, Prepared>();
  private scene = new RBush<Prepared>();
  private snaps = new RBush<SnapItem>();
  private intersectionCache = new Map<string, XY[]>();
  private lastSketches: Sketch[] | null = null;
  private sceneRevision = 0;
  private base: HTMLCanvasElement | null = null;
  private hitContext: CanvasRenderingContext2D | null = null;
  private baseKey = "";
  private frame: CanvasFrame | null = null;
  private profiles: Path2D[] | null = null;
  private profileCoordinates: XY[][] = [];
  private handles: CanvasHandle[] = [];
  private metadataHandles: CanvasMetadata["handles"] = [];
  private metadataDimensions: CanvasMetadata["dimensions"] = [];
  private handleSceneRevision = -1;
  private handleActiveId = "";
  private labels: DimensionPaint[] = [];
  private previewLabel: DimensionPaint | null = null;
  private hoveredEntityId: string | null = null;
  private operationPreviewEntities: Entity[] | null = null;
  private operationPreviewIndex = new RBush<Prepared>();
  private operationPreviewVisible = 0;
  private operationPreviewCached = 0;
  private operationPreviewRevision = 0;
  private lastDrawn = 0;
  private lastCulled = 0;
  private sketches: Sketch[] = [];
  private activeId = "";
  private entityRefs = new Map<string, Entity>();
  private pointRefs = new Map<string, Point>();
  private handleIndex = new RBush<
    CanvasBounds & CanvasHandle & { order: number }
  >();
  private cachedPaths = 0;
  private compiledPaths = 0;
  private baseDraws = 0;
  private frames = 0;
  private renderMs = 0;
  private hitCandidates = 0;

  sync(sketches: Sketch[], activeId: string): void {
    this.activeId = activeId;
    if (sketches === this.lastSketches) return;
    this.sketches = sketches;
    this.intersectionCache.clear();
    const live = new Set<string>(),
      items: Prepared[] = [],
      snaps: SnapItem[] = [];
    this.entityRefs.clear();
    this.pointRefs.clear();
    let order = 0;
    for (const sk of sketches) {
      if (!sk.visible) continue;
      for (const e of sk.entities) {
        live.add(e.id);
        const fingerprint = signature(e),
          old = this.prepared.get(e.id);
        let item: Prepared;
        if (old?.signature === fingerprint) {
          item = old;
          item.entity = e;
          item.sketchId = sk.id;
          item.order = order++;
        } else {
          if (old?.path) this.cachedPaths--;
          item = {
            ...canvasEntityBounds(e),
            entity: e,
            sketchId: sk.id,
            order: order++,
            signature: fingerprint,
          };
          this.prepared.set(e.id, item);
        }
        items.push(item);
        this.entityRefs.set(e.id, e);
        for (const p of e.points) {
          this.entityRefs.set(p.id, e);
          this.pointRefs.set(p.id, p);
        }
        for (const entry of entitySnapPoints(e)) {
          const p = entry.point;
          snaps.push({
            minX: p.x,
            maxX: p.x,
            minY: p.y,
            maxY: p.y,
            point: p,
            ref: entry.ref,
            pointIds: [p.id],
            kind: entry.kind,
            entityId: e.id,
            sketchId: sk.id,
            order: snaps.length,
          });
        }
        if (!e.sourceId && item.midpoint === undefined)
          item.midpoint = pathMidpoint(e) ?? null;
        if (!e.sourceId && item.midpoint) {
          const p = item.midpoint;
          snaps.push({
            minX: p.x,
            maxX: p.x,
            minY: p.y,
            maxY: p.y,
            point: p,
            kind: "midpoint",
            binding: { kind: "midpoint", refs: [e.id] },
            pointIds: e.points.map((point) => point.id),
            entityId: e.id,
            sketchId: sk.id,
            order: snaps.length,
          });
        }
      }
    }
    for (const [id, item] of this.prepared)
      if (!live.has(id)) {
        if (item.path) this.cachedPaths--;
        this.prepared.delete(id);
      }
    this.scene.clear().load(items);
    this.snaps.clear().load(snaps);
    // Construction styling can change without changing a native path fingerprint.
    this.profileCoordinates = sketches
      .filter((s) => s.visible)
      .flatMap((s) => profileCoordinates(s.entities));
    this.profiles = null;
    this.sceneRevision++;
    this.lastSketches = sketches;
  }
  private path(item: Prepared): Path2D {
    if (!item.path) {
      item.path = new Path2D(entityPath(item.entity));
      this.cachedPaths++;
      this.compiledPaths++;
    }
    return item.path;
  }
  private setWorld(ctx: CanvasRenderingContext2D, frame: CanvasFrame) {
    const sx = ctx.canvas.width / frame.width,
      sy = ctx.canvas.height / frame.height,
      s = frame.view.scale;
    const origin = worldToScreen({ x: 0, y: 0 }, frame);
    ctx.setTransform(sx * s, 0, 0, -sy * s, origin.x * sx, origin.y * sy);
  }
  private setScreen(ctx: CanvasRenderingContext2D, frame: CanvasFrame) {
    ctx.setTransform(
      ctx.canvas.width / frame.width,
      0,
      0,
      ctx.canvas.height / frame.height,
      0,
      0,
    );
  }

  draw(canvas: HTMLCanvasElement, frame: CanvasFrame): void {
    const start = performance.now();
    this.frame = frame;
    const w = Math.max(1, Math.round(frame.width * frame.dpr)),
      h = Math.max(1, Math.round(frame.height * frame.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (!this.base) this.base = canvas.ownerDocument.createElement("canvas");
    if (!this.hitContext)
      this.hitContext = canvas.ownerDocument
        .createElement("canvas")
        .getContext("2d");
    const key = JSON.stringify([
      this.sceneRevision,
      this.activeId,
      frame.width,
      frame.height,
      frame.dpr,
      frame.view,
      frame.grid,
      frame.unit,
      frame.selection,
      frame.dimensionSelection,
      frame.dimensionPreview?.constraintId,
    ]);
    const baseRebuilt = key !== this.baseKey;
    if (baseRebuilt) {
      if (this.base.width !== w || this.base.height !== h) {
        this.base.width = w;
        this.base.height = h;
      }
      const base = this.base.getContext("2d");
      if (!base) throw new Error("Canvas 2D unavailable");
      this.paintBase(base, frame);
      this.baseDraws++;
      this.baseKey = key;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.base, 0, 0);
    this.setScreen(ctx, frame);
    this.paintOverlay(ctx, frame);
    this.frames++;
    this.renderMs = performance.now() - start;
  }
  metadata(frame: CanvasFrame): CanvasMetadata {
    return {
      renderer: "canvas2d",
      width: frame.width,
      height: frame.height,
      dpr: frame.dpr,
      scale: frame.view.scale,
      origin: worldToScreen({ x: 0, y: 0 }, frame),
      spacing: gridStepForScale(frame.view.scale) * frame.view.scale,
      gridStep: gridStepForScale(frame.view.scale),
      gridVisible: frame.grid,
      hoveredEntityId: this.hoveredEntityId,
      operationPreview: this.operationPreviewEntities
        ? {
            entityCount: this.operationPreviewEntities.length,
            visibleEntities: this.operationPreviewVisible,
            cachedPaths: this.operationPreviewCached,
            revision: this.operationPreviewRevision,
          }
        : null,
      snapOptions: frame.snapOptions ?? {
        ...defaultSnapOptions,
        grid: frame.grid,
      },
      handles: this.metadataHandles,
      dimensions: this.metadataDimensions,
      dimensionPreview:
        this.previewLabel && frame.dimensionPreview
          ? {
              ...frame.dimensionPreview,
              text: this.previewLabel.text,
              x: this.previewLabel.x,
              y: this.previewLabel.y,
              bounds: {
                minX: this.previewLabel.rect.x,
                minY: this.previewLabel.rect.y,
                maxX: this.previewLabel.rect.x + this.previewLabel.rect.width,
                maxY: this.previewLabel.rect.y + this.previewLabel.rect.height,
              },
            }
          : null,
      snap: frame.snapPoint
        ? {
            ...worldToScreen(frame.snapPoint.point, frame),
            kind: frame.snapPoint.kind,
            ref: frame.snapPoint.ref,
          }
        : null,
      stats: {
        sceneEntities: this.prepared.size,
        visibleEntities: this.lastDrawn,
        cachedPaths: this.cachedPaths,
        compiledPaths: this.compiledPaths,
        baseDraws: this.baseDraws,
        frames: this.frames,
        renderMs: this.renderMs,
        hitCandidates: this.hitCandidates,
      },
    };
  }
  private paintBase(ctx: CanvasRenderingContext2D, frame: CanvasFrame) {
    this.setScreen(ctx, frame);
    ctx.fillStyle = "#fafcfb";
    ctx.fillRect(0, 0, frame.width, frame.height);
    const origin = worldToScreen({ x: 0, y: 0 }, frame),
      spacing = gridStepForScale(frame.view.scale) * frame.view.scale;
    if (frame.grid) {
      for (const major of [false, true]) {
        ctx.beginPath();
        for (const [extent, o, vertical] of [
          [frame.width, origin.x, true],
          [frame.height, origin.y, false],
        ] as const) {
          for (
            let k = Math.ceil(-o / spacing);
            o + k * spacing <= extent;
            k++
          ) {
            if ((k % 5 === 0) !== major) continue;
            const p = o + k * spacing;
            if (vertical) {
              ctx.moveTo(p, 0);
              ctx.lineTo(p, frame.height);
            } else {
              ctx.moveTo(0, p);
              ctx.lineTo(frame.width, p);
            }
          }
        }
        ctx.strokeStyle = major ? "#dce5e1" : "#e9eeec";
        ctx.lineWidth = major ? 1 : 0.7;
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#dc807c";
    segments(ctx, [
      [
        { x: 0, y: origin.y },
        { x: frame.width, y: origin.y },
      ],
    ]);
    ctx.strokeStyle = "#82ab8a";
    segments(ctx, [
      [
        { x: origin.x, y: 0 },
        { x: origin.x, y: frame.height },
      ],
    ]);
    circle(ctx, origin, 3, "#fafcfb", "#81988c");
    const margin = 10 / frame.view.scale,
      tl = screenToWorld({ x: 0, y: 0 }, frame),
      br = screenToWorld({ x: frame.width, y: frame.height }, frame);
    const visible = this.scene
        .search({
          minX: tl.x - margin,
          maxX: br.x + margin,
          minY: br.y - margin,
          maxY: tl.y + margin,
        })
        .sort((a, b) => a.order - b.order),
      selected = new Map(frame.selection.map((s) => [s.entityId, s])),
      selectedPointIds = new Set(
        frame.selection.flatMap((s) => (s.pointId ? [s.pointId] : [])),
      );
    this.lastDrawn = visible.length;
    this.lastCulled = this.prepared.size - visible.length;
    this.setWorld(ctx, frame);
    ctx.fillStyle = "rgba(79,151,112,0.065)";
    for (const path of this.profiles ??
      (this.profiles = this.profileCoordinates.map((ps) => {
        const p = new Path2D();
        p.moveTo(ps[0].x, ps[0].y);
        for (const v of ps.slice(1)) p.lineTo(v.x, v.y);
        p.closePath();
        return p;
      })))
      ctx.fill(path);
    for (const item of visible) {
      this.paintEntity(
        ctx,
        item.entity,
        frame,
        this.entityColor(item, selected.has(item.entity.id)),
        item,
      );
    }
    this.setScreen(ctx, frame);
    this.labels = this.layoutDimensions(ctx, frame);
    for (const label of this.labels) this.paintDimension(ctx, label);
    this.handles = [];
    for (const item of visible) {
      if (item.sketchId !== this.activeId) continue;
      const e = item.entity,
        chosen = selected.has(e.id);
      let points: Point[];
      if (chosen) points = e.points;
      else if (e.kind === "text") points = [];
      else if (e.kind === "circle" || e.kind === "ellipse")
        points = [e.points[0]];
      else if (e.kind === "bezier" || e.kind === "conic" || e.kind === "spline")
        points = [e.points[0], e.points.at(-1)!];
      else points = e.points;
      if (chosen && ["bezier", "conic", "spline"].includes(e.kind)) {
        ctx.strokeStyle = "#c5a464";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        segments(ctx, [e.points.map((p) => worldToScreen(p, frame))]);
        ctx.setLineDash([]);
      }
      for (const p of points) {
        const screen = worldToScreen(p, frame);
        if (
          screen.x < -8 ||
          screen.y < -8 ||
          screen.x > frame.width + 8 ||
          screen.y > frame.height + 8
        )
          continue;
        const isSelected = selectedPointIds.has(p.id),
          style = chosen
            ? "selected"
            : ["circle", "ellipse", "arc"].includes(e.kind) && p === e.points[0]
              ? "center"
              : "endpoint";
        this.handles.push({
          entityId: e.id,
          pointId: p.id,
          ...screen,
          r: 7,
          style,
          selected: isSelected,
        });
        ctx.lineWidth = style === "selected" ? 1.5 : 1;
        if (style === "center") {
          ctx.strokeStyle = "#75978b";
          segments(ctx, [
            [
              { x: screen.x - 4, y: screen.y },
              { x: screen.x + 4, y: screen.y },
            ],
            [
              { x: screen.x, y: screen.y - 4 },
              { x: screen.x, y: screen.y + 4 },
            ],
          ]);
        } else
          circle(
            ctx,
            screen,
            style === "selected" ? (isSelected ? 5 : 4) : 2.3,
            isSelected ? "#d29423" : style === "selected" ? "#fff" : "#fafcfb",
            style === "selected" ? "#c08a29" : "#4a9278",
          );
      }
    }
    this.handleIndex.clear().load(
      this.handles.map((p, order) => ({
        ...p,
        order,
        minX: p.x - p.r,
        maxX: p.x + p.r,
        minY: p.y - p.r,
        maxY: p.y + p.r,
      })),
    );
    this.handleSceneRevision = this.sceneRevision;
    this.handleActiveId = this.activeId;
    this.metadataHandles = this.handles.map((p) => ({
      entityId: p.entityId,
      pointId: p.pointId,
      x: p.x,
      y: p.y,
      radius: p.r,
    }));
    this.metadataDimensions = this.labels.map((d) => ({
      id: d.id,
      text: d.text,
      x: d.x,
      y: d.y,
      selected: d.selected === true,
      bounds: {
        minX: d.rect.x,
        minY: d.rect.y,
        maxX: d.rect.x + d.rect.width,
        maxY: d.rect.y + d.rect.height,
      },
    }));
    this.paintBadges(ctx, frame);
  }
  private entityColor(item: Prepared, selected: boolean): string {
    return selected
      ? "#d29423"
      : item.sketchId !== this.activeId
        ? "#a6b6ae"
        : item.entity.construction
          ? "#729baf"
          : "#267f67";
  }
  private paintHover(ctx: CanvasRenderingContext2D, frame: CanvasFrame) {
    this.hoveredEntityId = null;
    const item = frame.hoveredEntityId
      ? this.prepared.get(frame.hoveredEntityId)
      : undefined;
    if (!item || item.sketchId !== this.activeId) return;
    const color = this.entityColor(
      item,
      frame.selection.some((s) => s.entityId === item.entity.id),
    );
    const darker =
      "#" +
      [1, 3, 5]
        .map((offset) =>
          Math.round(parseInt(color.slice(offset, offset + 2), 16) * 0.65)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    this.paintEntity(ctx, item.entity, frame, darker, item, false, true);
    this.hoveredEntityId = item.entity.id;
  }
  private paintEntity(
    ctx: CanvasRenderingContext2D,
    e: Entity,
    frame: CanvasFrame,
    color: string,
    item?: Prepared,
    preview = false,
    emphasized = false,
  ) {
    ctx.save();
    if (e.kind === "point") {
      this.setScreen(ctx, frame);
      ctx.lineWidth = 1;
      circle(
        ctx,
        worldToScreen(e.points[0], frame),
        emphasized ? 6 : preview ? 3 : 4,
        color,
        "#fff",
      );
    } else if (e.kind === "text") {
      this.setWorld(ctx, frame);
      ctx.translate(e.points[0].x, e.points[0].y);
      ctx.rotate(((e.rotation ?? 0) * Math.PI) / 180);
      ctx.scale(1, -1);
      ctx.font = `${emphasized ? "bold " : ""}${e.fontSize ?? 6}px Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = color;
      ctx.fillText(e.text ?? "", 0, 0);
    } else {
      this.setWorld(ctx, frame);
      ctx.lineWidth =
        (emphasized ? 3.4 : preview ? 1.5 : 1.8) / frame.view.scale;
      ctx.strokeStyle = color;
      ctx.setLineDash(
        (e.construction ? [8, 5] : preview ? [6, 4] : []).map(
          (v) => v / frame.view.scale,
        ),
      );
      ctx.stroke(item ? this.path(item) : new Path2D(entityPath(e)));
    }
    ctx.restore();
  }
  private layoutDimensions(
    ctx: CanvasRenderingContext2D,
    frame: CanvasFrame,
    preview?: CanvasDimensionPreview,
  ): DimensionPaint[] {
    const labels: DimensionPaint[] = [],
      screen = (p: XY) => worldToScreen(p, frame),
      format = (v: number) =>
        Number(
          (frame.unit === "in" ? v / 25.4 : v).toFixed(
            frame.unit === "in" ? 3 : 2,
          ),
        ).toString();
    ctx.font = "12px Arial, sans-serif";
    const resolveEntity = (_sk: Sketch, ref: string) =>
        this.entityRefs.get(ref),
      referencePoint = (_sk: Sketch, ref: string) =>
        this.pointRefs.get(ref) ?? this.entityRefs.get(ref)?.points[0];
    const labelReferences = {
      entity: (ref: string) => {
        const e = this.entityRefs.get(ref);
        return e?.id === ref ? e : undefined;
      },
      point: (ref: string) =>
        this.pointRefs.get(ref) ?? this.entityRefs.get(ref)?.points[0],
    };
    for (const sk of this.sketches) {
      if (!sk.visible) continue;
      const constraints: Pick<
        Constraint,
        | "id"
        | "kind"
        | "refs"
        | "value"
        | "labelPosition"
        | "labelOffset"
        | "angleSector"
      >[] = preview
        ? sk.id === this.activeId
          ? [{ id: "__dimension_preview__", ...preview }]
          : []
        : sk.constraints;
      for (const c of constraints) {
        if (!preview && c.id === frame.dimensionPreview?.constraintId) continue;
        if (
          ![
            "length",
            "lineDistance",
            "radius",
            "diameter",
            "distanceX",
            "distanceY",
            "angle",
          ].includes(c.kind)
        )
          continue;
        const e = this.entityRefs.get(c.refs[0]);
        if (!e) continue;
        const placement = preview
          ? c.labelPosition
          : dimensionLabelPosition(c, labelReferences);
        const placed = placement ? screen(placement) : undefined;
        let a: XY,
          b: XY,
          label: XY,
          da: XY,
          db: XY,
          arc: DimensionPaint["arc"],
          value = c.value ?? 0,
          text: string;
        if (c.kind === "angle" && e.points.length >= 2) {
          const other = c.refs[1] ? resolveEntity(sk, c.refs[1]) : undefined,
            sector =
              c.angleSector ??
              (preview && other?.kind === "line"
                ? selectAngleSector(e, other, c.labelPosition)
                : undefined),
            f = angleDimensionFrame(e, other, sector),
            center = screen(f.vertex),
            start = -f.start,
            sweep = -f.sweep,
            radius = placed ? Math.max(12, dist(center, placed) - 18) : 29;
          arc = { center, start, sweep, radius };
          a = center;
          b = center;
          da = {
            x: center.x + Math.cos(start) * radius,
            y: center.y + Math.sin(start) * radius,
          };
          db = {
            x: center.x + Math.cos(start + sweep) * radius,
            y: center.y + Math.sin(start + sweep) * radius,
          };
          label = {
            x: center.x + Math.cos(start + sweep / 2) * (radius + 18),
            y: center.y + Math.sin(start + sweep / 2) * (radius + 18),
          };
          text = `${Number((c.value ?? ((sector ? Math.abs(f.sweep) : f.sweep) * 180) / Math.PI).toFixed(1))}\u00b0`;
        } else {
          if (c.kind === "lineDistance") {
            const point = referencePoint(sk, c.refs[0]) ?? e.points[0],
              line = this.entityRefs.get(c.refs[1]);
            const foot =
              line?.kind === "line"
                ? projection(point, line.points[0], line.points[1], false).point
                : point;
            a = screen(point);
            b = screen(foot);
            const length = dist(a, b) || 1;
            label = {
              x: (a.x + b.x) / 2 + ((b.y - a.y) / length) * 30,
              y: (a.y + b.y) / 2 - ((b.x - a.x) / length) * 30,
            };
            if (c.value === undefined)
              value =
                line?.kind === "line"
                  ? pointLineDistance(point, line.points[0], line.points[1])
                  : dist(point, foot);
          } else if (c.kind === "radius" || c.kind === "diameter") {
            const center = e.points[0],
              r = e.kind === "arc" ? arcInfo(e).r : (e.radius ?? 1),
              endpoints = circularDimensionEndpoints(
                center,
                r,
                c.kind,
                placement,
              );
            a = screen(endpoints.a);
            b = screen(endpoints.b);
            label = placed ?? { x: b.x + 18, y: b.y - 15 };
            if (c.value === undefined)
              value = r * (c.kind === "diameter" ? 2 : 1);
          } else {
            const pa = referencePoint(sk, c.refs[0]) ?? e.points[0],
              pb =
                (c.refs[1] ? referencePoint(sk, c.refs[1]) : e.points[1]) ?? pa;
            a = screen(pa);
            b = screen(pb);
            const length = dist(a, b) || 1;
            label =
              c.kind === "distanceX"
                ? { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + 32 }
                : c.kind === "distanceY"
                  ? { x: Math.max(a.x, b.x) + 34, y: (a.y + b.y) / 2 }
                  : {
                      x: (a.x + b.x) / 2 + ((b.y - a.y) / length) * 30,
                      y: (a.y + b.y) / 2 - ((b.x - a.x) / length) * 30,
                    };
            if (c.value === undefined)
              value =
                c.kind === "distanceX"
                  ? pb.x - pa.x
                  : c.kind === "distanceY"
                    ? pb.y - pa.y
                    : dist(pa, pb);
          }
          da = a;
          db = b;
          if (c.kind === "length" || c.kind === "lineDistance") {
            const length = dist(a, b) || 1,
              normal = { x: (b.y - a.y) / length, y: -(b.x - a.x) / length },
              midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
              position = placed ?? label,
              rawOffset =
                (position.x - midpoint.x) * normal.x +
                (position.y - midpoint.y) * normal.y,
              offset =
                Math.abs(rawOffset) < 12
                  ? rawOffset < 0
                    ? -12
                    : 12
                  : rawOffset,
              dx = normal.x * offset,
              dy = normal.y * offset;
            da = { x: a.x + dx, y: a.y + dy };
            db = { x: b.x + dx, y: b.y + dy };
            label = { x: midpoint.x + dx, y: midpoint.y + dy };
          }
          if (c.kind === "distanceX") {
            if (placed) label = { x: (a.x + b.x) / 2, y: placed.y };
            da = { x: a.x, y: label.y };
            db = { x: b.x, y: label.y };
          }
          if (c.kind === "distanceY") {
            if (placed) label = { x: placed.x, y: (a.y + b.y) / 2 };
            da = { x: label.x, y: a.y };
            db = { x: label.x, y: b.y };
          }
          text = `${c.kind === "radius" ? "R" : c.kind === "diameter" ? "\u00d8" : ""}${format(value)}`;
        }
        const width = Math.max(32, ctx.measureText(text).width + 12),
          rect = { x: label.x - width / 2, y: label.y - 10, width, height: 20 };
        if (
          !preview &&
          (rect.x + width < 0 ||
            rect.x > frame.width ||
            rect.y + 20 < 0 ||
            rect.y > frame.height)
        )
          continue;
        labels.push({
          id: c.id,
          sketchId: sk.id,
          text,
          x: label.x,
          y: label.y,
          width,
          height: 20,
          label,
          rect,
          a,
          b,
          da,
          db,
          arc,
          leader: c.kind === "radius" || c.kind === "diameter",
          selected: c.id === frame.dimensionSelection,
        });
      }
    }
    return labels;
  }
  private paintDimension(
    ctx: CanvasRenderingContext2D,
    d: DimensionPaint,
    preview = false,
  ) {
    ctx.save();
    const color = preview ? "#499ca7" : d.selected ? "#c08a29" : "#659a86";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    if (d.arc) {
      const { center, start, sweep, radius } = d.arc;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, start, start + sweep, sweep < 0);
      ctx.stroke();
      ctx.setLineDash([3, 3]);
      segments(ctx, [
        [center, d.da!],
        [center, d.db!],
      ]);
      ctx.setLineDash([]);
    } else {
      segments(ctx, [
        [d.a!, d.da!],
        [d.b!, d.db!],
        [d.da!, d.db!],
      ]);
      circle(ctx, d.da!, 2, color);
      circle(ctx, d.db!, 2, color);
      if (d.leader) segments(ctx, [[d.b!, d.label]]);
    }
    ctx.globalAlpha = 0.96;
    ctx.fillStyle = d.selected ? "#fff7e6" : "#f8faf9";
    ctx.beginPath();
    ctx.roundRect(d.rect.x, d.rect.y, d.rect.width, 20, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = d.selected ? "#8a5f12" : "#397b65";
    ctx.font = "12px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(d.text, d.x, d.y + 4);
    ctx.restore();
  }
  private paintBadges(ctx: CanvasRenderingContext2D, frame: CanvasFrame) {
    ctx.save();
    ctx.lineWidth = 1.5;
    const x = 38,
      y = frame.height - 40;
    ctx.strokeStyle = "#cc6662";
    segments(ctx, [
      [
        { x, y },
        { x: x + 28, y },
      ],
      [
        { x: x + 24, y: y - 3 },
        { x: x + 28, y },
        { x: x + 24, y: y + 3 },
      ],
    ]);
    ctx.strokeStyle = "#648e6d";
    segments(ctx, [
      [
        { x, y },
        { x, y: y - 28 },
      ],
      [
        { x: x - 3, y: y - 24 },
        { x, y: y - 28 },
        { x: x + 3, y: y - 24 },
      ],
    ]);
    ctx.font = "11px Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#cc6662";
    ctx.fillText("X", x + 33, y + 4);
    ctx.fillStyle = "#648e6d";
    ctx.fillText("Y", x - 4, y - 34);
    const v = 90 / frame.view.scale,
      power = 10 ** Math.floor(Math.log10(Math.max(v, 1e-10))),
      m = v / power,
      length = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power,
      pixels = length * frame.view.scale,
      barX = Math.max(100, frame.width - pixels - 28),
      barY = frame.height - 27;
    ctx.strokeStyle = "#63736c";
    ctx.lineWidth = 1;
    segments(ctx, [
      [
        { x: barX, y: barY - 5 },
        { x: barX, y: barY },
        { x: barX + pixels, y: barY },
        { x: barX + pixels, y: barY - 5 },
      ],
    ]);
    ctx.textAlign = "center";
    ctx.fillStyle = "#63736c";
    ctx.fillText(
      `${Number((frame.unit === "in" ? length / 25.4 : length).toFixed(2))} ${frame.unit}`,
      barX + pixels / 2,
      barY - 8,
    );
    ctx.restore();
  }
  private paintOperationPreview(
    ctx: CanvasRenderingContext2D,
    frame: CanvasFrame,
  ) {
    const entities = frame.operationPreview ?? null;
    if (entities !== this.operationPreviewEntities) {
      this.operationPreviewRevision++;
      this.operationPreviewEntities = entities;
      this.operationPreviewIndex.clear();
      this.operationPreviewCached = 0;
      if (entities)
        this.operationPreviewIndex.load(
          entities.map((entity, order) => ({
            ...canvasEntityBounds(entity),
            entity,
            order,
            sketchId: this.activeId,
            signature: "operation-preview",
          })),
        );
    }
    this.operationPreviewVisible = 0;
    if (!entities) return;
    const a = screenToWorld({ x: 0, y: 0 }, frame);
    const b = screenToWorld({ x: frame.width, y: frame.height }, frame);
    const margin = 10 / frame.view.scale;
    const visible = this.operationPreviewIndex
      .search({
        minX: a.x - margin,
        maxX: b.x + margin,
        minY: b.y - margin,
        maxY: a.y + margin,
      })
      .sort((a, b) => a.order - b.order);
    this.operationPreviewVisible = visible.length;
    for (const item of visible) {
      if (!item.path && !["point", "text"].includes(item.entity.kind)) {
        item.path = new Path2D(entityPath(item.entity));
        this.operationPreviewCached++;
      }
      this.paintEntity(ctx, item.entity, frame, "#499ca7", item, true);
    }
  }
  private paintOverlay(ctx: CanvasRenderingContext2D, frame: CanvasFrame) {
    this.paintHover(ctx, frame);
    this.paintOperationPreview(ctx, frame);
    this.previewLabel = frame.dimensionPreview
      ? (this.layoutDimensions(ctx, frame, frame.dimensionPreview)[0] ?? null)
      : null;
    if (this.previewLabel) this.paintDimension(ctx, this.previewLabel, true);
    for (const e of frame.preview ?? [])
      this.paintEntity(ctx, e, frame, "#499ca7", undefined, true);
    if (frame.drafts?.length && !frame.preview?.length && frame.cursor) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#499ca7";
      ctx.setLineDash([5, 4]);
      segments(ctx, [
        [...frame.drafts, frame.cursor].map((p) => worldToScreen(p, frame)),
      ]);
      ctx.setLineDash([]);
    }
    for (const p of frame.drafts ?? [])
      circle(ctx, worldToScreen(p, frame), 3, "#499ca7");
    if (frame.snapPoint) {
      const p = worldToScreen(frame.snapPoint.point, frame);
      if (
        ["endpoint", "tangent", "intersection"].includes(frame.snapPoint.kind)
      ) {
        ctx.save();
        ctx.lineWidth = 1.5;
        circle(ctx, p, 6, "#fafcfb", "#238363");
        ctx.strokeStyle = "#238363";
        if (frame.snapPoint.kind === "intersection")
          segments(ctx, [
            [
              { x: p.x - 4, y: p.y - 4 },
              { x: p.x + 4, y: p.y + 4 },
            ],
            [
              { x: p.x - 4, y: p.y + 4 },
              { x: p.x + 4, y: p.y - 4 },
            ],
          ]);
        else {
          circle(ctx, p, 2, "#238363");
          if (frame.snapPoint.kind === "tangent")
            segments(ctx, [
              [
                { x: p.x - 8, y: p.y + 6 },
                { x: p.x + 8, y: p.y + 6 },
              ],
            ]);
        }
        const x = Math.max(4, Math.min(frame.width - 42, p.x + 10));
        const y = Math.max(19, Math.min(frame.height - 4, p.y - 9));
        ctx.fillStyle = "#fafcfb";
        ctx.fillRect(x - 3, y - 13, 36, 18);
        ctx.fillStyle = "#238363";
        ctx.font = "11px Arial, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(
          frame.snapPoint.kind === "endpoint"
            ? "端点"
            : frame.snapPoint.kind === "tangent"
              ? "切点"
              : "交点",
          x,
          y,
        );
        ctx.restore();
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#dd9829";
        ctx.beginPath();
        if (frame.snapPoint.kind === "midpoint") {
          ctx.moveTo(p.x, p.y - 6);
          ctx.lineTo(p.x + 6, p.y + 5);
          ctx.lineTo(p.x - 6, p.y + 5);
          ctx.closePath();
        } else ctx.rect(p.x - 5, p.y - 5, 10, 10);
        ctx.stroke();
      }
    }
    if (frame.marquee) {
      const { a, b } = frame.marquee,
        x = Math.min(a.x, b.x),
        y = Math.min(a.y, b.y),
        w = Math.abs(a.x - b.x),
        h = Math.abs(a.y - b.y);
      ctx.fillStyle = "rgba(43,135,105,.09)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#2b8769";
      ctx.lineWidth = 1;
      ctx.setLineDash(b.y < a.y ? [5, 3] : []);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }
  dimensionPreviewAnchor(
    preview: CanvasDimensionPreview,
    frame: CanvasFrame,
  ): XY | null {
    const ctx = this.base?.getContext("2d");
    return ctx
      ? (this.layoutDimensions(ctx, frame, preview)[0]?.label ?? null)
      : null;
  }
  /** Screen position of a dimension label, used to place the inline editor. */
  dimensionAnchor(id: string): XY | null {
    const label = this.labels.find((item) => item.id === id);
    return label ? { x: label.x, y: label.y } : null;
  }
  private dimensionHit(d: DimensionPaint, screen: XY, includeLines: boolean) {
    if (
      screen.x >= d.rect.x &&
      screen.x <= d.rect.x + d.rect.width &&
      screen.y >= d.rect.y &&
      screen.y <= d.rect.y + d.rect.height
    )
      return true;
    if (!includeLines) return false;
    if (d.arc) {
      const { center, radius, start, sweep } = d.arc;
      const angle = Math.atan2(screen.y - center.y, screen.x - center.x);
      const tau = Math.PI * 2;
      const offset =
        sweep >= 0 ? (angle - start + tau) % tau : (start - angle + tau) % tau;
      if (
        Math.abs(dist(screen, center) - radius) <= 5 &&
        offset <= Math.abs(sweep)
      )
        return true;
    }
    const lines = [
      [d.a, d.da],
      [d.b, d.db],
    ];
    if (!d.arc) lines.push([d.da, d.db]);
    if (d.leader) lines.push([d.b, d.label]);
    return lines.some(
      ([a, b]) => a && b && dist(screen, projection(screen, a, b).point) <= 5,
    );
  }
  dimensionAt(
    screen: XY,
    frame: CanvasFrame,
    includeLines = false,
  ): string | null {
    if (!this.frame) return null;
    if (
      frame.dimensionPreview?.constraintId &&
      this.previewLabel &&
      this.dimensionHit(this.previewLabel, screen, includeLines)
    )
      return frame.dimensionPreview.constraintId;
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const d = this.labels[i];
      if (
        d.sketchId === this.activeId &&
        this.dimensionHit(d, screen, includeLines)
      )
        return d.id;
    }
    return null;
  }
  hitTest(screen: XY, frame: CanvasFrame): Selection | null {
    this.hitCandidates = 0;
    const old = this.frame,
      validHandles =
        old &&
        this.handleSceneRevision === this.sceneRevision &&
        this.handleActiveId === this.activeId &&
        old.width === frame.width &&
        old.height === frame.height &&
        old.view.scale === frame.view.scale &&
        old.view.center.x === frame.view.center.x &&
        old.view.center.y === frame.view.center.y &&
        old.selection === frame.selection;
    if (validHandles) {
      const handles = this.handleIndex
        .search({
          minX: screen.x,
          maxX: screen.x,
          minY: screen.y,
          maxY: screen.y,
        })
        .sort((a, b) => b.order - a.order);
      this.hitCandidates += handles.length;
      for (const p of handles)
        if (dist(p, screen) <= p.r)
          return { entityId: p.entityId, pointId: p.pointId };
    }
    const world = screenToWorld(screen, frame),
      t = 7 / frame.view.scale;
    const candidates = this.scene
      .search({
        minX: world.x - t,
        maxX: world.x + t,
        minY: world.y - t,
        maxY: world.y + t,
      })
      .filter((item) => item.sketchId === this.activeId)
      .sort((a, b) => b.order - a.order);
    this.hitCandidates += candidates.length;
    if (!validHandles) {
      const selected = new Set(frame.selection.map((s) => s.entityId));
      for (const item of candidates) {
        const e = item.entity,
          points = selected.has(e.id)
            ? e.points
            : e.kind === "text"
              ? []
              : ["circle", "ellipse"].includes(e.kind)
                ? [e.points[0]]
                : ["bezier", "conic", "spline"].includes(e.kind)
                  ? [e.points[0], e.points.at(-1)!]
                  : e.points;
        for (let i = points.length - 1; i >= 0; i--)
          if (dist(world, points[i]) <= t)
            return { entityId: e.id, pointId: points[i].id };
      }
    }
    if (!this.hitContext && typeof document !== "undefined")
      this.hitContext = document.createElement("canvas").getContext("2d");
    const ctx = this.hitContext;
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = t * 2;
    ctx.setLineDash([]);
    for (const item of candidates) {
      const e = item.entity;
      if (e.kind === "point") {
        if (dist(world, e.points[0]) <= t) return { entityId: e.id };
      } else if (e.kind === "text") {
        const c = e.points[0],
          a = ((e.rotation ?? 0) * Math.PI) / 180,
          dx = world.x - c.x,
          dy = world.y - c.y,
          local = {
            x: dx * Math.cos(a) + dy * Math.sin(a),
            y: -dx * Math.sin(a) + dy * Math.cos(a),
          };
        ctx.font = `${e.fontSize ?? 6}px Arial, sans-serif`;
        const metrics = ctx.measureText(e.text ?? ""),
          ascent = metrics.actualBoundingBoxAscent || e.fontSize || 6,
          descent =
            metrics.actualBoundingBoxDescent || (e.fontSize ?? 6) * 0.25;
        if (
          inBox(
            local,
            { minX: 0, maxX: metrics.width, minY: -descent, maxY: ascent },
            t,
          )
        )
          return { entityId: e.id };
      } else if (ctx.isPointInStroke(this.path(item), world.x, world.y))
        return { entityId: e.id };
    }
    return null;
  }
  private tightBounds(item: Prepared): CanvasBounds {
    const e = item.entity,
      ctx = this.hitContext;
    if (
      item.selectionBounds &&
      (e.kind !== "text" || item.selectionMeasured || !ctx)
    )
      return item.selectionBounds;
    if (e.kind === "text" && ctx) {
      ctx.font = `${e.fontSize ?? 6}px Arial, sans-serif`;
      const m = ctx.measureText(e.text ?? ""),
        a = ((e.rotation ?? 0) * Math.PI) / 180,
        c = e.points[0];
      item.selectionBounds = coordinateBounds(
        [-m.actualBoundingBoxLeft, m.actualBoundingBoxRight || m.width].flatMap(
          (x) =>
            [-m.actualBoundingBoxDescent, m.actualBoundingBoxAscent].map(
              (y) => ({
                x: c.x + x * Math.cos(a) - y * Math.sin(a),
                y: c.y + x * Math.sin(a) + y * Math.cos(a),
              }),
            ),
        ),
      );
      item.selectionMeasured = true;
    } else item.selectionBounds = geometryBounds([e]);
    return item.selectionBounds;
  }
  selectBox(worldA: XY, worldB: XY): string[] {
    const box = {
      minX: Math.min(worldA.x, worldB.x),
      maxX: Math.max(worldA.x, worldB.x),
      minY: Math.min(worldA.y, worldB.y),
      maxY: Math.max(worldA.y, worldB.y),
    };
    // Canvas Y points down, while the world coordinates passed here point up.
    const crossing = worldB.y > worldA.y;
    const selected: Prepared[] = [];
    let boundary: paper.Path | null = null;
    try {
      for (const item of this.scene.search(box)) {
        if (item.sketchId !== this.activeId) continue;
        const b = this.tightBounds(item);
        if (
          b.minX >= box.minX - 1e-7 &&
          b.maxX <= box.maxX + 1e-7 &&
          b.minY >= box.minY - 1e-7 &&
          b.maxY <= box.maxY + 1e-7
        ) {
          selected.push(item);
          continue;
        }
        if (
          !crossing ||
          b.maxX < box.minX ||
          b.minX > box.maxX ||
          b.maxY < box.minY ||
          b.minY > box.maxY
        )
          continue;
        if (item.entity.kind === "text") {
          selected.push(item);
          continue;
        }
        const path = paperPath(item.entity);
        try {
          if (path.firstSegment && inBox(path.firstSegment.point, box, 1e-7)) {
            selected.push(item);
            continue;
          }
          boundary ??= new paper.Path.Rectangle({
            from: [box.minX - 1e-7, box.minY - 1e-7],
            to: [box.maxX + 1e-7, box.maxY + 1e-7],
            insert: false,
          });
          if (path.intersects(boundary)) selected.push(item);
        } finally {
          path.remove();
        }
      }
      return selected
        .sort((a, b) => a.order - b.order)
        .map((item) => item.entity.id);
    } finally {
      boundary?.remove();
    }
  }
  position(pointId: string): XY | undefined {
    const point = this.pointRefs.get(pointId);
    return point ? { x: point.x, y: point.y } : undefined;
  }
  snap(
    world: XY,
    frame: CanvasFrame,
    excludeEntityId?: string | ReadonlySet<string>,
  ): CanvasSnap | null {
    const options = frame.snapOptions ?? {
      ...defaultSnapOptions,
      grid: frame.grid,
    };
    const tolerance = 10 / frame.view.scale;
    let best: CanvasSnap | null = null,
      distance = Infinity,
      bestOrder = Infinity,
      bestPriority = Infinity;
    const offer = (p: CanvasSnap, order = Infinity) => {
      if (!isSnapEnabled(p.kind, options)) return;
      const d = dist(world, p.point),
        priority = snapPriority(p.kind);
      if (!Number.isFinite(d) || d >= snapRadius(p.kind) / frame.view.scale)
        return;
      if (
        priority < bestPriority ||
        (priority === bestPriority &&
          (d < distance || (d === distance && order < bestOrder)))
      ) {
        distance = d;
        bestOrder = order;
        bestPriority = priority;
        best = {
          point: p.point,
          ref: p.ref,
          binding: p.binding,
          kind: p.kind,
        };
      }
    };
    const region = {
      minX: world.x - tolerance,
      maxX: world.x + tolerance,
      minY: world.y - tolerance,
      maxY: world.y + tolerance,
    };
    for (const item of this.snaps.search(region))
      if (
        item.sketchId === this.activeId &&
        !(typeof excludeEntityId === "string"
          ? item.entityId === excludeEntityId
          : excludeEntityId?.has(item.entityId) ||
            item.pointIds.some((id) => excludeEntityId?.has(id)))
      )
        offer(item, item.order);
    if (
      bestPriority !== 0 &&
      (options.intersection || (options.tangent && frame.snapFrom))
    ) {
      const signatures = new Set<string>();
      const curves = this.scene
        .search(region)
        .filter((item) => {
          const e = item.entity;
          if (
            item.sketchId !== this.activeId ||
            e.kind === "point" ||
            e.kind === "text" ||
            (typeof excludeEntityId === "string"
              ? e.id === excludeEntityId
              : excludeEntityId?.has(e.id) ||
                e.points.some((p) => excludeEntityId?.has(p.id)))
          )
            return false;
          if (
            e.kind === "line" &&
            dist(world, projection(world, e.points[0], e.points[1]).point) >
              tolerance
          )
            return false;
          if (
            (e.kind === "circle" || e.kind === "arc") &&
            Math.abs(
              dist(world, e.points[0]) -
                (e.kind === "arc" ? arcInfo(e).r : (e.radius ?? 1)),
            ) > tolerance
          )
            return false;
          return true;
        })
        .sort((a, b) => a.order - b.order)
        .filter((item) => {
          if (signatures.has(item.signature)) return false;
          signatures.add(item.signature);
          return true;
        });
      if (options.tangent && frame.snapFrom)
        for (const item of curves)
          for (const point of tangentPoints(item.entity, frame.snapFrom))
            offer(
              {
                point,
                kind: "tangent",
                binding: item.entity.sourceId
                  ? undefined
                  : { kind: "tangent", refs: [item.entity.id] },
              },
              item.order,
            );
      if (options.intersection)
        for (let i = 0; i < curves.length; i++)
          for (let j = i + 1; j < curves.length; j++) {
            const a = curves[i],
              b = curves[j];
            const key = JSON.stringify([a.entity.id, b.entity.id]);
            let points = this.intersectionCache.get(key);
            if (!points) {
              points = intersections(a.entity, b.entity);
              this.intersectionCache.set(key, points);
            }
            for (const point of points)
              offer({
                point,
                kind: "intersection",
                binding:
                  a.entity.sourceId || b.entity.sourceId
                    ? undefined
                    : {
                        kind: "intersection",
                        refs: [a.entity.id, b.entity.id],
                      },
              });
          }
    }
    offer({
      point: { x: 0, y: 0 },
      kind: "origin",
      binding: { kind: "origin", refs: [] },
    });
    if (!best && options.grid) {
      const step = gridStepForScale(frame.view.scale);
      offer({
        point: {
          x: Math.round(world.x / step) * step,
          y: Math.round(world.y / step) * step,
        },
        kind: "grid",
      });
    }
    return best;
  }
}

export default CanvasRenderer;
