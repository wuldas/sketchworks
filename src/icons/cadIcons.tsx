import type { ComponentType } from "react";
import { CadIcon, type CadIconProps } from "./CadIcon";
import type { CadIconName } from "./cadIconData";

function createCadIcon(name: CadIconName): ComponentType<CadIconProps> {
  const Icon = (props: CadIconProps) => <CadIcon name={name} {...props} />;
  Icon.displayName = `CadIcon(${name})`;
  return Icon;
}

export const ParallelIcon = createCadIcon("parallel");
export const TangentIcon = createCadIcon("tangent");
export const PerpendicularIcon = createCadIcon("perpendicular");
export const VerticalIcon = createCadIcon("vertical");
export const HorizontalIcon = createCadIcon("horizontal");
export const ChamferIcon = createCadIcon("chamfer");
export const MirrorIcon = createCadIcon("mirror");
export const OffsetIcon = createCadIcon("offset");
export const Arc3PointIcon = createCadIcon("arc-3-point");
export const ArcCenterIcon = createCadIcon("arc-center");
export const FilletIcon = createCadIcon("fillet");
export const BezierIcon = createCadIcon("bezier");
export const SlotIcon = createCadIcon("slot");

export type { CadIconProps, CadIconTheme, CadIconTone } from "./CadIcon";
export type { CadIconName } from "./cadIconData";
