import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

export interface DimensionInputHandle {
  commit: () => boolean;
}
export interface DimensionInputProps {
  ref?: Ref<DimensionInputHandle>;
  x: number;
  y: number;
  unit: string;
  initial: string;
  /** Returns false to keep the editor open for correction. */
  onCommit: (text: string) => boolean;
  onCancel: () => void;
}

export function DimensionInput({
  ref,
  x,
  y,
  unit,
  initial,
  onCommit,
  onCancel,
}: DimensionInputProps) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = () => {
    const accepted = onCommit(text.trim());
    if (!accepted) {
      input.current?.focus();
      input.current?.select();
    }
    return accepted;
  };
  useImperativeHandle(ref, () => ({ commit }));
  return (
    <div
      className="dimension-input"
      style={{ left: x, top: y }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button === 2) {
          event.preventDefault();
          onCancel();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <input
        ref={input}
        data-testid="dimension-input"
        aria-label="尺寸数值"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => onCancel()}
      />
      <span className="dimension-unit">{unit}</span>
      <small>Enter 确认 · Esc 取消</small>
    </div>
  );
}

export default DimensionInput;
