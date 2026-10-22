import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve("artifacts/creation-panel");
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const executablePath =
  process.env.CAD_BROWSER_PATH ||
  (!existsSync(chromium.executablePath()) && existsSync(chrome)
    ? chrome
    : undefined);
const storage = "sketchworks.document.v1";
const fixture = {
  version: 1,
  name: "创建参数",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "creation-sketch",
      name: "草图 1",
      visible: true,
      entities: [],
      constraints: [],
    },
  ],
};
const results = { checks: [], errors: [] };
const browser = await chromium.launch({ headless: true, executablePath });
await fs.mkdir(output, { recursive: true });
const near = (a, b, tolerance = 1e-5) =>
  assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const documentOf = (s) =>
  s.page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storage);
const entitiesOf = async (s) => (await documentOf(s)).sketches[0].entities;
const row = (s, index) => s.panel.locator(`[data-point-index="${index}"]`);
async function open(viewport = { width: 1440, height: 900 }, unit = "mm") {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(
    ({ storage, fixture, unit }) => {
      localStorage.setItem(storage, JSON.stringify({ ...fixture, unit }));
    },
    { storage, fixture, unit },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(url);
  await expect(page.locator(".loading-overlay")).toHaveCount(0, {
    timeout: 30000,
  });
  const project = page.locator('.app-header button[aria-label="项目管理"]');
  await expect(project).toBeEnabled();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
        ?.scale > 0,
  );
  if ((await project.getAttribute("aria-pressed")) === "true")
    await project.click();
  const master = page.locator('.bottom-actions button[title="切换吸附"]');
  if ((await master.getAttribute("aria-pressed")) === "true")
    await master.click();
  if (
    viewport.width > 960 &&
    !(await page.locator(".app").getAttribute("class")).includes("left-closed")
  ) {
    await page.getByRole("button", { name: "切换左侧栏", exact: true }).click();
  }
  return {
    context,
    page,
    canvas: page.getByTestId("cad-canvas"),
    panel: page.getByTestId("creation-panel"),
  };
}
async function tool(s, label) {
  const ribbon = s.page.locator(
    `button.ribbon-tool[title=${JSON.stringify(label)}]`,
  );
  if (await ribbon.count()) await ribbon.click();
  else {
    await s.page.getByRole("button", { name: "创建", exact: true }).click();
    await s.page
      .locator(".create-menu")
      .getByRole("button", { name: label, exact: true })
      .click();
  }
  await expect(s.panel).toBeVisible();
}
async function coordinate(s, index, point) {
  const inputs = row(s, index).locator("input");
  await inputs.nth(0).fill(String(point.x));
  await inputs.nth(1).fill(String(point.y));
  await s.canvas.focus();
}
async function canvasPoint(s, x, y) {
  await s.page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="cad-canvas"]');
    const state = canvas?.__cadViewport,
      box = canvas?.getBoundingClientRect();
    return (
      state &&
      box &&
      Math.abs(state.width - box.width) < 1 &&
      Math.abs(state.height - box.height) < 1
    );
  });
  const box = await s.canvas.boundingBox();
  const at = {
    x: Math.round(box.x + x * box.width),
    y: Math.round(box.y + y * box.height),
  };
  const target = await s.page.evaluate(
    (at) => document.elementFromPoint(at.x, at.y)?.tagName,
    at,
  );
  assert.equal(target, "CANVAS", "point must reach the actual drawing surface");
  const meta = await s.canvas.evaluate((el) => el.__cadViewport);
  return {
    ...at,
    world: {
      x: (at.x - box.x - meta.origin.x) / meta.scale,
      y: (meta.origin.y - at.y + box.y) / meta.scale,
    },
  };
}
async function pick(s, x, y) {
  const at = await canvasPoint(s, x, y);
  await s.page.mouse.click(at.x, at.y);
  return at.world;
}
async function pressDrag(s, from, to) {
  await s.page.mouse.move(from.x, from.y);
  await s.page.mouse.down();
  await expect(row(s, 1)).toHaveClass(/active/);
  await s.page.mouse.move(to.x, to.y, { steps: 8 });
}
async function created(s, count) {
  await expect.poll(async () => (await entitiesOf(s)).length).toBe(count);
  return entitiesOf(s);
}
async function check(name, fn, options = {}) {
  const s = await open(options.viewport, options.unit);
  try {
    await fn(s);
    results.checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.checks.push({ name, passed: false, error: error.stack });
    await s.page.screenshot({
      path: path.join(output, `failure-${results.checks.length}.png`),
      fullPage: true,
    });
    throw error;
  } finally {
    await s.context.close();
  }
}
try {
  await check(
    "docked sidebar replaces properties and final canvas pick commits one undoable rectangle",
    async (s) => {
      await tool(s, "两点矩形");
      assert.equal(
        await s.panel
          .locator("xpath=ancestor::aside[contains(@class,'properties-panel')]")
          .count(),
        1,
      );
      await expect(s.panel.locator('button[type="submit"]')).toHaveCount(0);
      await expect(
        s.page.locator(".properties-panel .property-content"),
      ).toHaveCount(0);
      await expect(
        s.page.locator(".properties-panel .constraint-grid"),
      ).toHaveCount(0);
      const canvas = await s.canvas.boundingBox(),
        panel = await s.panel.boundingBox();
      assert(
        canvas.x + canvas.width <= panel.x + 1,
        "sidebar must not overlap drawing surface",
      );
      await pick(s, 0.15, 0.25);
      await expect(row(s, 1)).toHaveClass(/active/);
      assert.equal((await entitiesOf(s)).length, 0);
      await pick(s, 0.4, 0.62);
      await created(s, 4);
      await expect(row(s, 0)).toHaveClass(/active/);
      await s.page.locator('button.ribbon-tool[title="选择"]').click();
      await expect(s.panel).toHaveCount(0);
      await expect(
        s.page.locator(".properties-panel .property-content"),
      ).toBeVisible();
      await expect(
        s.page.locator(".properties-panel .constraint-grid"),
      ).toBeVisible();
      await s.page.keyboard.press("Control+z");
      await created(s, 0);
      await s.page.keyboard.press("Control+Shift+z");
      await created(s, 4);
    },
  );
  await check(
    "rectangle press-drag previews without mutation and commits the final release target as one undo",
    async (s) => {
      await tool(s, "两点矩形");
      const a = await canvasPoint(s, 0.18, 0.3),
        hover = await canvasPoint(s, 0.45, 0.55),
        b = await canvasPoint(s, 0.62, 0.7);
      const history = await s.page.locator(".app").getAttribute("data-history");
      await pressDrag(s, a, hover);
      assert.equal((await entitiesOf(s)).length, 0);
      assert.equal(
        await s.page.locator(".app").getAttribute("data-history"),
        history,
      );
      await s.page.screenshot({
        path: path.join(output, "rectangle-press-drag-preview.png"),
      });
      const cdp = await s.context.newCDPSession(s.page);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: b.x,
        y: b.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await cdp.detach();
      const lines = await created(s, 4);
      near(lines[0].points[0].x, a.world.x);
      near(lines[0].points[0].y, a.world.y);
      near(lines[1].points[1].x, b.world.x);
      near(lines[1].points[1].y, b.world.y);
      await s.page.keyboard.press("Escape");
      await s.page.keyboard.press("Control+z");
      await created(s, 0);
      await s.page.keyboard.press("Control+Shift+z");
      await created(s, 4);
    },
  );
  await check(
    "reverse rectangle dragging preserves its pressed and released corners",
    async (s) => {
      await tool(s, "两点矩形");
      const a = await canvasPoint(s, 0.65, 0.72),
        b = await canvasPoint(s, 0.2, 0.3);
      await pressDrag(s, a, b);
      await s.page.mouse.up();
      const lines = await created(s, 4);
      near(lines[0].points[0].x, a.world.x);
      near(lines[0].points[0].y, a.world.y);
      near(lines[1].points[1].x, b.world.x);
      near(lines[1].points[1].y, b.world.y);
    },
  );
  await check(
    "rectangle dragging captures both source endpoints as real coincident references",
    async (s) => {
      await tool(s, "直线");
      await coordinate(s, 0, { x: 0, y: 0 });
      await coordinate(s, 1, { x: 20, y: 10 });
      const [source] = await created(s, 1);
      await s.page.keyboard.press("Escape");
      await tool(s, "两点矩形");
      await s.page.locator('.bottom-actions button[title="切换吸附"]').click();
      await canvasPoint(s, 0.3, 0.4);
      const state = await s.canvas.evaluate((el) => el.__cadViewport),
        box = await s.canvas.boundingBox();
      const at = (p) => ({
        x: Math.round(box.x + state.origin.x + p.x * state.scale) + 6,
        y: Math.round(box.y + state.origin.y - p.y * state.scale) + 1,
      });
      await pressDrag(s, at(source.points[0]), at(source.points[1]));
      await s.page.mouse.up();
      const added = (await created(s, 5)).slice(1),
        first = added[0].points[0],
        last = added[1].points[1];
      near(first.x, source.points[0].x);
      near(first.y, source.points[0].y);
      near(last.x, source.points[1].x);
      near(last.y, source.points[1].y);
      const constraints = (await documentOf(s)).sketches[0].constraints;
      for (const [a, b] of [
        [first.id, source.points[0].id],
        [last.id, source.points[1].id],
      ])
        assert(
          constraints.some(
            (c) =>
              c.kind === "coincident" &&
              c.refs.includes(a) &&
              c.refs.includes(b),
          ),
        );
    },
  );
  await check(
    "center rectangle dragging retains the pressed center and configured angle",
    async (s) => {
      await tool(s, "两点矩形");
      await s.panel.locator('[data-method="centerRectangle"]').click();
      await s.panel.getByLabel("绘制角度（°）", { exact: true }).fill("30");
      const a = await canvasPoint(s, 0.3, 0.4),
        b = await canvasPoint(s, 0.6, 0.7);
      await pressDrag(s, a, b);
      await s.page.mouse.up();
      const lines = await created(s, 4),
        corners = lines.map((line) => line.points[0]);
      near(corners.reduce((n, p) => n + p.x, 0) / 4, a.world.x);
      near(corners.reduce((n, p) => n + p.y, 0) / 4, a.world.y);
      near(corners[2].x, b.world.x);
      near(corners[2].y, b.world.y);
      near(
        (Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) *
          180) /
          Math.PI,
        30,
      );
    },
  );
  await check(
    "three-point rectangle dragging fixes the baseline and waits for its width point",
    async (s) => {
      await tool(s, "两点矩形");
      await s.panel.locator('[data-method="threeRectangle"]').click();
      const a = await canvasPoint(s, 0.2, 0.3),
        b = await canvasPoint(s, 0.55, 0.45);
      await pressDrag(s, a, b);
      await s.page.mouse.up();
      await expect(row(s, 2)).toHaveClass(/active/);
      assert.equal((await entitiesOf(s)).length, 0);
      await pick(s, 0.4, 0.72);
      const lines = await created(s, 4);
      near(lines[0].points[0].x, a.world.x);
      near(lines[0].points[0].y, a.world.y);
      near(lines[0].points[1].x, b.world.x);
      near(lines[0].points[1].y, b.world.y);
      const [p, q] = lines[0].points,
        r = lines[1].points[1];
      near((q.x - p.x) * (r.x - q.x) + (q.y - p.y) * (r.y - q.y), 0);
    },
  );
  await check(
    "a tiny pressed-point jitter remains a first click rather than a rectangle drag",
    async (s) => {
      await tool(s, "两点矩形");
      const a = await canvasPoint(s, 0.2, 0.3);
      await s.page.mouse.move(a.x, a.y);
      await s.page.mouse.down();
      await s.page.mouse.move(a.x + 2, a.y + 1);
      await s.page.mouse.up();
      assert.equal((await entitiesOf(s)).length, 0);
      await expect(row(s, 1)).toHaveClass(/active/);
      const b = await pick(s, 0.6, 0.7),
        lines = await created(s, 4);
      near(lines[0].points[0].x, a.world.x);
      near(lines[0].points[0].y, a.world.y);
      near(lines[1].points[1].x, b.x);
      near(lines[1].points[1].y, b.y);
    },
  );
  await check(
    "cancelled rectangle drags discard temporary anchors and leave the next gesture usable",
    async (s) => {
      const history = await s.page.locator(".app").getAttribute("data-history");
      for (const reason of ["pointercancel", "lostcapture", "blur", "Escape"]) {
        await tool(s, "两点矩形");
        await s.canvas.evaluate((el) =>
          el.addEventListener(
            "pointerdown",
            (event) => {
              el.__creationPointerId = event.pointerId;
            },
            { once: true },
          ),
        );
        const a = await canvasPoint(s, 0.2, 0.3),
          b = await canvasPoint(s, 0.6, 0.7);
        await pressDrag(s, a, b);
        if (reason === "Escape") await s.page.keyboard.press("Escape");
        else
          await s.canvas.evaluate((el, reason) => {
            if (reason === "pointercancel")
              el.dispatchEvent(
                new PointerEvent("pointercancel", {
                  pointerId: el.__creationPointerId,
                  bubbles: true,
                }),
              );
            else if (reason === "lostcapture")
              el.releasePointerCapture(el.__creationPointerId);
            else window.dispatchEvent(new Event("blur"));
          }, reason);
        await s.page.mouse.up();
        assert.equal((await entitiesOf(s)).length, 0, reason);
        assert.equal(
          await s.page.locator(".app").getAttribute("data-history"),
          history,
          reason,
        );
        if (reason === "Escape") await expect(s.panel).toHaveCount(0);
        else {
          await expect(row(s, 0)).toHaveClass(/active/);
          await expect(row(s, 0).locator("input").first()).toHaveValue("");
        }
      }
      await tool(s, "两点矩形");
      await pressDrag(
        s,
        await canvasPoint(s, 0.2, 0.3),
        await canvasPoint(s, 0.6, 0.7),
      );
      await s.page.mouse.up();
      await created(s, 4);
    },
  );
  await check(
    "switching tools during a rectangle drag never feeds its release into the new tool",
    async (s) => {
      await tool(s, "两点矩形");
      await pressDrag(
        s,
        await canvasPoint(s, 0.2, 0.3),
        await canvasPoint(s, 0.6, 0.7),
      );
      await s.page.keyboard.press("c");
      await s.page.mouse.up();
      await expect(
        s.panel.locator('[data-method="circle"] input'),
      ).toBeChecked();
      await expect(row(s, 0).locator("input").first()).toHaveValue("");
      assert.equal((await entitiesOf(s)).length, 0);
      const a = await pick(s, 0.3, 0.4),
        b = await pick(s, 0.5, 0.6),
        [circle] = await created(s, 1);
      near(circle.points[0].x, a.x);
      near(circle.points[0].y, a.y);
      near(circle.radius, distance(a, b));
    },
  );
  await check(
    "space and middle-button panning do not start a rectangle",
    async (s) => {
      await tool(s, "两点矩形");
      for (const kind of ["Space", "middle"]) {
        const a = await canvasPoint(s, 0.3, 0.4),
          before = await s.canvas.evaluate((el) => el.__cadViewport);
        await s.canvas.focus();
        if (kind === "Space") await s.page.keyboard.down("Space");
        await s.page.mouse.move(a.x, a.y);
        await s.page.mouse.down({
          button: kind === "middle" ? "middle" : "left",
        });
        await s.page.mouse.move(a.x + 40, a.y + 20, { steps: 8 });
        await s.page.mouse.up({
          button: kind === "middle" ? "middle" : "left",
        });
        if (kind === "Space") await s.page.keyboard.up("Space");
        await expect
          .poll(
            async () =>
              (await s.canvas.evaluate((el) => el.__cadViewport)).origin.x,
          )
          .toBeCloseTo(before.origin.x + 40, 5);
        assert.equal((await entitiesOf(s)).length, 0);
        await expect(row(s, 0).locator("input").first()).toHaveValue("");
      }
    },
  );
  await check(
    "390px rectangle press-drag finishes on release without covering the canvas",
    async (s) => {
      await tool(s, "两点矩形");
      const a = await canvasPoint(s, 0.2, 0.35),
        b = await canvasPoint(s, 0.75, 0.7);
      await pressDrag(s, a, b);
      await s.page.mouse.up();
      const lines = await created(s, 4);
      near(lines[0].points[0].x, a.world.x);
      near(lines[0].points[0].y, a.world.y);
      near(lines[1].points[1].x, b.world.x);
      near(lines[1].points[1].y, b.world.y);
      const canvas = await s.canvas.boundingBox(),
        panel = await s.panel.boundingBox();
      assert(canvas.x + canvas.width <= panel.x + 1);
    },
    { viewport: { width: 390, height: 844 } },
  );
  await check(
    "method radio navigation keeps keyboard focus while changing workflows",
    async (s) => {
      await tool(s, "两点矩形");
      const diagonal = s.panel.locator('[data-method="rectangle"] input');
      const threePoint = s.panel.locator(
        '[data-method="threeRectangle"] input',
      );
      const center = s.panel.locator('[data-method="centerRectangle"] input');
      await diagonal.focus();
      await diagonal.press("ArrowRight");
      await expect(threePoint).toBeChecked();
      await expect(threePoint).toBeFocused();
      await expect(s.panel.locator("[data-point-index]")).toHaveCount(3);
      await threePoint.press("ArrowRight");
      await expect(center).toBeChecked();
      await expect(center).toBeFocused();
      await expect(s.panel.locator("[data-point-index]")).toHaveCount(2);
      assert.equal((await entitiesOf(s)).length, 0);
    },
  );
  await check(
    "diagonal and center rectangles commit one undoable operation",
    async (s) => {
      await tool(s, "两点矩形");
      await coordinate(s, 0, { x: 2, y: 3 });
      await coordinate(s, 1, { x: 22, y: 13 });
      const lines = await created(s, 4);
      near(distance(lines[0].points[0], lines[0].points[1]), 20);
      near(distance(lines[1].points[0], lines[1].points[1]), 10);
      await s.page.keyboard.press("Escape");
      await s.page.keyboard.press("Control+z");
      await expect.poll(async () => (await entitiesOf(s)).length).toBe(0);
      await s.page.keyboard.press("Control+Shift+z");
      await expect.poll(async () => (await entitiesOf(s)).length).toBe(4);
      await tool(s, "两点矩形");
      await s.panel.locator('[data-method="centerRectangle"]').click();
      await coordinate(s, 0, { x: 40, y: 4 });
      await coordinate(s, 1, { x: 50, y: 9 });
      const added = (await created(s, 8)).slice(4);
      const corners = added.map((e) => e.points[0]);
      near(corners.reduce((n, p) => n + p.x, 0) / 4, 40);
      near(corners.reduce((n, p) => n + p.y, 0) / 4, 4);
      near(distance(added[0].points[0], added[0].points[1]), 20);
      near(distance(added[1].points[0], added[1].points[1]), 10);
    },
  );
  await check(
    "three-point rectangle keeps rotation and projected height",
    async (s) => {
      await tool(s, "两点矩形");
      await s.panel.locator('[data-method="threeRectangle"]').click();
      const points = [
        { x: -20, y: -10 },
        { x: -4, y: 2 },
        { x: 3, y: 24 },
      ];
      for (const [i, p] of points.entries()) {
        await coordinate(s, i, i === 2 ? { x: 12, y: 14 } : p);
      }
      assert.equal((await entitiesOf(s)).length, 0);
      await coordinate(s, 2, points[2]);
      const lines = await created(s, 4);
      near(lines[0].points[0].x, -20);
      near(lines[0].points[0].y, -10);
      near(lines[0].points[1].x, -4);
      near(lines[0].points[1].y, 2);
      const u = { x: 16, y: 12 },
        v = { x: lines[1].points[1].x + 4, y: lines[1].points[1].y - 2 };
      near(u.x * v.x + u.y * v.y, 0);
      near(Math.hypot(v.x, v.y), 13.4);
      assert(
        !(await documentOf(s)).sketches[0].constraints.some((c) =>
          ["horizontal", "vertical"].includes(c.kind),
        ),
      );
      await s.page.screenshot({
        path: path.join(output, "three-point-rectangle.png"),
      });
    },
  );
  await check(
    "polygon incircle and circumcircle modes use side and vertex radii",
    async (s) => {
      await tool(s, "多边形");
      await s.panel.getByLabel(/边数/).fill("2");
      await coordinate(s, 0, { x: 0, y: 0 });
      await coordinate(s, 1, { x: 10, y: 0 });
      assert.equal((await entitiesOf(s)).length, 0);
      await s.panel.locator('[data-polygon-mode="incircle"]').click();
      await pick(s, 0.2, 0.3);
      await pick(s, 0.45, 0.55);
      assert.equal((await entitiesOf(s)).length, 0);
      await expect(row(s, 0).locator("input").first()).toHaveValue("");
      await s.panel.getByLabel(/边数/).fill("4.5");
      await row(s, 0).locator("input").nth(0).focus();
      assert.equal((await entitiesOf(s)).length, 0);
      await s.panel.getByLabel(/边数/).fill("5");
      await s.panel.locator('[data-polygon-mode="incircle"]').click();
      await expect(row(s, 0).locator("input").nth(0)).toHaveValue("");
      await coordinate(s, 0, { x: 0, y: 0 });
      await coordinate(s, 1, { x: 10, y: 0 });
      const sides = await created(s, 5);
      const [a, b] = sides[0].points;
      near((a.x + b.x) / 2, 10);
      near((a.y + b.y) / 2, 0);
      near(distance({ x: 0, y: 0 }, a), 10 / Math.cos(Math.PI / 5));
      await s.panel.locator('[data-polygon-mode="circumcircle"]').click();
      await coordinate(s, 0, { x: 40, y: 0 });
      await coordinate(s, 1, { x: 50, y: 0 });
      const outer = (await created(s, 10)).slice(5);
      near(outer[0].points[0].x, 50);
      near(outer[0].points[0].y, 0);
      for (const side of outer)
        near(distance({ x: 40, y: 0 }, side.points[0]), 10);
      await s.page.screenshot({
        path: path.join(output, "polygon-methods.png"),
      });
    },
  );
  await check(
    "partial input cannot commit; repicking and method changes preserve committed geometry",
    async (s) => {
      await tool(s, "两点矩形");
      await coordinate(s, 0, { x: 0, y: 0 });
      await row(s, 1).locator("input").nth(1).fill("5");
      await row(s, 1).locator("input").nth(0).fill("-");
      await row(s, 1).locator("input").nth(0).press("Enter");
      assert.equal((await entitiesOf(s)).length, 0);
      await row(s, 1).locator("input").nth(0).fill("12");
      await row(s, 1).locator("input").nth(0).press("Enter");
      await created(s, 4);
      await coordinate(s, 0, { x: 30, y: 0 });
      await row(s, 0).getByRole("button").first().click();
      await expect(row(s, 0)).toHaveClass(/active/);
      await pick(s, 0.18, 0.7);
      await expect(row(s, 1)).toHaveClass(/active/);
      await s.panel.locator('[data-method="threeRectangle"]').click();
      await expect(row(s, 0).locator("input").nth(0)).toHaveValue("");
      assert.equal((await entitiesOf(s)).length, 4);
      await s.panel.getByLabel("取消创建", { exact: true }).click();
      await expect(s.panel).toHaveCount(0);
      assert.equal((await entitiesOf(s)).length, 4);
    },
  );
  await check(
    "center rectangle angle rotates real edges while preserving center and picked corner",
    async (s) => {
      await tool(s, "两点矩形");
      await s.panel.locator('[data-method="centerRectangle"]').click();
      const angle = s.panel.getByLabel("绘制角度（°）", { exact: true });
      await angle.fill("-");
      await pick(s, 0.2, 0.3);
      assert.equal((await entitiesOf(s)).length, 0);
      await expect(row(s, 0).locator("input").first()).toHaveValue("");
      await angle.fill("30");
      await coordinate(s, 0, { x: 0, y: 0 });
      await coordinate(s, 1, { x: 10, y: 4 });
      const lines = await created(s, 4);
      const [a, b] = lines[0].points,
        c = lines[1].points[1];
      near((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, 30);
      near((a.x + c.x) / 2, 0);
      near((a.y + c.y) / 2, 0);
      near(c.x, 10);
      near(c.y, 4);
      near((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y), 0);
      await s.page.screenshot({
        path: path.join(output, "docked-angle-rectangle.png"),
      });
    },
  );
  await check(
    "polygon angle preserves incircle and circumcircle radius definitions",
    async (s) => {
      await tool(s, "多边形");
      await s.panel.getByLabel(/边数/).fill("4");
      await s.panel.locator('[data-polygon-mode="incircle"]').click();
      await s.panel.getByLabel("绘制角度（°）", { exact: true }).fill("90");
      await coordinate(s, 0, { x: 0, y: 0 });
      await coordinate(s, 1, { x: 10, y: 0 });
      const lines = await created(s, 4),
        [a, b] = lines[0].points;
      near((a.x + b.x) / 2, 0);
      near((a.y + b.y) / 2, 10);
      await s.panel.locator('[data-polygon-mode="circumcircle"]').click();
      await s.panel.getByLabel("绘制角度（°）", { exact: true }).fill("90");
      await coordinate(s, 0, { x: 40, y: 0 });
      await coordinate(s, 1, { x: 50, y: 0 });
      const outer = (await created(s, 8)).slice(4);
      near(outer[0].points[0].x, 40);
      near(outer[0].points[0].y, 10);
      for (const side of outer)
        near(distance({ x: 40, y: 0 }, side.points[0]), 10);
    },
  );
  await check(
    "ellipse angle changes the stored major axis without changing its radii",
    async (s) => {
      await tool(s, "椭圆");
      await s.panel.getByLabel("绘制角度（°）", { exact: true }).fill("90");
      for (const [i, p] of [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 1, y: 3 },
      ].entries())
        await coordinate(s, i, p);
      const [ellipse] = await created(s, 1);
      near(ellipse.points[1].x, 0);
      near(ellipse.points[1].y, 8);
      near(ellipse.ry, 3);
      await s.panel.getByLabel("绘制角度（°）", { exact: true }).fill("");
      for (const [i, p] of [
        { x: 20, y: 0 },
        { x: 28, y: 0 },
        { x: 21, y: 3 },
      ].entries())
        await coordinate(s, i, p);
      const automatic = (await created(s, 2))[1];
      near(automatic.points[1].x, 28);
      near(automatic.points[1].y, 0);
      near(automatic.ry, 3);
    },
  );
  await check(
    "canvas lines chain immediately and cancelling a partial shape never rolls back committed segments",
    async (s) => {
      await tool(s, "直线");
      await pick(s, 0.18, 0.35);
      await pick(s, 0.38, 0.55);
      await created(s, 1);
      await pick(s, 0.58, 0.3);
      const lines = await created(s, 2);
      near(lines[0].points[1].x, lines[1].points[0].x);
      near(lines[0].points[1].y, lines[1].points[0].y);
      await s.page.keyboard.press("Escape");
      await tool(s, "两点矩形");
      await pick(s, 0.2, 0.5);
      await s.panel
        .getByRole("button", { name: "退出绘制", exact: true })
        .click();
      await created(s, 2);
    },
  );
  await check(
    "double click ends a variable-length spline without an extra confirmation or duplicate point",
    async (s) => {
      await tool(s, "拟合点样条");
      await pick(s, 0.2, 0.35);
      await pick(s, 0.4, 0.6);
      assert.equal((await entitiesOf(s)).length, 0);
      const box = await s.canvas.boundingBox();
      await s.canvas.dblclick({
        position: { x: box.width * 0.6, y: box.height * 0.4 },
      });
      const [curve] = await created(s, 1);
      assert.equal(curve.kind, "spline");
      assert.equal(curve.points.length, 3);
      await expect(row(s, 0)).toHaveClass(/active/);
    },
  );
  const methods = [
    {
      label: "直线",
      method: "line",
      points: [
        [0, 0],
        [20, 0.1],
      ],
      count: 1,
      verify: (es) => {
        near(es[0].points[0].y, 0);
        near(es[0].points[1].y, 0.1);
      },
    },
    {
      label: "直线",
      method: "midline",
      points: [
        [0, 0],
        [5, 0],
      ],
      count: 2,
      verify: (es) => {
        near(es[0].points[0].x, -5);
        near(es[0].points[1].x, 5);
      },
    },
    {
      label: "圆心圆",
      method: "circle",
      points: [
        [0, 0],
        [3, 4],
      ],
      count: 1,
      verify: (es) => near(es[0].radius, 5),
    },
    {
      label: "圆心圆",
      method: "threeCircle",
      points: [
        [5, 0],
        [0, 5],
        [-5, 0],
      ],
      count: 1,
      verify: (es) => {
        near(es[0].radius, 5);
        near(es[0].points[0].x, 0);
      },
    },
    {
      label: "三点圆弧",
      method: "arc",
      points: [
        [5, 0],
        [0, 5],
        [-5, 0],
      ],
      count: 1,
      verify: (es) => {
        near(es[0].radius, 5);
        near(es[0].points[1].x, 5);
        near(es[0].points[2].x, -5);
      },
    },
    {
      label: "三点圆弧",
      method: "centerArc",
      points: [
        [0, 0],
        [5, 0],
        [0, 7],
      ],
      count: 1,
      verify: (es) => {
        near(es[0].radius, 5);
        near(es[0].points[2].y, 5);
      },
    },
    {
      label: "椭圆",
      points: [
        [0, 0],
        [8, 0],
        [1, 3],
      ],
      count: 1,
      verify: (es) => near(es[0].ry, 3),
    },
    {
      label: "直线槽",
      method: "slot",
      points: [
        [0, 0],
        [20, 0],
        [20, 3],
      ],
      count: 4,
      verify: (es) => {
        for (const arc of es.filter((e) => e.kind === "arc"))
          near(arc.radius, 3);
      },
    },
    {
      label: "直线槽",
      method: "arcSlot",
      points: [
        [0, 0],
        [10, 0],
        [0, 10],
        [12, 0],
      ],
      count: 4,
      verify: (es) => {
        near(es[0].radius, 12);
        near(es[1].radius, 8);
        near(es[2].radius, 2);
        near(es[3].radius, 2);
      },
    },
    {
      label: "拟合点样条",
      method: "spline",
      points: [
        [0, 0],
        [5, 4],
        [10, 0],
      ],
      count: 1,
      verify: (es) => {
        near(es[0].points[1].x, 5);
        near(es[0].points[1].y, 4);
      },
    },
    {
      label: "拟合点样条",
      method: "bezier",
      points: [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
      ],
      count: 1,
      verify: (es) => {
        assert.equal(es[0].kind, "bezier");
        near(es[0].points[1].y, 10);
      },
    },
    {
      label: "拟合点样条",
      method: "conic",
      points: [
        [0, 0],
        [5, 10],
        [10, 0],
      ],
      count: 1,
      verify: (es) => {
        assert.equal(es[0].kind, "conic");
        near(es[0].weight, 0.65);
      },
    },
    {
      label: "点",
      points: [[4, -3]],
      count: 1,
      verify: (es) => {
        assert.equal(es[0].kind, "point");
        near(es[0].points[0].x, 4);
        near(es[0].points[0].y, -3);
      },
    },
  ];
  for (const spec of methods)
    await check(
      `${spec.method || spec.label} method creates matching geometry through the shared panel`,
      async (s) => {
        await tool(s, spec.label);
        if (spec.method)
          await s.panel.locator(`[data-method="${spec.method}"]`).click();
        for (const [i, [x, y]] of spec.points.entries())
          await coordinate(s, i, { x, y });
        if (spec.method === "spline") {
          assert.equal((await entitiesOf(s)).length, 0);
          await s.canvas.press("Enter");
        }
        spec.verify(await created(s, spec.count));
      },
    );
  await check(
    "optional spline input blocks incomplete termination and recovers when cleared",
    async (s) => {
      await tool(s, "拟合点样条");
      await coordinate(s, 0, { x: 0, y: 0 });
      await coordinate(s, 1, { x: 10, y: 5 });
      const nextX = row(s, 2).locator("input").nth(0);
      await nextX.fill("-");
      await nextX.press("Enter");
      assert.equal((await entitiesOf(s)).length, 0);
      await nextX.fill("");
      await nextX.press("Enter");
      const [curve] = await created(s, 1);
      assert.equal(curve.kind, "spline");
      assert.equal(curve.points.length, 2);
      near(curve.points[1].x, 10);
      near(curve.points[1].y, 5);
    },
  );
  await check(
    "text content and height are configured inline before insertion",
    async (s) => {
      await tool(s, "文本");
      await s.panel.getByLabel("文本内容", { exact: true }).fill("");
      await coordinate(s, 0, { x: 2, y: -3 });
      assert.equal((await entitiesOf(s)).length, 0);
      await s.panel.getByLabel("文本内容", { exact: true }).fill("孔位 A");
      await s.panel.getByLabel(/文本高度/).fill("4");
      await s.panel.getByLabel(/文本高度/).press("Enter");
      const [text] = await created(s, 1);
      assert.equal(text.kind, "text");
      assert.equal(text.text, "孔位 A");
      near(text.fontSize, 4);
      near(text.points[0].x, 2);
      near(text.points[0].y, -3);
    },
  );
  await check(
    "inch coordinate entry converts to internal millimeters",
    async (s) => {
      await tool(s, "两点矩形");
      await coordinate(s, 0, { x: 0, y: 0 });
      await coordinate(s, 1, { x: 2, y: 1 });
      const lines = await created(s, 4);
      near(distance(...lines[0].points), 50.8);
      near(distance(...lines[1].points), 25.4);
    },
    { unit: "in" },
  );
  await check(
    "390px dock keeps canvas and exit action reachable without overlap",
    async (s) => {
      await tool(s, "两点矩形");
      await s.page.locator('.view-controls button[title="缩小"]').click();
      const box = await s.panel.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= 391);
      const canvas = await s.canvas.boundingBox();
      assert(canvas.width >= 180);
      assert(canvas.x + canvas.width <= box.x + 1);
      const badge = await s.page.locator(".view-badge").boundingBox();
      const zoom = await s.page.locator(".view-controls").boundingBox();
      assert(
        badge.y >= zoom.y + zoom.height,
        "view scale must remain readable below zoom controls",
      );
      await expect(
        s.panel.getByRole("button", { name: "退出绘制", exact: true }),
      ).toBeVisible();
      await pick(s, 0.15, 0.82);
      await expect(row(s, 1)).toHaveClass(/active/);
      await pick(s, 0.42, 0.95);
      await created(s, 4);
      assert.equal(
        await s.page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await s.page.screenshot({
        path: path.join(output, "mobile-creation.png"),
        fullPage: true,
      });
    },
    { viewport: { width: 390, height: 844 } },
  );
  assert.deepEqual(results.errors, []);
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
