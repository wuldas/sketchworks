import {
  cadIconData,
  type CadIconDefinition,
  type CadIconName,
} from "./cadIconData";
import "./cadIcons.css";

export type CadIconTone = "color" | "mono";
export type CadIconTheme = "light" | "dark";

export type CadIconProps = {
  size?: number;
  className?: string;
  title?: string;
  /**
   * `color` preserves the CAD palette; `mono` follows `currentColor`.
   * Stroke-only icons always follow `currentColor`.
   */
  tone?: CadIconTone;
  /** Overrides the theme inherited from an ancestor `data-theme`. */
  theme?: CadIconTheme;
};

export type CadIconRenderProps = CadIconProps & { name: CadIconName };

export function CadIcon({
  name,
  size = 18,
  className = "",
  title,
  tone = "color",
  theme,
}: CadIconRenderProps) {
  const icon: CadIconDefinition = cadIconData[name];
  const hasFills = Boolean(icon.paths?.length);
  const effectiveTone = tone === "mono" || !hasFills ? "mono" : "color";

  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={`cad-icon${className ? ` ${className}` : ""}`}
      data-icon={name}
      data-theme={theme}
      data-tone={effectiveTone}
      focusable="false"
      height={size}
      role={title ? "img" : undefined}
      viewBox={icon.viewBox}
      width={size}
    >
      {title ? <title>{title}</title> : null}
      {icon.paths?.map((path, index) => (
        <path
          key={`fill-${index}`}
          d={path.d}
          fill={
            effectiveTone === "mono"
              ? "currentColor"
              : `var(--cad-icon-${path.fill})`
          }
        />
      ))}
      {icon.strokes?.map((stroke, index) => (
        <path
          key={`stroke-${index}`}
          d={stroke.d}
          fill="none"
          stroke="currentColor"
          strokeDasharray={stroke.dash}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={stroke.width}
        />
      ))}
    </svg>
  );
}
