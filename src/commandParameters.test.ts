import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  emptyDocument,
  entity,
  type ConstraintKind,
  type Selection,
  type Sketch,
} from "./model";
import {
  commandSelections,
  commandGeometryError,
  constraintGeometry,
  createCommandSession,
  normalizeParameterSelection,
  operationGeometry,
  updateCommandSelection,
  selectionKey,
} from "./commandParameters";
import { canConstrain, initSolver, solveSketch } from "./solver";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);

const fixture = () => {
  const s = emptyDocument().sketches[0];
  s.entities = [
    entity("line", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    entity("line", [
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    ]),
    entity("point", [{ x: 5, y: 2 }]),
    entity("point", [{ x: 7, y: 4 }]),
  ];
  return s;
};

describe("command parameter selection regressions", () => {
  it("toggles a single axis off and replaces it with another line", () => {
    const s = fixture();
    const session = createCommandSession(
      "operation",
      "mirror",
      "镜像",
      operationGeometry("mirror"),
      [],
      s,
      [{ entityId: s.entities[0].id }],
    );
    const axis = { entityId: s.entities[1].id };
    const filled = updateCommandSelection(session, s, [axis]).session;
    expect(filled.geometry[1].selections).toEqual([axis]);
    const empty = updateCommandSelection(filled, s, [axis]).session;
    expect(empty.geometry[1].selections).toEqual([]);
    expect(empty.geometry[0].selections).toEqual(
      session.geometry[0].selections,
    );
    const another = entity("line", [
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);
    s.entities.push(another);
    const changed = updateCommandSelection(filled, s, [
      { entityId: another.id },
    ]).session;
    expect(changed.geometry[1].selections).toEqual([{ entityId: another.id }]);
  });

  it("canonicalizes standalone point references so one point cannot occupy both coincidence inputs", () => {
    const s = fixture(),
      p = s.entities[2],
      q = s.entities[3];
    const session = createCommandSession(
      "constraint",
      "coincident",
      "重合",
      constraintGeometry("coincident"),
      [],
      s,
      [{ entityId: p.id }],
    );
    expect(session.geometry[0].selections).toEqual([
      { entityId: p.id, pointId: p.points[0].id },
    ]);
    const same = updateCommandSelection(session, s, [
      { entityId: p.id, pointId: p.points[0].id },
    ]);
    expect(same.error).toBeTruthy();
    expect(same.session).toBe(session);
    const other = updateCommandSelection(session, s, [{ entityId: q.id }]);
    expect(other.error).toBeUndefined();
    expect(commandSelections(other.session)).toEqual([
      { entityId: p.id, pointId: p.points[0].id },
      { entityId: q.id, pointId: q.points[0].id },
    ]);
  });

  it("rejects stale point references instead of selecting their parent", () => {
    const s = fixture();
    expect(
      normalizeParameterSelection(s, operationGeometry("copy")[0], {
        entityId: s.entities[0].id,
        pointId: "deleted",
      }),
    ).toBeNull();
  });

  it("allows independent copies and offsets of derived geometry but rejects derived mirror axes", () => {
    const s = fixture(),
      derived = s.entities[1];
    derived.sourceId = s.entities[0].id;
    derived.transform = { kind: "translate", y: 5 };
    const picked: Selection = { entityId: derived.id };
    for (const op of ["copy", "offset", "detach"]) {
      const session = createCommandSession(
        "operation",
        op,
        op,
        operationGeometry(op),
        [],
        s,
        [picked],
      );
      expect(session.geometry[0].selections).toEqual([picked]);
    }
    expect(
      normalizeParameterSelection(s, operationGeometry("mirror")[1], picked),
    ).toBeNull();
    expect(
      normalizeParameterSelection(s, operationGeometry("move")[0], picked),
    ).toBeNull();
  });

  it("lets array direction reuse a source edge in either input order", () => {
    const s = fixture(),
      line = { entityId: s.entities[0].id };
    const session = createCommandSession(
      "operation",
      "rectangularArray",
      "矩形阵列",
      operationGeometry("rectangularArray"),
      [],
      s,
      [line],
    );
    const direction = updateCommandSelection(session, s, [line]);
    expect(direction.error).toBeUndefined();
    const clearedObjects = {
      ...direction.session,
      active: 0,
      geometry: direction.session.geometry.map((p, i) =>
        i === 0 ? { ...p, selections: [] } : p,
      ),
    };
    expect(
      updateCommandSelection(clearedObjects, s, [line]).error,
    ).toBeUndefined();
  });
});

describe("circle bodies in point constraint parameters", () => {
  const apply = (
    s: Sketch,
    kind: ConstraintKind,
    picks: Selection[],
    preselect = false,
  ) => {
    let session = createCommandSession(
      "constraint",
      kind,
      kind,
      constraintGeometry(kind),
      [],
      s,
      preselect ? picks : [],
    );
    if (!preselect)
      for (const pick of picks) {
        const updated = updateCommandSelection(session, s, [pick]);
        expect(updated.error).toBeUndefined();
        session = updated.session;
      }
    expect(commandGeometryError(session)).toBeNull();
    const refs = commandSelections(session).map(selectionKey);
    expect(canConstrain(s, kind, refs)).toBeNull();
    s.constraints.push({ id: "picked-constraint", kind, refs });
    return refs;
  };
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  };

  it("preselected circle coincidence follows the live target point without constraining radius", () => {
    const s = emptyDocument().sketches[0],
      circle = entity("circle", [{ x: 7, y: 11 }], { radius: 5 }),
      target = entity("point", [{ x: -3, y: 4 }]);
    s.entities.push(circle, target);
    s.constraints.push({ id: "anchor", kind: "fixed", refs: [target.id] });
    apply(
      s,
      "coincident",
      [{ entityId: circle.id }, { entityId: target.id }],
      true,
    );
    expect(solveSketch(s).ok).toBe(true);
    near(circle.points[0], { x: -3, y: 4 });
    expect(circle.radius).toBeCloseTo(5, 6);
    s.constraints = s.constraints.filter((c) => c.id !== "anchor");
    const moved = { pointId: target.points[0].id, x: 30, y: -4, exact: true };
    expect(solveSketch(s, moved).ok).toBe(true);
    near(circle.points[0], moved);
    near(target.points[0], moved);
    circle.radius = 9;
    expect(solveSketch(s).ok).toBe(true);
    near(circle.points[0], target.points[0]);
    expect(circle.radius).toBeCloseTo(9, 6);
    expect(s.entities).toHaveLength(2);
  });

  it.each(["horizontal", "vertical"] as const)(
    "%s aligns two picked circle centers instead of their circumferences",
    (kind) => {
      const s = emptyDocument().sketches[0],
        a = entity("circle", [{ x: 0, y: 0 }], { radius: 6 }),
        b = entity("circle", [{ x: 10, y: 7 }], { radius: 4 });
      s.entities.push(a, b);
      s.constraints.push({ id: "anchor", kind: "fixed", refs: [a.id] });
      apply(s, kind, [{ entityId: a.id }, { entityId: b.id }]);
      expect(solveSketch(s).ok).toBe(true);
      near(
        b.points[0],
        kind === "horizontal" ? { x: 10, y: 0 } : { x: 0, y: 7 },
      );
      expect(a.radius).toBeCloseTo(6, 6);
      expect(b.radius).toBeCloseTo(4, 6);
    },
  );

  it("a circle center lies on another circle while that curve input retains its radius", () => {
    const s = emptyDocument().sketches[0],
      pointCircle = entity("circle", [{ x: 5, y: 6 }], { radius: 3 }),
      curveCircle = entity("circle", [{ x: 0, y: 0 }], { radius: 10 });
    s.entities.push(pointCircle, curveCircle);
    s.constraints.push({ id: "anchor", kind: "fixed", refs: [curveCircle.id] });
    apply(s, "onCurve", [
      { entityId: pointCircle.id },
      { entityId: curveCircle.id },
    ]);
    expect(solveSketch(s).ok).toBe(true);
    expect(
      Math.hypot(pointCircle.points[0].x, pointCircle.points[0].y),
    ).toBeCloseTo(10, 6);
    near(curveCircle.points[0], { x: 0, y: 0 });
    expect(pointCircle.radius).toBeCloseTo(3, 6);
    expect(curveCircle.radius).toBeCloseTo(10, 6);
  });

  it("three picked circle bodies define symmetry about the third center", () => {
    const s = emptyDocument().sketches[0],
      a = entity("circle", [{ x: -6, y: 2 }], { radius: 3 }),
      b = entity("circle", [{ x: 4, y: 7 }], { radius: 4 }),
      center = entity("circle", [{ x: 1, y: 1 }], { radius: 2 });
    s.entities.push(a, b, center);
    s.constraints.push(
      { id: "a", kind: "fixed", refs: [a.id] },
      { id: "center", kind: "fixed", refs: [center.id] },
    );
    apply(
      s,
      "symmetric",
      [a, b, center].map((e) => ({ entityId: e.id })),
      true,
    );
    expect(solveSketch(s).ok).toBe(true);
    near(b.points[0], { x: 8, y: 0 });
    expect(b.radius).toBeCloseTo(4, 6);
  });

  it("origin coincidence fixes only the center and leaves the radius free", () => {
    const s = emptyDocument().sketches[0],
      circle = entity("circle", [{ x: 7, y: 11 }], { radius: 5 });
    s.entities.push(circle);
    apply(s, "origin", [{ entityId: circle.id }]);
    expect(solveSketch(s)).toMatchObject({ ok: true, dof: 1 });
    near(circle.points[0], { x: 0, y: 0 });
    circle.radius = 9;
    expect(solveSketch(s)).toMatchObject({ ok: true, dof: 1 });
    near(circle.points[0], { x: 0, y: 0 });
    expect(circle.radius).toBeCloseTo(9, 6);
  });

  it("fixed keeps whole-circle semantics when the parameter accepts objects", () => {
    const s = emptyDocument().sketches[0],
      circle = entity("circle", [{ x: 7, y: 11 }], { radius: 5 });
    s.entities.push(circle);
    apply(s, "fixed", [{ entityId: circle.id }]);
    expect(solveSketch(s)).toMatchObject({ ok: true, dof: 0 });
    near(circle.points[0], { x: 7, y: 11 });
    expect(circle.radius).toBeCloseTo(5, 6);
  });

  it("equal uses the two circle radii without moving their centers", () => {
    const s = emptyDocument().sketches[0],
      a = entity("circle", [{ x: 0, y: 0 }], { radius: 5 }),
      b = entity("circle", [{ x: 10, y: 10 }], { radius: 9 });
    s.entities.push(a, b);
    s.constraints.push({ id: "anchor", kind: "fixed", refs: [a.id] });
    apply(s, "equal", [{ entityId: a.id }, { entityId: b.id }]);
    expect(solveSketch(s).ok).toBe(true);
    near(b.points[0], { x: 10, y: 10 });
    expect(b.radius).toBeCloseTo(5, 6);
  });

  it("the circle body and its center handle cannot occupy both coincidence inputs", () => {
    const s = emptyDocument().sketches[0],
      circle = entity("circle", [{ x: 7, y: 11 }], { radius: 5 });
    s.entities.push(circle);
    const session = createCommandSession(
      "constraint",
      "coincident",
      "重合",
      constraintGeometry("coincident"),
      [],
      s,
      [{ entityId: circle.id }],
    );
    const repeated = updateCommandSelection(session, s, [
      { entityId: circle.id, pointId: circle.points[0].id },
    ]);
    expect(repeated.error).toBeTruthy();
    expect(commandGeometryError(repeated.session)).not.toBeNull();
    expect(s.constraints).toEqual([]);
  });

  it.each(["stale", "derived"] as const)(
    "rejects a %s circle selection without falling back to its center",
    (kind) => {
      const s = emptyDocument().sketches[0],
        circle = entity("circle", [{ x: 7, y: 11 }], { radius: 5 });
      s.entities.push(circle);
      if (kind === "derived") {
        const source = entity("circle", [{ x: -3, y: 11 }], { radius: 5 });
        s.entities.unshift(source);
        circle.sourceId = source.id;
        circle.transform = { kind: "translate", x: 10 };
      }
      const session = createCommandSession(
        "constraint",
        "coincident",
        "重合",
        constraintGeometry("coincident"),
        [],
        s,
        [],
      );
      const picked = updateCommandSelection(session, s, [
        {
          entityId: circle.id,
          ...(kind === "stale" ? { pointId: "deleted" } : {}),
        },
      ]);
      expect(picked.error).toBeTruthy();
      expect(commandGeometryError(picked.session)).not.toBeNull();
      expect(s.constraints).toEqual([]);
    },
  );
});
