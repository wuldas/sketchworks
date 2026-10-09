import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import {
  type Constraint,
  type ConstraintKind,
  type Entity,
  type Sketch,
  type Selection,
  type XY,
  type AngleSector,
} from "./model";
import {
  resolveDimensionPreview,
  type DimensionPickMode,
} from "./dimensionPick";
import { bounds, dist } from "./geometry";
import { dimensionLabelAnchor, dimensionReferences } from "./dimensionLabel";
import { resolveBodyDragEntities } from "./dragTransaction";
import { appendSplinePoint } from "./splineDraft";
import {
  defaultSnapOptions,
  isSnapEnabled,
  type SnapOptions,
  type SnapReference,
} from "./snapping";
import { DimensionInput, type DimensionInputHandle } from "./DimensionInput";
import {
  createGeometry,
  toolClicks,
  type CreateConfig,
  type Tool,
} from "./creation";
import {
  CanvasRenderer,
  worldToScreen,
  type CanvasFrame,
  type CanvasView,
  type CanvasSnap,
} from "./canvasRenderer";
import {
  dragAnchor,
  resolveDragSelection,
  resolveDragSnap,
  sameDragPosition,
  type DragEvent,
  type DragFeedback,
} from "./dragging";

export interface ViewportProps {
  sketches: Sketch[];
  activeId: string;
  selection: Selection[];
  tool: Tool;
  drafts: XY[];
  config: CreateConfig;
  grid: boolean;
  snap: boolean;
  snapOptions?: SnapOptions;
  fitKey: number;
  unit: "mm" | "in";
  onPlace: (point: XY, snapRef?: SnapReference, captured?: boolean) => void;
  onSelect: (selection: Selection | null, additive: boolean) => void;
  onBox: (ids: string[], additive: boolean) => void;
  onCursor: (point: XY) => void;
  onDrag: (event: DragEvent) => DragFeedback | void;
  onFinish: (point?: XY, snapRef?: SnapReference) => void;
  onEditConstraint: (id: string) => void;
  pickParameters?: "geometry" | "position";
  onParameterPick?: (selection: Selection | null, point: XY) => void;
  /** Dimension tool active: canvas clicks pick geometry instead of selecting it. */
  pickDimension?: boolean;
  /** References picked so far, drawn as a rubber band towards the cursor. */
  dimensionGuides?: XY[];
  dimensionPicks?: string[];
  dimensionKindMode?: DimensionPickMode;
  dimensionAdjustment?: Constraint | null;
  dimensionSelection?: string | null;
  onDimensionSelect?: (id: string | null) => void;
  onDimensionAdjust?: (id: string) => void;
  onDimensionPositionCommit?: (id: string, point: XY) => void;
  dimensionDraft?: {
    kind: ConstraintKind;
    refs: string[];
    anchor?: XY;
    labelPosition?: XY;
    angleSector?: AngleSector;
    constraintId?: string;
    value: string;
    unit: string;
  } | null;
  onDimensionPick?: (selection: Selection | null, point: XY) => void;
  onDimensionCommit?: (text: string) => boolean;
  onDimensionCancel?: () => void;
}
type Size = { width: number; height: number };
type Gesture = {
  id: number;
  mode: "pan" | "box" | "place" | "drag" | "dimension";
  dimensionId?: string;
  start: XY;
  startWorld: XY;
  startView: CanvasView;
  target: XY;
  offset: XY;
  anchorId?: string;
  excluded: ReadonlySet<string>;
  snapPoint: CanvasSnap | null;
  lastSubmitted: XY | null;
  moved: boolean;
  additive: boolean;
  selected?: Selection;
  entityIds?: readonly string[];
  dragging: boolean;
  button: number;
};
type CadCanvas = HTMLCanvasElement & {
  __cadViewport?: ReturnType<CanvasRenderer["metadata"]>;
};
const pixelRatio = () => window.devicePixelRatio || 1;

export function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<CadCanvas>(null);
  const dimensionInput = useRef<DimensionInputHandle>(null);
  const renderer = useRef<CanvasRenderer | null>(null);
  if (!renderer.current || !(renderer.current instanceof CanvasRenderer))
    renderer.current = new CanvasRenderer();
  const propsRef = useRef(props);
  propsRef.current = props;
  const [size, setSize] = useState<Size>({ width: 800, height: 600 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [dpr, setDpr] = useState(pixelRatio);
  const dprRef = useRef(dpr);
  dprRef.current = dpr;
  const [view, setView] = useState<CanvasView>({
    center: { x: 0, y: 0 },
    scale: 3,
  });
  const viewRef = useRef(view);
  const [panning, setPanning] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const pointer = useRef<XY | null>(null);
  const space = useRef(false);
  const drawFrame = useRef<number | null>(null);
  const inputFrame = useRef<number | null>(null);
  const pendingDrag = useRef<Parameters<ViewportProps["onDrag"]>[0] | null>(
    null,
  );
  const lastCursorReport = useRef(0);
  const lastReportedCursor = useRef<XY | null>(null);
  const terminalCapture = useRef<{
    anchorId?: string;
    target: XY;
    snapPoint: CanvasSnap | null;
  } | null>(null);
  const fitState = useRef<{ measured: boolean; fitKey: number }>({
    measured: false,
    fitKey: props.fitKey,
  });
  const previewCache = useRef<{ key: string; entities: Entity[] }>({
    key: "",
    entities: [],
  });

  const toWorld = useCallback((point: XY): XY => {
    const current = viewRef.current,
      currentSize = sizeRef.current;
    return {
      x: current.center.x + (point.x - currentSize.width / 2) / current.scale,
      y: current.center.y - (point.y - currentSize.height / 2) / current.scale,
    };
  }, []);
  const local = useCallback(
    (event: { clientX: number; clientY: number }): XY => {
      const rect = canvas.current!.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    },
    [],
  );
  const frame = useCallback((): CanvasFrame => {
    const current = propsRef.current;
    return {
      ...sizeRef.current,
      view: viewRef.current,
      dpr: dprRef.current,
      grid: current.grid,
      snapOptions: current.snapOptions ?? defaultSnapOptions,
      snapFrom:
        !current.pickDimension &&
        (current.tool === "line" || current.tool === "midline")
          ? current.drafts.at(-1)
          : undefined,
      unit: current.unit,
      selection: current.selection,
      drafts: current.pickDimension
        ? (current.dimensionGuides ?? [])
        : current.drafts,
      preview: [],
      cursor: null,
      snapPoint: null,
      marquee: null,
      dimensionSelection: current.dimensionSelection ?? null,
      dimensionPreview: current.dimensionAdjustment
        ? {
            kind: current.dimensionAdjustment.kind,
            refs: current.dimensionAdjustment.refs,
            value: current.dimensionAdjustment.value,
            labelPosition: current.dimensionAdjustment.labelPosition,
            angleSector: current.dimensionAdjustment.angleSector,
            constraintId: current.dimensionAdjustment.id,
            fixed: false,
          }
        : current.dimensionDraft?.labelPosition &&
            !current.dimensionDraft.constraintId
          ? {
              kind: current.dimensionDraft.kind,
              refs: current.dimensionDraft.refs,
              labelPosition: current.dimensionDraft.labelPosition,
              angleSector: current.dimensionDraft.angleSector,
              fixed: true,
            }
          : null,
    };
  }, []);
  const requestDraw = useCallback(() => {
    if (drawFrame.current !== null) return;
    drawFrame.current = requestAnimationFrame(() => {
      drawFrame.current = null;
      const surface = canvas.current;
      if (!surface) return;
      const current = propsRef.current,
        currentFrame = frame(),
        activeGesture = gesture.current;
      if (pointer.current) {
        const capture =
          activeGesture?.mode === "drag"
            ? activeGesture
            : terminalCapture.current;
        if (capture) {
          currentFrame.cursor = capture.target;
          const actual = capture.anchorId
            ? renderer.current!.position(capture.anchorId)
            : undefined;
          if (
            current.snap &&
            capture.snapPoint &&
            isSnapEnabled(
              capture.snapPoint.kind,
              current.snapOptions ?? defaultSnapOptions,
            ) &&
            sameDragPosition(actual ?? null, capture.target)
          )
            currentFrame.snapPoint = capture.snapPoint;
        } else {
          const proposed = toWorld(pointer.current);
          if (current.snap && activeGesture?.mode !== "dimension")
            currentFrame.snapPoint = renderer.current!.snap(
              proposed,
              currentFrame,
            );
          currentFrame.cursor = currentFrame.snapPoint?.point ?? proposed;
        }
      }
      if (
        activeGesture?.mode === "box" &&
        activeGesture.moved &&
        pointer.current
      )
        currentFrame.marquee = { a: activeGesture.start, b: pointer.current };
      if (currentFrame.cursor && current.tool !== "select") {
        const key = JSON.stringify([
          current.tool,
          current.drafts,
          current.config,
          currentFrame.cursor,
        ]);
        if (previewCache.current.key !== key) {
          let entities: Entity[] = [];
          const points =
            current.tool === "spline"
              ? appendSplinePoint(current.drafts, [], currentFrame.cursor)
                  .points
              : [...current.drafts, currentFrame.cursor];
          if (
            points.length >= toolClicks[current.tool] ||
            current.tool === "spline"
          ) {
            try {
              entities = createGeometry(
                current.tool,
                points,
                current.config,
              ).entities;
            } catch {
              /* Incomplete or degenerate previews are not committed. */
            }
          }
          previewCache.current = { key, entities };
        }
        currentFrame.preview = previewCache.current.entities;
      }
      if (current.dimensionAdjustment && activeGesture?.mode === "dimension") {
        currentFrame.dimensionPreview!.labelPosition = activeGesture.target;
        if (
          currentFrame.dimensionPreview!.kind === "angle" &&
          currentFrame.dimensionPreview!.refs.length === 2
        ) {
          currentFrame.dimensionPreview!.angleSector = undefined;
          currentFrame.dimensionPreview!.value = undefined;
        }
      } else if (
        current.pickDimension &&
        !current.dimensionDraft &&
        !current.dimensionAdjustment
      ) {
        const sketch = current.sketches.find(
          (sk) => sk.id === current.activeId,
        );
        const request = sketch
          ? resolveDimensionPreview(
              sketch,
              current.dimensionPicks ?? [],
              current.dimensionKindMode,
              pointer.current
                ? renderer.current!.hitTest(pointer.current, currentFrame)
                : null,
            )
          : null;
        currentFrame.dimensionPreview = request
          ? {
              kind: request.kind,
              refs: request.refs,
              labelPosition: pointer.current
                ? toWorld(pointer.current)
                : undefined,
              fixed: false,
            }
          : null;
        if (request) currentFrame.drafts = [];
      }
      renderer.current!.draw(surface, currentFrame);
      surface.__cadViewport = renderer.current!.metadata(currentFrame);
    });
  }, [frame, toWorld]);
  const updateView = useCallback(
    (next: CanvasView) => {
      viewRef.current = next;
      setView(next);
      requestDraw();
    },
    [requestDraw],
  );
  const fit = useCallback(() => {
    const sketches = propsRef.current.sketches.filter(
        (sketch) => sketch.visible,
      ),
      visible = sketches.flatMap((sketch) => sketch.entities);
    const extent = bounds(visible),
      currentSize = sizeRef.current;
    for (const sketch of sketches) {
      const refs = dimensionReferences(sketch);
      for (const constraint of sketch.constraints) {
        const label = dimensionLabelAnchor(constraint, refs);
        if (!label || ![label.x, label.y].every(Number.isFinite)) continue;
        extent.minX = Math.min(extent.minX, label.x);
        extent.maxX = Math.max(extent.maxX, label.x);
        extent.minY = Math.min(extent.minY, label.y);
        extent.maxY = Math.max(extent.maxY, label.y);
      }
    }
    updateView({
      center: {
        x: (extent.minX + extent.maxX) / 2,
        y: (extent.minY + extent.maxY) / 2,
      },
      scale: Math.max(
        0.001,
        Math.min(
          500,
          Math.min(
            Math.max(100, currentSize.width - 160) /
              Math.max(20, extent.maxX - extent.minX),
            Math.max(100, currentSize.height - 150) /
              Math.max(20, extent.maxY - extent.minY),
          ),
        ),
      ),
    });
  }, [updateView]);
  const zoomAt = useCallback(
    (factor: number, at?: XY) => {
      const current = viewRef.current,
        currentSize = sizeRef.current;
      const anchor = at ?? {
        x: currentSize.width / 2,
        y: currentSize.height / 2,
      };
      const world = toWorld(anchor),
        scale = Math.max(0.001, Math.min(500, current.scale * factor));
      updateView({
        scale,
        center: {
          x: world.x - (anchor.x - currentSize.width / 2) / scale,
          y: world.y + (anchor.y - currentSize.height / 2) / scale,
        },
      });
    },
    [toWorld, updateView],
  );
  const resolveTarget = useCallback(
    (point: XY, currentGesture: Gesture) => {
      const current = propsRef.current,
        currentFrame = frame(),
        raw = toWorld(point);
      const proposed = {
        x: raw.x + currentGesture.offset.x,
        y: raw.y + currentGesture.offset.y,
      };
      if (currentGesture.selected?.pointId) {
        const selected = currentGesture.selected;
        const owner = current.sketches
          .find((sk) => sk.id === current.activeId)
          ?.entities.find((e) => e.id === selected.entityId);
        if (owner?.kind === "line")
          currentFrame.snapFrom = owner.points.find(
            (p) => p.id !== selected.pointId,
          );
      }
      const nearest = current.snap
        ? renderer.current!.snap(
            proposed,
            currentFrame,
            currentGesture.excluded,
          )
        : null;
      const previous =
        current.snap &&
        currentGesture.snapPoint?.kind !== "tangent" &&
        currentGesture.snapPoint?.kind !== "intersection" &&
        isSnapEnabled(
          currentGesture.snapPoint?.kind ?? "point",
          current.snapOptions ?? defaultSnapOptions,
        )
          ? currentGesture.snapPoint
          : null;
      const resolved = current.snap
        ? resolveDragSnap(proposed, previous, nearest, currentFrame.view.scale)
        : { target: proposed, snap: null };
      currentGesture.target = resolved.target;
      currentGesture.snapPoint = resolved.snap;
      return resolved;
    },
    [frame, toWorld],
  );
  const flushDrag = useCallback(() => {
    if (inputFrame.current !== null) cancelAnimationFrame(inputFrame.current);
    inputFrame.current = null;
    const event = pendingDrag.current;
    pendingDrag.current = null;
    const currentGesture = gesture.current;
    if (
      event &&
      currentGesture &&
      !sameDragPosition(currentGesture.lastSubmitted, event.target)
    ) {
      currentGesture.lastSubmitted = { ...event.target };
      propsRef.current.onDrag(event);
      requestDraw();
    }
  }, [requestDraw]);
  const cancelGesture = useCallback(() => {
    const current = gesture.current;
    if (inputFrame.current !== null) cancelAnimationFrame(inputFrame.current);
    inputFrame.current = null;
    pendingDrag.current = null;
    if (current?.mode === "dimension" && current.dragging)
      propsRef.current.onDimensionCancel?.();
    if (current?.dragging && current.selected)
      propsRef.current.onDrag({
        ...current.selected,
        delta: { x: 0, y: 0 },
        target: current.target,
        phase: "cancel",
      });
    terminalCapture.current =
      current?.mode === "drag"
        ? {
            anchorId: current.anchorId,
            target: current.startWorld,
            snapPoint: null,
          }
        : null;
    gesture.current = null;
    setPanning(false);
    if (current && canvas.current?.hasPointerCapture(current.id))
      canvas.current.releasePointerCapture(current.id);
    requestDraw();
  }, [requestDraw]);

  useLayoutEffect(() => {
    if (!props.pickDimension && gesture.current?.mode === "dimension")
      cancelGesture();
  }, [props.pickDimension, cancelGesture]);
  useLayoutEffect(() => {
    renderer.current!.sync(props.sketches, props.activeId);
    requestDraw();
  }, [props.sketches, props.activeId, requestDraw]);
  useLayoutEffect(() => {
    requestDraw();
  }, [
    props.selection,
    props.tool,
    props.drafts,
    props.config,
    props.grid,
    props.snap,
    props.snapOptions,
    props.unit,
    props.pickDimension,
    props.dimensionGuides,
    props.dimensionPicks,
    props.dimensionKindMode,
    props.dimensionDraft,
    props.dimensionAdjustment,
    props.dimensionSelection,
    size,
    dpr,
    view,
    requestDraw,
  ]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      if (rect.width <= 0 || rect.height <= 0) return;
      const next = { width: rect.width, height: rect.height };
      sizeRef.current = next;
      setSize(next);
      if (!fitState.current.measured) {
        fitState.current.measured = true;
        fit();
      }
      requestDraw();
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [fit, requestDraw]);
  useEffect(() => {
    if (props.fitKey === fitState.current.fitKey) return;
    fitState.current.fitKey = props.fitKey;
    if (fitState.current.measured) fit();
  }, [props.fitKey, fit]);
  useEffect(() => {
    const change = () => {
      const next = pixelRatio();
      dprRef.current = next;
      setDpr(next);
      requestDraw();
    };
    const resolution = window.matchMedia(`(resolution: ${dpr}dppx)`);
    window.addEventListener("resize", change);
    resolution.addEventListener("change", change);
    return () => {
      window.removeEventListener("resize", change);
      resolution.removeEventListener("change", change);
    };
  }, [dpr, requestDraw]);
  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (gesture.current) return;
      pointer.current = local(event);
      terminalCapture.current = null;
      zoomAt(
        Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.002),
        pointer.current,
      );
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, [local, zoomAt]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (
        /INPUT|TEXTAREA|SELECT/.test(
          (event.target as HTMLElement)?.tagName ?? "",
        )
      )
        return;
      if (event.code === "Space") {
        space.current = true;
        event.preventDefault();
      }
      if (event.key === "Escape") cancelGesture();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") space.current = false;
    };
    const blur = () => {
      space.current = false;
      cancelGesture();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [cancelGesture]);
  useEffect(
    () => () => {
      if (drawFrame.current !== null) cancelAnimationFrame(drawFrame.current);
      if (inputFrame.current !== null) cancelAnimationFrame(inputFrame.current);
      drawFrame.current = null;
      inputFrame.current = null;
      pendingDrag.current = null;
    },
    [],
  );

  const startPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (gesture.current || ![0, 1, 2].includes(event.button)) return;
    const current = propsRef.current,
      point = local(event),
      world = toWorld(point),
      currentFrame = frame();
    pointer.current = point;
    // Right click cancels any dimension step (pick phase included), matching
    // Escape; middle button remains available for panning.
    if (
      event.button === 2 &&
      (current.dimensionDraft ||
        current.dimensionAdjustment ||
        current.pickDimension)
    ) {
      event.preventDefault();
      current.onDimensionCancel?.();
      requestDraw();
      return;
    }
    if (current.dimensionDraft && event.button === 0 && !space.current) {
      event.preventDefault();
      if (
        !renderer.current!.hitTest(point, currentFrame) &&
        !renderer.current!.dimensionAt(point, currentFrame)
      )
        dimensionInput.current?.commit();
      return;
    }
    const pan = event.button !== 0 || space.current;
    const hit = pan ? null : renderer.current!.hitTest(point, currentFrame);
    const selectMode =
      !pan &&
      current.tool === "select" &&
      !current.pickDimension &&
      !current.pickParameters;
    const dimension =
      !pan && !hit?.pointId && !current.pickParameters
        ? (renderer.current!.dimensionAt(point, currentFrame) ??
          ((current.pickDimension || selectMode) && !hit
            ? renderer.current!.dimensionAt(point, currentFrame, true)
            : null))
        : null;
    if (dimension && !current.pickDimension && !selectMode) {
      event.preventDefault();
      return;
    }
    if (selectMode && dimension) current.onDimensionSelect?.(dimension);
    const dimensionAnchor = dimension
      ? renderer.current!.dimensionAnchor(dimension)
      : null;
    const dimensionWorld = dimensionAnchor ? toWorld(dimensionAnchor) : world;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const selected =
      hit &&
      current.tool === "select" &&
      !current.pickDimension &&
      !current.pickParameters &&
      !additive
        ? resolveDragSelection(hit, current.selection)
        : hit;
    const dimensionPick = !pan && !!current.pickDimension;
    const parameterPick = !pan && !!current.pickParameters;
    let mode: Gesture["mode"] = pan
      ? "pan"
      : parameterPick
        ? current.pickParameters === "position" || selected
          ? "place"
          : "box"
        : dimension
          ? "dimension"
          : dimensionPick || current.tool !== "select"
            ? "place"
            : selected
              ? "drag"
              : "box";
    if (mode === "drag" || mode === "box" || parameterPick)
      canvas.current?.focus({ preventScroll: true });
    if (dimensionPick || parameterPick) {
      // Command and dimension tools only collect references on release.
    } else if (!pan && current.tool === "select" && selected && !dimension) {
      const already = current.selection.some(
        (item) =>
          item.entityId === selected.entityId &&
          item.pointId === selected.pointId,
      );
      if (!already || additive) current.onSelect(selected, additive);
    }
    const sketch = current.sketches.find(
      (item) => item.id === current.activeId,
    );
    let entityIds: readonly string[] | undefined;
    if (mode === "drag" && selected && !selected.pointId && sketch) {
      try {
        entityIds = resolveBodyDragEntities(
          sketch,
          current.selection,
          selected,
        );
      } catch {
        entityIds = current.selection.some(
          (item) => item.entityId === selected.entityId,
        )
          ? current.selection.map((item) => item.entityId)
          : [selected.entityId];
      }
    }
    const dragSelection = entityIds
      ? entityIds.map((entityId) => ({ entityId }))
      : current.selection;
    const anchor =
      mode === "drag" && selected && sketch
        ? dragAnchor(sketch, selected, dragSelection, world)
        : null;
    if (mode === "drag" && !anchor) return;
    terminalCapture.current = null;
    gesture.current = {
      id: event.pointerId,
      mode,
      dimensionId: dimension ?? undefined,
      start: point,
      startWorld: dimension ? dimensionWorld : (anchor?.point ?? world),
      startView: viewRef.current,
      target: dimension ? dimensionWorld : (anchor?.point ?? world),
      offset: dimension
        ? { x: dimensionWorld.x - world.x, y: dimensionWorld.y - world.y }
        : (anchor?.offset ?? { x: 0, y: 0 }),
      anchorId: anchor?.pointId,
      excluded: anchor?.excluded ?? new Set<string>(),
      snapPoint: null,
      lastSubmitted: null,
      moved: false,
      additive,
      selected: dimension ? undefined : (selected ?? undefined),
      entityIds,
      dragging: false,
      button: event.button,
    };
    pointer.current = point;
    canvas.current?.setPointerCapture(event.pointerId);
    if (pan) setPanning(true);
    event.preventDefault();
    requestDraw();
  };
  const movePointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = local(event),
      current = propsRef.current,
      activeGesture = gesture.current;
    if (activeGesture && activeGesture.id !== event.pointerId) return;
    pointer.current = point;
    if (activeGesture) {
      if (dist(point, activeGesture.start) > 3) activeGesture.moved = true;
      if (activeGesture.mode === "pan")
        updateView({
          scale: activeGesture.startView.scale,
          center: {
            x:
              activeGesture.startView.center.x -
              (point.x - activeGesture.start.x) / activeGesture.startView.scale,
            y:
              activeGesture.startView.center.y +
              (point.y - activeGesture.start.y) / activeGesture.startView.scale,
          },
        });
    }
    if (activeGesture?.mode === "dimension" && activeGesture.dimensionId) {
      const raw = toWorld(point);
      activeGesture.target = {
        x: raw.x + activeGesture.offset.x,
        y: raw.y + activeGesture.offset.y,
      };
      if (activeGesture.moved && !activeGesture.dragging) {
        activeGesture.dragging = true;
        current.onDimensionAdjust?.(activeGesture.dimensionId);
      }
    }
    terminalCapture.current = null;
    const currentFrame = frame();
    const resolution =
      activeGesture?.mode === "drag"
        ? resolveTarget(point, activeGesture)
        : (() => {
            const raw = toWorld(point);
            const snap =
              current.snap && activeGesture?.mode !== "dimension"
                ? renderer.current!.snap(raw, currentFrame)
                : null;
            return { target: snap?.point ?? raw, snap };
          })();
    const target = resolution.target;
    const now = performance.now();
    if (
      now - lastCursorReport.current >= 100 &&
      !sameDragPosition(lastReportedCursor.current, target)
    ) {
      lastCursorReport.current = now;
      lastReportedCursor.current = { ...target };
      current.onCursor(target);
    }
    if (
      activeGesture?.mode === "drag" &&
      activeGesture.selected &&
      activeGesture.moved &&
      !activeGesture.additive
    ) {
      if (!activeGesture.dragging) {
        current.onDrag({
          ...activeGesture.selected,
          entityIds: activeGesture.entityIds,
          delta: { x: 0, y: 0 },
          target: activeGesture.startWorld,
          phase: "start",
        });
        activeGesture.dragging = true;
      }
      activeGesture.target = target;
      if (sameDragPosition(activeGesture.lastSubmitted, target)) {
        if (inputFrame.current !== null)
          cancelAnimationFrame(inputFrame.current);
        inputFrame.current = null;
        pendingDrag.current = null;
      } else if (
        !sameDragPosition(pendingDrag.current?.target ?? null, target)
      ) {
        pendingDrag.current = {
          ...activeGesture.selected,
          delta: {
            x: target.x - activeGesture.startWorld.x,
            y: target.y - activeGesture.startWorld.y,
          },
          target,
          phase: "move",
        };
        if (inputFrame.current === null)
          inputFrame.current = requestAnimationFrame(flushDrag);
      }
    }
    if (canvas.current) {
      const hit =
        current.tool === "select" && !activeGesture
          ? renderer.current!.hitTest(point, currentFrame)
          : null;
      const dimension =
        renderer.current!.dimensionAt(point, currentFrame) ??
        (current.pickDimension && !hit
          ? renderer.current!.dimensionAt(point, currentFrame, true)
          : null);
      canvas.current.style.cursor =
        activeGesture?.mode === "pan" ||
        (activeGesture?.mode === "dimension" && activeGesture.moved)
          ? "grabbing"
          : dimension && current.pickDimension && !current.dimensionDraft
            ? "move"
            : current.pickParameters ||
                current.pickDimension ||
                current.tool !== "select"
              ? "crosshair"
              : dimension
                ? "pointer"
                : hit?.pointId
                  ? "move"
                  : hit
                    ? "pointer"
                    : "default";
    }
    requestDraw();
  };
  const endPointer = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    cancelled = false,
  ) => {
    const activeGesture = gesture.current;
    if (!activeGesture || activeGesture.id !== event.pointerId) return;
    if (cancelled) {
      cancelGesture();
      return;
    }
    const current = propsRef.current,
      point = local(event),
      world = toWorld(point),
      currentFrame = frame();
    pointer.current = point;
    if (activeGesture.mode === "dimension" && activeGesture.dimensionId) {
      if (activeGesture.moved || dist(point, activeGesture.start) > 3)
        current.onDimensionPositionCommit?.(activeGesture.dimensionId, {
          x: world.x + activeGesture.offset.x,
          y: world.y + activeGesture.offset.y,
        });
    } else if (activeGesture.dragging && activeGesture.selected) {
      if (inputFrame.current !== null) cancelAnimationFrame(inputFrame.current);
      inputFrame.current = null;
      pendingDrag.current = null;
      const resolved = resolveTarget(point, activeGesture);
      const feedback = current.onDrag({
        ...activeGesture.selected,
        delta: {
          x: resolved.target.x - activeGesture.startWorld.x,
          y: resolved.target.y - activeGesture.startWorld.y,
        },
        target: resolved.target,
        phase: "end",
        exact: !!resolved.snap,
      });
      const actual = feedback?.point ?? resolved.target;
      terminalCapture.current = {
        anchorId: activeGesture.anchorId,
        target: actual,
        snapPoint: feedback?.ok === false ? null : resolved.snap,
      };
      lastReportedCursor.current = { ...actual };
      current.onCursor(actual);
    } else if (
      activeGesture.mode === "pan" &&
      activeGesture.button === 2 &&
      !activeGesture.moved &&
      current.tool !== "select"
    ) {
      const captured =
        current.tool === "spline" && current.snap
          ? renderer.current!.snap(world, currentFrame)
          : null;
      current.onFinish(
        captured && captured.kind !== "grid" ? captured.point : undefined,
        captured?.ref ?? captured?.binding,
      );
    } else if (activeGesture.mode === "place" && !activeGesture.moved) {
      if (current.pickParameters) {
        const snap =
          current.pickParameters === "position" && current.snap
            ? renderer.current!.snap(world, currentFrame)
            : null;
        current.onParameterPick?.(
          renderer.current!.hitTest(point, currentFrame),
          snap?.point ?? world,
        );
      } else if (current.pickDimension) {
        current.onDimensionPick?.(
          renderer.current!.hitTest(point, currentFrame),
          world,
        );
      } else if (!current.pickParameters) {
        const candidate = current.snap
          ? renderer.current!.snap(world, currentFrame)
          : null;
        current.onPlace(
          candidate?.point ?? world,
          candidate?.ref ?? candidate?.binding,
          !!candidate,
        );
      }
    } else if (activeGesture.mode === "box") {
      if (!activeGesture.moved) current.onSelect(null, activeGesture.additive);
      else
        current.onBox(
          renderer.current!.selectBox(activeGesture.startWorld, world),
          activeGesture.additive,
        );
    }
    gesture.current = null;
    setPanning(false);
    if (canvas.current?.hasPointerCapture(event.pointerId))
      canvas.current.releasePointerCapture(event.pointerId);
    requestDraw();
  };

  return (
    <div ref={host} className="viewport">
      <canvas
        ref={canvas}
        className="canvas-surface"
        data-testid="cad-canvas"
        data-renderer="canvas2d"
        role="region"
        aria-label="草图绘图区"
        tabIndex={0}
        style={{
          cursor: panning
            ? "grabbing"
            : props.pickParameters ||
                props.pickDimension ||
                props.tool !== "select"
              ? "crosshair"
              : "default",
        }}
        onPointerDown={startPointer}
        onPointerMove={movePointer}
        onPointerUp={(event) => endPointer(event)}
        onPointerCancel={(event) => endPointer(event, true)}
        onLostPointerCapture={(event) => {
          if (gesture.current?.id === event.pointerId) endPointer(event, true);
        }}
        onPointerLeave={() => {
          if (!gesture.current) {
            pointer.current = null;
            terminalCapture.current = null;
            requestDraw();
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (gesture.current?.mode === "dimension") cancelGesture();
        }}
        onDoubleClick={(event) => {
          if (propsRef.current.pickParameters) return;
          const current = propsRef.current,
            point = local(event),
            dimension = renderer.current!.dimensionAt(point, frame());
          if (dimension) {
            event.preventDefault();
            current.onEditConstraint(dimension);
          } else if (current.tool === "spline" && current.drafts.length >= 2) {
            event.preventDefault();
            current.onFinish();
          }
        }}
      />
      {props.dimensionDraft &&
        (() => {
          const draft = props.dimensionDraft;
          const existing = draft.constraintId
            ? props.sketches
                .find((sk) => sk.id === props.activeId)
                ?.constraints.find((c) => c.id === draft.constraintId)
            : undefined;
          const anchor = existing
            ? renderer.current!.dimensionPreviewAnchor(
                {
                  ...existing,
                  angleSector: draft.angleSector ?? existing.angleSector,
                  fixed: true,
                },
                frame(),
              )
            : draft.labelPosition
              ? renderer.current!.dimensionPreviewAnchor(
                  {
                    kind: draft.kind,
                    refs: draft.refs,
                    labelPosition: draft.labelPosition,
                    angleSector: draft.angleSector,
                    fixed: true,
                  },
                  frame(),
                )
              : draft.anchor
                ? worldToScreen(draft.anchor, frame())
                : null;
          if (!anchor) return null;
          return (
            <DimensionInput
              ref={dimensionInput}
              key={`${draft.constraintId ?? "new"}:${draft.value}`}
              x={Math.max(72, Math.min(size.width - 72, anchor.x))}
              y={Math.max(34, Math.min(size.height - 6, anchor.y))}
              unit={draft.unit}
              initial={draft.value}
              onCommit={(text) => props.onDimensionCommit?.(text) ?? false}
              onCancel={() => props.onDimensionCancel?.()}
            />
          );
        })()}
      <div
        className="view-badge"
        style={{
          position: "absolute",
          left: 18,
          top: 15,
          pointerEvents: "none",
          fontSize: 11,
          color: "#718078",
          display: "flex",
          gap: 12,
        }}
      >
        <span>俯视 · XY</span>
        <span>{Math.round((view.scale * 100) / 3)}%</span>
      </div>
      <div
        className="view-controls"
        style={{
          position: "absolute",
          right: 16,
          top: 15,
          display: "flex",
          gap: 4,
        }}
      >
        {[
          { title: "放大", Icon: Plus, action: () => zoomAt(1.25) },
          { title: "缩小", Icon: Minus, action: () => zoomAt(0.8) },
          { title: "适配全部", Icon: Maximize, action: fit },
        ].map(({ title, Icon, action }) => (
          <button
            key={title}
            type="button"
            title={title}
            aria-label={title}
            onClick={action}
            style={{
              width: 30,
              height: 30,
              display: "grid",
              placeItems: "center",
              padding: 0,
              border: "1px solid #dde5e0",
              borderRadius: 4,
              background: "#fff",
              color: "#62756a",
              cursor: "pointer",
            }}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}
export default Viewport;
