import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  MousePointer2,
  Minus,
  RectangleHorizontal,
  Circle,
  Spline,
  Type,
  MapPin,
  Hexagon,
  Save,
  FolderOpen,
  FilePlus2,
  Download,
  Undo2,
  Redo2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  X,
  Check,
  Trash2,
  Settings2,
  Grid3X3,
  Magnet,
  LockKeyhole,
  Equal,
  Move,
  Scissors,
  CornerUpRight,
  Copy,
  RotateCw,
  FlipHorizontal2,
  Rows3,
  Scaling,
  Ruler,
  CircleDot,
  Triangle,
  GitMerge,
  Unlink,
  PanelLeftClose,
  PanelRightClose,
  MoreHorizontal,
  FileJson,
  LoaderCircle,
  AlertTriangle,
  SlidersHorizontal,
  Pencil,
  Square,
  Crosshair,
  Maximize2,
  CircleDashed,
  GitBranch,
  CircleHelp,
  Github,
  Tangent,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
} from "lucide-react";
import {
  type Document,
  type Sketch,
  type Selection,
  type Entity,
  type XY,
  type ConstraintKind,
  type Constraint,
  type AngleSector,
  emptyDocument,
  demoDocument,
  clone,
  uid,
  validateDocument,
  deleteEntities,
  constraintLabels,
  kindLabels,
  entity,
  resolveEntity,
  referencePoint,
} from "./model";
import {
  dist,
  bounds,
  validGeometry,
  updateDerived,
  sub,
  add,
  mul,
  arcInfo,
  blendEntity,
} from "./geometry";
import {
  type Tool,
  type CreateConfig,
  defaultConfig,
  toolLabels,
  toolClicks,
  createGeometry,
  creationInputPoints,
  appendGeometry,
} from "./creation";
import {
  initSolver,
  solveSketch,
  canConstrain,
  type SolverResult,
} from "./solver";
import {
  createOperationCandidate,
  previewOperation,
  resolveOperationInput,
  type OperationInput,
} from "./operationPreview";
import {
  applyParameters,
  evaluateExpression,
  resolveParameters,
  hasParameterReferences,
} from "./parameters";
import { exportDxf, exportSvg, exportJson, download } from "./export";
import { Viewport } from "./Viewport";
import { FileManager } from "./FileManager";
import {
  createProject,
  decodeProject,
  encodeProject,
  projectFileName,
  type CadProject,
} from "./projectArchive";
import {
  virtualFiles,
  ROOT_ID,
  type VfsEntry,
  type VfsFileEntry,
} from "./virtualFileSystem";
import { useProjectWorkspace } from "./useProjectWorkspace";
import { appendSplinePoint } from "./splineDraft";
import {
  Arc3PointIcon,
  ArcCenterIcon,
  BezierIcon,
  ChamferIcon,
  FilletIcon,
  HorizontalIcon,
  MirrorIcon,
  OffsetIcon,
  ParallelIcon,
  PerpendicularIcon,
  SlotIcon,
  TangentIcon,
  VerticalIcon,
  type CadIconProps,
} from "./icons";
import {
  defaultSnapOptions,
  type SnapOptions,
  type SnapReference,
} from "./snapping";
import {
  resolveDimension,
  selectionRefs,
  pointLineDistance,
  isParallelPair,
  type DimensionPickMode,
} from "./dimensionPick";
import { placeDimensionLabel, updateDimensionLabels } from "./dimensionLabel";
import { convertAngleSector, resolveAnglePlacement } from "./angleDimension";
import { type DragEvent, type DragFeedback } from "./dragging";
import {
  dragPosition,
  solveDrag,
  resolveBodyDragEntities,
  type DragDriver,
} from "./dragTransaction";
import { ParameterPanel } from "./ParameterPanel";
import { CreationPanel } from "./CreationPanel";
import { creationMethods } from "./creationWorkflow";
import {
  type CommandSession,
  commandGeometryError,
  commandSelections,
  constraintGeometry,
  createCommandSession,
  operationGeometry,
  selectionKey,
  updateCommandSelection,
} from "./commandParameters";
import "./app.css";
const STORAGE = "sketchworks.document.v1";
const DIRECTION_CONSTRAINTS: ConstraintKind[] = [
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "collinear",
  "angle",
];
type IconComponent = ComponentType<{ size?: number; className?: string }>;

function monoTone(Icon: ComponentType<CadIconProps>): IconComponent {
  const ThemedIcon = (props: CadIconProps) => <Icon {...props} tone="mono" />;
  ThemedIcon.displayName = `Mono(${Icon.displayName ?? "CadIcon"})`;
  return ThemedIcon;
}

const toolIcons: Record<Tool, IconComponent> = {
  select: MousePointer2,
  line: Minus,
  midline: AlignHorizontalDistributeCenter,
  rectangle: RectangleHorizontal,
  threeRectangle: RectangleHorizontal,
  centerRectangle: Square,
  circle: Circle,
  threeCircle: CircleDot,
  arc: Arc3PointIcon,
  centerArc: ArcCenterIcon,
  polygon: Hexagon,
  ellipse: Circle,
  slot: SlotIcon,
  arcSlot: GitMerge,
  spline: Spline,
  bezier: BezierIcon,
  conic: GitBranch,
  point: MapPin,
  text: Type,
};
const constraintIcons: Record<ConstraintKind, IconComponent> = {
  coincident: GitMerge,
  horizontal: monoTone(HorizontalIcon),
  vertical: monoTone(VerticalIcon),
  parallel: monoTone(ParallelIcon),
  perpendicular: monoTone(PerpendicularIcon),
  equal: Equal,
  fixed: LockKeyhole,
  onLine: ArrowDownToLine,
  onCurve: Spline,
  intersection: Crosshair,
  origin: Crosshair,
  tangent: monoTone(TangentIcon),
  concentric: CircleDot,
  midpoint: AlignHorizontalDistributeCenter,
  symmetric: FlipHorizontal2,
  collinear: Minus,
  length: Ruler,
  lineDistance: AlignVerticalDistributeCenter,
  distanceX: AlignHorizontalDistributeCenter,
  distanceY: AlignVerticalDistributeCenter,
  radius: CircleDot,
  ellipseWidth: Circle,
  diameter: Circle,
  angle: Triangle,
};
const operationIcons: Record<string, IconComponent> = {
  fillet: FilletIcon,
  chamfer: ChamferIcon,
  blend: Spline,
  offset: OffsetIcon,
  trim: Scissors,
  extend: CornerUpRight,
  break: Unlink,
  scale: Scaling,
  move: Move,
  rotate: RotateCw,
  copy: Copy,
  mirror: MirrorIcon,
  rectangularArray: Grid3X3,
  circularArray: CircleDashed,
  detach: Unlink,
};
const operationNames: Record<string, string> = {
  fillet: "圆角",
  chamfer: "倒角",
  blend: "过渡曲线",
  offset: "偏移",
  trim: "修剪",
  extend: "延伸",
  break: "断开",
  scale: "草图缩放",
  move: "移动",
  rotate: "旋转",
  copy: "复制",
  mirror: "镜像",
  rectangularArray: "矩形阵列",
  circularArray: "环形阵列",
  detach: "解除关联",
};
interface Field {
  key: string;
  label: string;
  value: string;
  unit?: string;
  type?: "text" | "textarea" | "select";
  options?: string[];
}
interface Modal {
  title: string;
  fields: Field[];
  confirm: (values: Record<string, string>) => boolean | Promise<boolean>;
  description?: string;
  submit?: string;
}
function IconButton({
  icon: Icon,
  title,
  active = false,
  disabled = false,
  onClick,
  className = "",
}: {
  icon: IconComponent;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""} ${className}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={18} />
    </button>
  );
}
function ModalView({ modal, onClose }: { modal: Modal; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(modal.fields.map((f) => [f.key, f.value])),
  );
  return (
    <div
      className="modal-shade"
      onPointerDown={(e) => {
        if (!pending && e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="dialog"
        aria-busy={pending}
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending) return;
          setPending(true);
          try {
            if (await modal.confirm(values)) onClose();
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="dialog-title">
          <h2>{modal.title}</h2>
          <IconButton
            icon={X}
            title="关闭对话框"
            disabled={pending}
            onClick={onClose}
          />
        </div>
        {modal.description && (
          <div className="dialog-warning">{modal.description}</div>
        )}
        <div className="dialog-fields">
          {modal.fields.map((f, i) => (
            <label className="field" key={f.key}>
              <span>{f.label}</span>
              <div className="input-unit">
                {f.type === "select" ? (
                  <select
                    aria-label={f.label}
                    disabled={pending}
                    value={values[f.key]}
                    onChange={(e) =>
                      setValues({ ...values, [f.key]: e.target.value })
                    }
                  >
                    {f.options?.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                ) : f.type === "textarea" ? (
                  <textarea
                    autoFocus={i === 0}
                    aria-label={f.label}
                    disabled={pending}
                    value={values[f.key]}
                    onChange={(e) =>
                      setValues({ ...values, [f.key]: e.target.value })
                    }
                    maxLength={10000}
                  />
                ) : (
                  <input
                    autoFocus={i === 0}
                    aria-label={f.label}
                    disabled={pending}
                    value={values[f.key]}
                    onChange={(e) =>
                      setValues({ ...values, [f.key]: e.target.value })
                    }
                    maxLength={500}
                  />
                )}
                <span>{f.unit}</span>
              </div>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="button primary" disabled={pending}>
            <Check size={15} />
            {modal.submit ?? "确定"}
          </button>
        </div>
      </form>
    </div>
  );
}
function MenuItem({
  icon: Icon,
  label,
  shortcut,
  onClick,
  disabled = false,
}: {
  icon: IconComponent;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="menu-item" onClick={onClick} disabled={disabled}>
      <Icon size={17} />
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}
type ProjectTab = {
  id: string;
  fileId: string | null;
  name: string;
};
type UntitledSnapshot = {
  document: Document;
  project: CadProject;
};
const UNTITLED_TAB_ID = "untitled";
const isFileEntry = (entry: VfsEntry | undefined): entry is VfsFileEntry =>
  entry?.kind === "file";

function initialDocument(): Document {
  try {
    const stored = localStorage.getItem(STORAGE);
    if (stored) return validateDocument(JSON.parse(stored));
  } catch {
    /* Keep editing available when local storage is restricted. */
  }
  return demoDocument();
}
export default function App() {
  const [doc, setDocState] = useState<Document>(initialDocument),
    docRef = useRef(doc);
  const setDoc = useCallback((next: Document) => {
    docRef.current = next;
    setDocState(next);
  }, []);
  const [activeId, setActiveId] = useState(doc.sketches[0].id),
    [selection, setSelection] = useState<Selection[]>([]),
    [tool, setTool] = useState<Tool>("select"),
    [drafts, setDrafts] = useState<XY[]>([]),
    draftSnaps = useRef<(SnapReference | undefined)[]>([]),
    draftCaptured = useRef(false);
  const [creationActive, setCreationActive] = useState(0);
  const [creationInputsValid, setCreationInputsValid] = useState(true);
  const [creationPickRevision, setCreationPickRevision] = useState(0);
  const [config, setConfig] = useState<CreateConfig>(defaultConfig),
    [ready, setReady] = useState(false),
    [solverState, setSolverState] = useState<SolverResult>({
      ok: true,
      dof: 0,
      status: "Loading",
      conflicting: [],
    });
  const [grid, setGrid] = useState(true),
    [snap, setSnap] = useState(true),
    [snapOptions, setSnapOptions] = useState<SnapOptions>(defaultSnapOptions),
    [fitKey, setFitKey] = useState(0),
    [cursor, setCursor] = useState<XY>({ x: 0, y: 0 }),
    [menu, setMenu] = useState<string | null>(null),
    [modal, setModal] = useState<Modal | null>(null),
    [fileManager, setFileManager] = useState<"browse" | "save" | null>(null),
    [fileManagerLocked, setFileManagerLocked] = useState(false),
    [projectTransition, setProjectTransition] = useState<string | null>(null),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [saved, setSaved] = useState(false),
    [historyVersion, setHistoryVersion] = useState(0),
    [projectTabs, setProjectTabs] = useState<ProjectTab[]>([]),
    [activeTabId, setActiveTabId] = useState<string | null>(null),
    [leftOpen, setLeftOpen] = useState(window.innerWidth > 960),
    [rightOpen, setRightOpen] = useState(window.innerWidth > 1100),
    [command, setCommand] = useState<CommandSession | null>(null),
    [dimensionMode, setDimensionMode] = useState(false),
    [dimensionKindMode, setDimensionKindMode] =
      useState<DimensionPickMode>("auto"),
    [dimensionPicks, setDimensionPicks] = useState<string[]>([]),
    [dimensionAdjustmentId, setDimensionAdjustmentId] = useState<string | null>(
      null,
    ),
    [dimensionDraft, setDimensionDraft] = useState<{
      constraintId?: string;
      kind: ConstraintKind;
      refs: string[];
      anchor?: XY;
      labelPosition?: XY;
      angleSector?: AngleSector;
      preserveParallel?: boolean;
      value: string;
      unit: string;
    } | null>(null),
    [selectedDimensionId, setSelectedDimensionId] = useState<string | null>(
      null,
    );
  const projectTransitionRef = useRef(false);
  const history = useRef<Document[]>([]),
    future = useRef<Document[]>([]),
    dragBefore = useRef<Document | null>(null),
    dragSession = useRef<{
      document: Document;
      sketchId: string;
      selection: Selection[];
      primary: Selection;
      target: XY;
      entityIds?: readonly string[];
    } | null>(null),
    fileInput = useRef<HTMLInputElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeTabRef = useRef<string | null>(null);
  const untitledSnapshots = useRef(new Map<string, UntitledSnapshot>());
  const untitledCounter = useRef(1);
  const tabsInitialized = useRef(false);
  const defaultProjectPanelOpened = useRef(false);
  const sketch = doc.sketches.find((s) => s.id === activeId) ?? doc.sketches[0];
  const dimensionAdjustment = dimensionAdjustmentId
    ? sketch.constraints.find((c) => c.id === dimensionAdjustmentId)
    : undefined;
  const dimensionRequest =
    dimensionMode && !dimensionDraft && !dimensionAdjustment
      ? resolveDimension(sketch, dimensionPicks, dimensionKindMode)
      : null;
  const displayedSelection = command ? commandSelections(command) : selection;
  const selectedEntities = sketch.entities.filter((e) =>
    displayedSelection.some((s) => s.entityId === e.id),
  );
  const selectedDimension = selectedDimensionId
    ? sketch.constraints.find((c) => c.id === selectedDimensionId)
    : undefined;
  const one = selectedEntities.length === 1 ? selectedEntities[0] : undefined;
  const unit = doc.unit === "in" ? "in" : "mm",
    factor = doc.unit === "in" ? 25.4 : 1;
  const formatted = (n: number) => Number((n / factor).toFixed(3)).toString();
  const creationError = useMemo(() => {
    if (tool === "select") return null;
    const required = tool === "spline" ? 2 : toolClicks[tool];
    if (drafts.length < required)
      return `请先拾取 ${required} 个点，或填写对应坐标`;
    try {
      const geometry = createGeometry(tool, drafts, config);
      validGeometry({
        id: "creation",
        name: "创建预览",
        visible: true,
        ...geometry,
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }, [tool, drafts, config]);
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 6500 : 3000);
  }, []);
  const solveDocument = useCallback(
    (
      candidate: Document,
      drag?: DragDriver,
      solvingSketchId = activeId,
    ): SolverResult => {
      applyParameters(candidate);
      let current: SolverResult = {
        ok: true,
        dof: 0,
        status: "Success",
        conflicting: [],
      };
      for (const sk of candidate.sketches) {
        const derived = new Set(
          sk.entities
            .filter((e) => e.sourceId)
            .flatMap((e) => [e.id, ...e.points.map((p) => p.id)]),
        );
        if (sk.constraints.some((c) => c.refs.some((r) => derived.has(r))))
          throw new Error("派生对象请通过源对象编辑，或先解除关联");
        const base = {
          ...sk,
          entities: sk.entities.filter((e) => !e.sourceId),
        };
        const result = solveSketch(
          base,
          sk.id === solvingSketchId ? drag : undefined,
        );
        if (!result.ok)
          throw Object.assign(new Error("约束无法满足，已保留原草图"), {
            conflicting: result.conflicting,
          });
        updateDerived(sk);
        validGeometry(sk);
        updateDimensionLabels(sk);
        if (sk.id === solvingSketchId) current = result;
      }
      return current;
    },
    [activeId],
  );
  const commit = (candidate: Document, label = "操作", record = true) => {
    if (!ready) {
      notify("求解器正在加载", true);
      return false;
    }
    try {
      const result = solveDocument(candidate);
      if (record) {
        history.current.push(clone(docRef.current));
        if (history.current.length > 100) history.current.shift();
        future.current = [];
        setHistoryVersion((v) => v + 1);
      }
      setDoc(candidate);
      docRef.current = candidate;
      setSolverState(result);
      setSaved(false);
      return true;
    } catch (error) {
      const e = error as Error & { conflicting?: string[] };
      setSolverState((prev) => ({ ...prev, conflicting: e.conflicting ?? [] }));
      notify(`${label}：${e.message}`, true);
      return false;
    }
  };
  const transaction = (
    label: string,
    fn: (candidate: Document, active: Sketch) => void,
  ) => {
    try {
      const next = clone(docRef.current);
      const sk =
        next.sketches.find((s) => s.id === activeId) ?? next.sketches[0];
      fn(next, sk);
      return commit(next, label);
    } catch (error) {
      notify(`${label}：${(error as Error).message}`, true);
      return false;
    }
  };
  useEffect(() => {
    let alive = true;
    initSolver()
      .then(() => {
        if (!alive) return;
        setReady(true);
        const next = clone(docRef.current);
        try {
          const result = solveDocument(next);
          setDoc(next);
          setSolverState(result);
        } catch (error) {
          notify((error as Error).message, true);
        }
      })
      .catch((error) => notify(`求解器加载失败：${String(error)}`, true));
    return () => {
      alive = false;
    };
  }, []);
  const workspace = useProjectWorkspace({
    document: doc,
    documentRef: docRef,
    editorReady: ready,
    notify,
    onRestore: (project) => {
      if (!commit(clone(project.document), "恢复项目", false)) return false;
      history.current = [];
      future.current = [];
      switchSketch(docRef.current.sketches[0].id);
      setFitKey((value) => value + 1);
      return true;
    },
  });
  useEffect(() => {
    setSaved(workspace.saved);
  }, [workspace.saved]);
  useEffect(() => {
    const sk = doc.sketches.find((s) => s.id === activeId);
    if (sk && ready) {
      const base = clone(sk);
      base.entities = base.entities.filter((e) => !e.sourceId);
      const result = solveSketch(base);
      if (result.ok) setSolverState(result);
    }
  }, [activeId, ready]);
  const setMode = (mode: Tool, restoreSelection = true) => {
    setTool(mode);
    setDrafts([]);
    setCreationActive(0);
    setCreationPickRevision((version) => version + 1);
    setConfig((previous) =>
      previous.angle === undefined
        ? previous
        : { ...previous, angle: undefined },
    );
    draftSnaps.current = [];
    draftCaptured.current = false;
    if (!restoreSelection) setSelection([]);
    else if (command) setSelection(command.previousSelection);
    setCommand(null);
    setDimensionMode(false);
    setDimensionDraft(null);
    setDimensionAdjustmentId(null);
    setDimensionPicks([]);
    setSelectedDimensionId(null);
    setMenu(null);
  };
  const cancel = () => setMode("select");
  const switchSketch = (id: string) => {
    setMode("select", false);
    setActiveId(id);
  };
  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    future.current.push(clone(docRef.current));
    const previousSk = previous.sketches.some((s) => s.id === activeId)
      ? activeId
      : previous.sketches[0].id;
    setActiveId(previousSk);
    commit(previous, "撤销", false);
    setHistoryVersion((v) => v + 1);
    setMode("select", false);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    history.current.push(clone(docRef.current));
    setActiveId(
      next.sketches.some((s) => s.id === activeId)
        ? activeId
        : next.sketches[0].id,
    );
    commit(next, "重做", false);
    setHistoryVersion((v) => v + 1);
    setMode("select", false);
  };
  const removeSelectedDimension = () => {
    const id = selectedDimensionId;
    if (!id) return;
    if (!sketch.constraints.some((c) => c.id === id)) {
      setSelectedDimensionId(null);
      return;
    }
    if (
      transaction("删除尺寸", (_, s) => {
        s.constraints = s.constraints.filter((item) => item.id !== id);
      })
    )
      setSelectedDimensionId(null);
  };
  const removeSelected = () => {
    if (command) {
      setCommand({
        ...command,
        geometry: command.geometry.map((p, i) =>
          i === command.active
            ? { ...p, selections: [], position: undefined }
            : p,
        ),
      });
      return;
    }
    if (selectedDimensionId) return removeSelectedDimension();
    if (!selection.length) return;
    if (
      transaction("删除", (_, s) =>
        deleteEntities(
          s,
          selection.map((p) => p.entityId),
        ),
      )
    ) {
      setSelection([]);
      cancelDimensions();
    }
  };
  const projectTabName = (document: Document) =>
    document.name?.trim() || "未命名草图";
  const projectFileTabName = (file: VfsFileEntry) =>
    file.name.replace(/\.(?:swcad|asar|json)$/i, "") || "未命名项目";
  const nextUntitledId = () => `untitled-${++untitledCounter.current}`;
  const nextUntitledName = () => {
    const names = new Set(projectTabs.map((tab) => tab.name));
    if (!names.has("未命名草图")) return "未命名草图";
    let index = 2;
    while (names.has(`未命名草图 ${index}`)) index += 1;
    return `未命名草图 ${index}`;
  };
  const upsertProjectTab = (tab: ProjectTab) =>
    setProjectTabs((current) => {
      if (!current.some((item) => item.id === tab.id)) return [...current, tab];
      return current.map((item) =>
        item.id === tab.id
          ? { ...item, name: tab.name, fileId: tab.fileId }
          : item,
      );
    });
  const markProjectTabActive = (id: string) => {
    activeTabRef.current = id;
    setActiveTabId(id);
  };
  const rememberUntitledProject = () => {
    if (workspace.activeFile) return;
    const id = activeTabRef.current ?? UNTITLED_TAB_ID;
    untitledSnapshots.current.set(id, {
      document: clone(docRef.current),
      project: clone(workspace.currentProject()),
    });
  };
  const restoreUntitledProject = (snapshot: UntitledSnapshot) => {
    const next = clone(snapshot.document);
    if (!commit(next, "切换项目", false)) return false;
    history.current = [];
    future.current = [];
    setHistoryVersion((value) => value + 1);
    workspace.detach(clone(next), clone(snapshot.project));
    switchSketch(next.sketches[0].id);
    setFitKey((value) => value + 1);
    return true;
  };
  const registerUntitledTab = (name?: string) => {
    const active = projectTabs.find((tab) => tab.id === activeTabRef.current);
    const id = active && active.fileId === null ? active.id : nextUntitledId();
    untitledSnapshots.current.set(id, {
      document: clone(docRef.current),
      project: clone(workspace.currentProject()),
    });
    upsertProjectTab({
      id,
      fileId: null,
      name: name?.trim() || projectTabName(docRef.current),
    });
    markProjectTabActive(id);
  };
  useEffect(() => {
    if (!workspace.ready || tabsInitialized.current) return;
    tabsInitialized.current = true;
    const file = workspace.activeFile;
    if (file) {
      upsertProjectTab({
        id: file.id,
        fileId: file.id,
        name: projectFileTabName(file),
      });
      markProjectTabActive(file.id);
      return;
    }
    untitledSnapshots.current.set(UNTITLED_TAB_ID, {
      document: clone(docRef.current),
      project: clone(workspace.currentProject()),
    });
    upsertProjectTab({
      id: UNTITLED_TAB_ID,
      fileId: null,
      name: projectTabName(docRef.current),
    });
    markProjectTabActive(UNTITLED_TAB_ID);
  }, [workspace.ready]);
  useEffect(() => {
    if (!workspace.ready || defaultProjectPanelOpened.current) return;
    defaultProjectPanelOpened.current = true;
    if (window.innerWidth > 960)
      setFileManager((current) => current ?? "browse");
  }, [workspace.ready]);
  const openFileManager = (mode: "browse" | "save" = "browse") => {
    if (!workspace.ready) {
      notify("项目存储正在打开，请稍后操作", true);
      return;
    }
    cancel();
    setModal(null);
    setMenu(null);
    setLeftOpen(true);
    setFileManager(mode);
  };
  const saveProject = async () => {
    if (!workspace.ready) {
      notify("项目存储正在打开，请稍后保存", true);
      return;
    }
    if (!workspace.activeFile) {
      openFileManager("save");
      return;
    }
    try {
      const entry = await virtualFiles.get(workspace.activeFile.id);
      if (!entry || entry.kind !== "file") {
        await workspace.refresh();
        openFileManager("save");
        return;
      }
      await workspace.persist();
      notify("项目已保存");
      setMenu(null);
    } catch {
      /* The workspace reports the actual storage error. */
    }
  };
  const downloadProject = () => {
    if (!workspace.ready) {
      notify("项目存储正在打开，请稍后下载", true);
      return;
    }
    try {
      const project = workspace.currentProject();
      const contents = encodeProject(project);
      const name = projectFileName(
        workspace.activeFile?.name ?? docRef.current.name,
      );
      download(name, contents, "application/octet-stream");
      notify("项目已下载");
      setMenu(null);
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const openVirtualProject = async (file: VfsFileEntry) => {
    if (!ready) {
      notify("求解器正在加载", true);
      return false;
    }
    if (projectTransitionRef.current) return false;
    projectTransitionRef.current = true;
    setProjectTransition("正在打开项目");
    try {
      rememberUntitledProject();
      await workspace.persist();
      const latestFile = await virtualFiles.get(file.id);
      if (!latestFile || !isFileEntry(latestFile))
        throw new Error("项目文件已不存在");
      const contents = await virtualFiles.readFile(file.id);
      const project = /\.json$/i.test(latestFile.name)
        ? createProject(validateDocument(JSON.parse(await contents.text())))
        : decodeProject(await contents.arrayBuffer());
      if (!commit(clone(project.document), "打开项目", false)) return false;
      history.current = [];
      future.current = [];
      setHistoryVersion((value) => value + 1);
      switchSketch(docRef.current.sketches[0].id);
      setFitKey((value) => value + 1);
      workspace.attach(latestFile, project);
      upsertProjectTab({
        id: latestFile.id,
        fileId: latestFile.id,
        name: projectFileTabName(latestFile),
      });
      markProjectTabActive(latestFile.id);
      setFileManager("browse");
      notify("项目已打开");
      return true;
    } finally {
      projectTransitionRef.current = false;
      setProjectTransition(null);
    }
  };
  const createVirtualProject = async (name: string, parentId: string) => {
    if (!ready || !workspace.ready)
      throw new Error("项目存储正在准备，请稍后操作");
    if (projectTransitionRef.current)
      throw new Error("正在切换项目，请稍后操作");
    projectTransitionRef.current = true;
    setProjectTransition("正在创建项目");
    try {
      rememberUntitledProject();
      await workspace.persist();
      const next = emptyDocument();
      next.name = name.replace(/\.swcad$/i, "");
      const project = createProject(next);
      const contents = new Blob([Uint8Array.from(encodeProject(project))], {
        type: "application/octet-stream",
      });
      const file = await virtualFiles.createFile(parentId, name, contents);
      if (!commit(next, "新建项目", false)) {
        await virtualFiles.remove(file.id);
        return undefined;
      }
      history.current = [];
      future.current = [];
      setHistoryVersion((value) => value + 1);
      switchSketch(next.sketches[0].id);
      setFitKey((value) => value + 1);
      workspace.attach(file, project);
      upsertProjectTab({
        id: file.id,
        fileId: file.id,
        name: projectFileTabName(file),
      });
      markProjectTabActive(file.id);
      setFileManager("browse");
      notify("项目已创建");
      return file;
    } finally {
      projectTransitionRef.current = false;
      setProjectTransition(null);
    }
  };
  const saveVirtualProject = (file: VfsFileEntry, project: CadProject) => {
    const previousId = activeTabRef.current;
    const previousTab = projectTabs.find((tab) => tab.id === previousId);
    if (previousId && previousTab && previousTab.fileId === null) {
      setProjectTabs((current) =>
        current.filter((tab) => tab.id !== previousId),
      );
      untitledSnapshots.current.delete(previousId);
    }
    workspace.attach(file, project);
    upsertProjectTab({
      id: file.id,
      fileId: file.id,
      name: projectFileTabName(file),
    });
    markProjectTabActive(file.id);
    setFileManager("browse");
    notify("项目已保存到项目管理");
  };
  const refreshVirtualFiles = () => {
    void (async () => {
      try {
        await workspace.refresh();
        const entries = await virtualFiles.allEntries();
        const activeId = activeTabRef.current;
        const activeTab = projectTabs.find((tab) => tab.id === activeId);
        const activeEntry = activeId
          ? entries.find((entry) => entry.id === activeId)
          : undefined;
        setProjectTabs((current) =>
          current.flatMap((tab) => {
            if (!tab.fileId) return [tab];
            const entry = entries.find(
              (candidate): candidate is VfsFileEntry =>
                candidate.id === tab.fileId && candidate.kind === "file",
            );
            if (!entry) return [];
            return [
              {
                ...tab,
                name: projectFileTabName(entry),
              },
            ];
          }),
        );
        if (activeId && activeTab?.fileId && !activeEntry) {
          const id = nextUntitledId();
          untitledSnapshots.current.set(id, {
            document: clone(docRef.current),
            project: clone(workspace.currentProject()),
          });
          upsertProjectTab({
            id,
            fileId: null,
            name: projectTabName(docRef.current),
          });
          markProjectTabActive(id);
        }
      } catch (error) {
        notify((error as Error).message, true);
      }
    })();
  };
  const activateProjectTab = async (tab: ProjectTab) => {
    if (tab.id === activeTabRef.current) return false;
    if (!workspace.ready || projectTransitionRef.current) return false;
    if (tab.fileId) {
      const file = await virtualFiles.get(tab.fileId);
      if (!isFileEntry(file)) {
        setProjectTabs((current) =>
          current.filter((item) => item.id !== tab.id),
        );
        notify("项目文件已不存在", true);
        return false;
      }
      return openVirtualProject(file);
    }
    projectTransitionRef.current = true;
    setProjectTransition("正在切换项目");
    try {
      await workspace.persist();
      let snapshot = untitledSnapshots.current.get(tab.id);
      if (!snapshot) {
        const fresh = emptyDocument();
        fresh.name = tab.name || "未命名草图";
        snapshot = { document: fresh, project: createProject(fresh) };
        untitledSnapshots.current.set(tab.id, snapshot);
      }
      if (!restoreUntitledProject(snapshot)) return false;
      upsertProjectTab({
        id: tab.id,
        fileId: null,
        name: projectTabName(snapshot.document),
      });
      markProjectTabActive(tab.id);
      return true;
    } catch (error) {
      notify(`切换项目失败：${(error as Error).message}`, true);
      return false;
    } finally {
      projectTransitionRef.current = false;
      setProjectTransition(null);
    }
  };
  const closeProjectTab = async (tab: ProjectTab) => {
    if (projectTransitionRef.current) return;
    const index = projectTabs.findIndex((item) => item.id === tab.id);
    if (index < 0) return;
    const remaining = projectTabs.filter((item) => item.id !== tab.id);
    if (activeTabRef.current === tab.id) {
      if (!remaining.length) {
        try {
          await workspace.persist();
        } catch {
          return;
        }
        const fresh = emptyDocument();
        if (!commit(fresh, "新建", false)) return;
        history.current = [];
        future.current = [];
        setHistoryVersion((value) => value + 1);
        workspace.detach(docRef.current);
        untitledSnapshots.current.clear();
        untitledSnapshots.current.set(UNTITLED_TAB_ID, {
          document: clone(docRef.current),
          project: clone(workspace.currentProject()),
        });
        switchSketch(docRef.current.sketches[0].id);
        setFitKey((value) => value + 1);
        const freshTab: ProjectTab = {
          id: UNTITLED_TAB_ID,
          fileId: null,
          name: projectTabName(docRef.current),
        };
        setProjectTabs([freshTab]);
        markProjectTabActive(UNTITLED_TAB_ID);
        return;
      }
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (!(await activateProjectTab(next))) return;
    }
    setProjectTabs((current) => current.filter((item) => item.id !== tab.id));
    if (tab.fileId === null) untitledSnapshots.current.delete(tab.id);
  };
  const addUntitledProject = async () => {
    if (!workspace.ready || projectTransitionRef.current) return;
    projectTransitionRef.current = true;
    setProjectTransition("正在新建项目");
    try {
      await workspace.persist();
      rememberUntitledProject();
      const next = emptyDocument();
      next.name = nextUntitledName();
      if (!commit(next, "新建", false)) return;
      history.current = [];
      future.current = [];
      setHistoryVersion((value) => value + 1);
      workspace.detach(docRef.current);
      switchSketch(next.sketches[0].id);
      setFitKey((value) => value + 1);
      const id = nextUntitledId();
      untitledSnapshots.current.set(id, {
        document: clone(docRef.current),
        project: clone(workspace.currentProject()),
      });
      upsertProjectTab({ id, fileId: null, name: next.name });
      markProjectTabActive(id);
    } catch (error) {
      notify(`新建项目失败：${(error as Error).message}`, true);
    } finally {
      projectTransitionRef.current = false;
      setProjectTransition(null);
    }
  };
  const saveJson = () => {
    download(`${doc.name}.sketch.json`, exportJson(doc), "application/json");
    notify("草图文件已下载");
    setMenu(null);
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (projectTransitionRef.current) return;
      if ((e.target as HTMLElement)?.matches("input,textarea,select") || modal)
        return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "s") {
        e.preventDefault();
        if (e.shiftKey) openFileManager("save");
        else void saveProject();
        return;
      }
      if ((e.target as HTMLElement)?.closest('[data-testid="file-manager"]'))
        return;
      if (command) {
        if (key === "escape") {
          e.preventDefault();
          cancel();
        } else if (key === "enter") {
          e.preventDefault();
          confirmCommand();
        } else if (key === "delete" || key === "backspace") {
          e.preventDefault();
          removeSelected();
        } else if ((e.ctrlKey || e.metaKey) && key === "a") {
          e.preventDefault();
          changeCommandSelection(
            sketch.entities.map((e) => ({ entityId: e.id })),
            "replace",
          );
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && key === "y") {
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && key === "o") {
        e.preventDefault();
        openFileManager("browse");
      } else if ((e.ctrlKey || e.metaKey) && key === "a") {
        e.preventDefault();
        setSelection(sketch.entities.map((e) => ({ entityId: e.id })));
      } else if (key === "escape") {
        if (dimensionDraft || dimensionPicks.length || dimensionMode)
          cancelDimensions();
        else cancel();
      } else if (key === "delete" || key === "backspace") {
        e.preventDefault();
        removeSelected();
      } else if (key === "enter" && tool === "spline") {
        e.preventDefault();
        document
          .querySelector<HTMLFormElement>('[data-testid="creation-panel"]')
          ?.requestSubmit();
      } else if (!e.ctrlKey && !e.metaKey) {
        // Tool shortcuts must not type their letter into a freshly opened editor.
        const shortcuts: Record<string, () => void> = {
          l: () => setMode("line"),
          r: () => setMode("rectangle"),
          c: () => setMode("circle"),
          d: () => startDimension(),
          t: () => startOperation("trim"),
          o: () => startOperation("offset"),
          m: () => startOperation("move"),
        };
        const action = shortcuts[key];
        if (action) {
          e.preventDefault();
          action();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    if (selection.length) setSelectedDimensionId(null);
  }, [selection]);
  const selectDimension = (id: string | null) => {
    if (id && !sketch.constraints.some((c) => c.id === id)) return;
    if (id) setSelection([]);
    setSelectedDimensionId(id);
  };
  const changeCommandSelection = (
    picks: Selection[],
    mode: "toggle" | "replace" | "append" = "toggle",
  ) => {
    if (!command) return;
    const result = updateCommandSelection(command, sketch, picks, mode);
    if (result.error) notify(result.error, true);
    else setCommand(result.session);
  };
  const select = (s: Selection | null, additive: boolean) => {
    if (command) {
      if (s) changeCommandSelection([s]);
      return;
    }
    if (!s) {
      if (!additive) {
        setSelection([]);
        setSelectedDimensionId(null);
      }
      return;
    }
    setSelection((prev) =>
      additive
        ? prev.some((p) => p.entityId === s.entityId && p.pointId === s.pointId)
          ? prev.filter(
              (p) => !(p.entityId === s.entityId && p.pointId === s.pointId),
            )
          : [...prev, s]
        : [s],
    );
  };
  const refs = selection.map((s) => s.pointId ?? s.entityId);
  const startConstraint = (kind: ConstraintKind) => {
    const previous = command?.previousSelection ?? selection;
    setMode("select");
    setCommand(
      createCommandSession(
        "constraint",
        kind,
        constraintLabels[kind],
        constraintGeometry(kind),
        [],
        sketch,
        previous,
      ),
    );
  };
  const commandInputError = command
    ? (commandGeometryError(command) ??
      (command.type === "constraint" &&
      canConstrain(
        sketch,
        command.name as ConstraintKind,
        commandSelections(command).map(selectionKey),
      )
        ? "选取的对象不适用于此约束，请修改几何参数"
        : null))
    : null;
  const operationPreview = useMemo(
    () =>
      !ready || commandInputError
        ? { entities: null, error: null }
        : previewOperation(doc, sketch.id, command, solveDocument),
    [doc, sketch.id, command, ready, commandInputError, solveDocument],
  );
  const commandError = commandInputError ?? operationPreview.error;
  const pickCommand = (picked: Selection | null, point: XY) => {
    if (!command) return;
    const active = command.geometry[command.active];
    if (active.kind !== "position") {
      if (picked) changeCommandSelection([picked]);
      return;
    }
    const values = { ...command.values };
    if (active.optional) {
      values.cx = String(point.x / factor);
      values.cy = String(point.y / factor);
    }
    setCommand({
      ...command,
      values,
      geometry: command.geometry.map((p, i) =>
        i === command.active ? { ...p, position: { ...point } } : p,
      ),
    });
  };
  const dimensionValue = (kind: ConstraintKind, rs = refs): number => {
    const e = resolveEntity(sketch, rs[0]);
    if (!e) return 10;
    if (kind === "radius" || kind === "diameter") {
      const r = e.kind === "arc" ? arcInfo(e).r : (e.radius ?? 1);
      return kind === "diameter" ? 2 * r : r;
    }
    if (kind === "lineDistance") {
      const point = referencePoint(sketch, rs[0]) ?? e.points[0],
        line = resolveEntity(sketch, rs[1]);
      return point && line?.kind === "line"
        ? pointLineDistance(point, line)
        : 10;
    }
    const ps =
      rs.length === 1
        ? e.points
        : (rs.map((r) => referencePoint(sketch, r)).filter(Boolean) as XY[]);
    if (kind === "angle") {
      const v = sub(e.points[1], e.points[0]);
      if (rs.length === 1) return (Math.atan2(v.y, v.x) * 180) / Math.PI;
      const e2 = resolveEntity(sketch, rs[1]);
      if (e2) {
        const b = sub(e2.points[1], e2.points[0]);
        return (
          (Math.atan2(v.x * b.y - v.y * b.x, v.x * b.x + v.y * b.y) * 180) /
          Math.PI
        );
      }
      return 90;
    }
    if (ps.length < 2) return 10;
    return kind === "distanceX"
      ? ps[1].x - ps[0].x
      : kind === "distanceY"
        ? ps[1].y - ps[0].y
        : dist(ps[0], ps[1]);
  };
  const dimensionAnchorFor = (targetRefs: string[]): XY | undefined => {
    const points: XY[] = [];
    for (const ref of targetRefs) {
      const found = referencePoint(sketch, ref);
      if (found) points.push({ x: found.x, y: found.y });
    }
    const single =
      targetRefs.length === 1
        ? resolveEntity(sketch, targetRefs[0])
        : undefined;
    if (points.length >= 2)
      return {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      };
    if (single?.points.length)
      return single.kind === "line" && single.points.length >= 2
        ? {
            x: (single.points[0].x + single.points[1].x) / 2,
            y: (single.points[0].y + single.points[1].y) / 2,
          }
        : { x: single.points[0].x, y: single.points[0].y };
    return points[0];
  };
  /** Open the inline value editor on the drawing area instead of a dialog. */
  const openDimensionInput = (
    kind: ConstraintKind,
    targetRefs: string[],
    options?: {
      existingId?: string;
      anchor?: XY;
      labelPosition?: XY;
      angleSector?: AngleSector;
      preserveParallel?: boolean;
    },
  ) => {
    const existing = options?.existingId
      ? sketch.constraints.find((item) => item.id === options.existingId)
      : undefined;
    const angle =
        kind === "angle"
          ? resolveAnglePlacement(
              sketch,
              targetRefs,
              options?.labelPosition ?? existing?.labelPosition,
            )
          : undefined,
      angleSector =
        existing?.angleSector ?? options?.angleSector ?? angle?.angleSector,
      converted =
        existing && angleSector && !existing.angleSector
          ? convertAngleSector(
              existing,
              angleSector,
              angle?.value ?? Math.abs(existing.value ?? 0),
            )
          : undefined,
      raw =
        converted?.value ??
        existing?.value ??
        angle?.value ??
        dimensionValue(kind, targetRefs);
    setDimensionAdjustmentId(null);
    setDimensionDraft({
      constraintId: options?.existingId,
      kind,
      refs: targetRefs,
      anchor: options?.anchor ?? dimensionAnchorFor(targetRefs),
      labelPosition: options?.labelPosition ?? existing?.labelPosition,
      angleSector,
      preserveParallel: options?.preserveParallel,
      unit: kind === "angle" ? "°" : unit,
      value:
        (converted ? converted.expression : existing?.expression) ??
        (kind === "angle" ? Number(raw.toFixed(3)).toString() : formatted(raw)),
    });
  };
  const cancelDimensions = () => {
    setDimensionDraft(null);
    setDimensionAdjustmentId(null);
    setDimensionPicks([]);
    setSelectedDimensionId(null);
    setDimensionMode(false);
  };
  const commitDimension = (text: string): boolean => {
    const draft = dimensionDraft;
    if (!draft) return false;
    if (!text) {
      notify("请输入尺寸数值或表达式", true);
      return false;
    }
    try {
      const vars = resolveParameters(docRef.current.parameters);
      const isExpression = hasParameterReferences(text);
      let value = evaluateExpression(
        text,
        vars,
        draft.kind === "angle" ? "deg" : "mm",
      );
      if (!isExpression && draft.kind !== "angle") value *= factor;
      if (draft.angleSector && (value < 0 || value >= 360))
        throw new Error(
          "角度应在 0° 至 360° 之间（不含 360°），方向由所选角度区域确定",
        );
      const ok = transaction(
        draft.constraintId
          ? `编辑${constraintLabels[draft.kind]}`
          : `添加${constraintLabels[draft.kind]}`,
        (_, target) => {
          if (draft.constraintId) {
            const current = target.constraints.find(
              (item) => item.id === draft.constraintId,
            );
            if (!current) throw new Error("尺寸不存在");
            current.value = value;
            current.expression = isExpression ? text : undefined;
            if (draft.angleSector) {
              if (!current.angleSector) delete current.labelOffset;
              current.angleSector = draft.angleSector;
            }
            return;
          }
          const live = draft.refs.filter((ref) => !!resolveEntity(target, ref));
          if (live.length !== draft.refs.length)
            throw new Error("标注对象已不存在");
          const invalid = canConstrain(target, draft.kind, live);
          if (invalid) throw new Error("选取的对象不适用于此尺寸");
          if (
            target.constraints.some(
              (c) =>
                c.kind === draft.kind &&
                c.refs.length === live.length &&
                c.refs.every((ref) => live.includes(ref)),
            )
          )
            throw new Error("此尺寸已经存在");
          target.constraints.push({
            id: uid("c"),
            kind: draft.kind,
            refs: live,
            value,
            expression: isExpression ? text : undefined,
            labelPosition: draft.labelPosition,
            angleSector: draft.angleSector,
          });
          // Only a confirmed line pair implies a parallelism constraint.
          if (draft.kind === "lineDistance" && draft.preserveParallel) {
            const ids = live.map(
              (ref) => resolveEntity(target, ref)?.id ?? ref,
            );
            const pair = ids.map((id) =>
              target.entities.find((item) => item.id === id),
            );
            const locked = (id: string) =>
              target.constraints.some(
                (c) =>
                  DIRECTION_CONSTRAINTS.includes(c.kind) &&
                  c.refs.some(
                    (ref) =>
                      ref === id || resolveEntity(target, ref)?.id === id,
                  ),
              );
            const related = target.constraints.some(
              (c) =>
                c.kind === "parallel" && ids.every((id) => c.refs.includes(id)),
            );
            if (
              pair[0] &&
              pair[1] &&
              pair[0].kind === "line" &&
              pair[1].kind === "line" &&
              isParallelPair(pair[0], pair[1]) &&
              !related &&
              !(locked(ids[0]) && locked(ids[1]))
            )
              target.constraints.push({
                id: uid("c"),
                kind: "parallel",
                refs: ids,
              });
          }
        },
      );
      if (!ok) return false;
      setDimensionDraft(null);
      setDimensionPicks([]);
      return true;
    } catch (error) {
      notify((error as Error).message, true);
      return false;
    }
  };
  const startDimension = (preferred: DimensionPickMode = dimensionKindMode) => {
    if (!ready) return;
    setTool("select");
    setDrafts([]);
    draftSnaps.current = [];
    draftCaptured.current = false;
    if (command) setSelection(command.previousSelection);
    setCommand(null);
    setMenu(null);
    setDimensionMode(true);
    setDimensionDraft(null);
    setDimensionAdjustmentId(null);
    const available = selectionRefs(selection);
    const request = available.length
      ? resolveDimension(sketch, available, preferred)
      : null;
    if (
      request?.complete &&
      (request.kind === "radius" || request.kind === "diameter")
    ) {
      setDimensionPicks([]);
      openDimensionInput(request.kind, request.refs);
      return;
    }
    setDimensionPicks(
      request ? (request.complete ? available : request.refs) : [],
    );
  };
  const adjustDimension = (id: string) => {
    if (dimensionDraft) return;
    if (!sketch.constraints.some((c) => c.id === id)) return;
    setDimensionPicks([]);
    setDimensionAdjustmentId(id);
  };
  const commitDimensionPosition = (id: string, world: XY) => {
    if (dimensionDraft) return;
    transaction("调整尺寸标注位置", (_, target) => {
      const c = target.constraints.find((item) => item.id === id);
      if (!c) throw new Error("尺寸不存在");
      placeDimensionLabel(target, c, world);
    });
    setDimensionAdjustmentId(null);
  };
  const pickDimension = (picked: Selection | null, world: XY) => {
    if (!dimensionMode || dimensionDraft) return;
    if (!picked) {
      if (!dimensionRequest?.complete) {
        notify("此处没有可标注的对象", true);
        return;
      }
      openDimensionInput(dimensionRequest.kind, dimensionRequest.refs, {
        anchor: world,
        labelPosition: world,
        preserveParallel:
          dimensionPicks.length === 2 &&
          dimensionPicks.every(
            (ref) =>
              resolveEntity(sketch, ref)?.id === ref &&
              resolveEntity(sketch, ref)?.kind === "line",
          ),
      });
      setDimensionPicks([]);
      return;
    }
    const picks = [
      ...new Set([...dimensionPicks, picked.pointId ?? picked.entityId]),
    ];
    const request = resolveDimension(sketch, picks, dimensionKindMode);
    if (!request) {
      notify("此对象不适用于当前尺寸类型", true);
      return;
    }
    if (
      request.complete &&
      (request.kind === "radius" || request.kind === "diameter")
    ) {
      setDimensionPicks([]);
      openDimensionInput(request.kind, request.refs, { anchor: world });
      return;
    }
    setDimensionPicks(request.complete ? picks : request.refs);
  };
  const finishCreation = (
    points: XY[],
    snaps: (SnapReference | undefined)[],
    mode = tool,
    preserveCapturedCoordinates = false,
  ) => {
    let result: ReturnType<typeof createGeometry>;
    try {
      const effective = creationInputPoints(mode, points, config);
      if (effective !== points) {
        snaps = snaps.map((ref, index) =>
          dist(points[index], effective[index]) < 1e-7 ? ref : undefined,
        );
        points = effective;
        preserveCapturedCoordinates = true;
      }
      result = createGeometry(mode, points, {
        ...config,
        preserveCapturedCoordinates,
      });
    } catch (error) {
      notify((error as Error).message, true);
      return false;
    }
    const ok = transaction(toolLabels[mode], (_, s) => {
      appendGeometry(
        s,
        result,
        snaps.flatMap((ref, pointIndex) =>
          ref === undefined
            ? []
            : [{ pointIndex, ref, point: points[pointIndex] }],
        ),
        config.autoConstraint,
        mode,
      );
    });
    if (ok) setSelection([]);
    return ok;
  };
  const completeCreation = (
    points = drafts,
    snaps = draftSnaps.current,
    captured = draftCaptured.current,
  ) => {
    if (
      tool === "select" ||
      !creationInputsValid ||
      points.length < toolClicks[tool]
    )
      return false;
    if (!finishCreation(points, snaps, tool, captured)) return false;
    setCreationPickRevision((version) => version + 1);
    if (tool === "line") {
      const endpoint = docRef.current.sketches
        .find((s) => s.id === activeId)!
        .entities.at(-1)!.points[1];
      setDrafts([{ x: endpoint.x, y: endpoint.y }]);
      draftSnaps.current = [endpoint.id];
      draftCaptured.current = true;
      setCreationActive(1);
    } else {
      setDrafts([]);
      draftSnaps.current = [];
      draftCaptured.current = false;
      setCreationActive(0);
    }
    return true;
  };
  const place = (p: XY, snapRef?: SnapReference, captured = false) => {
    if (tool === "select" || !ready) return false;
    if (!creationInputsValid) {
      notify("请先修正绘制参数", true);
      return false;
    }
    const index = Math.min(creationActive, drafts.length);
    const next =
      tool === "spline" && index === drafts.length
        ? appendSplinePoint(drafts, draftSnaps.current, p, snapRef)
        : {
            points: [...drafts.slice(0, index), p, ...drafts.slice(index + 1)],
            refs: [
              ...draftSnaps.current.slice(0, index),
              snapRef,
              ...draftSnaps.current.slice(index + 1),
            ],
          };
    setDrafts(next.points);
    setCreationPickRevision((version) => version + 1);
    draftSnaps.current = next.refs;
    draftCaptured.current ||= captured;
    if (
      tool !== "spline" &&
      next.points.length >= toolClicks[tool] &&
      completeCreation(next.points, next.refs, draftCaptured.current)
    )
      return true;
    setCreationActive(Math.min(next.points.length, toolClicks[tool] - 1));
    return true;
  };
  const changeCreationPoint = (index: number, point: XY) => {
    if (
      index > drafts.length ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    )
      return;
    const points = [
      ...drafts.slice(0, index),
      point,
      ...drafts.slice(index + 1),
    ];
    setDrafts(points);
    draftSnaps.current[index] = undefined;
    draftCaptured.current = true;
    setCreationActive(Math.min(points.length, toolClicks[tool] - 1));
  };
  const truncateCreation = (index: number) => {
    setDrafts(drafts.slice(0, index));
    draftSnaps.current = draftSnaps.current.slice(0, index);
    if (index === 0) draftCaptured.current = false;
    setCreationActive(index);
  };
  const finishSpline = (point?: XY, snapRef?: SnapReference) => {
    if (!creationInputsValid) return;
    const final = point
      ? appendSplinePoint(drafts, draftSnaps.current, point, snapRef)
      : { points: drafts, refs: draftSnaps.current };
    if (
      tool === "spline" &&
      final.points.length >= 2 &&
      finishCreation(final.points, final.refs)
    ) {
      setDrafts([]);
      setCreationPickRevision((version) => version + 1);
      setCreationActive(0);
      draftSnaps.current = [];
      draftCaptured.current = false;
    }
  };
  const drag = (event: DragEvent): DragFeedback => {
    if (!ready) return { ok: false };
    if (event.phase === "start") {
      const before = clone(docRef.current);
      const frozenSelection = selection.map((item) => ({ ...item }));
      const primary = { entityId: event.entityId, pointId: event.pointId };
      const initial = dragPosition(before, activeId, primary);
      const sketch = before.sketches.find((item) => item.id === activeId);
      if (!initial || !sketch) return { ok: false };
      try {
        const entityIds = event.pointId
          ? undefined
          : (event.entityIds ??
            resolveBodyDragEntities(sketch, frozenSelection, primary));
        dragBefore.current = before;
        dragSession.current = {
          document: docRef.current,
          sketchId: activeId,
          selection: frozenSelection,
          primary,
          target: initial,
          entityIds,
        };
        return { ok: true, point: initial };
      } catch (error) {
        dragBefore.current = null;
        dragSession.current = null;
        notify((error as Error).message, true);
        return { ok: false, point: initial };
      }
    }
    const before = dragBefore.current,
      session = dragSession.current;
    if (!before || !session) return { ok: false };
    if (
      event.entityId !== session.primary.entityId ||
      event.pointId !== session.primary.pointId
    )
      return { ok: false };
    if (event.phase === "cancel") {
      flushSync(() => setDoc(before));
      dragBefore.current = null;
      dragSession.current = null;
      return { ok: true, point: dragPosition(before, session.sketchId, event) };
    }
    const finish = () => {
      if (JSON.stringify(docRef.current) !== JSON.stringify(before)) {
        history.current.push(before);
        if (history.current.length > 100) history.current.shift();
        future.current = [];
        setHistoryVersion((value) => value + 1);
      }
      dragBefore.current = null;
      dragSession.current = null;
    };
    try {
      if (
        event.phase === "move" &&
        Math.hypot(
          event.target.x - session.target.x,
          event.target.y - session.target.y,
        ) <= 1e-7
      )
        return {
          ok: true,
          point: dragPosition(session.document, session.sketchId, event),
        };
      const solved = solveDrag(
        session.document,
        session.sketchId,
        session.selection,
        event,
        (candidate, driver) =>
          solveDocument(candidate, driver, session.sketchId),
        { previousTarget: session.target, entityIds: session.entityIds },
      );
      session.document = solved.document;
      session.target = { ...event.target };
      flushSync(() => {
        setDoc(solved.document);
        setSolverState(solved.result);
        if (event.phase === "end") finish();
      });
      return { ok: true, point: solved.point };
    } catch (error) {
      if (event.phase === "end") {
        const valid = session.document;
        let result: SolverResult | undefined;
        try {
          result = solveDocument(clone(valid), undefined, session.sketchId);
        } catch {
          /* The accepted geometry remains authoritative on a rejected release. */
        }
        flushSync(() => {
          setDoc(valid);
          if (result?.ok) setSolverState(result);
          finish();
        });
        notify(
          event.exact
            ? `捕获位置无法满足现有约束，已保留有效位置：${(error as Error).message}`
            : (error as Error).message,
          true,
        );
      }
      return {
        ok: false,
        point: dragPosition(docRef.current, session.sketchId, event),
      };
    }
  };
  const field = (
    key: string,
    label: string,
    value: number,
    units = unit,
  ): Field => ({ key, label, value: String(value), unit: units });
  const runOperation = (input: OperationInput) => {
    try {
      const { operation } = input;
      const candidate = createOperationCandidate(
        docRef.current,
        activeId,
        input,
      );
      const next = candidate.document;
      if (candidate.removedConstraints.length) {
        setModal({
          title: "确认修改几何",
          description: `此操作将移除 ${candidate.removedConstraints.length} 项受影响的约束：${candidate.removedConstraints.map((id) => constraintLabels[sketch.constraints.find((c) => c.id === id)!.kind]).join("、")}`,
          fields: [],
          submit: "移除约束并修改",
          confirm: () => {
            const ok = commit(next, operationNames[operation]);
            if (ok) {
              setCommand(null);
              setSelection([]);
            }
            return ok;
          },
        });
        return false;
      }
      const ok = commit(next, operationNames[operation]);
      if (ok) {
        setSelection([]);
        setCommand(null);
      }
      return ok;
    } catch (error) {
      notify((error as Error).message, true);
      return false;
    }
  };
  const startOperation = (op: string) => {
    const previous = command?.previousSelection ?? selection;
    setMode("select");
    const forms: Record<string, Field[]> = {
      fillet: [field("radius", "半径", 5)],
      chamfer: [
        field("distance", "距离 1", 5),
        field("distance2", "距离 2", 5),
      ],
      offset: [field("distance", "偏移距离", 3)],
      move: [field("dx", "X 位移", 10), field("dy", "Y 位移", 0)],
      copy: [field("dx", "X 位移", 20), field("dy", "Y 位移", 0)],
      rotate: [
        field("angle", "角度", 30, "°"),
        field("cx", "中心 X", 0),
        field("cy", "中心 Y", 0),
      ],
      scale: [
        field("factor", "比例", 1.5, ""),
        field("cx", "基点 X", 0),
        field("cy", "基点 Y", 0),
      ],
      rectangularArray: [
        {
          key: "distribution",
          label: "分发",
          value: "间距",
          type: "select",
          options: ["间距", "范围"],
        },
        field("cols", "数量 1", 3, ""),
        field("dx", "距离 1", 20),
        {
          key: "direction1",
          label: "方向 1",
          value: "单向",
          type: "select",
          options: ["单向", "反向", "对称"],
        },
        field("rows", "数量 2", 2, ""),
        field("dy", "距离 2", 20),
        {
          key: "direction2",
          label: "方向 2",
          value: "单向",
          type: "select",
          options: ["单向", "反向", "对称"],
        },
      ],
      circularArray: [
        field("count", "数量", 6, ""),
        field("angle", "总角度", 360, "°"),
        field("cx", "中心 X", 0),
        field("cy", "中心 Y", 0),
      ],
    };
    setCommand(
      createCommandSession(
        "operation",
        op,
        operationNames[op],
        operationGeometry(op),
        forms[op] ?? [],
        sketch,
        previous,
      ),
    );
  };
  const confirmCommand = () => {
    if (!command || commandError) return;
    const picked = commandSelections(command);
    if (command.type === "constraint") {
      const kind = command.name as ConstraintKind;
      const targetRefs = picked.map(selectionKey);
      const ok = transaction(constraintLabels[kind], (_, s) => {
        if (canConstrain(s, kind, targetRefs))
          throw new Error("选取的对象不适用于此约束");
        if (
          s.constraints.some(
            (c) =>
              c.kind === kind &&
              c.refs.length === targetRefs.length &&
              c.refs.every((r) => targetRefs.includes(r)),
          )
        )
          throw new Error("此约束已经存在");
        s.constraints.push({ id: uid("c"), kind, refs: targetRefs });
      });
      if (ok) {
        setCommand(null);
        setSelection(picked);
      }
      return;
    }
    if (command.name === "blend") {
      const ok = transaction("过渡曲线", (_, s) => {
        const [a, b] = picked.map(
          (sel) => s.entities.find((e) => e.id === sel.entityId)!,
        );
        if (!a || !b || a.sourceId || b.sourceId)
          throw new Error("请先解除关联");
        const blended = blendEntity(a, b);
        blended.id = uid();
        blended.sourceId = a.id;
        blended.transform = { kind: "blend", secondarySourceId: b.id };
        s.entities.push(blended);
      });
      if (ok) {
        setCommand(null);
        setSelection([]);
      }
      return;
    }
    try {
      runOperation(resolveOperationInput(docRef.current, activeId, command));
    } catch (error) {
      notify((error as Error).message, true);
    }
  };
  const openExport = () => {
    setMenu(null);
    setModal({
      title: "导出草图",
      fields: [
        {
          key: "format",
          label: "文件格式",
          value: "DXF",
          type: "select",
          options: ["DXF", "SVG", "PDF"],
        },
        {
          key: "scope",
          label: "导出范围",
          value: "当前草图",
          type: "select",
          options: ["当前草图", "所有可见草图"],
        },
        {
          key: "construction",
          label: "构造几何",
          value: "不包含",
          type: "select",
          options: ["不包含", "包含"],
        },
        { key: "name", label: "文件名", value: doc.name, type: "text" },
      ],
      submit: "导出",
      confirm: async (values) => {
        try {
          if (!ready) throw new Error("求解器未就绪");
          const output = clone(docRef.current);
          solveDocument(output);
          if (values.scope === "当前草图")
            output.sketches = output.sketches
              .filter((s) => s.id === activeId)
              .map((s) => ({ ...s, visible: true }));
          const options = {
            allVisible: true,
            construction: values.construction === "包含",
          };
          if (
            !output.sketches.some(
              (s) =>
                s.visible &&
                s.entities.some((e) => options.construction || !e.construction),
            )
          )
            throw new Error("没有可导出的几何");
          if (values.format === "PDF") {
            const { exportPdf } = await import("./pdfExport");
            const content = await exportPdf(output, options);
            download(`${values.name}.pdf`, content, "application/pdf");
          } else {
            const isDxf = values.format === "DXF";
            const content = isDxf
              ? exportDxf(output, options)
              : exportSvg(output, options);
            download(
              `${values.name}.${isDxf ? "dxf" : "svg"}`,
              content,
              isDxf ? "application/dxf" : "image/svg+xml",
            );
          }
          notify(`${values.format} 已导出`);
          return true;
        } catch (error) {
          notify((error as Error).message, true);
          return false;
        }
      },
    });
  };
  const openParameters = () => {
    setMenu(null);
    setModal({
      title: "更改参数",
      description: undefined,
      fields: [
        {
          key: "parameters",
          label: "名称, 表达式, 单位（每行一项）",
          value: doc.parameters
            .map((p) => `${p.name}, ${p.expression}, ${p.unit}`)
            .join("\n"),
          type: "textarea",
        },
      ],
      confirm: (values) => {
        try {
          const parameters = values.parameters.trim()
            ? values.parameters
                .split(/\n|;/)
                .filter(Boolean)
                .map((line) => {
                  const [name, expression, unit = "mm"] = line
                    .split(",")
                    .map((s) => s.trim());
                  if (!["mm", "deg", "scalar"].includes(unit))
                    throw new Error("单位仅支持 mm、deg、scalar");
                  return {
                    name,
                    expression,
                    unit: unit as "mm" | "deg" | "scalar",
                  };
                })
            : [];
          resolveParameters(parameters);
          return transaction("更改参数", (candidate) => {
            candidate.parameters = parameters;
          });
        } catch (error) {
          notify((error as Error).message, true);
          return false;
        }
      },
    });
  };
  const newDocument = (demo = false) => {
    setMenu(null);
    setModal({
      title: demo ? "打开示例草图" : "新建文档",
      description: "当前文档将被替换。可先取消并下载草图文件。",
      fields: [
        {
          key: "name",
          label: "文档名称",
          value: demo ? "连接板" : "未命名草图",
        },
      ],
      submit: demo ? "打开示例" : "新建",
      confirm: async (values) => {
        try {
          await workspace.persist();
          const next = demo ? demoDocument() : emptyDocument();
          next.name = values.name.trim() || "未命名草图";
          if (commit(next, "新建", false)) {
            history.current = [];
            future.current = [];
            setHistoryVersion((value) => value + 1);
            workspace.detach(docRef.current);
            registerUntitledTab(next.name);
            switchSketch(next.sketches[0].id);
            setFitKey((v) => v + 1);
            return true;
          }
          return false;
        } catch (error) {
          notify(`未替换当前项目：${(error as Error).message}`, true);
          return false;
        }
      },
    });
  };
  const createSketch = () => {
    const s: Sketch = {
      id: uid("sk"),
      name: `草图 ${docRef.current.sketches.length + 1}`,
      visible: true,
      entities: [],
      constraints: [],
    };
    if (transaction("新建草图", (candidate) => candidate.sketches.push(s)))
      switchSketch(s.id);
  };
  const editEntity = (e: Entity) => {
    if (e.sourceId && e.transform) {
      const t = e.transform;
      if (!["translate", "rotate"].includes(t.kind)) {
        notify("此对象通过源几何更新；可先解除关联后编辑", true);
        return;
      }
      const fields: Field[] = [
        {
          key: "x",
          label: t.kind === "rotate" ? "中心 X" : "X 位移",
          value: t.xExpression ?? formatted(t.x ?? 0),
          unit,
        },
        {
          key: "y",
          label: t.kind === "rotate" ? "中心 Y" : "Y 位移",
          value: t.yExpression ?? formatted(t.y ?? 0),
          unit,
        },
      ];
      if (t.kind === "rotate")
        fields.push({
          key: "angle",
          label: "角度",
          value: t.angleExpression ?? String(t.angle ?? 0),
          unit: "°",
        });
      setModal({
        title: "关联变换",
        fields,
        confirm: (values) =>
          transaction("关联变换", (_, s) => {
            const target = s.entities.find(
              (item) => item.id === e.id,
            )!.transform!;
            for (const key of ["x", "y", "angle"] as const) {
              if (values[key] === undefined) continue;
              const linked = hasParameterReferences(values[key]);
              target[key] =
                evaluateExpression(
                  values[key],
                  resolveParameters(docRef.current.parameters),
                  key === "angle" ? "deg" : "mm",
                ) * (key !== "angle" && !linked ? factor : 1);
              const expressionKey =
                key === "x"
                  ? "xExpression"
                  : key === "y"
                    ? "yExpression"
                    : "angleExpression";
              target[expressionKey] = linked ? values[key] : undefined;
            }
          }),
      });
      return;
    }
    const fields: Field[] = [{ key: "name", label: "名称", value: e.name }];
    if (e.kind === "circle")
      fields.push(
        field("diameter", "直径", Number(formatted(2 * (e.radius ?? 1)))),
      );
    else if (e.kind === "arc")
      fields.push(field("radius", "半径", Number(formatted(arcInfo(e).r))));
    if (e.kind === "ellipse")
      fields.push(field("ry", "短轴半径", Number(formatted(e.ry ?? 1))));
    if (e.kind === "conic")
      fields.push(field("weight", "权重", e.weight ?? 1, ""));
    if (e.kind === "text")
      fields.push(
        { key: "text", label: "内容", value: e.text ?? "" },
        field("fontSize", "高度", Number(formatted(e.fontSize ?? 6))),
        field("rotation", "旋转", e.rotation ?? 0, "°"),
      );
    setModal({
      title: "对象属性",
      fields,
      confirm: (values) =>
        transaction("编辑属性", (_, s) => {
          const item = s.entities.find((item) => item.id === e.id)!;
          if (item.sourceId) throw new Error("请编辑源对象或解除关联");
          item.name = values.name.trim() || kindLabels[item.kind];
          for (const key of [
            "radius",
            "diameter",
            "ry",
            "weight",
            "fontSize",
            "rotation",
          ] as const) {
            if (
              values[key] === undefined ||
              values[key] === fields.find((f) => f.key === key)?.value
            )
              continue;
            if (
              s.constraints.some(
                (c) => c.kind === "fixed" && c.refs.includes(item.id),
              )
            )
              throw new Error("固定对象须先移除固定约束");
            if (
              key === "ry" &&
              s.constraints.some(
                (c) => c.kind === "ellipseWidth" && c.refs[0] === item.id,
              )
            )
              throw new Error("短轴已绑定，请编辑绑定点或移除短轴关联");
            if (
              (key === "radius" || key === "diameter") &&
              s.constraints.some(
                (c) =>
                  ["radius", "diameter"].includes(c.kind) &&
                  c.refs.includes(item.id),
              )
            )
              throw new Error("请编辑对应的半径或直径尺寸");
            const n =
              evaluateExpression(
                values[key],
                resolveParameters(doc.parameters),
                key === "rotation" ? "deg" : key === "weight" ? "scalar" : "mm",
              ) *
              (!["weight", "rotation"].includes(key) &&
              !hasParameterReferences(values[key])
                ? factor
                : 1);
            if (key !== "rotation" && n <= 0) throw new Error("参数必须为正");
            if (key === "radius" && item.kind === "arc") {
              const ratio = n / arcInfo(item).r;
              for (const p of item.points.slice(1))
                Object.assign(
                  p,
                  add(item.points[0], mul(sub(p, item.points[0]), ratio)),
                );
            }
            if (key === "diameter") item.radius = n / 2;
            else item[key] = n;
          }
          if (item.kind === "text") {
            if (!values.text.trim()) throw new Error("文本不能为空");
            item.text = values.text;
          }
        }),
    });
  };
  const menuToggle = (name: string) => setMenu(menu === name ? null : name);
  const constraintKinds: ConstraintKind[] = [
    "coincident",
    "horizontal",
    "vertical",
    "parallel",
    "perpendicular",
    "tangent",
    "equal",
    "fixed",
    "concentric",
    "midpoint",
    "symmetric",
    "collinear",
    "onLine",
  ];
  return (
    <div
      className={`app ${tool !== "select" ? "creation-mode" : ""} ${leftOpen ? "" : "left-closed"} ${rightOpen || tool !== "select" ? "" : "right-closed"}`}
      inert={projectTransition !== null}
      data-history={historyVersion}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <Hexagon size={23} strokeWidth={1.7} />
            <Minus size={11} />
          </div>
          <strong>SketchWorks</strong>
          <span className="brand-tag">CAD</span>
        </div>
        <button
          type="button"
          className="header-action"
          aria-label="项目管理"
          aria-pressed={fileManager !== null}
          title="项目管理 (Ctrl+O)"
          disabled={!workspace.ready || fileManagerLocked}
          onClick={() =>
            fileManager ? setFileManager(null) : openFileManager("browse")
          }
        >
          <FolderOpen size={15} />
          <span>项目管理</span>
        </button>
        <div className="document-title">
          <FileJson size={16} />
          <strong
            className="document-name"
            title={workspace.activeFile?.name ?? doc.name}
          >
            {doc.name || "未命名草图"}
          </strong>
          <span className="save-dot" data-saved={saved} />
        </div>
        <div className="header-right">
          <span className="save-label" title={workspace.activeFile?.name}>
            {workspace.activeFile
              ? `${workspace.activeFile.name} · ${saved ? "项目已保存" : "未保存"}`
              : saved
                ? "本地已保存"
                : "未保存"}
          </span>
          <a
            className="header-link"
            href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`}
            target="_blank"
            title="第三方许可"
            aria-label="第三方许可"
          >
            <CircleHelp size={16} />
          </a>
          <a
            className="header-link"
            href="https://github.com/wuldas/sketchworks"
            target="_blank"
            rel="noreferrer"
            title="GitHub 项目主页"
            aria-label="GitHub 项目主页"
          >
            <Github size={16} />
          </a>
          <button
            className="export-button"
            onClick={openExport}
            disabled={!ready || !sketch.entities.length}
          >
            <Download size={15} />
            导出
            <ChevronDown size={13} />
          </button>
        </div>
      </header>
      <div className="app-body">
        {fileManager && (
          <aside className="project-panel">
            <FileManager
              mode={fileManager}
              document={doc}
              project={workspace.project}
              activeFileId={workspace.activeFile?.id}
              initialFolderId={workspace.activeFile?.parentId ?? ROOT_ID}
              onOpen={openVirtualProject}
              onCreateProject={createVirtualProject}
              onSaved={saveVirtualProject}
              onProjectChanged={workspace.updateProject}
              onEntriesChanged={refreshVirtualFiles}
              onLockChange={setFileManagerLocked}
              onClose={() => setFileManager(null)}
            />
          </aside>
        )}
        <div className="app-main">
          <nav className="project-tabs" role="tablist" aria-label="打开的项目">
            {projectTabs.map((tab) => (
              <div
                key={tab.id}
                className={`project-tab ${activeTabId === tab.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTabId === tab.id}
                  className="project-tab-label"
                  title={tab.name}
                  onClick={() => void activateProjectTab(tab)}
                >
                  {tab.name}
                </button>
                <button
                  type="button"
                  className="project-tab-close"
                  aria-label={`关闭 ${tab.name}`}
                  title={`关闭 ${tab.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeProjectTab(tab);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="project-tab-add"
              aria-label="新建未命名项目"
              title="新建未命名项目"
              disabled={!workspace.ready || projectTransition !== null}
              onClick={() => void addUntitledProject()}
            >
              <Plus size={14} />
            </button>
          </nav>
          <nav className="workspace-tabbar" aria-label="一级标签">
            <div className="file-menu-wrap">
              <button
                className="file-menu-toggle"
                onClick={() => menuToggle("file")}
              >
                <FileJson size={15} />
                文件
                <ChevronDown size={12} />
              </button>
              {menu === "file" && (
                <div className="menu file-menu">
                  <MenuItem
                    icon={FolderOpen}
                    label="项目管理"
                    shortcut="Ctrl O"
                    onClick={() => openFileManager("browse")}
                  />
                  <div className="menu-divider" />
                  <MenuItem
                    icon={FilePlus2}
                    label="新建文档"
                    onClick={() => newDocument()}
                  />
                  <MenuItem
                    icon={FolderOpen}
                    label="打开草图"
                    onClick={() => {
                      fileInput.current?.click();
                      setMenu(null);
                    }}
                  />
                  <MenuItem
                    icon={Save}
                    label="保存草图"
                    shortcut="Ctrl S"
                    onClick={() => void saveProject()}
                  />
                  <MenuItem
                    icon={Save}
                    label="项目另存为"
                    shortcut="Ctrl Shift S"
                    onClick={() => openFileManager("save")}
                  />
                  <MenuItem
                    icon={Download}
                    label="下载项目"
                    onClick={downloadProject}
                  />
                  <MenuItem
                    icon={FileJson}
                    label="导出 JSON 草图"
                    onClick={saveJson}
                  />
                  <div className="menu-divider" />
                  <MenuItem
                    icon={Hexagon}
                    label="打开连接板示例"
                    onClick={() => newDocument(true)}
                  />
                  <MenuItem
                    icon={Download}
                    label="导出 DXF / SVG / PDF"
                    onClick={openExport}
                  />
                </div>
              )}
            </div>
            <IconButton
              icon={Save}
              title="保存当前项目"
              disabled={!workspace.ready || fileManagerLocked}
              onClick={() => openFileManager("save")}
            />
            <IconButton
              icon={Undo2}
              title="撤销 (Ctrl+Z)"
              disabled={!history.current.length}
              onClick={undo}
            />
            <IconButton
              icon={Redo2}
              title="重做 (Ctrl+Shift+Z)"
              disabled={!future.current.length}
              onClick={redo}
            />
            <div className="tab-divider" />
            <button className="workspace-tab selected">草图</button>
            <div className="tab-spacer" />
            <IconButton
              icon={PanelLeftClose}
              title="切换左侧栏"
              active={!leftOpen}
              disabled={fileManagerLocked}
              onClick={() => setLeftOpen(!leftOpen)}
            />
            <IconButton
              icon={PanelRightClose}
              title="切换属性面板"
              active={!rightOpen}
              disabled={tool !== "select"}
              onClick={() => setRightOpen(!rightOpen)}
            />
          </nav>
          <div className="ribbon">
            <div className="ribbon-group select-group">
              <button
                className={`ribbon-tool ${tool === "select" && !command ? "selected" : ""}`}
                onClick={() => setMode("select")}
                title="选择"
              >
                <MousePointer2 size={25} />
                <span>选择</span>
              </button>
              <span className="group-caption">选择</span>
            </div>
            <div className="ribbon-group create-group">
              <div className="ribbon-tools">
                {(
                  [
                    "line",
                    "rectangle",
                    "circle",
                    "arc",
                    "spline",
                    "polygon",
                  ] as Tool[]
                ).map((mode) => {
                  const Icon = toolIcons[mode];
                  return (
                    <button
                      key={mode}
                      className={`ribbon-tool ${creationMethods(tool).some((method) => method.tool === mode) ? "selected" : ""}`}
                      title={toolLabels[mode]}
                      aria-label={toolLabels[mode]}
                      onClick={() => setMode(mode)}
                    >
                      <Icon size={25} />
                      <span>
                        {
                          (
                            {
                              line: "直线",
                              rectangle: "矩形",
                              circle: "圆",
                              arc: "圆弧",
                              spline: "样条",
                              polygon: "多边形",
                            } as Record<string, string>
                          )[mode]
                        }
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                className={`group-caption dropdown-caption ${menu === "create" ? "open" : ""}`}
                onClick={() => menuToggle("create")}
              >
                创建
                <ChevronDown size={12} />
              </button>
              {menu === "create" && (
                <div className="menu ribbon-menu create-menu">
                  {(Object.keys(toolLabels) as Tool[])
                    .filter((m) => m !== "select")
                    .map((m) => (
                      <MenuItem
                        key={m}
                        icon={toolIcons[m]}
                        label={toolLabels[m]}
                        shortcut={m === "line" ? "L" : undefined}
                        onClick={() => setMode(m)}
                      />
                    ))}
                  <div className="menu-divider" />
                  {["mirror", "rectangularArray", "circularArray"].map((op) => (
                    <MenuItem
                      key={op}
                      icon={operationIcons[op]}
                      label={operationNames[op]}
                      onClick={() => startOperation(op)}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="ribbon-group modify-group">
              <div className="ribbon-tools">
                {["fillet", "trim", "offset", "move"].map((op) => {
                  const Icon = operationIcons[op];
                  return (
                    <button
                      key={op}
                      className={`ribbon-tool ${command?.type === "operation" && command.name === op ? "selected" : ""}`}
                      title={operationNames[op]}
                      onClick={() => startOperation(op)}
                    >
                      <Icon size={25} />
                      <span>{operationNames[op]}</span>
                    </button>
                  );
                })}
              </div>
              <button
                className={`group-caption dropdown-caption ${menu === "modify" ? "open" : ""}`}
                onClick={() => menuToggle("modify")}
              >
                修改
                <ChevronDown size={12} />
              </button>
              {menu === "modify" && (
                <div className="menu ribbon-menu">
                  {[
                    "fillet",
                    "chamfer",
                    "blend",
                    "offset",
                    "trim",
                    "extend",
                    "break",
                    "scale",
                    "move",
                    "rotate",
                    "copy",
                    "detach",
                  ].map((op) => (
                    <MenuItem
                      key={op}
                      icon={operationIcons[op]}
                      label={operationNames[op]}
                      onClick={() => startOperation(op)}
                    />
                  ))}
                  <div className="menu-divider" />
                  <MenuItem
                    icon={SlidersHorizontal}
                    label="更改参数"
                    onClick={openParameters}
                  />
                </div>
              )}
            </div>
            <div className="ribbon-group dimension-group">
              <button
                className={`ribbon-tool ${dimensionMode ? "selected" : ""}`}
                title="草图尺寸 (D)"
                aria-pressed={dimensionMode}
                onClick={() => startDimension()}
              >
                <Ruler size={26} />
                <span>尺寸</span>
              </button>
              <span className="group-caption">标注</span>
            </div>
            <div className="ribbon-group constraints-group">
              <div className="constraint-ribbon">
                {constraintKinds.slice(0, 10).map((kind) => (
                  <IconButton
                    key={kind}
                    icon={constraintIcons[kind]}
                    title={constraintLabels[kind]}
                    disabled={!ready}
                    onClick={() => startConstraint(kind)}
                  />
                ))}
              </div>
              <button
                className="group-caption dropdown-caption"
                onClick={() => menuToggle("constraints")}
              >
                约束
                <ChevronDown size={12} />
              </button>
              {menu === "constraints" && (
                <div className="menu ribbon-menu">
                  {constraintKinds.map((kind) => (
                    <MenuItem
                      key={kind}
                      icon={constraintIcons[kind]}
                      label={constraintLabels[kind]}
                      disabled={!ready}
                      onClick={() => {
                        startConstraint(kind);
                        setMenu(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="ribbon-end">
              <button
                className="construction-button"
                title="构造几何"
                aria-label="构造几何"
                aria-pressed={config.construction}
                onClick={() => {
                  if (selection.length)
                    transaction("构造几何", (_, s) => {
                      for (const e of s.entities)
                        if (selection.some((p) => p.entityId === e.id))
                          e.construction = !e.construction;
                    });
                  else
                    setConfig({
                      ...config,
                      construction: !config.construction,
                    });
                }}
              >
                <CircleDashed size={22} />
                <span>构造</span>
              </button>
            </div>
          </div>
          <main className="work-area">
            <aside className="browser-panel">
              <div className="sketch-browser">
                <div className="panel-heading">
                  <span>浏览器</span>
                  <IconButton
                    icon={Plus}
                    title="新建草图"
                    disabled={!ready}
                    onClick={createSketch}
                  />
                </div>
                <div className="tree-document">
                  <ChevronDown size={13} />
                  <FileJson size={16} />
                  <strong>{doc.name || "未命名草图"}</strong>
                </div>
                <div className="document-settings">
                  <Settings2 size={14} />
                  <span>文档设置</span>
                </div>
                <div className="unit-setting">
                  <Ruler size={14} />
                  <span>单位</span>
                  <select
                    aria-label="单位"
                    value={doc.unit}
                    onChange={(e) => {
                      if (
                        transaction("切换单位", (candidate) => {
                          candidate.unit = e.target.value as "mm" | "in";
                        })
                      )
                        setMode("select");
                    }}
                  >
                    <option value="mm">毫米</option>
                    <option value="in">英寸</option>
                  </select>
                </div>
                <div className="tree-section">
                  <Crosshair size={14} />
                  <span>原点</span>
                  <span className="subtle">XY</span>
                </div>
                <div className="tree-section">
                  <Rows3 size={14} />
                  <span>草图</span>
                  <span className="count-badge">{doc.sketches.length}</span>
                </div>
                <div className="sketch-tree">
                  {doc.sketches.map((s) => (
                    <div
                      key={s.id}
                      className={`sketch-row ${s.id === activeId ? "current" : ""}`}
                    >
                      <button
                        className="sketch-name"
                        onClick={() => switchSketch(s.id)}
                      >
                        <ChevronRight size={12} />
                        <Pencil size={14} />
                        <span>{s.name}</span>
                      </button>
                      <IconButton
                        icon={s.visible ? Eye : EyeOff}
                        title={`${s.visible ? "隐藏" : "显示"}${s.name}`}
                        onClick={() =>
                          transaction("草图可见性", (candidate) => {
                            candidate.sketches.find(
                              (sk) => sk.id === s.id,
                            )!.visible = !s.visible;
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="entity-list-heading">
                  <span>几何对象</span>
                  <span>{sketch.entities.length}</span>
                </div>
                <div className="entity-list">
                  {sketch.entities.map((e, i) => {
                    const Icon =
                      toolIcons[
                        (e.kind === "line"
                          ? "line"
                          : e.kind === "circle"
                            ? "circle"
                            : e.kind === "arc"
                              ? "arc"
                              : e.kind === "ellipse"
                                ? "ellipse"
                                : e.kind === "spline"
                                  ? "spline"
                                  : e.kind === "bezier"
                                    ? "bezier"
                                    : e.kind === "conic"
                                      ? "conic"
                                      : e.kind === "point"
                                        ? "point"
                                        : "text") as Tool
                      ];
                    return (
                      <button
                        key={e.id}
                        className={`entity-row ${displayedSelection.some((s) => s.entityId === e.id) ? "selected" : ""}`}
                        title={e.sourceId ? "关联副本" : e.name}
                        onClick={(event) =>
                          select(
                            { entityId: e.id },
                            event.ctrlKey || event.metaKey || event.shiftKey,
                          )
                        }
                        onDoubleClick={() => {
                          if (!command) editEntity(e);
                        }}
                      >
                        <Icon size={14} />
                        <span>{e.name}</span>
                        {e.sourceId ? (
                          <GitBranch size={12} />
                        ) : e.construction ? (
                          <CircleDashed size={12} />
                        ) : (
                          <small>{String(i + 1).padStart(2, "0")}</small>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="browser-footer">
                  <span className="plane-dot" />
                  XY 平面<span>2D</span>
                </div>
              </div>
            </aside>
            <div className="canvas-container">
              <Viewport
                sketches={doc.sketches}
                activeId={activeId}
                selection={displayedSelection}
                tool={tool}
                drafts={drafts}
                creationActive={creationActive}
                operationPreview={operationPreview.entities}
                config={config}
                grid={grid}
                snap={snap}
                snapOptions={snapOptions}
                fitKey={fitKey}
                unit={doc.unit}
                onPlace={place}
                onSelect={select}
                onBox={(ids, additive) => {
                  if (command) {
                    changeCommandSelection(
                      ids.map((entityId) => ({ entityId })),
                      additive ? "append" : "replace",
                    );
                    return;
                  }
                  if (!additive) setSelectedDimensionId(null);
                  setSelection((prev) => {
                    const next = ids.map((entityId) => ({ entityId }));
                    return additive
                      ? [
                          ...prev.filter((p) => !ids.includes(p.entityId)),
                          ...next,
                        ]
                      : next;
                  });
                }}
                onCursor={setCursor}
                onDrag={drag}
                onFinish={(point, snapRef) => {
                  if (tool === "spline") finishSpline(point, snapRef);
                  else {
                    setDrafts([]);
                    setCreationActive(0);
                    setCreationPickRevision((version) => version + 1);
                    draftSnaps.current = [];
                    draftCaptured.current = false;
                  }
                }}
                onEditConstraint={(id) => {
                  const c = sketch.constraints.find((c) => c.id === id);
                  if (c)
                    openDimensionInput(c.kind, c.refs, { existingId: c.id });
                }}
                pickParameters={
                  command
                    ? command.geometry[command.active]?.kind === "position"
                      ? "position"
                      : "geometry"
                    : undefined
                }
                onParameterPick={pickCommand}
                pickDimension={dimensionMode}
                dimensionPicks={dimensionPicks}
                dimensionKindMode={dimensionKindMode}
                dimensionGuides={
                  dimensionMode && !dimensionDraft
                    ? (dimensionPicks
                        .filter((ref) => resolveEntity(sketch, ref)?.id !== ref)
                        .map((ref) => referencePoint(sketch, ref))
                        .filter(Boolean) as XY[])
                    : []
                }
                dimensionDraft={dimensionDraft}
                dimensionAdjustment={dimensionAdjustment}
                onDimensionAdjust={adjustDimension}
                onDimensionPositionCommit={commitDimensionPosition}
                dimensionSelection={selectedDimensionId}
                onDimensionSelect={selectDimension}
                onDimensionPick={pickDimension}
                onDimensionCommit={commitDimension}
                onDimensionCancel={cancelDimensions}
              />
              {command && (
                <ParameterPanel
                  session={command}
                  sketch={sketch}
                  unit={unit}
                  factor={factor}
                  error={commandError}
                  onChange={setCommand}
                  onConfirm={confirmCommand}
                  onCancel={cancel}
                />
              )}
              {!ready && (
                <div className="loading-overlay">
                  <LoaderCircle size={23} className="spin" />
                  <span>加载几何求解器</span>
                </div>
              )}
            </div>
            <aside
              className="properties-panel"
              aria-label={tool !== "select" ? "绘制参数" : "属性与约束"}
            >
              <div className="panel-heading">
                <span>草图选项</span>
                <Settings2 size={16} />
              </div>
              <div className="option-list">
                <label>
                  <span>
                    <Grid3X3 size={15} />
                    网格
                  </span>
                  <input
                    type="checkbox"
                    checked={grid}
                    onChange={(e) => setGrid(e.target.checked)}
                  />
                </label>
                <label>
                  <span>
                    <Magnet size={15} />
                    吸附
                  </span>
                  <input
                    type="checkbox"
                    checked={snap}
                    onChange={(e) => setSnap(e.target.checked)}
                  />
                </label>
                <label>
                  <span>
                    <GitMerge size={15} />
                    自动约束
                  </span>
                  <input
                    type="checkbox"
                    checked={config.autoConstraint}
                    onChange={(e) =>
                      setConfig({ ...config, autoConstraint: e.target.checked })
                    }
                  />
                </label>
                <label>
                  <span>
                    <CircleDashed size={15} />
                    构造几何
                  </span>
                  <input
                    type="checkbox"
                    checked={config.construction}
                    onChange={(e) =>
                      setConfig({ ...config, construction: e.target.checked })
                    }
                  />
                </label>
              </div>
              {tool !== "select" && !command ? (
                <CreationPanel
                  tool={tool}
                  points={drafts}
                  active={creationActive}
                  pickRevision={creationPickRevision}
                  config={config}
                  unit={unit}
                  factor={factor}
                  error={creationError}
                  onToolChange={setMode}
                  onActivate={(index) => {
                    if (index <= drafts.length) setCreationActive(index);
                  }}
                  onPointChange={changeCreationPoint}
                  onTruncate={truncateCreation}
                  onConfigChange={setConfig}
                  onInputValidityChange={setCreationInputsValid}
                  onComplete={() => {
                    if (tool === "spline") finishSpline();
                    else completeCreation();
                  }}
                  onCancel={cancel}
                />
              ) : (
                <>
                  <div className="section-heading">
                    <span>属性</span>
                    {one && (
                      <IconButton
                        icon={Pencil}
                        title="编辑对象属性"
                        onClick={() => editEntity(one)}
                      />
                    )}
                  </div>
                  <div className="property-content">
                    {selection.length ? (
                      <>
                        <div className="property-title">
                          {selection.length === 1
                            ? selection[0].pointId
                              ? "控制点"
                              : one?.name
                            : `${selectedEntities.length} 个对象`}
                          <span className="property-chip">
                            {selection[0]?.pointId
                              ? "点"
                              : one
                                ? kindLabels[one.kind]
                                : "多选"}
                          </span>
                        </div>
                        {one && (
                          <>
                            <div className="property-row">
                              <span>X</span>
                              <strong>
                                {formatted(one.points[0].x)}
                                <small>{unit}</small>
                              </strong>
                            </div>
                            <div className="property-row">
                              <span>Y</span>
                              <strong>
                                {formatted(one.points[0].y)}
                                <small>{unit}</small>
                              </strong>
                            </div>
                            {one.kind === "line" && (
                              <div className="property-row">
                                <span>长度</span>
                                <strong>
                                  {formatted(
                                    dist(one.points[0], one.points[1]),
                                  )}
                                  <small>{unit}</small>
                                </strong>
                              </div>
                            )}
                            {(one.kind === "circle" || one.kind === "arc") && (
                              <div className="property-row">
                                <span>
                                  {one.kind === "circle" ? "直径" : "半径"}
                                </span>
                                <strong>
                                  {formatted(
                                    one.kind === "arc"
                                      ? arcInfo(one).r
                                      : 2 * (one.radius ?? 0),
                                  )}
                                  <small>{unit}</small>
                                </strong>
                              </div>
                            )}
                            {one.sourceId && (
                              <div className="derived-note">
                                <GitBranch size={14} />
                                关联几何
                                <IconButton
                                  icon={Unlink}
                                  title="解除关联"
                                  onClick={() => startOperation("detach")}
                                />
                              </div>
                            )}
                          </>
                        )}
                        <div className="selection-actions">
                          <button
                            className="button small"
                            onClick={() => startDimension()}
                          >
                            <Ruler size={14} />
                            尺寸
                          </button>
                          <IconButton
                            icon={Trash2}
                            title="删除选中对象"
                            onClick={removeSelected}
                          />
                        </div>
                      </>
                    ) : selectedDimension ? (
                      <div data-testid="selected-dimension">
                        <div className="property-title">
                          标注
                          <span className="property-chip">
                            {constraintLabels[selectedDimension.kind]}
                          </span>
                        </div>
                        {selectedDimension.value !== undefined && (
                          <div className="property-row">
                            <span>数值</span>
                            <strong>
                              {selectedDimension.expression ??
                                (selectedDimension.kind === "angle"
                                  ? `${Number(selectedDimension.value.toFixed(2))}°`
                                  : formatted(selectedDimension.value))}
                            </strong>
                          </div>
                        )}
                        <div className="selection-actions">
                          {selectedDimension.value !== undefined && (
                            <button
                              className="button small"
                              onClick={() =>
                                openDimensionInput(
                                  selectedDimension.kind,
                                  selectedDimension.refs,
                                  { existingId: selectedDimension.id },
                                )
                              }
                            >
                              <Ruler size={14} />
                              编辑
                            </button>
                          )}
                          <IconButton
                            icon={Trash2}
                            title="删除选中对象"
                            onClick={removeSelected}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="empty-selection">
                        <MousePointer2 size={21} />
                        <span>未选择对象</span>
                      </div>
                    )}
                  </div>
                  <div className="section-heading">
                    <span>几何约束</span>
                    <span className="count-badge">
                      {sketch.constraints.length}
                    </span>
                  </div>
                  <div className="constraint-grid">
                    {constraintKinds.map((kind) => (
                      <IconButton
                        key={kind}
                        icon={constraintIcons[kind]}
                        title={constraintLabels[kind]}
                        disabled={!ready}
                        onClick={() => startConstraint(kind)}
                      />
                    ))}
                  </div>
                  <div className="dimension-select">
                    <select
                      aria-label="尺寸类型"
                      value={dimensionKindMode}
                      onChange={(e) => {
                        const mode = e.target.value as DimensionPickMode;
                        setDimensionKindMode(mode);
                        setDimensionPicks([]);
                        setDimensionDraft(null);
                        startDimension(mode);
                      }}
                    >
                      <option value="auto">自动</option>
                      {(
                        [
                          "length",
                          "lineDistance",
                          "distanceX",
                          "distanceY",
                          "radius",
                          "diameter",
                          "angle",
                        ] as ConstraintKind[]
                      ).map((kind) => (
                        <option key={kind} value={kind}>
                          {constraintLabels[kind]}
                        </option>
                      ))}
                    </select>
                    <IconButton
                      icon={Ruler}
                      title="添加尺寸"
                      active={dimensionMode}
                      onClick={() => startDimension()}
                    />
                  </div>
                  <div className="constraint-list">
                    {sketch.constraints
                      .filter(
                        (c) =>
                          !selection.length ||
                          c.refs.some((r) =>
                            selection.some(
                              (s) =>
                                s.entityId === r ||
                                s.pointId === r ||
                                sketch.entities
                                  .find((e) => e.id === s.entityId)
                                  ?.points.some((p) => p.id === r),
                            ),
                          ),
                      )
                      .map((c) => {
                        const Icon = constraintIcons[c.kind];
                        return (
                          <div
                            key={c.id}
                            className={`constraint-row ${solverState.conflicting.includes(c.id) ? "conflict" : ""}`}
                          >
                            <Icon size={13} />
                            <button
                              title="定位约束"
                              onClick={() =>
                                setSelection(
                                  c.refs
                                    .map((r) => {
                                      const e = resolveEntity(sketch, r);
                                      return e
                                        ? {
                                            entityId: e.id,
                                            pointId: e.id === r ? undefined : r,
                                          }
                                        : undefined;
                                    })
                                    .filter(Boolean) as Selection[],
                                )
                              }
                            >
                              {constraintLabels[c.kind]}
                            </button>
                            {c.value !== undefined && (
                              <button
                                className="constraint-value"
                                title="编辑尺寸"
                                onClick={() =>
                                  openDimensionInput(c.kind, c.refs, {
                                    existingId: c.id,
                                  })
                                }
                              >
                                {c.expression ??
                                  (c.kind === "angle"
                                    ? `${Number(c.value.toFixed(2))}°`
                                    : formatted(c.value))}
                              </button>
                            )}
                            <IconButton
                              icon={X}
                              title={`移除${constraintLabels[c.kind]}约束`}
                              onClick={() =>
                                transaction("移除约束", (_, s) => {
                                  s.constraints = s.constraints.filter(
                                    (item) => item.id !== c.id,
                                  );
                                })
                              }
                            />
                          </div>
                        );
                      })}
                  </div>
                  <div className="parameter-footer">
                    <button onClick={openParameters}>
                      <SlidersHorizontal size={15} />
                      参数<span>{doc.parameters.length}</span>
                    </button>
                  </div>
                </>
              )}
            </aside>
          </main>
          <div className="bottom-strip">
            <div className="sketch-tabs">
              {doc.sketches.map((s) => (
                <button
                  key={s.id}
                  className={s.id === activeId ? "active" : ""}
                  onClick={() => switchSketch(s.id)}
                >
                  <Pencil size={12} />
                  {s.name}
                </button>
              ))}
              <IconButton icon={Plus} title="添加草图" onClick={createSketch} />
            </div>
            <div className="bottom-actions">
              <IconButton
                icon={Maximize2}
                title="适配全部"
                onClick={() => setFitKey((v) => v + 1)}
              />
              {(
                [
                  ["grid", Grid3X3, "网格捕获"],
                  ["midpoint", Triangle, "中点捕获"],
                  ["endpoint", CircleDot, "端点捕获"],
                  ["tangent", Tangent, "切点捕获"],
                  ["intersection", Crosshair, "相交点捕获"],
                ] as const
              ).map(([kind, Icon, title]) => (
                <IconButton
                  key={kind}
                  icon={Icon}
                  title={title}
                  active={snapOptions[kind]}
                  onClick={() =>
                    setSnapOptions((current) => ({
                      ...current,
                      [kind]: !current[kind],
                    }))
                  }
                />
              ))}
              <IconButton
                icon={Magnet}
                title="切换吸附"
                active={snap}
                onClick={() => setSnap(!snap)}
              />
            </div>
          </div>
        </div>
      </div>
      <footer className="status-bar">
        <div className={`solver-status ${ready ? "" : "loading"}`}>
          <span
            className={`status-dot ${solverState.conflicting.length ? "error" : solverState.dof === 0 ? "complete" : ""}`}
          />
          {!ready
            ? "求解器加载中"
            : solverState.conflicting.length
              ? "约束冲突 · 操作未提交"
              : solverState.dof === 0
                ? "完全约束"
                : `欠约束 · ${solverState.dof} 自由度`}
        </div>
        <span className="tool-status">
          {dimensionDraft
            ? `${constraintLabels[dimensionDraft.kind]}：输入数值后按 Enter`
            : dimensionAdjustment
              ? "尺寸：调整标注位置"
              : dimensionMode
                ? dimensionRequest?.complete
                  ? dimensionPicks.length === 1 && dimensionKindMode === "auto"
                    ? "尺寸：定位标注 / 第二个对象"
                    : "尺寸：定位标注"
                  : dimensionPicks.length
                    ? dimensionKindMode === "angle"
                      ? "尺寸：请选择第二条线"
                      : dimensionKindMode === "lineDistance"
                        ? "尺寸：请选择直线或点"
                        : "尺寸：请选择第二个点"
                    : "尺寸：点击几何或点"
                : command
                  ? `${command.title}：选择${command.geometry[command.active]?.label}`
                  : toolLabels[tool]}
          {drafts.length ? ` · ${drafts.length}` : ""}
        </span>
        <div className="status-right">
          <span>
            X <strong>{formatted(cursor.x)}</strong>
          </span>
          <span>
            Y <strong>{formatted(cursor.y)}</strong>
          </span>
          <span>{unit}</span>
          <span className="status-separator" />
          <span>{sketch.entities.length} 对象</span>
        </div>
      </footer>
      {menu && <div className="menu-dismiss" onClick={() => setMenu(null)} />}
      {modal && (
        <ModalView
          key={modal.title + modal.fields.map((f) => f.value).join("|")}
          modal={modal}
          onClose={() => setModal(null)}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".swcad,.asar,.json,.sketch.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const isAsar = /\.(?:swcad|asar)$/i.test(file.name);
            if (file.size > (isAsar ? 100 * 1024 * 1024 : 10_000_000))
              throw new Error(
                isAsar ? "项目文件超过 100 MB" : "文件超过 10 MB",
              );
            const project = isAsar
              ? decodeProject(await file.arrayBuffer())
              : createProject(validateDocument(JSON.parse(await file.text())));
            await workspace.persist();
            if (commit(clone(project.document), "打开草图", false)) {
              history.current = [];
              future.current = [];
              setHistoryVersion((value) => value + 1);
              workspace.detach(docRef.current, project);
              registerUntitledTab(docRef.current.name);
              switchSketch(docRef.current.sketches[0].id);
              setFitKey((v) => v + 1);
              notify(isAsar ? "项目已打开" : "JSON 草图已打开");
            }
          } catch (error) {
            notify((error as Error).message, true);
          }
          e.target.value = "";
        }}
      />
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <AlertTriangle size={17} /> : <Check size={17} />}
          <span>{toast.text}</span>
          <IconButton
            icon={X}
            title="关闭通知"
            onClick={() => setToast(null)}
          />
        </div>
      )}
      {projectTransition &&
        createPortal(
          <div
            className="project-transition-overlay"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle size={22} className="spin" />
            <span>{projectTransition}…</span>
          </div>,
          window.document.body,
        )}
    </div>
  );
}
