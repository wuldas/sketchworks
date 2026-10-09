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
