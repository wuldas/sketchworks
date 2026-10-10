import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import {
  clone,
  emptyDocument,
  entity,
  validateDocument,
  type Document,
} from "./model";
import { applyParameters } from "./parameters";
import { updateDerived, validGeometry } from "./geometry";
import { updateDimensionLabels } from "./dimensionLabel";
import { initSolver, solveSketch } from "./solver";
import {
  createCommandSession,
  operationGeometry,
  type CommandField,
  type CommandSession,
} from "./commandParameters";
import {
  createOperationCandidate,
  previewOperation,
  resolveOperationInput,
} from "./operationPreview";

const require = createRequire(import.meta.url);
beforeAll(() =>
  initSolver(
    require.resolve("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"),
  ),
);
const fixture = () => {
  const doc = emptyDocument(),
    s = doc.sketches[0];
  s.entities = [
    entity("circle", [{ x: 2, y: 3 }], { radius: 2 }),
    entity("line", [
      { x: 20, y: -10 },
      { x: 20, y: 10 },
    ]),
    entity("line", [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]),
  ];
  doc.parameters = [{ name: "pitch", expression: "12", unit: "mm" }];
  return {
    doc,
    s,
    source: s.entities[0],
    axis: s.entities[1],
    direction: s.entities[2],
  };
};
const field = (key: string, value: string, unit = "mm"): CommandField => ({
  key,
  label: key,
  value,
  unit,
});
function command(
  doc: Document,
  name: string,
  fields: CommandField[] = [],
): CommandSession {
  const s = doc.sketches[0];
  return createCommandSession(
    "operation",
    name,
    name,
    operationGeometry(name),
    fields,
    s,
    [{ entityId: s.entities[0].id }],
  );
}
const solve = (doc: Document) => {
  applyParameters(doc);
  for (const s of doc.sketches) {
    const result = solveSketch({
      ...s,
      entities: s.entities.filter((e) => !e.sourceId),
    });
    if (!result.ok) throw new Error("约束无法满足");
    updateDerived(s);
    validGeometry(s);
    updateDimensionLabels(s);
  }
};
const positions = (
  entities: NonNullable<ReturnType<typeof previewOperation>["entities"]>,
) => entities.map((e) => e.points[0]);

describe("read-only command previews with the real solver", () => {
  it("requires a mirror axis and previews its reflected copies without mutating the source", () => {
    const { doc, s, source, axis } = fixture(),
      session = command(doc, "mirror"),
      before = clone(doc);
    expect(previewOperation(doc, s.id, session, solve)).toMatchObject({
      entities: null,
      error: "请选择镜像线",
    });
    session.geometry[1].selections = [{ entityId: axis.id }];
    const preview = previewOperation(doc, s.id, session, solve);
    expect(preview.error).toBeNull();
    expect(preview.entities).toHaveLength(1);
    expect(preview.entities![0].sourceId).toBe(source.id);
    expect(preview.entities![0].points[0]).toMatchObject({ x: 38, y: 3 });
    expect(doc).toEqual(before);
    const confirmed = createOperationCandidate(
      doc,
      s.id,
      resolveOperationInput(doc, s.id, session),
    );
    solve(confirmed.document);
    const copy = confirmed.sketch.entities.find(
      (e) => e.sourceId === source.id,
    )!;
    expect(copy.points[0]).toMatchObject({ x: 38, y: 3 });
    expect(() => validateDocument(confirmed.document)).not.toThrow();
    preview.entities![0].points[0].x = -999;
    expect(doc).toEqual(before);
  });

  it("updates rectangular array spacing, directions and expressions using the confirmation rules", () => {
    const { doc, s, direction } = fixture();
    const session = command(doc, "rectangularArray", [
      field("cols", "3", ""),
      field("rows", "2", ""),
      field("dx", "pitch"),
      field("dy", "8"),
    ]);
    session.geometry[1].selections = [{ entityId: direction.id }];
    const before = clone(doc),
      preview = previewOperation(doc, s.id, session, solve);
    expect(preview.error).toBeNull();
    expect(preview.entities).toHaveLength(5);
    const expected = [
      [2, 15],
      [2, 27],
      [-6, 3],
      [-6, 15],
      [-6, 27],
    ];
    positions(preview.entities!).forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i][0], 7);
      expect(p.y).toBeCloseTo(expected[i][1], 7);
    });
    expect(
      preview.entities!.every((e) =>
        e.transform?.yExpression?.includes("pitch"),
      ),
    ).toBe(true);
    session.values.dx = "2*pitch";
    const updated = previewOperation(doc, s.id, session, solve);
    expect(updated.entities![0].points[0].y).toBeCloseTo(27, 7);
    expect(doc).toEqual(before);
  });

  it("honors range distribution and rejects invalid counts instead of retaining a stale preview", () => {
    const { doc, s } = fixture();
    const session = command(doc, "rectangularArray", [
      field("cols", "3", ""),
      field("rows", "1", ""),
      field("dx", "40"),
      field("dy", "0"),
    ]);
    session.values.distribution = "范围";
    expect(
      positions(previewOperation(doc, s.id, session, solve).entities!).map(
        (p) => p.x,
      ),
    ).toEqual([22, 42]);
    session.values.cols = "2.5";
    expect(previewOperation(doc, s.id, session, solve)).toMatchObject({
      entities: null,
      error: expect.stringContaining("整数"),
    });
    session.values.cols = "4";
    session.values.direction1 = "对称";
    expect(previewOperation(doc, s.id, session, solve)).toMatchObject({
      entities: null,
      error: expect.stringContaining("奇数"),
    });
  });

  it("previews circular arrays around a picked center", () => {
    const { doc, s } = fixture();
    const session = command(doc, "circularArray", [
      field("count", "4", ""),
      field("angle", "360", "°"),
      field("cx", "0"),
      field("cy", "0"),
    ]);
    session.geometry[1].position = { x: 2, y: 0 };
    const preview = previewOperation(doc, s.id, session, solve);
    expect(preview.error).toBeNull();
    expect(preview.entities).toHaveLength(3);
    const expected = [
      [-1, 0],
      [2, -3],
      [5, 0],
    ];
    positions(preview.entities!).forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i][0], 7);
      expect(p.y).toBeCloseTo(expected[i][1], 7);
    });
  });

  it("converts literal inches and referenced millimeters consistently", () => {
    const { doc, s } = fixture();
    doc.unit = "in";
    const session = command(doc, "move", [
      field("dx", "0.5", "in"),
      field("dy", "pitch", "in"),
    ]);
    const before = clone(doc),
      preview = previewOperation(doc, s.id, session, solve);
    expect(preview.error).toBeNull();
    expect(preview.entities![0].points[0].x).toBeCloseTo(14.7, 7);
    expect(preview.entities![0].points[0].y).toBeCloseTo(15, 7);
    expect(doc).toEqual(before);
  });

  it("clears previews for missing geometry and incomplete numeric input", () => {
    const { doc, s } = fixture();
    const session = command(doc, "move", [field("dx", "5"), field("dy", "0")]);
    expect(previewOperation(doc, s.id, session, solve).entities).toHaveLength(
      1,
    );
    session.values.dx = "1+";
    expect(previewOperation(doc, s.id, session, solve)).toMatchObject({
      entities: null,
      error: expect.stringContaining("dx"),
    });
    session.values.dx = "5";
    session.geometry[0].selections = [];
    expect(previewOperation(doc, s.id, session, solve)).toMatchObject({
      entities: null,
      error: "请选择对象",
    });
  });

  it("does not preview or mutate a fixed source that cannot move", () => {
    const { doc, s, source } = fixture();
    s.constraints.push({ id: "fixed", kind: "fixed", refs: [source.id] });
    const before = clone(doc),
      session = command(doc, "move", [field("dx", "5"), field("dy", "0")]);
    expect(previewOperation(doc, s.id, session, solve)).toMatchObject({
      entities: null,
      error: expect.stringContaining("固定"),
    });
    expect(doc).toEqual(before);
  });

  it("rejects an otherwise valid transform when its solved constraints fail", () => {
    const { doc, s, source } = fixture();
    s.constraints.push({
      id: "radius",
      kind: "radius",
      refs: [source.id],
      value: -1,
    });
    const before = clone(doc),
      session = command(doc, "move", [field("dx", "5"), field("dy", "0")]);
    expect(previewOperation(doc, s.id, session, solve)).toMatchObject({
      entities: null,
      error: "约束无法满足",
    });
    expect(doc).toEqual(before);
  });

  it("shows both the moved source and its changed dependent copies", () => {
    const { doc, s, source } = fixture();
    const array = command(doc, "rectangularArray", [
      field("cols", "2", ""),
      field("rows", "1", ""),
      field("dx", "20"),
      field("dy", "0"),
    ]);
    const base = createOperationCandidate(
      doc,
      s.id,
      resolveOperationInput(doc, s.id, array),
    );
    solve(base.document);
    const before = clone(base.document),
      move = command(base.document, "move", [
        field("dx", "5"),
        field("dy", "4"),
      ]);
    const preview = previewOperation(base.document, s.id, move, solve);
    expect(preview.entities).toHaveLength(2);
    expect(
      preview.entities!.find((e) => e.id === source.id)!.points[0],
    ).toMatchObject({ x: 7, y: 7 });
    expect(
      preview.entities!.find((e) => e.sourceId === source.id)!.points[0],
    ).toMatchObject({ x: 27, y: 7 });
    expect(base.document).toEqual(before);
  });

  it("clears previews when no supported operation remains active", () => {
    const { doc, s } = fixture();
    expect(previewOperation(doc, s.id, null, solve)).toEqual({
      entities: null,
      error: null,
    });
    expect(previewOperation(doc, s.id, command(doc, "detach"), solve)).toEqual({
      entities: null,
      error: null,
    });
  });
});
