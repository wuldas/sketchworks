import { Check, MousePointer2, X } from "lucide-react";
import { type Sketch } from "./model";
import {
  type CommandSession,
  type GeometryParameter,
} from "./commandParameters";

export function ParameterPanel({
  session,
  sketch,
  unit,
  factor,
  error,
  onChange,
  onConfirm,
  onCancel,
}: {
  session: CommandSession;
  sketch: Sketch;
  unit: string;
  factor: number;
  error: string | null;
  onChange: (session: CommandSession) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const display = (n: number) => Number((n / factor).toFixed(3));
  const activate = (index: number) => onChange({ ...session, active: index });
  const clear = (index: number) =>
    onChange({
      ...session,
      active: index,
      geometry: session.geometry.map((p, i) =>
        i === index ? { ...p, selections: [], position: undefined } : p,
      ),
    });
  const summary = (p: GeometryParameter) => {
    if (p.position)
      return `(${display(p.position.x)}, ${display(p.position.y)}) ${unit}`;
    if (p.selections.length)
      return p.multiple
        ? `已选择 ${p.selections.length} 个`
        : (sketch.entities.find((e) => e.id === p.selections[0].entityId)
            ?.name ?? "已选择");
    return p.optional
      ? p.kind === "position"
        ? "可选 · 使用下方坐标"
        : "可选 · X / Y 轴"
      : "选择";
  };
  return (
    <form
      className="parameter-panel"
      role="dialog"
      aria-modal="false"
      aria-label={session.title}
      data-testid="parameter-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="parameter-panel-title">
        <strong>{session.title}</strong>
        <button
          type="button"
          className="icon-button"
          title="取消操作"
          aria-label="取消操作"
          onClick={onCancel}
        >
          <X size={15} />
        </button>
      </div>
      <div className="parameter-panel-body">
        {session.geometry.map((p, index) => (
          <div
            className={`geometry-parameter ${session.active === index ? "active" : ""}`}
            key={p.key}
            data-parameter={p.key}
          >
            <div className="geometry-parameter-row">
              <label>{p.label}</label>
              <button
                type="button"
                className="geometry-pick"
                aria-label={`选择${p.label}`}
                aria-pressed={session.active === index}
                title={p.hint}
                onClick={() => activate(index)}
              >
                <MousePointer2 size={14} />
                <span>{summary(p)}</span>
              </button>
              <button
                type="button"
                className="geometry-clear"
                title={`清空${p.label}`}
                aria-label={`清空${p.label}`}
                disabled={!p.selections.length && !p.position}
                onClick={() => clear(index)}
              >
                <X size={14} />
              </button>
            </div>
            {!!p.selections.length && (
              <div className="geometry-selection-list">
                {p.selections.map((s) => {
                  const e = sketch.entities.find((e) => e.id === s.entityId);
                  const pointIndex =
                    e?.points.findIndex((point) => point.id === s.pointId) ??
                    -1;
                  const name = `${e?.name ?? "对象"}${s.pointId ? (e?.kind === "circle" && pointIndex === 0 ? " · 圆心" : ` · 点 ${pointIndex + 1}`) : ""}`;
                  return (
                    <button
                      type="button"
                      key={s.pointId ?? s.entityId}
                      title={`移除${name}`}
                      onClick={() =>
                        onChange({
                          ...session,
                          active: index,
                          geometry: session.geometry.map((p, i) =>
                            i === index
                              ? {
                                  ...p,
                                  selections: p.selections.filter(
                                    (item) => item !== s,
                                  ),
                                }
                              : p,
                          ),
                        })
                      }
                    >
                      {name}
                      <X size={11} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        <p className="parameter-pick-hint">
          <MousePointer2 size={13} />
          {session.geometry[session.active]?.hint}
        </p>
        {!!session.fields.length && (
          <div className="parameter-fields">
            {session.fields.map((f) => (
              <label key={f.key}>
                <span>{f.label}</span>
                <div>
                  {f.type === "select" ? (
                    <select
                      aria-label={f.label}
                      value={session.values[f.key]}
                      onChange={(event) =>
                        onChange({
                          ...session,
                          values: {
                            ...session.values,
                            [f.key]: event.target.value,
                          },
                        })
                      }
                    >
                      {f.options?.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={f.label}
                      value={session.values[f.key]}
                      spellCheck={false}
                      onChange={(event) => {
                        let geometry = session.geometry;
                        if (f.key === "cx" || f.key === "cy")
                          geometry = geometry.map((p) =>
                            p.kind === "position"
                              ? { ...p, position: undefined }
                              : p,
                          );
                        onChange({
                          ...session,
                          geometry,
                          values: {
                            ...session.values,
                            [f.key]: event.target.value,
                          },
                        });
                      }}
                    />
                  )}
                  <span>{f.unit}</span>
                </div>
              </label>
            ))}
          </div>
        )}
        {error && (
          <p className="parameter-validation" role="status">
            {error}
          </p>
        )}
      </div>
      <div className="parameter-panel-actions">
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={!!error}>
          <Check size={14} />
          确定
        </button>
      </div>
    </form>
  );
}
