import { describe, expect, it, vi } from "vitest";
import { entity, type Entity, type Sketch, type XY } from "./model";
import {
  defaultSnapOptions,
  entitySnapPoints,
  isSnapEnabled,
  pathEndpoints,
  pathMidpoint,
  snapPriority,
  snapRadius,
  tangentPoints,
  type SnapKind,
  type SnapOptions,
} from "./snapping";
import * as geometry from "./geometry";
import { CanvasRenderer, type CanvasFrame } from "./canvasRenderer";
import { dragAnchor, resolveDragSnap } from "./dragging";

const frame = (scale = 4): CanvasFrame => ({
  width: 800,
  height: 600,
  dpr: 1,
  view: { center: { x: 0, y: 0 }, scale },
  grid: false,
  unit: "mm",
  selection: [],
  drafts: [],
  preview: [],
  cursor: null,
  snapPoint: null,
  marquee: null,
});
const sketch = (entities: Entity[]): Sketch => ({
  id: "endpoint-test",
  name: "test",
  visible: true,
  entities,
  constraints: [],
});

const expectXY = (actual: XY, expected: XY) => {
  expect(actual.x).toBeCloseTo(expected.x, 7);
  expect(actual.y).toBeCloseTo(expected.y, 7);
};
const polar = (center: XY, radius: number, angle: number): XY => ({
  x: center.x + radius * Math.cos(angle),
  y: center.y + radius * Math.sin(angle),
});
const snapKinds: SnapKind[] = [
  "endpoint",
  "tangent",
  "intersection",
  "point",
  "midpoint",
  "origin",
  "grid",
];
const disabledOptions: SnapOptions = {
  grid: false,
  midpoint: false,
  endpoint: false,
  tangent: false,
  intersection: false,
};

describe("snap category options", () => {
  it("enables every category by default and keeps point/origin independent", () => {
    expect(defaultSnapOptions).toEqual({
      grid: true,
      midpoint: true,
      endpoint: true,
      tangent: true,
      intersection: true,
    });
    expect(
      snapKinds.filter((kind) => isSnapEnabled(kind, defaultSnapOptions)),
    ).toEqual(snapKinds);
    expect(
      snapKinds.filter((kind) => isSnapEnabled(kind, disabledOptions)),
    ).toEqual(["point", "origin"]);
  });
  it.each(["grid", "midpoint", "endpoint", "tangent", "intersection"] as const)(
    "filters %s independently from every other category",
    (category) => {
      const disabled = { ...defaultSnapOptions, [category]: false },
        enabled = { ...disabledOptions, [category]: true };
      expect(snapKinds.filter((kind) => isSnapEnabled(kind, disabled))).toEqual(
        snapKinds.filter((kind) => kind !== category),
      );
      expect(snapKinds.filter((kind) => isSnapEnabled(kind, enabled))).toEqual(
        snapKinds.filter(
          (kind) => kind === category || kind === "point" || kind === "origin",
        ),
      );
    },
  );
  it("orders endpoint, tangent/intersection, point-like and grid captures", () => {
    const priorities: Record<SnapKind, number> = {
      endpoint: 0,
      tangent: 1,
      intersection: 1,
      point: 2,
      midpoint: 2,
      origin: 2,
      grid: 3,
    };
    for (const kind of snapKinds) {
      expect(snapPriority(kind)).toBe(priorities[kind]);
      expect(snapRadius(kind)).toBe(kind === "endpoint" ? 10 : 8);
    }
  });
});

describe("analytic tangent capture", () => {
  it("returns both exact tangencies with the circle radius and perpendicular anchor line", () => {
    const center = { x: 2, y: -3 },
      from = { x: 15, y: -3 },
      circle = entity("circle", [center], { radius: 5 }),
      before = structuredClone(circle),
      points = tangentPoints(circle, from);
    expect(points).toHaveLength(2);
    expectXY(points[0], { x: 2 + 25 / 13, y: -3 + 60 / 13 });
    expectXY(points[1], { x: 2 + 25 / 13, y: -3 - 60 / 13 });
    for (const point of points) {
      expect(geometry.dist(point, center)).toBeCloseTo(5, 10);
      expect(
        geometry.dot(geometry.sub(point, center), geometry.sub(from, point)),
      ).toBeCloseTo(0, 10);
      expect(Object.keys(point).sort()).toEqual(["x", "y"]);
    }
    expect(circle).toEqual(before);
  });
  it.each([
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 5, y: 0 },
    { x: 3, y: 4 },
    { x: 5 / Math.sqrt(2), y: 5 / Math.sqrt(2) },
  ])("rejects an inside/on-circle anchor at $x, $y", (from) => {
    expect(
      tangentPoints(entity("circle", [{ x: 0, y: 0 }], { radius: 5 }), from),
    ).toEqual([]);
  });
  it("retains distinct tangencies for a genuinely external nearby anchor", () => {
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 5 });
    expect(tangentPoints(circle, { x: 5 + 1e-9, y: 0 })).toHaveLength(2);
  });
  it.each([0, -2, geometry.EPS / 2, NaN, Infinity])(
    "rejects a degenerate/non-finite radius %s",
    (radius) => {
      expect(
        tangentPoints(entity("circle", [{ x: 0, y: 0 }], { radius }), {
          x: 10,
          y: 0,
        }),
      ).toEqual([]);
    },
  );
  it("rejects malformed, non-finite, collapsed, and unsupported geometry", () => {
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 5 });
    for (const from of [
      { x: Infinity, y: 0 },
      { x: 10, y: NaN },
    ])
      expect(tangentPoints(circle, from)).toEqual([]);
    for (const candidate of [
      entity("circle", [], { radius: 5 }),
      entity("circle", [{ x: NaN, y: 0 }], { radius: 5 }),
      entity("arc", [{ x: 0, y: 0 }]),
      entity("arc", [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 5, y: 0 },
      ]),
      entity(
        "arc",
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 0 },
        ],
        {
          ccw: false,
        },
      ),
      entity("line", [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
      ]),
      entity(
        "ellipse",
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
        { ry: 3 },
      ),
    ])
      expect(tangentPoints(candidate, { x: 10, y: 0 })).toEqual([]);
  });
  it.each([
    { start: 0, end: 90, ccw: true, fromX: 10, signs: [1] },
    { start: 0, end: -90, ccw: false, fromX: 10, signs: [-1] },
    { start: 100, end: -170, ccw: true, fromX: -10, signs: [1] },
    { start: -100, end: 170, ccw: false, fromX: -10, signs: [-1] },
    { start: 170, end: -170, ccw: true, fromX: -10, signs: [] },
    { start: 30, end: -30, ccw: false, fromX: 10, signs: [] },
    { start: 30, end: -30, ccw: true, fromX: 10, signs: [-1, 1] },
    { start: -30, end: 30, ccw: false, fromX: 10, signs: [-1, 1] },
  ])(
    "filters the visible $start to $end degree arc (ccw=$ccw)",
    ({ start, end, ccw, fromX, signs }) => {
      const center = { x: 0, y: 0 },
        arc = entity(
          "arc",
          [
            center,
            polar(center, 5, (start * Math.PI) / 180),
            polar(center, 5, (end * Math.PI) / 180),
          ],
          { ccw, radius: 200 },
        ),
        points = tangentPoints(arc, { x: fromX, y: 0 });
      expect(points.map((point) => Math.sign(point.y)).sort()).toEqual(signs);
      for (const point of points) {
        expect(Math.abs(point.x)).toBeCloseTo(2.5, 10);
        expect(Math.abs(point.y)).toBeCloseTo((5 * Math.sqrt(3)) / 2, 10);
      }
    },
  );
  it.each([
    { start: Math.PI / 3, end: Math.PI / 2, ccw: true, sign: 1 },
    {
      start: Math.PI / 3 + geometry.EPS / 2,
      end: Math.PI / 2,
      ccw: true,
      sign: 1,
    },
    { start: 0, end: Math.PI / 3 - geometry.EPS / 2, ccw: true, sign: 1 },
    {
      start: -Math.PI / 3 - geometry.EPS / 2,
      end: -Math.PI / 2,
      ccw: false,
      sign: -1,
    },
    { start: 0, end: -Math.PI / 3 + geometry.EPS / 2, ccw: false, sign: -1 },
  ])(
    "includes exact and epsilon-close arc endpoints ($ccw, $sign)",
    ({ start, end, ccw, sign }) => {
      const center = { x: 0, y: 0 },
        arc = entity(
          "arc",
          [center, polar(center, 5, start), polar(center, 5, end)],
          { ccw },
        ),
        points = tangentPoints(arc, { x: 10, y: 0 });
      expect(points).toHaveLength(1);
      expect(Math.sign(points[0].y)).toBe(sign);
    },
  );
  it("captures a tangent on a short but geometrically valid arc", () => {
    const center = { x: 0, y: 0 },
      start = Math.PI / 3,
      arc = entity(
        "arc",
        [
          center,
          polar(center, 5, start),
          polar(center, 5, start + geometry.EPS / 2),
        ],
        { ccw: true },
      ),
      points = tangentPoints(arc, { x: 10, y: 0 });
    expect(geometry.dist(arc.points[1], arc.points[2])).toBeGreaterThan(
      geometry.EPS,
    );
    expect(points).toHaveLength(1);
    expectXY(points[0], { x: 2.5, y: (5 * Math.sqrt(3)) / 2 });
  });
  it.each([0.01, 3, 1000])(
    "preserves translated and scaled circle tangencies at scale %s",
    (scale) => {
      const center = { x: 20, y: -8 },
        circle = entity("circle", [center], { radius: 5 * scale }),
        points = tangentPoints(circle, {
          x: center.x + 13 * scale,
          y: center.y,
        });
      expect(points).toHaveLength(2);
      expectXY(points[0], {
        x: center.x + (25 * scale) / 13,
        y: center.y + (60 * scale) / 13,
      });
      expectXY(points[1], {
        x: center.x + (25 * scale) / 13,
        y: center.y - (60 * scale) / 13,
      });
    },
  );
});

describe("open path midpoint capture", () => {
  it("returns the analytic line average without an ID or reference", () => {
    const line = entity("line", [
      { x: -4, y: 10 },
      { x: 12, y: -2 },
    ]);
    expect(pathMidpoint(line)).toEqual({ x: 4, y: 4 });
  });
  it.each([
    { start: 0, end: 90, ccw: true, middle: 45 },
    { start: 0, end: 90, ccw: false, middle: -135 },
    { start: 170, end: -170, ccw: true, middle: 180 },
    { start: -170, end: 170, ccw: false, middle: -180 },
  ])(
    "uses half the actual $start to $end degree arc sweep (ccw=$ccw)",
    ({ start, end, ccw, middle }) => {
      const center = { x: 3, y: -4 },
        arc = entity(
          "arc",
          [
            center,
            polar(center, 5, (start * Math.PI) / 180),
            polar(center, 5, (end * Math.PI) / 180),
          ],
          { ccw },
        );
      expectXY(pathMidpoint(arc)!, polar(center, 5, (middle * Math.PI) / 180));
    },
  );
  it.each([
    entity("bezier", [
      { x: 0, y: 0 },
      { x: 1, y: 20 },
      { x: 5, y: -6 },
      { x: 30, y: 0 },
    ]),
    entity("spline", [
      { x: 0, y: 0 },
      { x: 2, y: 10 },
      { x: 7, y: -1 },
      { x: 30, y: 5 },
    ]),
    entity(
      "conic",
      [
        { x: 0, y: 0 },
        { x: 1, y: 18 },
        { x: 30, y: 0 },
      ],
      { weight: 0.6 },
    ),
  ])(
    "captures half the actual $kind path length, not a control or chord average",
    (curve) => {
      const path = geometry.paperPath(curve);
      try {
        const expected = path.getPointAt(path.length / 2),
          midpoint = pathMidpoint(curve)!;
        expectXY(midpoint, expected);
        expect(Object.keys(midpoint).sort()).toEqual(["x", "y"]);
        const [start, end] = pathEndpoints(curve),
          chordMidpoint = geometry.lerp(start, end, 0.5);
        expect(geometry.dist(midpoint, chordMidpoint)).toBeGreaterThan(0.5);
        if (curve.kind === "bezier")
          expect(
            geometry.dist(midpoint, geometry.bezierAt(curve.points, 0.5)),
          ).toBeGreaterThan(0.5);
        if (curve.kind === "conic")
          expect(
            geometry.dist(midpoint, geometry.conicAt(curve, 0.5)),
          ).toBeGreaterThan(0.5);
      } finally {
        path.remove();
      }
    },
  );
  it.each([false, true])(
    "removes temporary paths even when lookup throws: %s",
    (throws) => {
      const curve = entity("bezier", [
          { x: 0, y: 0 },
          { x: 1, y: 20 },
          { x: 5, y: -6 },
          { x: 30, y: 0 },
        ]),
        path = geometry.paperPath(curve),
        remove = vi.spyOn(path, "remove"),
        getPointAt = vi.spyOn(path, "getPointAt"),
        factory = vi.spyOn(geometry, "paperPath").mockReturnValue(path);
      try {
        if (throws) {
          getPointAt.mockImplementation(() => {
            throw new Error("lookup failed");
          });
          expect(() => pathMidpoint(curve)).toThrow("lookup failed");
        } else {
          expect(pathMidpoint(curve)).toBeDefined();
        }
        expect(remove).toHaveBeenCalledTimes(1);
      } finally {
        factory.mockRestore();
        getPointAt.mockRestore();
        remove.mockRestore();
        path.remove();
      }
    },
  );
  it("does not invent a midpoint for closed or non-path entities", () => {
    for (const candidate of [
      entity("circle", [{ x: 0, y: 0 }], { radius: 5 }),
      entity(
        "ellipse",
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
        { ry: 3 },
      ),
      entity("point", [{ x: 0, y: 0 }]),
      entity("text", [{ x: 0, y: 0 }], { text: "test" }),
    ])
      expect(pathMidpoint(candidate)).toBeUndefined();
  });
});

describe("path endpoint capture", () => {
  it.each(["line", "arc", "spline", "bezier", "conic"] as const)(
    "identifies actual %s path endpoints",
    (kind) => {
      const counts = { line: 2, arc: 3, spline: 5, bezier: 4, conic: 3 };
      const e = entity(
        kind,
        Array.from({ length: counts[kind] }, (_, i) => ({
          x: 10 + i * 10,
          y: 10 + i * 5,
        })),
        { ccw: true, weight: 1 },
      );
      const expected =
        kind === "arc"
          ? [e.points[1], e.points[2]]
          : [e.points[0], e.points.at(-1)!];
      expect(pathEndpoints(e)).toEqual(expected);
      expect(
        entitySnapPoints(e)
          .filter((point) => point.kind === "endpoint")
          .map((point) => point.ref),
      ).toEqual(expected.map((point) => point.id));
    },
  );
  it("does not describe circle centres, ellipse controls or interior spline points as endpoints", () => {
    const circle = entity("circle", [{ x: 0, y: 0 }], { radius: 4 });
    const ellipse = entity(
      "ellipse",
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
      ],
      { ry: 3 },
    );
    const spline = entity("spline", [
      { x: 0, y: 0 },
      { x: 5, y: 3 },
      { x: 10, y: 0 },
    ]);
    expect(pathEndpoints(circle)).toEqual([]);
    expect(pathEndpoints(ellipse)).toEqual([]);
    expect(entitySnapPoints(spline)[1].kind).toBe("point");
    const bezier = entity("bezier", [
      { x: 0, y: 0 },
      { x: 3, y: 7 },
      { x: 7, y: -3 },
      { x: 10, y: 0 },
    ]);
    expect(
      entitySnapPoints(bezier).map((point) => point.point.id),
    ).not.toContain(bezier.points[1].id);
  });
  it("captures endpoints before the first draw at a stable CSS-pixel tolerance", () => {
    const line = entity("line", [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ]);
    const r = new CanvasRenderer();
    r.sync([sketch([line])], "endpoint-test");
    for (const scale of [1, 4, 20]) {
      expect(r.snap({ x: 20 + 9 / scale, y: 20 }, frame(scale))).toMatchObject({
        kind: "endpoint",
        ref: line.points[0].id,
        point: { x: 20, y: 20 },
      });
      expect(r.snap({ x: 20 + 10 / scale, y: 20 }, frame(scale))?.ref).not.toBe(
        line.points[0].id,
      );
    }
  });
  it("prefers nearby endpoints over a closer midpoint, centre, or grid", () => {
    const line = entity("line", [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ]);
    const circle = entity("circle", [{ x: 21, y: 20 }], { radius: 3 });
    const short = entity("line", [
      { x: 16, y: 20 },
      { x: 26, y: 20 },
    ]);
    const r = new CanvasRenderer();
    r.sync([sketch([circle, short, line])], "endpoint-test");
    expect(r.snap({ x: 21, y: 20 }, { ...frame(), grid: true })).toMatchObject({
      kind: "endpoint",
      ref: line.points[0].id,
    });
  });
  it("captures derived endpoint coordinates without creating an unsupported reference", () => {
    const source = entity("line", [
      { x: 60, y: 60 },
      { x: 80, y: 60 },
    ]);
    const derived = entity(
      "line",
      [
        { x: 20, y: 20 },
        { x: 40, y: 20 },
      ],
      { sourceId: source.id, transform: { kind: "translate", x: -40, y: -40 } },
    );
    const s = sketch([source, derived]),
      r = new CanvasRenderer();
    r.sync([s], s.id);
    const captured = r.snap({ x: 20.2, y: 20.1 }, frame());
    expect(captured).toMatchObject({
      kind: "endpoint",
      point: { x: 20, y: 20 },
    });
    expect(captured?.ref).toBeUndefined();
    const drag = dragAnchor(s, { entityId: source.id }, [], source.points[0])!;
    expect(drag.excluded.has(derived.id)).toBe(true);
    expect(r.snap({ x: 20, y: 20 }, frame(), drag.excluded)).toBeNull();
  });
  it("promotes endpoints above lower-priority latched captures without border jitter", () => {
    const endpoint = {
      kind: "endpoint" as const,
      ref: "end",
      point: { x: 20, y: 20 },
    };
    const centre = {
      kind: "point" as const,
      ref: "centre",
      point: { x: 21, y: 20 },
    };
    expect(resolveDragSnap({ x: 21, y: 20 }, centre, endpoint, 4).snap).toEqual(
      endpoint,
    );
    expect(resolveDragSnap({ x: 21, y: 20 }, endpoint, centre, 4).snap).toEqual(
      endpoint,
    );
  });
  it("discards deleted endpoint IDs from the retained index", () => {
    const line = entity("line", [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ]);
    const r = new CanvasRenderer();
    r.sync([sketch([line])], "endpoint-test");
    r.sync([sketch([])], "endpoint-test");
    expect(r.snap({ x: 20, y: 20 }, frame())).toBeNull();
  });
});
