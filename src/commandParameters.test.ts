import { describe, expect, it } from "vitest";
import { emptyDocument, entity, type Selection } from "./model";
import {
  commandSelections,
  constraintGeometry,
  createCommandSession,
  normalizeParameterSelection,
  operationGeometry,
  updateCommandSelection,
} from "./commandParameters";

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
