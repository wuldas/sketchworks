import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/circle-diameter",
);
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CAD_BROWSER_PATH ||
    (!existsSync(chromium.executablePath()) && existsSync(chrome)
      ? chrome
      : undefined),
});
const results = { checks: [], errors: [] };
await fs.mkdir(output, { recursive: true });
const circle = {
  id: "ring",
  kind: "circle",
  name: "ring",
  points: [{ id: "center", x: 0, y: 0 }],
  radius: 8,
};
const fixture = (dimension = false, unit = "mm", radius = 8) => ({
  version: 1,
  name: "Circle size",
  unit,
  parameters: [],
  sketches: [
    {
      id: "circle",
      name: "Circle",
      visible: true,
      entities: [{ ...circle, radius }],
      constraints: dimension
        ? [
            {
              id: "diameter",
              kind: "diameter",
              refs: ["ring"],
              value: 2 * radius,
              labelPosition: { x: radius * 1.5, y: 0 },
            },
          ]
        : [],
    },
  ],
});
async function open(doc) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  if (doc)
    await context.addInitScript(
      (doc) =>
        localStorage.setItem("sketchworks.document.v1", JSON.stringify(doc)),
      doc,
    );
  await context.addInitScript(() => {
    window.__dimensionSegments = [];
    const proto = CanvasRenderingContext2D.prototype;
    const begin = proto.beginPath,
      move = proto.moveTo,
      line = proto.lineTo,
      stroke = proto.stroke;
    proto.beginPath = function (...args) {
      this.__segments = [];
      this.__last = null;
      return begin.apply(this, args);
    };
    proto.moveTo = function (x, y) {
      this.__last = { x, y };
      return move.call(this, x, y);
    };
    proto.lineTo = function (x, y) {
      if (this.__last) this.__segments?.push({ a: this.__last, b: { x, y } });
      this.__last = { x, y };
      return line.call(this, x, y);
    };
    proto.stroke = function (...args) {
      if (["#659a86", "#499ca7", "#c08a29"].includes(this.strokeStyle))
        window.__dimensionSegments.push(...(this.__segments || []));
      return stroke.apply(this, args);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => results.errors.push(e.message));
  await page.goto(url);
  await page.locator(".loading-overlay").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
        ?.renderer === "canvas2d",
  );
  return { context, page };
}
const state = (page) =>
  page.getByTestId("cad-canvas").evaluate((el) => el.__cadViewport);
const saved = async (page) => {
  await page.locator('.save-dot[data-saved="true"]').waitFor();
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("sketchworks.document.v1")),
  );
};
async function click(page, p) {
  const s = await state(page),
    box = await page.getByTestId("cad-canvas").boundingBox();
  await page.mouse.click(
    box.x + s.origin.x + p.x * s.scale,
    box.y + s.origin.y - p.y * s.scale,
  );
}
async function check(name, doc, run) {
  const { context, page } = await open(doc);
  try {
    const detail = await run(page);
    results.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.checks.push({ name, passed: false, error: e.stack });
    console.error(`FAIL ${name}: ${e.message}`);
    await page.screenshot({
      path: path.join(output, `${results.checks.length}-failure.png`),
    });
  } finally {
    await context.close();
  }
}
try {
  await check(
    "Example circles default to diameter constraints and labels",
    null,
    async (page) => {
      const doc = await saved(page);
      const circles = doc.sketches[0].entities.filter(
        (e) => e.kind === "circle",
      );
      const dimensions = doc.sketches[0].constraints.filter(
        (c) => c.kind === "diameter",
      );
      assert.equal(dimensions.length, 4);
      for (const d of dimensions)
        assert.equal(
          d.value,
          2 * circles.find((e) => e.id === d.refs[0]).radius,
        );
      assert.equal(
        (await state(page)).dimensions.filter((d) => d.text === "Ø10").length,
        4,
      );
      await page.screenshot({
        path: path.join(output, "default-diameters.png"),
      });
      return { diameters: dimensions.length };
    },
  );
  await check(
    "Rendered diameter reaches both circle boundaries and crosses center",
    fixture(true),
    async (page) => {
      const s = await state(page);
      const span = 16 * s.scale;
      const segments = await page.evaluate(() => window.__dimensionSegments);
      const matching = segments.find(
        ({ a, b }) =>
          Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - span) < 1e-5 &&
          Math.abs((a.x + b.x) / 2 - s.origin.x) < 1e-5 &&
          Math.abs((a.y + b.y) / 2 - s.origin.y) < 1e-5,
      );
      assert(matching, "real Canvas stroke covers a full diameter");
      assert.equal(s.dimensions.find((d) => d.id === "diameter").text, "Ø16");
      await page.screenshot({ path: path.join(output, "full-diameter.png") });
      return { span, matching };
    },
  );
  await check(
    "Circle property editor uses diameter and stores half as radius",
    fixture(),
    async (page) => {
      const row = page.locator('.entity-row[title="ring"]');
      await row.click();
      await row.dblclick();
      const dialog = page.locator(".dialog");
      const input = dialog.getByRole("textbox", { name: "直径", exact: true });
      assert.equal(await input.inputValue(), "16");
      assert.equal(
        await dialog
          .getByRole("textbox", { name: "半径", exact: true })
          .count(),
        0,
      );
      await input.fill("24");
      await dialog.getByRole("button", { name: "确定", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal((await saved(page)).sketches[0].entities[0].radius, 12);
      return { diameter: 24, radius: 12 };
    },
  );
  await check(
    "Automatic circle dimension edits its full diameter",
    fixture(),
    async (page) => {
      await page.locator('button[title="草图尺寸 (D)"]').click();
      await click(page, { x: 0, y: 8 });
      const input = page.getByTestId("dimension-input");
      await input.waitFor();
      assert.equal(await input.inputValue(), "16");
      await input.fill("20");
      await input.press("Enter");
      await input.waitFor({ state: "detached" });
      const doc = await saved(page),
        sketch = doc.sketches[0];
      assert.equal(sketch.entities[0].radius, 10);
      const d = sketch.constraints.find((c) => c.kind === "diameter");
      assert.equal(d.value, 20);
      return { diameter: d.value, radius: sketch.entities[0].radius };
    },
  );
  await check(
    "Diameter property input respects inch display",
    fixture(false, "in", 25.4),
    async (page) => {
      await page.locator('.entity-row[title="ring"]').dblclick();
      const dialog = page.locator(".dialog");
      const input = dialog.getByRole("textbox", { name: "直径", exact: true });
      assert.equal(await input.inputValue(), "2");
      await input.fill("3");
      await dialog.getByRole("button", { name: "确定", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert(
        Math.abs((await saved(page)).sketches[0].entities[0].radius - 38.1) <
          1e-7,
      );
      return { diameterInches: 3, radiusMillimeters: 38.1 };
    },
  );
  const cornerLine = (id, coords) => ({
    id,
    name: id,
    kind: "line",
    points: coords.map(([x, y], index) => ({ id: `${id}-p${index}`, x, y })),
  });
  const cornerDoc = fixture();
  cornerDoc.sketches[0].entities = [
    cornerLine("top", [
      [0, 20],
      [20, 20],
    ]),
    cornerLine("left", [
      [0, 0],
      [0, 20],
    ]),
    cornerLine("bottom", [
      [20, 0],
      [0, 0],
    ]),
  ];
  cornerDoc.sketches[0].constraints = [
    { id: "top-axis", kind: "horizontal", refs: ["top"] },
    { id: "left-axis", kind: "vertical", refs: ["left"] },
    { id: "bottom-axis", kind: "horizontal", refs: ["bottom"] },
    { id: "top-joint", kind: "coincident", refs: ["top-p0", "left-p1"] },
    { id: "bottom-joint", kind: "coincident", refs: ["left-p0", "bottom-p1"] },
  ];
  await check(
    "Adjacent fillets stay joined and tangent through radius edits, dragging and history",
    cornerDoc,
    async (page) => {
      await page
        .getByRole("checkbox", { name: "自动约束", exact: true })
        .uncheck();
      const row = (id) => page.locator(`.entity-row[title="${id}"]`);
      const fillet = async (first, second) => {
        await row(first).click();
        await row(second).click({ modifiers: ["Control"] });
        await page.getByRole("button", { name: "圆角", exact: true }).click();
        const panel = page.getByTestId("parameter-panel");
        await panel
          .getByRole("textbox", { name: "半径", exact: true })
          .fill("3");
        await panel.locator('button[type="submit"]').click();
        const confirmation = page.locator(".dialog");
        await confirmation.waitFor();
        await confirmation
          .getByRole("button", { name: "移除约束并修改", exact: true })
          .click();
        await panel.waitFor({ state: "detached" });
      };
      const connected = (doc) => {
        const sketch = doc.sketches[0],
          top = sketch.entities.find((e) => e.id === "top"),
          left = sketch.entities.find((e) => e.id === "left"),
          bottom = sketch.entities.find((e) => e.id === "bottom"),
          arcs = sketch.entities.filter((e) => e.kind === "arc");
        assert.equal(arcs.length, 2);
        const pairs = [
          [top, 0, arcs[0], 1],
          [left, 1, arcs[0], 2],
          [left, 0, arcs[1], 1],
          [bottom, 1, arcs[1], 2],
        ];
        const gaps = [];
        for (const [line, lineEndpoint, arc, arcEndpoint] of pairs) {
          const point = arc.points[arcEndpoint],
            center = arc.points[0],
            end = line.points[lineEndpoint],
            rx = point.x - center.x,
            ry = point.y - center.y,
            dx = line.points[1].x - line.points[0].x,
            dy = line.points[1].y - line.points[0].y,
            gap = Math.hypot(point.x - end.x, point.y - end.y),
            tangent =
              Math.abs(rx * dx + ry * dy) /
              (Math.hypot(rx, ry) * Math.hypot(dx, dy));
          assert(gap < 1e-6, `fillet endpoint separated by ${gap}`);
          assert(tangent < 1e-6, `fillet lost tangency: ${tangent}`);
          gaps.push(gap);
        }
        assert(Math.abs(top.points[0].y - top.points[1].y) < 1e-6);
        assert(Math.abs(left.points[0].x - left.points[1].x) < 1e-6);
        assert(Math.abs(bottom.points[0].y - bottom.points[1].y) < 1e-6);
        return { arcs, gaps };
      };
      await fillet("top", "left");
      await fillet("left", "bottom");
      const created = await saved(page);
      const initial = connected(created),
        upper = initial.arcs[0];
      await page
        .getByRole("combobox", { name: "尺寸类型", exact: true })
        .selectOption("radius");
      await page.locator('button[title="草图尺寸 (D)"]').click();
      await click(page, {
        x: upper.points[0].x - upper.radius / Math.SQRT2,
        y: upper.points[0].y + upper.radius / Math.SQRT2,
      });
      const input = page.getByTestId("dimension-input");
      await input.waitFor();
      await input.fill("5");
      await input.press("Enter");
      await input.waitFor({ state: "detached" });
      const edited = await saved(page),
        changed = connected(edited);
      assert(Math.abs(changed.arcs[0].radius - 5) < 1e-6);
      await page
        .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
        .click();
      assert(Math.abs(connected(await saved(page)).arcs[0].radius - 3) < 1e-6);
      await page
        .getByRole("button", { name: "重做 (Ctrl+Shift+Z)", exact: true })
        .click();
      assert(Math.abs(connected(await saved(page)).arcs[0].radius - 5) < 1e-6);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "选择", exact: true }).click();
      await page.getByRole("checkbox", { name: "吸附", exact: true }).uncheck();
      const beforeDrag = await saved(page),
        lower = connected(beforeDrag).arcs[1],
        canvas = page.getByTestId("cad-canvas"),
        box = await canvas.boundingBox(),
        handle = (await state(page)).handles.find(
          (p) => p.pointId === lower.points[1].id,
        );
      await page.mouse.move(box.x + handle.x, box.y + handle.y);
      await page.mouse.down();
      await page.mouse.move(box.x + handle.x, box.y + handle.y - 15, {
        steps: 6,
      });
      await page.mouse.up();
      const dragged = await saved(page),
        afterDrag = connected(dragged);
      const draggedPoint = afterDrag.arcs[1].points[1],
        beforePoint = lower.points[1];
      assert(
        Math.hypot(
          draggedPoint.x - beforePoint.x,
          draggedPoint.y - beforePoint.y,
        ) > 1e-3,
        "connected endpoint really moved",
      );
      await page
        .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
        .click();
      assert.deepEqual(await saved(page), beforeDrag);
      await page
        .getByRole("button", { name: "重做 (Ctrl+Shift+Z)", exact: true })
        .click();
      connected(await saved(page));
      await page.reload();
      await page.locator(".loading-overlay").waitFor({ state: "hidden" });
      connected(await saved(page));
      await page.screenshot({
        path: path.join(output, "connected-fillet-radius.png"),
      });
      return {
        initialGaps: initial.gaps,
        resizedGaps: changed.gaps,
        draggedGaps: afterDrag.gaps,
        radius: changed.arcs[0].radius,
      };
    },
  );
  assert.deepEqual(results.errors, []);
  results.passed = results.checks.every((c) => c.passed);
  if (!results.passed) process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  console.log(
    `${results.checks.filter((c) => c.passed).length}/${results.checks.length} circle checks passed`,
  );
}
