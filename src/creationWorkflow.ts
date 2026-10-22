import { type Tool } from "./creation";

export interface CreationStep {
  key: string;
  label: string;
  hint: string;
}

export interface CreationMethod {
  tool: Tool;
  label: string;
  hint: string;
  polygonOuter?: boolean;
}

const STEPS: Partial<Record<Tool, CreationStep[]>> = {
  line: [
    {
      key: "start",
      label: "起点",
      hint: "单击画布或输入坐标确定直线起点",
    },
    {
      key: "end",
      label: "终点",
      hint: "第二点自动完成当前线段，并从终点继续绘制下一段",
    },
  ],
  midline: [
    {
      key: "mid",
      label: "中点",
      hint: "第一点为线段中点",
    },
    {
      key: "end",
      label: "端点",
      hint: "第二点确定方向和半长，线段关于中点对称延伸",
    },
  ],
  rectangle: [
    {
      key: "corner",
      label: "第一角",
      hint: "单击确定第一角后逐点绘制，或按住鼠标拖至对角点、松开完成",
    },
    {
      key: "opposite",
      label: "对角点",
      hint: "第二点为对角点，矩形沿坐标轴对齐",
    },
  ],
  centerRectangle: [
    {
      key: "center",
      label: "中心",
      hint: "第一点为矩形中心；可按住鼠标拖向角点、松开完成",
    },
    {
      key: "corner",
      label: "角点",
      hint: "第二点为一个角点，矩形关于中心对称；可填写角度旋转矩形边",
    },
  ],
  threeRectangle: [
    {
      key: "edge-start",
      label: "边起点",
      hint: "第一点为边起点；可按住拖出第一条边，松开后再取宽度点",
    },
    {
      key: "edge-end",
      label: "边终点",
      hint: "第二点为第一条边的终点，确定矩形长度和方向",
    },
    {
      key: "width",
      label: "宽度点",
      hint: "第三点确定矩形宽度方向和距离",
    },
  ],
  circle: [
    {
      key: "center",
      label: "圆心",
      hint: "第一点为圆心",
    },
    {
      key: "radius",
      label: "半径点",
      hint: "第二点确定圆的半径",
    },
  ],
  threeCircle: [
    { key: "p1", label: "第一点", hint: "圆周通过三个点，单击确定第一个点" },
    { key: "p2", label: "第二点", hint: "单击确定圆周上的第二个点" },
    { key: "p3", label: "第三点", hint: "单击确定圆周上的第三个点" },
  ],
  arc: [
    { key: "start", label: "起点", hint: "第一点为圆弧起点" },
    { key: "mid", label: "弧上点", hint: "第二点位于圆弧上，确定圆弧弯曲方向" },
    { key: "end", label: "终点", hint: "第三点为圆弧终点" },
  ],
  centerArc: [
    { key: "center", label: "圆心", hint: "第一点为圆弧圆心" },
    { key: "start", label: "起点", hint: "第二点确定半径和起始角度" },
    { key: "end", label: "终点", hint: "第三点确定终止角度，圆弧逆时针绘制" },
  ],
  polygon: [
    { key: "center", label: "中心", hint: "第一点为多边形中心" },
    {
      key: "direction",
      label: "方向点",
      hint: "第二点确定第一条边方向：内切圆模式为边中点，外接圆模式为顶点",
    },
  ],
  ellipse: [
    { key: "center", label: "中心", hint: "第一点为椭圆中心" },
    { key: "axis", label: "长轴端点", hint: "第二点确定长轴方向和半长" },
    { key: "width", label: "短轴点", hint: "第三点确定短半轴的宽度" },
  ],
  slot: [
    { key: "center-1", label: "第一圆心", hint: "第一点为槽一端圆弧的圆心" },
    { key: "center-2", label: "第二圆心", hint: "第二点为槽另一端圆弧的圆心" },
    { key: "width", label: "宽度点", hint: "第三点确定槽宽，槽两端为半圆" },
  ],
  arcSlot: [
    { key: "center", label: "圆心", hint: "第一点为圆弧槽的中心" },
    { key: "radius", label: "半径点", hint: "第二点确定槽中心线的半径" },
    { key: "end", label: "终点角", hint: "第三点确定终止角度，沿逆时针绘制" },
    { key: "width", label: "宽度点", hint: "第四点确定槽宽" },
  ],
  bezier: [
    { key: "start", label: "起点", hint: "第一点为曲线起点" },
    { key: "control-1", label: "控制点 1", hint: "第二点为起始控制点" },
    { key: "control-2", label: "控制点 2", hint: "第三点为终止控制点" },
    { key: "end", label: "终点", hint: "第四点为曲线终点" },
  ],
  conic: [
    { key: "start", label: "起点", hint: "第一点为圆锥曲线起点" },
    {
      key: "control",
      label: "控制点",
      hint: "第二点为控制点，确定曲线弯曲方向",
    },
    { key: "end", label: "终点", hint: "第三点为曲线终点" },
  ],
  point: [
    { key: "position", label: "位置", hint: "单击画布或输入坐标确定点的位置" },
  ],
  text: [
    {
      key: "position",
      label: "插入点",
      hint: "第一点为文本插入点，文本内容在下方填写",
    },
  ],
};

const METHOD_FAMILIES: CreationMethod[][] = [
  [
    { tool: "line", label: "直线", hint: "两点绘制直线段" },
    { tool: "midline", label: "中点线", hint: "从中点对称绘制线段" },
  ],
  [
    { tool: "rectangle", label: "对角矩形", hint: "两个对角点绘制矩形" },
    {
      tool: "threeRectangle",
      label: "三点矩形",
      hint: "第一条边加宽度绘制矩形",
    },
    {
      tool: "centerRectangle",
      label: "中心点矩形",
      hint: "中心点加角点绘制矩形",
    },
  ],
  [
    { tool: "circle", label: "圆心圆", hint: "圆心加半径绘制圆" },
    { tool: "threeCircle", label: "三点圆", hint: "圆周通过三个点绘制圆" },
  ],
  [
    { tool: "arc", label: "三点圆弧", hint: "起点、弧上点、终点绘制圆弧" },
    {
      tool: "centerArc",
      label: "圆心圆弧",
      hint: "圆心、起点、终点角度绘制圆弧",
    },
  ],
  [
    { tool: "spline", label: "拟合点样条", hint: "曲线依次通过拟合点" },
    { tool: "bezier", label: "控制点曲线", hint: "三次贝塞尔曲线由控制点绘制" },
    { tool: "conic", label: "圆锥曲线", hint: "起点、控制点、终点加权重绘制" },
  ],
  [
    { tool: "slot", label: "直线槽", hint: "两端圆心加槽宽绘制直槽" },
    {
      tool: "arcSlot",
      label: "圆弧槽",
      hint: "圆心、半径、角度加槽宽绘制弧形槽",
    },
  ],
];

const SINGLE_METHODS: Partial<Record<Tool, CreationMethod>> = {
  ellipse: {
    tool: "ellipse",
    label: "椭圆",
    hint: "中心、长轴端点、短轴宽度绘制椭圆",
  },
  point: { tool: "point", label: "点", hint: "单击放置草绘点" },
  text: { tool: "text", label: "文本", hint: "插入点加文本内容和高度" },
};

const POLYGON_METHODS: CreationMethod[] = [
  {
    tool: "polygon",
    label: "内切圆",
    hint: "半径到边：第二点为第一条边的中点",
    polygonOuter: true,
  },
  {
    tool: "polygon",
    label: "外接圆",
    hint: "半径到顶点：第二点为多边形的顶点",
    polygonOuter: false,
  },
];

const TITLES: Partial<Record<Tool, string>> = {
  line: "绘制直线",
  midline: "绘制中点线",
  rectangle: "绘制矩形",
  centerRectangle: "绘制矩形",
  threeRectangle: "绘制矩形",
  circle: "绘制圆",
  threeCircle: "绘制圆",
  arc: "绘制圆弧",
  centerArc: "绘制圆弧",
  polygon: "绘制多边形",
  ellipse: "绘制椭圆",
  slot: "绘制槽",
  arcSlot: "绘制槽",
  spline: "绘制样条曲线",
  bezier: "绘制控制点曲线",
  conic: "绘制圆锥曲线",
  point: "绘制点",
  text: "绘制文本",
};

/**
 * Steps of a creation workflow: one entry per click/point, plus for splines
 * one trailing "next point" entry (call with pointCount = placed points).
 */
export function creationSteps(tool: Tool, pointCount = 0): CreationStep[] {
  if (tool === "spline") {
    const placed = Array.from({ length: Math.max(0, pointCount) }, (_, i) => ({
      key: `point-${i}`,
      label: `点 ${i + 1}`,
      hint: "已放置的拟合点，可修改坐标或重新拾取",
    }));
    return [
      ...placed,
      {
        key: "next-point",
        label: "下一点",
        hint: "单击画布或输入坐标继续添加；至少 2 个点后双击或按 Enter 结束",
      },
    ];
  }
  return STEPS[tool] ?? [];
}

/** Methods (tool variants) of the family the given tool belongs to. */
export function creationMethods(tool: Tool): CreationMethod[] {
  const family = METHOD_FAMILIES.find((methods) =>
    methods.some((method) => method.tool === tool),
  );
  if (family) return family;
  const single = SINGLE_METHODS[tool];
  if (single) return [single];
  if (tool === "polygon") return POLYGON_METHODS;
  return [];
}

/** Panel header, e.g. 绘制矩形. */
export function creationTitle(tool: Tool): string {
  return TITLES[tool] ?? (tool === "select" ? "选择" : tool);
}
