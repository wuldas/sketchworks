declare module "clipper-lib" {
  namespace ClipperLib {
    interface IntPoint {
      X: number;
      Y: number;
    }
    type Path = IntPoint[];
    type Paths = Path[];
    class ClipperOffset {
      constructor(miterLimit?: number, arcTolerance?: number);
      AddPath(path: Path, joinType: number, endType: number): void;
      Execute(solution: Paths, delta: number): void;
    }
    const JoinType: { jtMiter: number; jtRound: number; jtSquare: number };
    const EndType: { etClosedPolygon: number; etOpenButt: number };
    const PolyFillType: { pftEvenOdd: number };
    class Clipper {
      static Area(path: Path): number;
      static SimplifyPolygons(paths: Paths, fillType: number): Paths;
    }
  }
  export = ClipperLib;
}
