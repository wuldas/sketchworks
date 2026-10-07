import { describe, expect, it } from "vitest";
import { entity, emptyDocument, clone, type Document } from "./model";
import { solveDrag, type DocumentSolver } from "./dragTransaction";
import { type DragEvent } from "./dragging";

const success = (dof = 2) => ({
  ok: true,
  dof,
  status: "Success",
  conflicting: [],
});
const fixture = () => {
  const document = emptyDocument();
  const point = entity("point", [{ x: 3, y: 7 }]);
  document.sketches[0].entities.push(point);
  return { document, point, sketchId: document.sketches[0].id };
};
const fakeSolver: DocumentSolver = (document, driver) => {
  if (driver) {
    const point = document.sketches
      .flatMap((sketch) => sketch.entities.flatMap((entity) => entity.points))
      .find((point) => point.id === driver.pointId)!;
    point.x = driver.x;
    point.y = driver.y;
  }
  return success(driver?.exact ? 0 : 2);
};

describe("atomic drag transactions", () => {
  it("applies a final exact target and reports canonical DOF without writing constraints", () => {
    const { document, point, sketchId } = fixture(),
      before = clone(document);
    const event: DragEvent = {
      entityId: point.id,
      pointId: point.points[0].id,
      delta: { x: 7, y: 13 },
      target: { x: 10, y: 20 },
      phase: "end",
      exact: true,
    };
    const result = solveDrag(document, sketchId, [], event, fakeSolver);
    expect(result.point).toEqual(event.target);
    expect(result.result.dof).toBe(2);
    expect(result.document.sketches[0].constraints).toEqual([]);
    expect(document).toEqual(before);
  });
  it("rejects a canonical solve that drifts from the promised capture atomically", () => {
    const { document, point, sketchId } = fixture(),
      before = clone(document);
    const solve: DocumentSolver = (candidate, driver) => {
      const result = fakeSolver(candidate, driver);
      if (!driver) candidate.sketches[0].entities[0].points[0].x += 0.01;
      return result;
    };
    expect(() =>
      solveDrag(
        document,
        sketchId,
        [],
        {
          entityId: point.id,
          pointId: point.points[0].id,
          delta: { x: 7, y: 13 },
          target: { x: 10, y: 20 },
          phase: "end",
          exact: true,
        },
        solve,
      ),
    ).toThrow("捕获位置");
    expect(document).toEqual(before);
  });
  it("allows best-feasible soft move feedback without claiming an exact capture", () => {
    const { document, point, sketchId } = fixture();
    const solve: DocumentSolver = (candidate, driver) => {
      const result = fakeSolver(candidate, driver);
      candidate.sketches[0].entities[0].points[0].y = 7;
      return result;
    };
    const result = solveDrag(
      document,
      sketchId,
      [],
      {
        entityId: point.id,
        pointId: point.points[0].id,
        delta: { x: 7, y: 13 },
        target: { x: 10, y: 20 },
        phase: "move",
      },
      solve,
    );
    expect(result.point).toEqual({ x: 10, y: 7 });
  });
  it("translates a selected free group by the anchor delta while preserving relative offsets", () => {
    const { document, point, sketchId } = fixture();
    const second = entity("point", [{ x: 12, y: 11 }]);
    document.sketches[0].entities.push(second);
    const result = solveDrag(
      document,
      sketchId,
      [{ entityId: point.id }, { entityId: second.id }],
      {
        entityId: point.id,
        delta: { x: 7, y: 13 },
        target: { x: 10, y: 20 },
        phase: "end",
        exact: true,
      },
      fakeSolver,
    );
    expect(
      result.document.sketches[0].entities.map((entity) => ({
        x: entity.points[0].x,
        y: entity.points[0].y,
      })),
    ).toEqual([
      { x: 10, y: 20 },
      { x: 19, y: 24 },
    ]);
  });
  it("rejects whole-body translation of a group containing a fixed control", () => {
    const { document, point, sketchId } = fixture();
    document.sketches[0].constraints.push({
      id: "fixed",
      kind: "fixed",
      refs: [point.points[0].id],
    });
    expect(() =>
      solveDrag(
        document,
        sketchId,
        [],
        {
          entityId: point.id,
          delta: { x: 7, y: 13 },
          target: { x: 10, y: 20 },
          phase: "end",
          exact: true,
        },
        fakeSolver,
      ),
    ).toThrow("固定对象");
    expect(point.points[0]).toMatchObject({ x: 3, y: 7 });
  });
  it("does not publish any candidate if the driver solve fails", () => {
    const { document, point, sketchId } = fixture(),
      before = clone(document);
    const solve: DocumentSolver = (candidate) => {
      candidate.sketches[0].entities[0].points[0].x = 999;
      return {
        ok: false,
        dof: 0,
        status: "Failed",
        conflicting: [],
        message: "unreachable",
      };
    };
    expect(() =>
      solveDrag(
        document,
        sketchId,
        [],
        {
          entityId: point.id,
          delta: { x: 7, y: 13 },
          target: { x: 10, y: 20 },
          phase: "end",
          exact: true,
        },
        solve,
      ),
    ).toThrow("unreachable");
    expect(document).toEqual(before);
  });
});
