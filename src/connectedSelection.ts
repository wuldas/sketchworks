import RBush from "rbush";
import { dist, projection } from "./geometry";
import { type Entity, type Point, type Sketch, type XY } from "./model";
import { pathEndpoints } from "./snapping";

const JOIN_TOLERANCE = 1e-6;
type Cut = { t: number; endpoint: number };
type Path = { entity: Entity; endpoints: [number, number]; cuts: Cut[] };
type Edge = {
  entityId: string;
  nodes: [number, number];
  from: number;
  to: number;
};
type Indexed = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  index: number;
};
const around = (point: XY): Omit<Indexed, "index"> => ({
  minX: point.x - JOIN_TOLERANCE,
  minY: point.y - JOIN_TOLERANCE,
  maxX: point.x + JOIN_TOLERANCE,
  maxY: point.y + JOIN_TOLERANCE,
});

/**
 * Select connected open paths in document order without changing the sketch.
 * Ordinary traversal stops at junctions; extendBranches visits the full network.
 * A line is split virtually at endpoints touching its interior. The click chooses
 * the starting subedge (its midpoint when omitted), but selection returns whole
 * entity IDs. Crossings between two path interiors never create a junction.
 */
export function connectedContour(
  sketch: Sketch,
  entityId: string,
  extendBranches = false,
  click?: XY,
): string[] {
  if (!sketch.entities.some((entity) => entity.id === entityId)) return [];
  const endpoints: Point[] = [],
    paths: Path[] = [];
  for (const entity of sketch.entities) {
    const ends = pathEndpoints(entity);
    if (
      ends.length !== 2 ||
      ends.some(
        (point) =>
          !point || !Number.isFinite(point.x) || !Number.isFinite(point.y),
      )
    )
      continue;
    const first = endpoints.length;
    endpoints.push(...ends);
    paths.push({
      entity,
      endpoints: [first, first + 1],
      cuts: [
        { t: 0, endpoint: first },
        { t: 1, endpoint: first + 1 },
      ],
    });
  }
  const selectedPath = paths.find((path) => path.entity.id === entityId);
  if (!selectedPath) return [entityId];

  const parents = endpoints.map((_, index) => index);
  const root = (index: number): number => {
    let result = index;
    while (parents[result] !== result) result = parents[result];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = result;
      index = next;
    }
    return result;
  };
  const join = (first: number, second: number) => {
    const a = root(first),
      b = root(second);
    parents[Math.max(a, b)] = Math.min(a, b);
  };

  // Join endpoint positions and explicit endpoint references, independently of
  // direction, length, fixed, source, or other constraint relationships.
  const endpointIndex = new RBush<Indexed>(),
    references = new Map<string, number>();
  endpoints.forEach((point, index) => {
    const previous = references.get(point.id);
    if (previous !== undefined) join(index, previous);
    else references.set(point.id, index);
    for (const candidate of endpointIndex.search(around(point)))
      if (dist(point, endpoints[candidate.index]) <= JOIN_TOLERANCE)
        join(index, candidate.index);
    endpointIndex.insert({
      minX: point.x,
      maxX: point.x,
      minY: point.y,
      maxY: point.y,
      index,
    });
  });
  for (const constraint of sketch.constraints) {
    if (constraint.kind !== "coincident") continue;
    const refs = constraint.refs
      .map((ref) => references.get(ref))
      .filter((ref): ref is number => ref !== undefined);
    for (let index = 1; index < refs.length; index++)
      join(refs[0], refs[index]);
  }

  // Only query real path endpoints against nearby straight segments. This finds
  // T-junctions without joining accidental X-crossings or curve control points.
  const lineIndex = new RBush<Indexed>();
  lineIndex.load(
    paths.flatMap((path, index) => {
      if (path.entity.kind !== "line") return [];
      const [a, b] = path.endpoints.map((endpoint) => endpoints[endpoint]);
      return [
        {
          minX: Math.min(a.x, b.x),
          maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxY: Math.max(a.y, b.y),
          index,
        },
      ];
    }),
  );
  endpoints.forEach((point, endpoint) => {
    for (const candidate of lineIndex.search(around(point))) {
      const path = paths[candidate.index];
      if (path.endpoints.includes(endpoint)) continue;
      const [a, b] = path.endpoints.map((index) => endpoints[index]),
        projected = projection(point, a, b);
      if (
        dist(point, projected.point) <= JOIN_TOLERANCE &&
        dist(projected.point, a) > JOIN_TOLERANCE &&
        dist(projected.point, b) > JOIN_TOLERANCE
      )
        path.cuts.push({ t: projected.t, endpoint });
    }
  });

  // Several endpoints can describe the same virtual cut, including nearly
  // coincident points approaching a line from opposite sides.
  for (const path of paths) {
    path.cuts.sort((a, b) => a.t - b.t || a.endpoint - b.endpoint);
    const length = dist(
      endpoints[path.endpoints[0]],
      endpoints[path.endpoints[1]],
    );
    const cuts: Cut[] = [];
    for (const cut of path.cuts) {
      const previous = cuts.at(-1);
      if (
        previous &&
        path.entity.kind === "line" &&
        (cut.t - previous.t) * length <= JOIN_TOLERANCE
      )
        join(previous.endpoint, cut.endpoint);
      else cuts.push(cut);
    }
    // Keep even a collapsed path selectable as a single edge.
    if (cuts.length > 1) path.cuts = cuts;
  }

  const edges: Edge[] = [],
    incident = new Map<number, number[]>(),
    selectedEdges: number[] = [];
  for (const path of paths) {
    for (let index = 1; index < path.cuts.length; index++) {
      const first = path.cuts[index - 1],
        second = path.cuts[index],
        nodes: [number, number] = [root(first.endpoint), root(second.endpoint)],
        edge = edges.length;
      edges.push({
        entityId: path.entity.id,
        nodes,
        from: first.t,
        to: second.t,
      });
      for (const node of nodes) {
        const neighbors = incident.get(node) ?? [];
        neighbors.push(edge);
        incident.set(node, neighbors);
      }
      if (path === selectedPath) selectedEdges.push(edge);
    }
  }
  const t =
      selectedPath.entity.kind === "line" && click
        ? projection(
            click,
            endpoints[selectedPath.endpoints[0]],
            endpoints[selectedPath.endpoints[1]],
          ).t
        : 0.5,
    start =
      selectedEdges.find((index) => t <= edges[index].to) ??
      selectedEdges.at(-1)!;
  const visited = new Set<number>([start]),
    selected = new Set<string>(),
    pending = [start];
  for (let index = 0; index < pending.length; index++) {
    const edge = edges[pending[index]];
    selected.add(edge.entityId);
    for (const node of edge.nodes) {
      const neighbors = incident.get(node)!;
      if (!extendBranches && neighbors.length > 2) continue;
      for (const neighbor of neighbors)
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
    }
  }
  return sketch.entities
    .filter((entity) => selected.has(entity.id))
    .map((entity) => entity.id);
}
