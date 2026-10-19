import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/canvas-grid",
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const results = { url, dpr: 2, checks: [], errors: [], externalRequests: [] };
await fs.mkdir(output, { recursive: true });
await context.route("**/*", (route) => {
  const requestUrl = route.request().url();
  if (
    /^https?:/.test(requestUrl) &&
    new URL(requestUrl).origin !== new URL(url).origin
  ) {
    results.externalRequests.push(requestUrl);
    return route.abort();
  }
  return route.continue();
});
page.on("pageerror", (error) => results.errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") results.errors.push(message.text());
});
await page.addInitScript(() =>
  localStorage.setItem(
    "sketchworks.document.v1",
    JSON.stringify({
      version: 1,
      name: "Canvas grid regression",
      unit: "mm",
      parameters: [],
      sketches: [
        {
          id: "grid-test",
          name: "草图 1",
          visible: true,
          entities: [],
          constraints: [],
        },
      ],
    }),
  ),
);
const canvas = page.getByTestId("cad-canvas");
const viewport = () => canvas.evaluate((element) => element.__cadViewport);
const ready = () =>
  page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="cad-canvas"]');
    return (
      element instanceof HTMLCanvasElement &&
      element.__cadViewport?.renderer === "canvas2d"
    );
  });

async function inspectGrid(name) {
  await page.mouse.move(5, 5);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]').__cadViewport
        .snap === null,
  );
  const grid = await canvas.evaluate((element) => {
    const state = element.__cadViewport;
    const { origin, spacing, width, height, dpr } = state;
    const drawing = element.getContext("2d");
    const mod = (value) => ((value % spacing) + spacing) % spacing;
    const sampleX = Math.round((90 + mod(origin.x + spacing / 2 - 90)) * dpr);
    const sampleY = Math.round((90 + mod(origin.y + spacing / 2 - 90)) * dpr);
    const runs = (data, count) => {
      const groups = [];
      for (let index = 0; index < count; index++) {
        const at = index * 4;
        if (!(data[at] < 247 && data[at + 1] < 250 && data[at + 2] < 249))
          continue;
        if (groups.length && groups.at(-1).at(-1) === index - 1)
          groups.at(-1).push(index);
        else groups.push([index]);
      }
      return groups.map((group) => (group[0] + group.at(-1) + 1) / (2 * dpr));
    };
    return {
      origin,
      spacing,
      width,
      height,
      dpr,
      scale: state.scale,
      backingWidth: element.width,
      backingHeight: element.height,
      vertical: runs(
        drawing.getImageData(0, sampleY, element.width, 1).data,
        element.width,
      ),
      horizontal: runs(
        drawing.getImageData(sampleX, 0, 1, element.height).data,
        element.height,
      ),
    };
  });
  assert.equal(grid.dpr, 2);
  assert(Math.abs(grid.backingWidth - Math.round(grid.width * grid.dpr)) <= 1);
  assert(
    Math.abs(grid.backingHeight - Math.round(grid.height * grid.dpr)) <= 1,
  );
  for (const [axis, extent, origin] of [
    ["vertical", grid.width, grid.origin.x],
    ["horizontal", grid.height, grid.origin.y],
  ]) {
    const expected = [];
    for (
      let k = Math.ceil((4 - origin) / grid.spacing);
      origin + k * grid.spacing < extent - 80;
      k++
    )
      expected.push(origin + k * grid.spacing);
    const actual = grid[axis].filter(
      (position) => position > 4 && position < extent - 80,
    );
    assert(expected.length > 3, `${name}: enough ${axis} grid lines to test`);
    for (const position of actual)
      assert(
        Math.abs(
          position -
            (origin +
              Math.round((position - origin) / grid.spacing) * grid.spacing),
        ) <= 1,
        `${name}: misplaced ${axis} grid line at ${position}`,
      );
    for (const position of expected)
      assert(
        grid[axis].some((target) => Math.abs(target - position) <= 1),
        `${name}: missing ${axis} grid line at ${position}; rendered=${JSON.stringify(grid[axis])}`,
      );
  }
  const target = {
    x:
      grid.origin.x +
      Math.round((grid.width * 0.3 - grid.origin.x) / grid.spacing) *
        grid.spacing,
    y:
      grid.origin.y +
      Math.round((grid.height * 0.35 - grid.origin.y) / grid.spacing) *
        grid.spacing,
  };
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + target.x + 2, box.y + target.y + 1);
  await page.waitForFunction((target) => {
    const snap = document.querySelector('[data-testid="cad-canvas"]')
      .__cadViewport.snap;
    return (
      snap?.kind === "grid" &&
      Math.abs(snap.x - target.x) < 1e-6 &&
      Math.abs(snap.y - target.y) < 1e-6
    );
  }, target);
  const marker = await canvas.evaluate((element, target) => {
    const state = element.__cadViewport,
      dpr = state.dpr;
    const x = Math.floor((target.x - 9) * dpr),
      y = Math.floor((target.y - 9) * dpr),
      size = Math.ceil(18 * dpr);
    const pixels = element.getContext("2d").getImageData(x, y, size, size).data;
    let orangePixels = 0;
    for (let at = 0; at < pixels.length; at += 4)
      if (
        pixels[at] > 160 &&
        pixels[at + 1] > 80 &&
        pixels[at + 1] < 190 &&
        pixels[at + 2] < 110
      )
        orangePixels++;
    return { snap: state.snap, orangePixels };
  }, target);
  assert(
    marker.orangePixels > 8,
    `${name}: real rasterized snapping square at the visible grid intersection`,
  );
  results.checks.push({
    name,
    passed: true,
    spacing: grid.spacing,
    origin: grid.origin,
    dpr: grid.dpr,
    lines: {
      vertical: grid.vertical.length,
      horizontal: grid.horizontal.length,
    },
    marker,
  });
  console.log(`PASS ${name}`);
  return grid;
}

async function pan(dx, dy) {
  const box = await canvas.boundingBox(),
    before = await viewport();
  const x = box.x + box.width * 0.6,
    y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await page.waitForFunction(
    (before) =>
      document.querySelector('[data-testid="cad-canvas"]').__cadViewport.origin
        .x !== before,
    before.origin.x,
  );
}
async function zoom(delta) {
  const box = await canvas.boundingBox(),
    before = await viewport();
  const globalX = Math.round(box.x + box.width * 0.35),
    globalY = Math.round(box.y + box.height * 0.4);
  const anchor = { x: globalX - box.x, y: globalY - box.y };
  const world = {
    x: (anchor.x - before.origin.x) / before.scale,
    y: (before.origin.y - anchor.y) / before.scale,
  };
  await page.mouse.move(globalX, globalY);
  await page.mouse.wheel(0, delta);
  await page.waitForFunction(
    (before) =>
      document.querySelector('[data-testid="cad-canvas"]').__cadViewport
        .scale !== before,
    before.scale,
  );
  const after = await viewport();
  assert(
    Math.abs((anchor.x - after.origin.x) / after.scale - world.x) < 1e-6 &&
      Math.abs((after.origin.y - anchor.y) / after.scale - world.y) < 1e-6,
    "wheel zoom retains the world point under its CSS-pixel cursor",
  );
}

try {
  await page.goto(url);
  await page.locator(".loading-overlay").waitFor({ state: "hidden" });
  await ready();
  await page.getByRole("button", { name: "直线", exact: true }).click();
  await inspectGrid("Desktop initial grid");
  await pan(37, -23);
  await inspectGrid("Desktop panned grid");
  await zoom(-100);
  await inspectGrid("Desktop zoomed-in grid");
  await zoom(100);
  const before = await inspectGrid("Desktop zoomed-out grid");
  await page
    .getByRole("combobox", { name: "单位", exact: true })
    .selectOption("in");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]').__cadViewport
        .snap === null,
  );
  await page.getByRole("button", { name: "直线", exact: true }).click();
  const inches = await inspectGrid("Inch display preserves grid coordinates");
  assert.deepEqual(inches.origin, before.origin);
  assert.equal(inches.spacing, before.spacing);
  await page.mouse.move(5, 5);
  await page.screenshot({
    path: path.join(output, "desktop.png"),
    scale: "css",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".loading-overlay").waitFor({ state: "hidden" });
  await ready();
  await page.getByRole("button", { name: "直线", exact: true }).click();
  await inspectGrid("Mobile initial grid");
  await pan(-29, 19);
  await inspectGrid("Mobile panned grid");
  await zoom(-100);
  await inspectGrid("Mobile zoomed grid");
  await page.mouse.move(5, 5);
  await page.screenshot({
    path: path.join(output, "mobile.png"),
    scale: "css",
  });
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.externalRequests, []);
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.failure = error.stack;
  console.error(error);
  await page
    .screenshot({ path: path.join(output, "failure.png"), scale: "css" })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
