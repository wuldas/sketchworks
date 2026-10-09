import { describe, expect, it } from "vitest";
import { connectedContour } from "./connectedSelection";
import {
  type Constraint,
  type Entity,
  type EntityKind,
  type Sketch,
} from "./model";

type Coord = [number, number];
const shape = (
  kind: EntityKind,
  id: string,
  coords: Coord[],
  extra: Partial<Entity> = {},
): Entity => ({
  kind,
  id,
  name: id,
  points: coords.map(([x, y], index) => ({ id: `${id}_p${index}`, x, y })),
  ...extra,
});
const line = (id: string, a: Coord, b: Coord) => shape("line", id, [a, b]);
const sketch = (
  entities: Entity[],
  constraints: Constraint[] = [],
): Sketch => ({
  id: "contours",
  name: "Contours",
  visible: true,
  entities,
  constraints,
});
const ids = (entities: Entity[]) => entities.map((entity) => entity.id);
const closed = (coords: Coord[]) =>
  coords.map((a, index) =>
    line(`edge${index}`, a, coords[(index + 1) % coords.length]),
  );

// Freezing catches accidental changes to coordinates, constraint references, or
// document ordering rather than merely comparing the selected IDs.
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

describe("connected contour selection", () => {
  it("follows a chain in either direction and returns document order", () => {
    const a = line("a", [0, 0], [10, 0]),
      b = line("b", [20, 5], [10, 0]),
      c = line("c", [20, 5], [30, 5]),
      detached = line("detached", [50, 20], [60, 20]),
      doc = freeze(sketch([c, detached, a, b]));
    for (const start of [a, b, c])
      expect(connectedContour(doc, start.id)).toEqual(["c", "a", "b"]);
    expect(connectedContour(doc, "missing")).toEqual([]);
  });

  it.each([
    [
      "rectangle",
      [
        [0, 0],
        [20, 0],
        [20, 15],
        [0, 15],
      ] as Coord[],
    ],
    [
      "polygon",
      [
        [0, 0],
        [15, 0],
        [22, 12],
        [12, 22],
        [-8, 12],
      ] as Coord[],
    ],
  ])("selects an entire %s cycle without detached geometry", (_, coords) => {
    const ring = closed(coords),
      detached = line("detached", [60, 0], [70, 0]),
      doc = freeze(sketch([...ring, detached]));
    for (const edge of ring) {
      expect(connectedContour(doc, edge.id)).toEqual(ids(ring));
      expect(connectedContour(doc, edge.id, true)).toEqual(ids(ring));
    }
  });

  it("covers a rectangle ring up to its branched corner without spreading into the branch", () => {
    const ring = closed([
        [0, 0],
        [20, 0],
        [20, 15],
        [0, 15],
      ]),
      branch = line("branch", [0, 0], [-10, -10]),
      outer = line("outer", [-10, -10], [-20, -10]),
      doc = sketch([...ring, branch, outer]);
    for (const edge of ring) {
      expect(connectedContour(doc, edge.id)).toEqual(ids(ring));
      expect(connectedContour(doc, edge.id, true)).toEqual(ids(doc.entities));
    }
    expect(connectedContour(doc, branch.id)).toEqual(["branch", "outer"]);
  });

  it.each([3, 4])(
    "stops at a %i-way endpoint branch from entry and interior chain edges",
    (degree) => {
      const entry = line("entry", [-10, 0], [0, 0]),
        interior = line("interior", [-20, 0], [-10, 0]),
        tail = line("tail", [-20, 0], [-30, 0]),
        right = line("right", [10, 0], [0, 0]),
        up = line("up", [0, 0], [0, 10]),
        down = line("down", [0, -10], [0, 0]),
        entities = [
          up,
          tail,
          entry,
          right,
          interior,
          ...(degree === 4 ? [down] : []),
        ],
        doc = freeze(sketch(entities));
      for (const start of [entry, interior, tail]) {
        expect(connectedContour(doc, start.id)).toEqual([
          "tail",
          "entry",
          "interior",
        ]);
        expect(connectedContour(doc, start.id, true)).toEqual(ids(entities));
      }
      for (const start of [right, up, ...(degree === 4 ? [down] : [])]) {
        expect(connectedContour(doc, start.id)).toEqual([start.id]);
        expect(connectedContour(doc, start.id, true)).toEqual(ids(entities));
      }
    },
  );

  it.each([3, 4])(
    "splits a straight line at an interior %i-way T junction and respects the clicked side",
    (degree) => {
      const trunk = line("trunk", [-10, 0], [10, 0]),
        left = line("left", [-20, 0], [-10, 0]),
        right = line("right", [20, 0], [10, 0]),
        up = line("up", [0, 0], [0, 10]),
        down = line("down", [0, -10], [0, 0]),
        entities = [right, up, trunk, left, ...(degree === 4 ? [down] : [])],
        doc = sketch(entities);
      expect(connectedContour(doc, "trunk", false, { x: -5, y: 0 })).toEqual([
        "trunk",
        "left",
      ]);
      expect(connectedContour(doc, "trunk", false, { x: 5, y: 0 })).toEqual([
        "right",
        "trunk",
      ]);
      expect(connectedContour(doc, "left")).toEqual(["trunk", "left"]);
      expect(connectedContour(doc, "right")).toEqual(["right", "trunk"]);
      expect(connectedContour(doc, "up")).toEqual(["up"]);
      for (const start of entities)
        expect(connectedContour(doc, start.id, true)).toEqual(ids(entities));
      trunk.points.reverse();
      expect(connectedContour(doc, "trunk", false, { x: -5, y: 0 })).toEqual([
        "trunk",
        "left",
      ]);
      expect(connectedContour(doc, "trunk", false, { x: 5, y: 0 })).toEqual([
        "right",
        "trunk",
      ]);
    },
  );

  it("does not pass either of two interior T junctions when clicking the middle subedge", () => {
    const doc = sketch([
      line("left", [-20, 0], [-10, 0]),
      line("trunk", [-10, 0], [10, 0]),
      line("right", [10, 0], [20, 0]),
      line("first-branch", [-3, 0], [-3, 10]),
      line("second-branch", [3, 0], [3, 10]),
    ]);
    expect(connectedContour(doc, "trunk", false, { x: 0, y: 0 })).toEqual([
      "trunk",
    ]);
    expect(connectedContour(doc, "trunk", true, { x: 0, y: 0 })).toEqual(
      ids(doc.entities),
    );
  });

  it("keeps crossing interiors separate even when branch traversal is requested", () => {
    const doc = sketch([
      line("horizontal", [-10, 0], [10, 0]),
      line("vertical", [0, -10], [0, 10]),
      line("diagonal", [-5, -5], [5, 5]),
    ]);
    for (const entity of doc.entities)
      expect(connectedContour(doc, entity.id, true)).toEqual([entity.id]);
  });

  it.each([0, 0.999999e-6, 1e-6, 1.000001e-6])(
    "joins different point IDs only within 1e-6 (%s)",
    (gap) => {
      const doc = sketch([
        line("first", [0, 0], [10, 0]),
        line("second", [10 + gap, 0], [20, 0]),
      ]);
      expect(connectedContour(doc, "first")).toEqual(
        gap <= 1e-6 ? ["first", "second"] : ["first"],
      );
    },
  );

  it("uses Euclidean endpoint tolerance rather than just a bounding box", () => {
    const doc = sketch([
      line("first", [0, 0], [10, 0]),
      line("second", [10 + 0.8e-6, 0.8e-6], [20, 10]),
    ]);
    expect(connectedContour(doc, "first", true)).toEqual(["first"]);
  });

  it.each([0.5e-6, 1.1e-6])(
    "uses endpoint tolerance for near T-junctions (%s)",
    (gap) => {
      const doc = sketch([
        line("trunk", [-10, 0], [10, 0]),
        line("branch", [0, gap], [0, 10]),
      ]);
      expect(connectedContour(doc, "trunk", false, { x: -5, y: 0 })).toEqual([
        "trunk",
      ]);
      expect(connectedContour(doc, "trunk", true)).toEqual(
        gap < 1e-6 ? ["trunk", "branch"] : ["trunk"],
      );
    },
  );

  it("joins only explicit coincident endpoint refs, including transitive refs", () => {
    const a = line("a", [0, 0], [10, 0]),
      b = line("b", [20, 0], [30, 0]),
      c = line("c", [40, 0], [50, 0]),
      doc = freeze(
        sketch(
          [c, a, b],
          [
            {
              id: "ab",
              kind: "coincident",
              refs: [a.points[1].id, b.points[0].id],
            },
            {
              id: "bc",
              kind: "coincident",
              refs: [b.points[1].id, c.points[0].id],
            },
          ],
        ),
      );
    expect(connectedContour(doc, "a")).toEqual(["c", "a", "b"]);
  });

  it("ignores direction, equality, angle and other non-topological relationships", () => {
    const a = line("a", [0, 0], [10, 0]),
      b = line("b", [30, 0], [40, 0]),
      kinds = [
        "angle",
        "parallel",
        "perpendicular",
        "equal",
        "collinear",
        "tangent",
        "midpoint",
        "onLine",
      ] as const,
      doc = sketch(
        [a, b],
        kinds.map((kind) => ({ id: kind, kind, refs: [a.id, b.id] })),
      );
    expect(connectedContour(doc, "a", true)).toEqual(["a"]);
  });

  it("follows endpoints of all supported open curve types", () => {
    const entities = [
      line("line", [-30, 0], [-20, 0]),
      shape("arc", "arc", [
        [-10, 0],
        [-20, 0],
        [0, 0],
      ]),
      shape("spline", "spline", [
        [0, 0],
        [5, 5],
        [10, 0],
      ]),
      shape("bezier", "bezier", [
        [10, 0],
        [14, 5],
        [16, 5],
        [20, 0],
      ]),
      shape(
        "conic",
        "conic",
        [
          [20, 0],
          [25, 5],
          [30, 0],
        ],
        { weight: 0.7 },
      ),
      line("end", [40, 0], [30, 0]),
    ];
    const doc = freeze(sketch(entities));
    for (const entity of entities)
      expect(connectedContour(doc, entity.id)).toEqual(ids(entities));
  });

  it.each([
    [
      "arc",
      [
        [0, 0],
        [-10, 0],
        [10, 0],
      ] as Coord[],
    ],
    [
      "spline",
      [
        [-10, 0],
        [0, 0],
        [10, 0],
      ] as Coord[],
    ],
    [
      "bezier",
      [
        [-10, -5],
        [0, 0],
        [2, 6],
        [10, -5],
      ] as Coord[],
    ],
    [
      "conic",
      [
        [-10, -5],
        [0, 0],
        [10, -5],
      ] as Coord[],
    ],
  ] as const)(
    "does not use an %s center or interior control as an endpoint",
    (kind, coords) => {
      const curve = shape(kind, "curve", [...coords]),
        branch = line("branch", [0, 0], [0, 30]),
        middle = curve.points.find((point) => point.x === 0 && point.y === 0)!,
        doc = sketch(
          [curve, branch],
          [
            {
              id: "control-coincident",
              kind: "coincident",
              refs: [middle.id, branch.points[0].id],
            },
          ],
        );
      expect(connectedContour(doc, "curve", true)).toEqual(["curve"]);
      expect(connectedContour(doc, "branch", true)).toEqual(["branch"]);
    },
  );

  it.each(["circle", "ellipse", "point", "text"] as const)(
    "selects an isolated %s as one entity",
    (kind) => {
      const single = shape(
          kind,
          "single",
          kind === "ellipse"
            ? [
                [0, 0],
                [2, 0],
              ]
            : [[0, 0]],
          { radius: 5, text: "text" },
        ),
        path = line("path", [0, 0], [10, 0]),
        doc = sketch(
          [single, path],
          [
            {
              id: "center-coincident",
              kind: "coincident",
              refs: [single.points[0].id, path.points[0].id],
            },
          ],
        );
      expect(connectedContour(doc, "single", true)).toEqual(["single"]);
      expect(connectedContour(doc, "path", true)).toEqual(["path"]);
    },
  );

  it("includes fixed, construction, and derived geometry without modifying the sketch", () => {
    const source = line("source", [0, 0], [10, 0]),
      derived = shape(
        "line",
        "derived",
        [
          [10, 0],
          [20, 0],
        ],
        {
          construction: true,
          sourceId: source.id,
          transform: { kind: "translate", x: 10, y: 0 },
        },
      ),
      doc = freeze(
        sketch(
          [source, derived],
          [{ id: "fixed", kind: "fixed", refs: [source.id] }],
        ),
      ),
      before = structuredClone(doc);
    expect(connectedContour(doc, source.id)).toEqual([source.id, derived.id]);
    expect(connectedContour(doc, derived.id, true)).toEqual([
      source.id,
      derived.id,
    ]);
    expect(doc).toEqual(before);
  });

  it("handles coincident endpoints at the same virtual cut as a branch", () => {
    const doc = sketch([
      line("trunk", [-10, 0], [10, 0]),
      line("up", [0, 0.8e-6], [0, 10]),
      line("down", [0, -0.8e-6], [0, -10]),
    ]);
    expect(connectedContour(doc, "up")).toEqual(["up"]);
    expect(connectedContour(doc, "down")).toEqual(["down"]);
    expect(connectedContour(doc, "trunk", true)).toEqual(ids(doc.entities));
  });

  it("keeps collapsed paths selectable and safely visits a coincident cycle", () => {
    const collapsed = line("collapsed", [0, 0], [0, 0]),
      doc = freeze(sketch([collapsed]));
    expect(connectedContour(doc, "collapsed")).toEqual(["collapsed"]);
    expect(connectedContour(doc, "collapsed", true)).toEqual(["collapsed"]);
  });
});
