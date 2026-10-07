import { parse, type MathNode } from "mathjs";
import { type Document, type Parameter } from "./model";
type Unit = Parameter["unit"];
type Value = { value: number; unit: Unit };
function parseSafe(expression: string): MathNode {
  if (!expression.trim() || expression.length > 500)
    throw new Error("表达式为空或过长");
  const node = parse(expression);
  let count = 0;
  node.traverse((n) => {
    if (++count > 120) throw new Error("表达式过于复杂");
    if (
      ![
        "ConstantNode",
        "SymbolNode",
        "OperatorNode",
        "ParenthesisNode",
      ].includes(n.type)
    )
      throw new Error("仅支持数值、参数、四则运算与括号");
    if (
      n.type === "OperatorNode" &&
      !["+", "-", "*", "/"].includes((n as unknown as { op: string }).op)
    )
      throw new Error("仅支持四则运算");
  });
  return node;
}
function symbols(node: MathNode): string[] {
  const refs = new Set<string>();
  node.traverse((n) => {
    if (n.type === "SymbolNode")
      refs.add((n as unknown as { name: string }).name);
  });
  return [...refs];
}
export function hasParameterReferences(expression: string): boolean {
  return symbols(parseSafe(expression)).some((name) => name !== "pi");
}
export function evaluateExpression(
  expression: string,
  variables: Map<string, Value> = new Map(),
  expected?: Unit,
): number {
  const visit = (node: MathNode): Value => {
    const n = node as unknown as {
      value: number;
      name: string;
      content: MathNode;
      op: string;
      args: MathNode[];
    };
    if (node.type === "ConstantNode") {
      if (typeof n.value !== "number" || !Number.isFinite(n.value))
        throw new Error("无效数值");
      return { value: n.value, unit: "scalar" };
    }
    if (node.type === "SymbolNode") {
      if (n.name === "pi") return { value: Math.PI, unit: "scalar" };
      const v = variables.get(n.name);
      if (!v) throw new Error(`参数 ${n.name} 不存在`);
      return v;
    }
    if (node.type === "ParenthesisNode") return visit(n.content);
    const a = visit(n.args[0]);
    if (n.args.length === 1)
      return { value: n.op === "-" ? -a.value : a.value, unit: a.unit };
    const b = visit(n.args[1]);
    let unit = a.unit;
    if (n.op === "+" || n.op === "-") {
      if (a.unit !== b.unit && a.unit !== "scalar" && b.unit !== "scalar")
        throw new Error("长度与角度不能相加");
      unit = a.unit === "scalar" ? b.unit : a.unit;
    } else if (n.op === "*") {
      if (a.unit !== "scalar" && b.unit !== "scalar")
        throw new Error("不支持复合单位");
      unit = a.unit === "scalar" ? b.unit : a.unit;
    } else {
      if (Math.abs(b.value) < 1e-14) throw new Error("除数不能为零");
      if (b.unit !== "scalar") {
        if (a.unit !== b.unit) throw new Error("单位不匹配");
        unit = "scalar";
      }
    }
    const value =
      n.op === "+"
        ? a.value + b.value
        : n.op === "-"
          ? a.value - b.value
          : n.op === "*"
            ? a.value * b.value
            : a.value / b.value;
    if (!Number.isFinite(value) || Math.abs(value) > 1e9)
      throw new Error("表达式结果越界");
    return { value, unit };
  };
  const result = visit(parseSafe(expression));
  if (expected && result.unit !== "scalar" && result.unit !== expected)
    throw new Error("表达式单位不匹配");
  return result.value;
}
export function resolveParameters(parameters: Parameter[]): Map<string, Value> {
  const vars = new Map<string, Value>(),
    byName = new Map(parameters.map((p) => [p.name, p])),
    visiting = new Set<string>();
  if (byName.size !== parameters.length) throw new Error("参数名称重复");
  const resolve = (name: string): Value => {
    if (vars.has(name)) return vars.get(name)!;
    const p = byName.get(name);
    if (!p) throw new Error(`参数 ${name} 不存在`);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name) || name === "pi")
      throw new Error("参数名使用字母、数字和下划线，且不能为 pi");
    if (visiting.has(name)) throw new Error("参数存在循环依赖");
    visiting.add(name);
    for (const ref of symbols(parseSafe(p.expression)))
      if (ref !== "pi") resolve(ref);
    const value = evaluateExpression(p.expression, vars, p.unit);
    vars.set(name, { value, unit: p.unit });
    visiting.delete(name);
    return vars.get(name)!;
  };
  for (const p of parameters) resolve(p.name);
  return vars;
}
export function applyParameters(doc: Document) {
  const vars = resolveParameters(doc.parameters);
  for (const sk of doc.sketches) {
    for (const c of sk.constraints)
      if (c.expression) {
        const value = evaluateExpression(
          c.expression,
          vars,
          c.kind === "angle" ? "deg" : "mm",
        );
        if (["length", "radius", "diameter"].includes(c.kind) && value <= 0)
          throw new Error("长度和半径必须为正");
        c.value = value;
      }
    for (const e of sk.entities)
      if (e.transform) {
        const t = e.transform;
        if (t.xExpression) t.x = evaluateExpression(t.xExpression, vars, "mm");
        if (t.yExpression) t.y = evaluateExpression(t.yExpression, vars, "mm");
        if (t.angleExpression)
          t.angle = evaluateExpression(t.angleExpression, vars, "deg");
      }
  }
  return vars;
}
