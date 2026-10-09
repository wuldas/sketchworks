/**
 * Command parameter panel browser suite (real Chrome, real canvas events).
 *
 * Verifies the parameter-panel contract that replaced the immediate-pick
 * mirror/array/constraint commands:
 *  - every modify command and geometric constraint opens a panel with one
 *    geometry row per input parameter plus 取消 / 确定
 *  - preselected objects land in the 对象 parameter, mirror axes are picked
 *    separately as 镜像线
 *  - clicking a row activates it, 清空 empties it, clicking again re-selects,
 *    activating a filled row lets the user toggle its contents, and canvas
 *    picks never move geometry
 *  - 确定 commits (mirror creates a derived axis copy, the rectangular array
 *    honours its 方向 line, the constraint lands in the sketch) and 取消 or
 *    Escape restore the previous selection without touching the document
 *
 * Environment: CAD_URL, CAD_ARTIFACTS, CAD_BROWSER_PATH (defaults below).
 */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/command-panel",
);
const storageKey = "sketchworks.document.v1";
const localChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const executablePath =
  process.env.CAD_BROWSER_PATH ||
  (!existsSync(chromium.executablePath()) && existsSync(localChrome)
    ? localChrome
    : undefined);
const results = {
  url,
  output,
  started: new Date().toISOString(),
  browserPath: executablePath || "playwright-chromium",
  checks: [],
  consoleErrors: [],
  pageErrors: [],
};
await fs.mkdir(output, { recursive: true });
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.checks.push({ name, passed: false, error: error.stack });
    throw error;
  }
};

const point = (id, x, y) => ({ id, x, y });
const entity = (kind, id, coords, extra = {}) => ({
  id,
  kind,
  name: id,
  points: coords.map(([x, y], index) => point(`${id}_p${index}`, x, y)),
  ...extra,
});
const line = (id, coords) => entity("line", id, coords);
const fixture = {
  version: 1,
  name: "命令参数面板",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "command-fixture",
      name: "命令面板",
      visible: true,
      entities: [
        line("obj1", [
          [-60, -15],
          [-60, 15],
        ]),
        line("axis", [
          [-45, -25],
          [-45, 25],
        ]),
        entity("circle", "obj2", [[-25, 20]], { radius: 6 }),
        line("dir", [
          [-70, 25],
          [-70, 5],
        ]),
        line("c1", [
          [-40, 25],
          [-20, 25],
        ]),
        line("c2", [
          [-40, 15],
          [-20, 15],
        ]),
      ],
      constraints: [],
    },
    {
      id: "other-sketch",
      name: "其他草图",
      visible: true,
      entities: [],
      constraints: [],
    },
  ],
};

const browser = await chromium.launch({ headless: true, executablePath });
results.browser = browser.version();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addInitScript(
  ([key, value]) => window.localStorage.setItem(key, value),
  [storageKey, JSON.stringify(fixture)],
);
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() !== "error") return;
  if (
    message.location().url.endsWith("/favicon.ico") &&
    message.text().includes("404")
  )
    return;
  results.consoleErrors.push(message.text());
});
page.on("pageerror", (error) => results.pageErrors.push(error.message));

const canvas = page.getByTestId("cad-canvas");
const panel = page.getByTestId("parameter-panel");
const geometry = async () => {
  const document = JSON.parse(
    await page.evaluate((key) => window.localStorage.getItem(key), storageKey),
  );
  return document.sketches[0];
};
const savedGeometry = async () => {
  await page.waitForTimeout(800);
  await page.locator('.save-dot[data-saved="true"]').waitFor();
  return geometry();
};
const viewport = async () =>
  canvas.evaluate((element) => element.__cadViewport);
/** Wait for the auto-fit/view to settle so screen math cannot race a zoom. */
const stableViewport = async () => {
  let previous = await viewport();
  for (let attempt = 0; attempt < 24; attempt++) {
    await page.waitForTimeout(60);
    const next = await viewport();
    if (
      next.scale === previous.scale &&
      next.origin.x === previous.origin.x &&
      next.origin.y === previous.origin.y
    )
      return next;
    previous = next;
  }
  return previous;
};
const topElement = (screen) =>
  page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element
      ? `${element.tagName}.${String(element.className || "")}`
      : "none";
  }, screen);
/** Click the first candidate point that is really on the canvas surface. */
const clickCandidate = async (candidates, label) => {
  const box = await canvas.boundingBox();
  const state = await stableViewport();
  for (const world of candidates) {
    const screen = {
      x: box.x + state.origin.x + world.x * state.scale,
      y: box.y + state.origin.y - world.y * state.scale,
    };
    if (
      screen.x < box.x + 4 ||
      screen.x > box.x + box.width - 4 ||
      screen.y < box.y + 4 ||
      screen.y > box.y + box.height - 4
    )
      continue;
    if ((await topElement(screen)) !== "CANVAS.canvas-surface") continue;
    await page.mouse.click(screen.x, screen.y);
    return { world, screen };
  }
  throw new Error(`no uncovered canvas point for ${label}`);
};
const FRACTIONS = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
const clickLine = async (id, fractions = FRACTIONS) => {
  const target = (await geometry()).entities.find((e) => e.id === id);
  assert.equal(target?.kind, "line", `${id} is a line`);
  const [a, b] = target.points;
  return clickCandidate(
    fractions.map((t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    })),
    id,
  );
};
const clickCircle = async (id, degrees = [90, 180, 270, 45, 135, 225, 315]) => {
  const target = (await geometry()).entities.find((e) => e.id === id);
  assert.equal(target?.kind, "circle", `${id} is a circle`);
  const center = target.points[0];
  return clickCandidate(
    degrees.map((deg) => ({
      x: center.x + target.radius * Math.cos((deg * Math.PI) / 180),
      y: center.y + target.radius * Math.sin((deg * Math.PI) / 180),
    })),
    id,
  );
};
const row = (name) =>
  page.locator(".entity-row").filter({ hasText: name }).first();
const parameter = (key) =>
  panel.locator(`.geometry-parameter[data-parameter="${key}"]`);
const summary = async (key) =>
  (await parameter(key).locator(".geometry-pick span").innerText()).trim();
const active = async (key) =>
  (await parameter(key).getAttribute("class")).includes("active");
const pick = async (key) => parameter(key).locator(".geometry-pick").click();
const clear = async (key) => parameter(key).locator(".geometry-clear").click();
const confirm = () => panel.locator('button[type="submit"]').click();
const cancel = () =>
  panel.locator(".parameter-panel-actions button", { hasText: "取消" }).click();
const openCommand = async (menu, label) => {
  await page
    .locator(".dropdown-caption")
    .filter({ hasText: menu })
    .first()
    .click();
  await page.locator(".menu-item").filter({ hasText: label }).first().click();
  await panel.waitFor();
};
const selectedRows = () => page.locator(".entity-row.selected").count();

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(
  () =>
    document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
      ?.renderer === "canvas2d",
);
await page.waitForFunction(() => !document.querySelector(".loading-overlay"));

/* ------------------------------------------------------------- constraint */
await check(
  "a constraint is picked, cleared and re-picked before commit",
  async () => {
    await row("c1").click();
    await page.locator('button[title="平行"]').first().click();
    await panel.waitFor();
    assert.equal(await summary("first"), "c1");
    assert.equal(
      await active("second"),
      true,
      "the next empty input is active",
    );
    await clickLine("c2");
    assert.equal(await summary("second"), "c2");
    await clear("second");
    assert.equal(await summary("second"), "选择");
    assert.equal(await active("second"), true, "clearing keeps the row active");
    await clickLine("c2");
    assert.equal(await summary("second"), "c2");
    await confirm();
    await panel.waitFor({ state: "detached" });
    const sketch = await savedGeometry();
    const parallel = sketch.constraints.filter((c) => c.kind === "parallel");
    assert.equal(parallel.length, 1);
    assert.deepEqual(parallel[0].refs, ["c1", "c2"]);
    return { refs: parallel[0].refs };
  },
);

await check("an unusable pick keeps the input empty", async () => {
  await row("obj1").click();
  await page.locator('button[title="平行"]').first().click();
  await panel.waitFor();
  await clickCircle("obj2");
  assert.equal(await summary("second"), "选择", "a circle cannot fill 直线 2");
  assert.equal(await panel.locator('button[type="submit"]').isDisabled(), true);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  return { rejected: true };
});

await check("Escape closes the panel without committing", async () => {
  const before = await geometry();
  await row("c1").click();
  await openCommand("修改", "偏移");
  assert.equal(await summary("objects"), "已选择 1 个");
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  const after = await geometry();
  assert.equal(after.entities.length, before.entities.length);
  assert.equal(after.constraints.length, before.constraints.length);
  return { entities: after.entities.length };
});

/* ----------------------------------------------------------------- mirror */
await check("mirror preselects objects and waits for its axis", async () => {
  await row("obj1").click();
  await openCommand("创建", "镜像");
  const labels = await panel
    .locator(".geometry-parameter > .geometry-parameter-row > label")
    .allInnerTexts();
  assert.deepEqual(labels, ["对象", "镜像线"]);
  assert.equal(await summary("objects"), "已选择 1 个");
  assert.equal(
    await active("axis"),
    true,
    "the mirror axis is the active input",
  );
  assert.equal(await summary("axis"), "选择");
  assert.equal(await panel.locator('button[type="submit"]').isDisabled(), true);
  await page.screenshot({ path: path.join(output, "mirror-panel.png") });
  return { labels };
});

await check("canvas picks fill the axis without moving geometry", async () => {
  await clickLine("axis");
  assert.equal(await summary("axis"), "axis");
  const sketch = await geometry();
  const source = sketch.entities.find((e) => e.id === "obj1");
  assert.deepEqual(
    source.points.map((p) => [p.x, p.y]),
    [
      [-60, -15],
      [-60, 15],
    ],
    "picking must not drag the preselected object",
  );
  return { axis: await summary("axis") };
});

await check(
  "对象 can be cleared, re-picked and toggled off again",
  async () => {
    await clear("objects");
    assert.equal(await summary("objects"), "选择");
    assert.equal(await active("objects"), true, "clearing activates the input");
    assert.equal(
      await panel.locator('button[type="submit"]').isDisabled(),
      true,
    );
    await clickLine("obj1");
    assert.equal(await summary("objects"), "已选择 1 个");
    await pick("objects");
    assert.equal(
      await active("objects"),
      true,
      "activating a filled row works",
    );
    await row("obj1").click();
    assert.equal(
      await summary("objects"),
      "选择",
      "clicking a selected object removes it",
    );
    await clickLine("obj1");
    assert.equal(await summary("objects"), "已选择 1 个");
    return { summary: await summary("objects") };
  },
);

await check(
  "keyboard activation and clearing never submit a completed command",
  async () => {
    const before = (await geometry()).entities.length;
    await parameter("axis").locator(".geometry-pick").focus();
    await page.keyboard.press("Enter");
    assert.equal(await panel.count(), 1);
    assert.equal(await active("axis"), true);
    await clickLine("axis");
    assert.equal(await summary("axis"), "选择", "single references toggle off");
    await clickLine("axis");
    assert.equal(await summary("axis"), "axis");
    await parameter("axis").locator(".geometry-clear").focus();
    await page.keyboard.press("Enter");
    assert.equal(await panel.count(), 1);
    assert.equal(await summary("axis"), "选择");
    await clickLine("axis");
    assert.equal((await geometry()).entities.length, before);
    return { unchanged: true };
  },
);

await check("确定 mirrors the source across the picked line", async () => {
  await confirm();
  await panel.waitFor({ state: "detached" });
  const sketch = await savedGeometry();
  const derived = sketch.entities.filter((e) => e.sourceId === "obj1");
  assert.equal(derived.length, 1);
  assert.equal(derived[0].transform.kind, "mirror");
  assert.equal(derived[0].transform.axisId, "axis");
  assert.deepEqual(
    derived[0].points.map((p) => [Math.round(p.x), Math.round(p.y)]),
    [
      [-30, -15],
      [-30, 15],
    ],
    "the copy reflects the source about x = -45",
  );
  return { entities: sketch.entities.length };
});

await check(
  "取消 restores the previous selection and keeps the document",
  async () => {
    const before = (await geometry()).entities.length;
    await row("obj1").click();
    await openCommand("创建", "镜像");
    await clickLine("axis");
    await cancel();
    await panel.waitFor({ state: "detached" });
    assert.equal((await geometry()).entities.length, before);
    assert.equal(
      await selectedRows(),
      1,
      "cancelling restores the prior selection",
    );
    return { entities: before };
  },
);

/* --------------------------------------------------------- rectangular array */
await check(
  "rectangular array exposes object, direction and count fields",
  async () => {
    await row("obj2").click();
    await openCommand("创建", "矩形阵列");
    assert.equal(await summary("objects"), "已选择 1 个");
    assert.equal(
      await active("direction"),
      true,
      "direction is the next input",
    );
    const fields = await panel
      .locator(".parameter-fields > label > span")
      .allInnerTexts();
    assert.deepEqual(fields, [
      "分发",
      "数量 1",
      "距离 1",
      "方向 1",
      "数量 2",
      "距离 2",
      "方向 2",
    ]);
    await page.screenshot({ path: path.join(output, "array-panel.png") });
    return { fields };
  },
);

await check(
  "array direction is re-pickable and the array honours it",
  async () => {
    await clickLine("dir");
    assert.equal(await summary("direction"), "dir");
    await clear("direction");
    assert.equal(await summary("direction"), "可选 · X / Y 轴");
    await clickLine("dir");
    assert.equal(await summary("direction"), "dir");
    await confirm();
    await panel.waitFor({ state: "detached" });
    const sketch = await savedGeometry();
    const copies = sketch.entities.filter((e) => e.sourceId === "obj2");
    assert.equal(copies.length, 5, "a 3 x 2 array adds five copies");
    const centers = copies
      .map((e) => e.points[0])
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
      .sort();
    assert.deepEqual(
      centers,
      ["-25,-20", "-25,0", "-5,-20", "-5,0", "-5,20"],
      "the -Y direction drives spacing 1 and the perpendicular drives spacing 2",
    );
    return { centers };
  },
);

await check(
  "unit changes cancel a command before old-unit literals can be committed",
  async () => {
    const before = await geometry();
    await page
      .getByRole("combobox", { name: "单位", exact: true })
      .selectOption("in");
    await row("obj1").click();
    await openCommand("修改", "移动");
    assert.equal(
      await panel
        .getByRole("textbox", { name: "X 位移", exact: true })
        .inputValue(),
      "10",
    );
    await page
      .getByRole("combobox", { name: "单位", exact: true })
      .selectOption("mm");
    await panel.waitFor({ state: "detached" });
    const after = await savedGeometry();
    assert.deepEqual(after.entities, before.entities);
    return { unchanged: true };
  },
);

await check(
  "sketch and new-sketch switches discard command selections",
  async () => {
    await row("obj1").click();
    await openCommand("修改", "移动");
    await page
      .locator(".sketch-tabs button")
      .filter({ hasText: "其他草图" })
      .click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await selectedRows(), 0);
    assert.equal(await page.locator(".empty-selection").count(), 1);
    await page
      .locator(".sketch-tabs button")
      .filter({ hasText: "命令面板" })
      .click();
    await openCommand("修改", "移动");
    assert.equal(
      await summary("objects"),
      "选择",
      "old selections do not reappear",
    );
    await cancel();
    await row("obj1").click();
    await openCommand("修改", "移动");
    await page.locator('button[title="添加草图"]').click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await selectedRows(), 0);
    assert.equal(await page.locator(".empty-selection").count(), 1);
    return { cleared: true };
  },
);

await check("no unexpected console or page errors", async () => {
  assert.deepEqual(results.consoleErrors, []);
  assert.deepEqual(results.pageErrors, []);
  return { consoleErrors: 0, pageErrors: 0 };
});

await fs.writeFile(
  path.join(output, "results.json"),
  JSON.stringify(results, null, 2),
);
await browser.close();
console.log(`\n${results.checks.length} checks passed -> ${output}`);
