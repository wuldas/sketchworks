import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanvasRenderer,
  canvasEntityBounds,
  gridStepForScale,
  niceStep,
  screenToWorld,
  worldToScreen,
  type CanvasFrame,
} from "./canvasRenderer";
import { entity, clone, type Entity, type Sketch } from "./model";
import { defaultSnapOptions } from "./snapping";
const capturesOff = {
  grid: false,
  endpoint: false,
  midpoint: false,
  tangent: false,
  intersection: false,
};
const frame = (extra: Partial<CanvasFrame> = {}): CanvasFrame => ({
  width: 800,
  height: 600,
  dpr: 1,
  view: { center: { x: 0, y: 0 }, scale: 4 },
  grid: true,
  unit: "mm",
  selection: [],
  drafts: [],
  preview: [],
  cursor: null,
  snapPoint: null,
  marquee: null,
  ...extra,
});
const sketch = (entities: Entity[], extra: Partial<Sketch> = {}): Sketch => ({
  id: "s1",
  name: "Sketch",
  visible: true,
  entities,
  constraints: [],
  ...extra,
});
class FakePath {
  constructor(_source?: string) {}
  moveTo() {}
  lineTo() {}
  closePath() {}
}
function fakeCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 0,
    height: 0,
    ownerDocument: { createElement: () => fakeCanvas() },
  } as unknown as HTMLCanvasElement;
  const context = new Proxy(
    {
      canvas,
      measureText: (text: string) => ({
        width: text.length * 7,
        actualBoundingBoxAscent: 5,
        actualBoundingBoxDescent: 1,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * 7,
      }),
      isPointInStroke: () => true,
    },
    {
      get: (object, key) =>
        key in object ? object[key as keyof typeof object] : () => {},
    },
  ) as unknown as CanvasRenderingContext2D;
  canvas.getContext = (() => context) as unknown as typeof canvas.getContext;
  return canvas;
}
afterEach(() => vi.unstubAllGlobals());
describe("retained Canvas renderer", () => {
  it("culls and caches operation previews without changing the real scene or picking", () => {
    vi.stubGlobal("Path2D", FakePath);
    const source = entity("line", [
      { x: -80, y: 20 },
      { x: -70, y: 20 },
    ]);
    const s = sketch([source]),
      before = clone(s),
      r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      f = frame();
    r.sync([s], s.id);
    r.draw(canvas, f);
    const initial = r.metadata(f).stats;
    const entities = Array.from({ length: 1000 }, (_, i) =>
      entity("line", [
        { x: i * 50, y: 20 },
        { x: i * 50 + 10, y: 20 },
      ]),
    );
    const preview = { ...f, operationPreview: entities };
    r.draw(canvas, preview);
    const metadata = r.metadata(preview);
    expect(metadata.operationPreview?.entityCount).toBe(1000);
    expect(metadata.operationPreview!.visibleEntities).toBeLessThan(10);
    expect(metadata.operationPreview?.cachedPaths).toBe(
      metadata.operationPreview?.visibleEntities,
    );
    expect(metadata.stats.sceneEntities).toBe(1);
    expect(metadata.stats.baseDraws).toBe(initial.baseDraws);
    expect(metadata.stats.compiledPaths).toBe(initial.compiledPaths);
    expect(
      r.hitTest(worldToScreen({ x: 1, y: 20 }, preview), preview),
    ).toBeNull();
    expect(
      r.snap(
        { x: 0, y: 20 },
        { ...preview, snapOptions: { ...capturesOff, endpoint: true } },
      ),
    ).toBeNull();
    const movedCursor = { ...preview, cursor: { x: 0, y: -20 } };
    r.draw(canvas, movedCursor);
    expect(r.metadata(movedCursor).operationPreview?.cachedPaths).toBe(
      metadata.operationPreview?.cachedPaths,
    );
    expect(r.metadata(movedCursor).stats.baseDraws).toBe(initial.baseDraws);
    r.draw(canvas, f);
    expect(r.metadata(f).operationPreview).toBeNull();
    expect(r.metadata(f).stats.baseDraws).toBe(initial.baseDraws);
    expect(s).toEqual(before);
  });

  it("keeps hover emphasis in the overlay and restores the cached scene when cleared", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
      { x: 0, y: 20 },
      { x: 20, y: 20 },
    ]);
    const s = sketch([e]),
      r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      f = frame();
    const ctx = canvas.getContext("2d")!;
    const strokes: {
      color: string | CanvasGradient | CanvasPattern;
      width: number;
    }[] = [];
    ctx.stroke = (() => {
      strokes.push({ color: ctx.strokeStyle, width: ctx.lineWidth });
    }) as typeof ctx.stroke;
    r.sync([s], s.id);
    r.draw(canvas, f);
    const initial = r.metadata(f).stats;
    const hover = { ...f, hoveredEntityId: e.id };
    r.draw(canvas, hover);
    expect(r.metadata(hover).hoveredEntityId).toBe(e.id);
    expect(strokes).toEqual([{ color: "#195343", width: 3.4 / f.view.scale }]);
    expect(r.metadata(hover).stats.baseDraws).toBe(initial.baseDraws);
    expect(r.metadata(hover).stats.compiledPaths).toBe(initial.compiledPaths);
    r.draw(canvas, f);
    expect(r.metadata(f).hoveredEntityId).toBeNull();
    expect(r.metadata(f).stats.baseDraws).toBe(initial.baseDraws);
    expect(strokes).toHaveLength(1);
    expect(f.selection).toEqual([]);
  });

  it("never emphasizes an inactive sketch or a removed hovered object", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("circle", [{ x: 10, y: 10 }], { radius: 5 });
    const other = sketch([e], { id: "other" });
    const active = sketch([]),
      r = new CanvasRenderer(),
      canvas = fakeCanvas();
    const f = frame({ hoveredEntityId: e.id });
    r.sync([active, other], active.id);
    r.draw(canvas, f);
    expect(r.metadata(f).hoveredEntityId).toBeNull();
    r.sync([other], other.id);
    r.draw(canvas, f);
    expect(r.metadata(f).hoveredEntityId).toBe(e.id);
    r.sync([{ ...other, entities: [] }], other.id);
    r.draw(canvas, f);
    expect(r.metadata(f).hoveredEntityId).toBeNull();
  });

  it("renders relative labels against current geometry even when the world cache has not been refreshed", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ]),
      s = sketch([e], {
        constraints: [
          {
            id: "relative",
            kind: "length",
            refs: [e.id],
            value: 20,
            labelPosition: { x: 10, y: 8 },
            labelOffset: { x: 0, y: 8 },
          },
        ],
      }),
      r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      f = frame();
    r.sync([s], s.id);
    r.draw(canvas, f);
    expect(r.dimensionAnchor("relative")).toEqual({ x: 440, y: 268 });
    const moved = clone(s);
    for (const p of moved.entities[0].points) {
      p.x += 7;
      p.y += 9;
    }
    r.sync([moved], moved.id);
    r.draw(canvas, f);
    expect(r.dimensionAnchor("relative")).toEqual({ x: 468, y: 232 });
    expect(moved.constraints[0].labelPosition).toEqual({ x: 10, y: 8 });
    const preview = frame({
      dimensionPreview: {
        kind: "length",
        refs: [e.id],
        value: 20,
        labelPosition: { x: 12, y: 30 },
        fixed: true,
      },
    });
    r.draw(canvas, preview);
    expect(r.metadata(preview).dimensionPreview).toMatchObject({
      x: 468,
      y: 180,
    });
  });

  it("round-trips world and screen coordinates after pan and zoom", () => {
    for (const scale of [0.01, 1, 4, 250]) {
      const f = frame({ view: { center: { x: 37, y: -23 }, scale } }),
        p = { x: 17.25, y: -8.4 };
      const result = screenToWorld(worldToScreen(p, f), f);
      expect(result.x).toBeCloseTo(p.x, 8);
      expect(result.y).toBeCloseTo(p.y, 8);
    }
  });
  it("uses one world origin and nested 1/2/5 grid spacing", () => {
    expect(niceStep(22)).toBe(50);
    expect(niceStep(4.2)).toBe(5);
    expect(gridStepForScale(4)).toBe(10);
    const f = frame({ view: { center: { x: 37, y: -23 }, scale: 4 } }),
      origin = worldToScreen({ x: 0, y: 0 }, f),
      step = gridStepForScale(4);
    for (const k of [-5, -1, 0, 1, 5])
      expect(worldToScreen({ x: k * step, y: 0 }, f).x).toBeCloseTo(
        origin.x + k * step * 4,
        10,
      );
  });
  it("uses analytic circle and rotated ellipse broad bounds", () => {
    expect(
      canvasEntityBounds(entity("circle", [{ x: 4, y: -3 }], { radius: 10 })),
    ).toEqual({ minX: -6, maxX: 14, minY: -13, maxY: 7 });
    const e = entity(
      "ellipse",
      [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ],
      { ry: 2 },
    );
    const b = canvasEntityBounds(e);
    expect(b.maxX).toBeCloseTo(Math.hypot(3, 1.6));
    expect(b.maxY).toBeCloseTo(Math.hypot(4, 1.2));
  });
  it("bounds Bezier controls conservatively and rotates text bounds", () => {
    const b = canvasEntityBounds(
      entity("bezier", [
        { x: 0, y: 0 },
        { x: 4, y: 10 },
        { x: 6, y: -10 },
        { x: 10, y: 0 },
      ]),
    );
    expect(b).toEqual({ minX: 0, minY: -10, maxX: 10, maxY: 10 });
    const t = canvasEntityBounds(
      entity("text", [{ x: 0, y: 0 }], {
        text: "ABC",
        fontSize: 4,
        rotation: 90,
      }),
    );
    expect(t.maxX).toBeCloseTo(1.6);
    expect(t.maxY).toBeGreaterThan(16);
  });
  it("keeps grid capture independent from visible grid lines", () => {
    const r = new CanvasRenderer();
    r.sync([sketch([])], "s1");
    for (const visible of [true, false]) {
      expect(
        r.snap(
          { x: 40.1, y: 30.1 },
          frame({ grid: visible, snapOptions: { ...capturesOff, grid: true } }),
        ),
      ).toMatchObject({ kind: "grid", point: { x: 40, y: 30 } });
      expect(
        r.snap(
          { x: 40.1, y: 30.1 },
          frame({ grid: visible, snapOptions: capturesOff }),
        ),
      ).toBeNull();
    }
  });
  it("filters endpoint and midpoint captures without changing geometry points", () => {
    const e = entity("line", [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ]);
    const r = new CanvasRenderer();
    r.sync([sketch([e])], "s1");
    expect(r.snap(e.points[0], frame({ snapOptions: capturesOff }))).toBeNull();
    expect(
      r.snap(
        e.points[0],
        frame({ snapOptions: { ...capturesOff, endpoint: true } }),
      ),
    ).toMatchObject({ kind: "endpoint", ref: e.points[0].id });
    expect(
      r.snap(
        { x: 30, y: 20 },
        frame({ snapOptions: { ...capturesOff, midpoint: true } }),
      ),
    ).toMatchObject({ kind: "midpoint", point: { x: 30, y: 20 } });
    expect(
      r.snap({ x: 30, y: 20 }, frame({ snapOptions: capturesOff })),
    ).toBeNull();
  });
  it("preserves ordinary point and origin capture under the category switches", () => {
    const e = entity("circle", [{ x: 80, y: 80 }], { radius: 5 });
    const r = new CanvasRenderer(),
      f = frame({ snapOptions: capturesOff });
    r.sync([sketch([e])], "s1");
    expect(r.snap(e.points[0], f)).toMatchObject({
      kind: "point",
      ref: e.points[0].id,
    });
    expect(r.snap({ x: 0, y: 0 }, f)).toMatchObject({ kind: "origin" });
  });
  it("captures tangent coordinates only with a valid line reference and enabled category", () => {
    const e = entity("circle", [{ x: 0, y: 0 }], { radius: 10 });
    const r = new CanvasRenderer();
    r.sync([sketch([e])], "s1");
    const target = { x: -5, y: Math.sqrt(75) };
    const f = frame({
      snapOptions: { ...capturesOff, tangent: true },
      snapFrom: { x: -20, y: 0 },
    });
    const captured = r.snap(target, f);
    expect(captured?.kind).toBe("tangent");
    expect(captured?.point.x).toBeCloseTo(target.x, 8);
    expect(captured?.point.y).toBeCloseTo(target.y, 8);
    expect(captured?.ref).toBeUndefined();
    expect(r.snap(target, { ...f, snapFrom: undefined })).toBeNull();
    expect(r.snap(target, { ...f, snapOptions: capturesOff })).toBeNull();
    expect(r.snap(target, f, e.id)).toBeNull();
  });
  it("rejects tangent captures outside a visible arc", () => {
    const e = entity(
      "arc",
      [
        { x: 0, y: 0 },
        { x: -10, y: 0 },
        { x: 10, y: 0 },
      ],
      { ccw: false },
    );
    const r = new CanvasRenderer();
    r.sync([sketch([e])], "s1");
    const f = frame({
      snapOptions: { ...capturesOff, tangent: true },
      snapFrom: { x: -20, y: 0 },
    });
    expect(r.snap({ x: -5, y: Math.sqrt(75) }, f)?.kind).toBe("tangent");
    expect(r.snap({ x: -5, y: -Math.sqrt(75) }, f)).toBeNull();
  });
  it("captures actual line intersections and invalidates changed or deleted geometry", () => {
    const a = entity("line", [
      { x: 10, y: 30 },
      { x: 50, y: 30 },
    ]);
    const b = entity("line", [
      { x: 25, y: 10 },
      { x: 25, y: 70 },
    ]);
    const s = sketch([a, b]),
      r = new CanvasRenderer();
    const f = frame({ snapOptions: { ...capturesOff, intersection: true } });
    r.sync([s], "s1");
    const captured = r.snap({ x: 25, y: 30 }, f);
    expect(captured?.kind).toBe("intersection");
    expect(captured?.point.x).toBeCloseTo(25, 8);
    expect(captured?.point.y).toBeCloseTo(30, 8);
    expect(r.snap({ x: 25, y: 30 }, f)?.ref).toBeUndefined();
    expect(
      r.snap({ x: 25, y: 30 }, { ...f, snapOptions: capturesOff }),
    ).toBeNull();
    expect(r.snap({ x: 25, y: 30 }, f, new Set([b.points[0].id]))).toBeNull();
    const changed = clone(s);
    changed.entities[1].points.forEach((p) => (p.x += 10));
    r.sync([changed], "s1");
    expect(r.snap({ x: 25, y: 30 }, f)).toBeNull();
    expect(r.snap({ x: 35, y: 30 }, f)?.kind).toBe("intersection");
    r.sync([sketch([a])], "s1");
    expect(r.snap({ x: 35, y: 30 }, f)).toBeNull();
  });
  it("does not capture intersections belonging to inactive or hidden sketches", () => {
    const a = entity("line", [
      { x: 10, y: 30 },
      { x: 50, y: 30 },
    ]);
    const b = entity("line", [
      { x: 25, y: 10 },
      { x: 25, y: 70 },
    ]);
    const r = new CanvasRenderer(),
      f = frame({ snapOptions: { ...capturesOff, intersection: true } });
    r.sync([sketch([a]), sketch([b], { id: "s2" })], "s1");
    expect(r.snap({ x: 25, y: 30 }, f)).toBeNull();
    r.sync([sketch([a, b], { visible: false })], "s1");
    expect(r.snap({ x: 25, y: 30 }, f)).toBeNull();
  });
  it("captures and updates analytic arc midpoints", () => {
    const e = entity(
      "arc",
      [
        { x: 60, y: 60 },
        { x: 70, y: 60 },
        { x: 60, y: 70 },
      ],
      { ccw: true },
    );
    const s = sketch([e]),
      r = new CanvasRenderer();
    const f = frame({ snapOptions: { ...capturesOff, midpoint: true } });
    r.sync([s], "s1");
    const p = { x: 60 + 10 * Math.SQRT1_2, y: 60 + 10 * Math.SQRT1_2 };
    expect(r.snap(p, f)?.kind).toBe("midpoint");
    const changed = clone(s);
    changed.entities[0].points.forEach((point) => {
      point.x += 3;
      point.y += 4;
    });
    r.sync([changed], "s1");
    expect(r.snap(p, f)).toBeNull();
    expect(r.snap({ x: p.x + 3, y: p.y + 4 }, f)?.kind).toBe("midpoint");
  });
  it("exposes independent capture settings without rebuilding the base bitmap", () => {
    vi.stubGlobal("Path2D", FakePath);
    const r = new CanvasRenderer(),
      canvas = fakeCanvas();
    r.sync([sketch([])], "s1");
    const initial = frame({ grid: true, snapOptions: defaultSnapOptions });
    r.draw(canvas, initial);
    const before = r.metadata(initial);
    const changed = { ...initial, snapOptions: capturesOff };
    r.draw(canvas, changed);
    expect(r.metadata(changed).gridVisible).toBe(true);
    expect(r.metadata(changed).snapOptions).toEqual(capturesOff);
    expect(r.metadata(changed).stats.baseDraws).toBe(before.stats.baseDraws);
  });
  it("supports point and midpoint snapping before the first draw", () => {
    const e = entity("line", [
        { x: 10, y: 5 },
        { x: 30, y: 5 },
      ]),
      r = new CanvasRenderer();
    r.sync([sketch([e])], "s1");
    expect(r.snap({ x: 10.2, y: 5.1 }, frame())?.ref).toBe(e.points[0].id);
    expect(r.snap({ x: 20.1, y: 5.2 }, frame())?.kind).toBe("midpoint");
    expect(r.snap({ x: 10, y: 5 }, frame({ grid: false }), e.id)).toBeNull();
    expect(r.hitTest(worldToScreen(e.points[0], frame()), frame())).toEqual({
      entityId: e.id,
      pointId: e.points[0].id,
    });
  });
  it("excludes derived and inactive points from snapping", () => {
    const source = entity("point", [{ x: 80, y: 80 }]),
      derived = entity("point", [{ x: 20, y: 20 }], { sourceId: source.id }),
      inactive = entity("point", [{ x: 30, y: 30 }]),
      r = new CanvasRenderer();
    r.sync([sketch([source, derived]), sketch([inactive], { id: "s2" })], "s1");
    expect(r.snap({ x: 20, y: 20 }, frame({ grid: false }))).toBeNull();
    expect(r.snap({ x: 30, y: 30 }, frame({ grid: false }))).toBeNull();
    r.sync([sketch([source, derived]), sketch([inactive], { id: "s2" })], "s2");
    expect(r.snap({ x: 30, y: 30 }, frame({ grid: false }))?.ref).toBe(
      inactive.points[0].id,
    );
  });
  it("preserves document offer order for equal-distance spatial snap candidates", () => {
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 5 });
    const overlapping = Array.from({ length: 40 }, () =>
      entity("point", [{ x: 0, y: 0 }]),
    );
    const axis = entity(
      "line",
      [
        { x: -30, y: 0 },
        { x: 30, y: 0 },
      ],
      { construction: true },
    );
    const r = new CanvasRenderer(),
      f = frame({ grid: false });
    r.sync([sketch([circle, ...overlapping, axis])], "s1");
    expect(r.snap({ x: 0.2, y: 0.1 }, f)?.ref).toBe(circle.points[0].id);
    r.sync([sketch([axis, circle, ...overlapping])], "s1");
    expect(r.snap({ x: 0.2, y: 0.1 }, f)?.kind).toBe("midpoint");
    expect(r.snap({ x: 0.2, y: 0.1 }, f)?.ref).toBeUndefined();
    r.sync([sketch([entity("point", [{ x: 102, y: 50 }])])], "s1");
    expect(r.snap({ x: 100, y: 50 }, f)).toBeNull();
  });
  it("falls back to origin then visible grid within an eight-pixel tolerance", () => {
    const r = new CanvasRenderer();
    r.sync([sketch([])], "s1");
    expect(r.snap({ x: 0.2, y: 0.4 }, frame())?.kind).toBe("origin");
    expect(r.snap({ x: 40.2, y: 29.8 }, frame())?.point).toEqual({
      x: 40,
      y: 30,
    });
    expect(r.snap({ x: 45, y: 35 }, frame())).toBeNull();
    expect(r.snap({ x: 40, y: 30 }, frame({ grid: false }))).toBeNull();
  });
  it("selects an arc by actual curve bounds rather than its invisible full circle", () => {
    const e = entity(
        "arc",
        [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 0, y: 20 },
        ],
        { ccw: true },
      ),
      r = new CanvasRenderer();
    r.sync([sketch([e])], "s1");
    expect(r.selectBox({ x: -0.01, y: -0.01 }, { x: 20.01, y: 20.01 })).toEqual(
      [e.id],
    );
  });
  it("selects Bezier ink without enclosing control handles", () => {
    const e = entity("bezier", [
        { x: 0, y: 0 },
        { x: 4, y: 10 },
        { x: 6, y: -10 },
        { x: 10, y: 0 },
      ]),
      r = new CanvasRenderer();
    r.sync([sketch([e])], "s1");
    expect(r.selectBox({ x: -0.1, y: -3 }, { x: 10.1, y: 3 })).toEqual([e.id]);
  });
  it("retains native paths across cloned documents and prunes removed paths", () => {
    vi.stubGlobal("Path2D", FakePath);
    const r = new CanvasRenderer(),
      e = entity("circle", [{ x: 10, y: 10 }], { radius: 3 }),
      s = [sketch([e])],
      f = frame(),
      canvas = fakeCanvas();
    r.sync(s, "s1");
    r.draw(canvas, f);
    const initial = r.metadata(f);
    expect(initial.stats.compiledPaths).toBe(1);
    r.sync(clone(s), "s1");
    r.draw(canvas, f);
    expect(r.metadata(f).stats.compiledPaths).toBe(1);
    const changed = clone(s);
    changed[0].entities[0].radius = 4;
    r.sync(changed, "s1");
    r.draw(canvas, f);
    expect(r.metadata(f).stats.compiledPaths).toBe(2);
    expect(r.metadata(f).stats.cachedPaths).toBe(1);
    r.sync([sketch([])], "s1");
    r.draw(canvas, f);
    expect(r.metadata(f).stats.cachedPaths).toBe(0);
  });
  it("reuses the base bitmap and metadata arrays for cursor-only frames", () => {
    vi.stubGlobal("Path2D", FakePath);
    const r = new CanvasRenderer(),
      f = frame(),
      e = entity("line", [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ]);
    r.sync([sketch([e])], "s1");
    const canvas = fakeCanvas();
    r.draw(canvas, f);
    const first = r.metadata(f);
    const overlay = {
      ...f,
      cursor: { x: 12, y: 5 },
      snapPoint: { kind: "grid" as const, point: { x: 10, y: 10 } },
    };
    r.draw(canvas, overlay);
    const next = r.metadata(overlay);
    expect(next.stats.baseDraws).toBe(first.stats.baseDraws);
    expect(next.stats.frames).toBe(first.stats.frames + 1);
    expect(next.handles).toBe(first.handles);
    expect(next.dimensions).toBe(first.dimensions);
    expect(next.snap?.x).toBe(440);
  });
  it("renders and freezes a dimension preview without changing the base bitmap", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const r = new CanvasRenderer(),
      canvas = fakeCanvas();
    r.sync([sketch([e])], "s1");
    const initial = frame();
    r.draw(canvas, initial);
    const baseDraws = r.metadata(initial).stats.baseDraws;
    const preview = frame({
      dimensionPreview: {
        kind: "length",
        refs: [e.id],
        labelPosition: { x: 10, y: 10 },
        fixed: false,
      },
    });
    r.draw(canvas, preview);
    const metadata = r.metadata(preview);
    expect(metadata.dimensions).toEqual([]);
    expect(metadata.dimensionPreview).toMatchObject({
      kind: "length",
      text: "20",
      x: 440,
      y: 260,
      fixed: false,
    });
    expect(r.dimensionAt({ x: 440, y: 260 }, preview)).toBeNull();
    expect(metadata.stats.baseDraws).toBe(baseDraws);
    const frozen = {
      ...preview,
      cursor: { x: -40, y: -40 },
      dimensionPreview: { ...preview.dimensionPreview!, fixed: true },
    };
    r.draw(canvas, frozen);
    expect(r.metadata(frozen).dimensionPreview).toMatchObject({
      x: 440,
      y: 260,
      fixed: true,
    });
    expect(r.dimensionPreviewAnchor(frozen.dimensionPreview, frozen)).toEqual({
      x: 440,
      y: 260,
    });
    r.draw(canvas, initial);
    expect(r.metadata(initial).dimensionPreview).toBeNull();
  });
  it("hides only the moving saved dimension and reuses the base during position previews", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const s = sketch([e], {
      constraints: [
        {
          id: "length",
          kind: "length",
          refs: [e.id],
          value: 20,
          labelPosition: { x: 10, y: 10 },
        },
      ],
    });
    const r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      initial = frame();
    r.sync([s], "s1");
    r.draw(canvas, initial);
    const original = clone(s);
    const moving = frame({
      dimensionPreview: {
        constraintId: "length",
        kind: "length",
        refs: [e.id],
        value: 20,
        labelPosition: { x: 10, y: 20 },
        fixed: false,
      },
    });
    r.draw(canvas, moving);
    expect(r.metadata(moving).dimensions).toEqual([]);
    expect(r.metadata(moving).dimensionPreview).toMatchObject({
      constraintId: "length",
      x: 440,
      y: 220,
      text: "20",
    });
    expect(r.dimensionAt({ x: 440, y: 220 }, moving)).toBe("length");
    const base = r.metadata(moving).stats.baseDraws;
    const further = {
      ...moving,
      dimensionPreview: {
        ...moving.dimensionPreview!,
        labelPosition: { x: 10, y: 25 },
      },
    };
    r.draw(canvas, further);
    expect(r.metadata(further).stats.baseDraws).toBe(base);
    expect(s).toEqual(original);
    r.draw(canvas, initial);
    expect(r.metadata(initial).dimensions).toHaveLength(1);
    expect(r.metadata(initial).dimensionPreview).toBeNull();
    expect(r.dimensionAnchor("length")).toEqual({ x: 440, y: 260 });
  });
  it("hits dimension segments for dragging without treating them as numeric labels", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      f = frame();
    r.sync(
      [
        sketch([e], {
          constraints: [
            {
              id: "length",
              kind: "length",
              refs: [e.id],
              value: 20,
              labelPosition: { x: 10, y: 10 },
            },
          ],
        }),
      ],
      "s1",
    );
    r.draw(canvas, f);
    expect(r.dimensionAt({ x: 410, y: 260 }, f)).toBeNull();
    expect(r.dimensionAt({ x: 410, y: 260 }, f, true)).toBe("length");
    expect(r.dimensionAt({ x: 400, y: 280 }, f, true)).toBe("length");
    expect(r.dimensionAt({ x: 500, y: 250 }, f, true)).toBeNull();
  });
  it("hits angular annotation arcs only inside the displayed sweep", () => {
    vi.stubGlobal("Path2D", FakePath);
    const a = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const b = entity("line", [
      { x: 0, y: 0 },
      { x: 0, y: 20 },
    ]);
    const r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      f = frame();
    r.sync(
      [
        sketch([a, b], {
          constraints: [
            { id: "angle", kind: "angle", refs: [a.id, b.id], value: 90 },
          ],
        }),
      ],
      "s1",
    );
    r.draw(canvas, f);
    const p = {
      x: 400 + 29 * Math.cos(-Math.PI / 9),
      y: 300 + 29 * Math.sin(-Math.PI / 9),
    };
    expect(r.dimensionAt(p, f)).toBeNull();
    expect(r.dimensionAt(p, f, true)).toBe("angle");
    expect(r.dimensionAt({ x: 375, y: 285 }, f, true)).toBeNull();
  });
  it("places circular dimension labels and leaders at their saved positions", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("circle", [{ x: 0, y: 0 }], { radius: 5 });
    const r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      f = frame();
    r.sync(
      [
        sketch([e], {
          constraints: [
            {
              id: "diameter",
              kind: "diameter",
              refs: [e.id],
              value: 10,
              labelPosition: { x: 15, y: 0 },
            },
          ],
        }),
      ],
      "s1",
    );
    r.draw(canvas, f);
    expect(r.dimensionAnchor("diameter")).toEqual({ x: 460, y: 300 });
    expect(r.dimensionAt({ x: 430, y: 300 }, f, true)).toBe("diameter");
    expect(r.dimensionAt({ x: 390, y: 300 }, f, true)).toBe("diameter");
    expect(r.dimensionAt({ x: 380, y: 300 }, f, true)).toBe("diameter");
    expect(r.metadata(f).dimensions[0].text).toBe("\u00d810");
  });
  it("uses the saved label position after reload, pan and zoom", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const s = sketch([e], {
      constraints: [
        {
          id: "length",
          kind: "length",
          refs: [e.id],
          value: 20,
          labelPosition: { x: 10, y: 15 },
        },
      ],
    });
    const r = new CanvasRenderer(),
      canvas = fakeCanvas();
    r.sync(clone([s]), "s1");
    for (const f of [
      frame(),
      frame({ view: { center: { x: 3, y: 4 }, scale: 6 } }),
    ]) {
      r.draw(canvas, f);
      const expected = worldToScreen({ x: 10, y: 15 }, f);
      expect(r.dimensionAnchor("length")).toEqual(expected);
      expect(r.dimensionAt(expected, f)).toBe("length");
    }
  });
  it("lays out point-line and point-pair previews with projected dimension lines", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const p = entity("point", [{ x: 8, y: 10 }]);
    const r = new CanvasRenderer(),
      canvas = fakeCanvas();
    r.sync([sketch([e, p])], "s1");
    const f = frame({
      dimensionPreview: {
        kind: "lineDistance",
        refs: [p.points[0].id, e.id],
        labelPosition: { x: 15, y: 5 },
        fixed: false,
      },
    });
    r.draw(canvas, f);
    expect(r.metadata(f).dimensionPreview).toMatchObject({
      kind: "lineDistance",
      text: "10",
      x: 460,
      y: 280,
    });
    const horizontal = {
      ...f,
      dimensionPreview: {
        kind: "distanceX" as const,
        refs: [e.points[0].id, e.points[1].id],
        labelPosition: { x: 18, y: -10 },
        fixed: false,
      },
    };
    r.draw(canvas, horizontal);
    expect(r.metadata(horizontal).dimensionPreview).toMatchObject({
      kind: "distanceX",
      text: "20",
      x: 440,
      y: 340,
    });
  });
  it("positions signed angle previews by their chosen arc radius", () => {
    vi.stubGlobal("Path2D", FakePath);
    const a = entity("line", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    const b = entity("line", [
      { x: 0, y: 0 },
      { x: 10, y: -10 },
    ]);
    const r = new CanvasRenderer(),
      canvas = fakeCanvas();
    r.sync([sketch([a, b])], "s1");
    const f = frame({
      dimensionPreview: {
        kind: "angle",
        refs: [a.id, b.id],
        labelPosition: { x: 15, y: -10 },
        fixed: false,
      },
    });
    r.draw(canvas, f);
    const label = r.metadata(f).dimensionPreview!;
    expect(label.text).toBe("45\u00b0");
    expect(label.x).toBeGreaterThan(f.width / 2);
    expect(label.y).toBeGreaterThan(f.height / 2);
    const origin = worldToScreen({ x: 0, y: 0 }, f);
    expect(Math.hypot(label.x - origin.x, label.y - origin.y)).toBeCloseTo(
      Math.hypot(15, 10) * f.view.scale,
    );
  });
  it("marks only the selected annotation in its painted metadata", () => {
    vi.stubGlobal("Path2D", FakePath);
    const e = entity("line", [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ]),
      s = sketch([e], {
        constraints: [
          {
            id: "length",
            kind: "length",
            refs: [e.id],
            value: 20,
            labelPosition: { x: 10, y: 8 },
          },
        ],
      }),
      r = new CanvasRenderer(),
      canvas = fakeCanvas();
    r.sync([s], s.id);
    const idle = frame();
    r.draw(canvas, idle);
    expect(r.metadata(idle).dimensions[0].selected).toBe(false);
    const active = frame({ dimensionSelection: "length" });
    r.draw(canvas, active);
    expect(r.metadata(active).dimensions[0].selected).toBe(true);
    const cleared = frame();
    r.draw(canvas, cleared);
    expect(r.metadata(cleared).dimensions[0].selected).toBe(false);
  });
  it("rebuilds closed profiles on construction toggles without recompiling native geometry", () => {
    vi.stubGlobal("Path2D", FakePath);
    const edges = [
        entity("line", [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ]),
        entity("line", [
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ]),
        entity("line", [
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]),
        entity("line", [
          { x: 0, y: 10 },
          { x: 0, y: 0 },
        ]),
      ],
      r = new CanvasRenderer(),
      canvas = fakeCanvas(),
      f = frame();
    const doc = [sketch(edges)];
    r.sync(doc, "s1");
    r.draw(canvas, f);
    const initial = r.metadata(f).stats;
    const next = clone(doc);
    next[0].entities[0].construction = true;
    r.sync(next, "s1");
    r.draw(canvas, f);
    expect(r.metadata(f).stats.compiledPaths).toBe(initial.compiledPaths);
    expect(r.metadata(f).stats.baseDraws).toBe(initial.baseDraws + 1);
  });
  it("uses local spatial hit candidates in a large scene", () => {
    vi.stubGlobal("Path2D", FakePath);
    const entities = Array.from({ length: 2000 }, (_, i) =>
        entity("circle", [{ x: i * 50, y: 20 }], { radius: 5 }),
      ),
      r = new CanvasRenderer(),
      f = frame();
    r.sync([sketch(entities)], "s1");
    r.draw(fakeCanvas(), f);
    r.hitTest(worldToScreen({ x: 5, y: 20 }, f), f);
    expect(r.metadata(f).stats.hitCandidates).toBeLessThan(5);
    expect(r.metadata(f).stats.visibleEntities).toBeLessThan(10);
  });
  it("keeps metadata and DPR backing dimensions in CSS coordinate space", () => {
    vi.stubGlobal("Path2D", FakePath);
    const r = new CanvasRenderer(),
      f = frame({ dpr: 2 }),
      canvas = fakeCanvas();
    r.sync([sketch([])], "s1");
    r.draw(canvas, f);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(r.metadata(f).origin).toEqual({ x: 400, y: 300 });
    expect(r.metadata(f).scale).toBe(4);
  });
});
