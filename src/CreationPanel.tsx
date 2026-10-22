import { useLayoutEffect, useMemo, useState } from "react";
import { Check, MousePointer2, X } from "lucide-react";
import {
  creationSupportsAngle,
  type CreateConfig,
  type Tool,
} from "./creation";
import { type XY } from "./model";
import { dist } from "./geometry";
import {
  creationMethods,
  creationSteps,
  creationTitle,
} from "./creationWorkflow";

const parseCoordinate = (raw: string): number | null => {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const formatLength = (value: number, factor: number): string =>
  String(Number((value / factor).toFixed(3)));

const invalidNumber = (raw: string | undefined): boolean =>
  raw !== undefined && parseCoordinate(raw) === null;

type ConfigField = "sides" | "fontSize" | "weight" | "angle";

export function CreationPanel({
  tool,
  points,
  active,
  pickRevision,
  config,
  unit,
  factor,
  error,
  onToolChange,
  onActivate,
  onPointChange,
  onTruncate,
  onConfigChange,
  onInputValidityChange,
  onComplete,
  onCancel,
}: {
  tool: Tool;
  points: XY[];
  active: number;
  pickRevision: number;
  config: CreateConfig;
  unit: string;
  factor: number;
  error: string | null;
  onToolChange: (tool: Tool) => void;
  onActivate: (index: number) => void;
  onPointChange: (index: number, point: XY) => void;
  onTruncate: (index: number) => void;
  onConfigChange: (config: CreateConfig) => void;
  onInputValidityChange: (valid: boolean) => void;
  onComplete: () => void;
  onCancel: () => void;
}) {
  // Raw input text for point coordinates ("3.", "-", "" …). Committed values
  // reach the parent only once a string parses to a finite number, so an
  // empty field never becomes 0.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [configEdits, setConfigEdits] = useState<
    Partial<Record<ConfigField, string>>
  >({});
  useLayoutEffect(() => setEdits({}), [pickRevision]);
  useLayoutEffect(() => setConfigEdits({}), [tool]);

  const methods = creationMethods(tool);
  const clicks = tool === "spline" ? Infinity : creationSteps(tool).length;
  const steps = creationSteps(tool, points.length);
  const rows = steps;

  const dropEditsFrom = (index: number) =>
    setEdits((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(
          ([key]) => Number(key.split(":")[0]) < index,
        ),
      ),
    );

  const coordinateText = (index: number, axis: "x" | "y"): string => {
    const point = points[index];
    const raw = edits[`${index}:${axis}`];
    if (!point) return raw ?? "";
    if (raw === undefined) return formatLength(point[axis], factor);
    const value = parseCoordinate(raw);
    if (value === null) return raw;
    // A committed coordinate that no longer matches means the point moved on
    // the canvas or via truncation; show the authoritative value.
    return Math.abs(value * factor - point[axis]) <= 1e-9
      ? raw
      : formatLength(point[axis], factor);
  };

  const commitCoordinate = (index: number, axis: "x" | "y", raw: string) => {
    const key = `${index}:${axis}`;
    const nextEdits = { ...edits, [key]: raw };
    setEdits(nextEdits);
    const value = parseCoordinate(raw);
    if (value === null) return;
    const mm = value * factor;
    if (index < points.length) {
      const base = points[index];
      onPointChange(
        index,
        axis === "x" ? { x: mm, y: base.y } : { x: base.x, y: mm },
      );
      return;
    }
    // The pending row only materializes a point once both axes parse, so a
    // half-filled coordinate never silently creates a 0.
    const other = parseCoordinate(
      nextEdits[`${index}:${axis === "x" ? "y" : "x"}`] ?? "",
    );
    if (other === null) return;
    onPointChange(
      index,
      axis === "x"
        ? { x: mm, y: other * factor }
        : { x: other * factor, y: mm },
    );
  };

  const commitConfigField = (
    field: ConfigField,
    raw: string,
    build: (value: number) => CreateConfig,
  ) => {
    setConfigEdits((prev) => ({ ...prev, [field]: raw }));
    const value = parseCoordinate(raw);
    if (value === null) return;
    const next = build(value);
    if (next !== config) onConfigChange(next);
  };

  const truncate = (index: number) => {
    onTruncate(index);
    dropEditsFrom(index);
  };

  const configInvalid = useMemo(() => {
    const sides = configEdits.sides;
    if (sides !== undefined) {
      const value = parseCoordinate(sides);
      if (
        value === null ||
        !Number.isInteger(value) ||
        value < 3 ||
        value > 100
      )
        return true;
    }
    for (const field of ["fontSize", "weight"] as const) {
      const raw = configEdits[field];
      if (raw !== undefined && (parseCoordinate(raw) ?? 0) <= 0) return true;
    }
    const angle = configEdits.angle;
    if (angle?.trim() && parseCoordinate(angle) === null) return true;
    return tool === "text" && !config.text.trim();
  }, [configEdits, config.text, tool]);
  const localInvalid =
    configInvalid ||
    Object.entries(edits).some(([key, raw]) => {
      const index = Number(key.split(":")[0]);
      return index >= points.length
        ? !!(edits[`${index}:x`]?.trim() || edits[`${index}:y`]?.trim())
        : invalidNumber(raw);
    });
  useLayoutEffect(
    () => onInputValidityChange(!localInvalid),
    [localInvalid, onInputValidityChange],
  );

  const summary = useMemo(() => {
    if (
      tool !== "rectangle" &&
      tool !== "centerRectangle" &&
      tool !== "threeRectangle"
    )
      return null;
    if (points.length < clicks) return null;
    if (tool === "threeRectangle") {
      const [a, b, c] = points;
      const width = dist(a, b);
      const height =
        width <= 1e-9
          ? 0
          : Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) /
            width;
      return { width, height, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    const [a, b] = points;
    const scale = tool === "centerRectangle" ? 2 : 1;
    const angle =
      tool === "centerRectangle" ? ((config.angle ?? 0) * Math.PI) / 180 : 0;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    return {
      width: Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) * scale,
      height: Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle)) * scale,
      angle,
    };
  }, [tool, points, clicks, config.angle]);

  let hint = rows[Math.min(active, rows.length - 1)]?.hint ?? "";
  if (tool === "polygon" && active === 1)
    hint = config.polygonOuter
      ? "第二点位于第一条边的中点，确定多边形方向和大小（半径到边）"
      : "第二点为多边形的顶点，确定多边形方向和大小（半径到顶点）";

  const blocked = !!error || localInvalid;

  return (
    <form
      className="creation-panel"
      data-testid="creation-panel"
      role="region"
      aria-label={creationTitle(tool)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) onComplete();
      }}
      onBlur={(event) => {
        if (
          tool !== "spline" &&
          !blocked &&
          event.relatedTarget instanceof HTMLCanvasElement
        )
          onComplete();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          event.target.type !== "radio" &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          if (!blocked) onComplete();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="creation-panel-title">
        <strong>{creationTitle(tool)}</strong>
        <button
          type="button"
          className="icon-button"
          title="取消创建"
          aria-label="取消创建"
          onClick={onCancel}
        >
          <X size={15} />
        </button>
      </div>
      <div className="creation-panel-body">
        <div className="creation-section-label">绘制方式</div>
        {tool === "polygon" ? (
          <div
            className="creation-polygon"
            role="group"
            aria-label="多边形构造方式"
          >
            {methods.map((method) => {
              // 内切圆 → polygonOuter=true（半径到边），外接圆 → false（半径到顶点）。
              const incircle = method.polygonOuter === true;
              return (
                <button
                  key={method.label}
                  type="button"
                  className={`creation-polygon-option ${config.polygonOuter === incircle ? "active" : ""}`}
                  data-polygon-mode={incircle ? "incircle" : "circumcircle"}
                  aria-pressed={config.polygonOuter === incircle}
                  onClick={() => {
                    if (config.polygonOuter === incircle) return;
                    // 切换构造方式先经 onToolChange 重置已拾取的点，再提交配置。
                    onToolChange("polygon");
                    onConfigChange({ ...config, polygonOuter: incircle });
                  }}
                >
                  <strong>{method.label}</strong>
                  <small>{method.hint}</small>
                </button>
              );
            })}
          </div>
        ) : methods.length > 1 ? (
          <div
            className="creation-methods"
            role="radiogroup"
            aria-label="创建方式"
          >
            {methods.map((method) => (
              <label
                key={method.tool}
                className="creation-method"
                data-method={method.tool}
                title={method.hint}
              >
                <input
                  type="radio"
                  name="creation-method"
                  value={method.tool}
                  checked={method.tool === tool}
                  onChange={() => onToolChange(method.tool)}
                />
                <span>{method.label}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="creation-method-description">{methods[0]?.hint}</p>
        )}
        {creationSupportsAngle(tool) && (
          <div className="creation-fields creation-angle">
            <label className="creation-field">
              <span>角度</span>
              <div>
                <input
                  aria-label="绘制角度（°）"
                  inputMode="decimal"
                  spellCheck={false}
                  placeholder={tool === "centerRectangle" ? "0" : "随拾取方向"}
                  value={
                    configEdits.angle ??
                    (config.angle === undefined ? "" : String(config.angle))
                  }
                  className={
                    configEdits.angle?.trim() &&
                    invalidNumber(configEdits.angle)
                      ? "invalid"
                      : ""
                  }
                  onChange={(event) => {
                    const raw = event.target.value;
                    setConfigEdits((previous) => ({ ...previous, angle: raw }));
                    const value = parseCoordinate(raw);
                    if (!raw.trim() || value !== null)
                      onConfigChange({ ...config, angle: value ?? undefined });
                  }}
                />
                <span>°</span>
              </div>
            </label>
            <small className="creation-angle-purpose">
              {tool === "centerRectangle"
                ? "矩形边相对 X 轴的角度，保持中心和拾取角点不变"
                : tool === "polygon"
                  ? config.polygonOuter
                    ? "中心到第一条边中点的方向"
                    : "中心到首个顶点的方向"
                  : tool === "ellipse"
                    ? "长轴相对 X 轴的方向"
                    : tool === "centerArc" || tool === "arcSlot"
                      ? "起始半径相对 X 轴的方向，保持圆弧扫角"
                      : "中心连线相对 X 轴的方向"}
              ；逆时针为正，
              {tool === "centerRectangle" ? "留空为 0°" : "留空跟随拾取方向"}
            </small>
          </div>
        )}
        <div className="creation-section-label creation-parameters-heading">
          几何参数 · 点击拾取或输入坐标
        </div>
        <ul className="creation-points">
          {rows.map((step, index) => {
            const done = index < points.length;
            const pending = index > points.length;
            const rowActive = active === index;
            const editable = done || (index === points.length && rowActive);
            return (
              <li
                key={index}
                data-point-index={index}
                className={`creation-point ${rowActive ? "active" : ""} ${done ? "done" : ""} ${pending ? "pending" : ""}`}
                title={step.hint}
                aria-current={rowActive ? "step" : undefined}
              >
                <span className="creation-point-marker" aria-hidden>
                  {done ? <Check size={11} /> : index + 1}
                </span>
                <span className="creation-point-label">{step.label}</span>
                <div className="creation-coords">
                  <input
                    value={coordinateText(index, "x")}
                    disabled={!editable}
                    inputMode="decimal"
                    spellCheck={false}
                    aria-label={`${step.label} X 坐标（${unit}）`}
                    placeholder="X"
                    className={
                      invalidNumber(edits[`${index}:x`]) ? "invalid" : ""
                    }
                    onChange={(event) =>
                      commitCoordinate(index, "x", event.target.value)
                    }
                  />
                  <input
                    value={coordinateText(index, "y")}
                    disabled={!editable}
                    inputMode="decimal"
                    spellCheck={false}
                    aria-label={`${step.label} Y 坐标（${unit}）`}
                    placeholder="Y"
                    className={
                      invalidNumber(edits[`${index}:y`]) ? "invalid" : ""
                    }
                    onChange={(event) =>
                      commitCoordinate(index, "y", event.target.value)
                    }
                  />
                  <span className="creation-coord-unit">{unit}</span>
                </div>
                <button
                  type="button"
                  className="icon-button creation-pick"
                  aria-pressed={rowActive}
                  aria-label={`拾取${step.label}`}
                  title={`在画布上拾取${step.label}`}
                  disabled={pending}
                  onClick={() => {
                    dropEditsFrom(index);
                    onActivate(index);
                  }}
                >
                  <MousePointer2 size={13} />
                </button>
                <button
                  type="button"
                  className="icon-button creation-truncate"
                  aria-label={`删除${step.label}及后续点`}
                  title={`删除${step.label}及后续点`}
                  disabled={
                    index >= points.length &&
                    edits[`${index}:x`] === undefined &&
                    edits[`${index}:y`] === undefined
                  }
                  onClick={() => truncate(index)}
                >
                  <X size={13} />
                </button>
                <small className="creation-point-purpose">
                  {tool === "polygon" && index === 1
                    ? config.polygonOuter
                      ? "点在边中点：确定内切圆半径和第一条边的方向"
                      : "点在顶点：确定外接圆半径和首个顶点方向"
                    : step.hint}
                </small>
              </li>
            );
          })}
        </ul>
        {tool === "polygon" && (
          <div className="creation-fields">
            <label className="creation-field">
              <span>边数</span>
              <div>
                <input
                  value={configEdits.sides ?? String(config.sides)}
                  inputMode="numeric"
                  spellCheck={false}
                  aria-label="多边形边数"
                  className={invalidNumber(configEdits.sides) ? "invalid" : ""}
                  onChange={(event) =>
                    commitConfigField("sides", event.target.value, (value) =>
                      Number.isInteger(value) && value >= 3 && value <= 100
                        ? { ...config, sides: value }
                        : config,
                    )
                  }
                />
              </div>
            </label>
          </div>
        )}
        {tool === "text" && (
          <div className="creation-fields">
            <label className="creation-field">
              <span>文本</span>
              <div>
                <input
                  value={config.text}
                  spellCheck={false}
                  aria-label="文本内容"
                  onChange={(event) =>
                    onConfigChange({ ...config, text: event.target.value })
                  }
                />
              </div>
            </label>
            <label className="creation-field">
              <span>高度</span>
              <div>
                <input
                  value={
                    configEdits.fontSize ??
                    formatLength(config.fontSize, factor)
                  }
                  inputMode="decimal"
                  spellCheck={false}
                  aria-label={`文本高度（${unit}）`}
                  className={
                    invalidNumber(configEdits.fontSize) ? "invalid" : ""
                  }
                  onChange={(event) =>
                    commitConfigField(
                      "fontSize",
                      event.target.value,
                      (value) =>
                        value > 0
                          ? { ...config, fontSize: value * factor }
                          : config,
                    )
                  }
                />
                <span>{unit}</span>
              </div>
            </label>
          </div>
        )}
        {tool === "conic" && (
          <div className="creation-fields">
            <label className="creation-field">
              <span>权重</span>
              <div>
                <input
                  value={configEdits.weight ?? String(config.weight)}
                  inputMode="decimal"
                  spellCheck={false}
                  aria-label="圆锥曲线权重"
                  className={invalidNumber(configEdits.weight) ? "invalid" : ""}
                  onChange={(event) =>
                    commitConfigField("weight", event.target.value, (value) =>
                      value > 0 ? { ...config, weight: value } : config,
                    )
                  }
                />
              </div>
            </label>
          </div>
        )}
        {summary && (
          <div className="creation-summary" aria-label="尺寸摘要">
            <span>
              宽 {formatLength(summary.width, factor)} {unit}
            </span>
            <span>
              高 {formatLength(summary.height, factor)} {unit}
            </span>
            <span>
              角度 {Math.round(((summary.angle * 180) / Math.PI) * 10) / 10}°
            </span>
          </div>
        )}
        <p className="parameter-pick-hint" aria-live="polite">
          <MousePointer2 size={13} />
          {hint}
        </p>
        {(error || localInvalid) && (
          <p className="parameter-validation" role="status">
            {localInvalid
              ? "输入的数值无效或尚未填写完整，请修正后继续绘制"
              : error}
          </p>
        )}
      </div>
      <div className="creation-panel-actions">
        <span className="creation-note">
          {tool === "spline"
            ? "双击 / Enter 结束样条"
            : "取点后自动完成，无需确认"}
        </span>
        <button type="button" className="button" onClick={onCancel}>
          退出绘制
        </button>
      </div>
    </form>
  );
}
