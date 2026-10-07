/**
 * Inline dimension editor browser suite (real Chrome, real Canvas events).
 *
 * Verifies the implemented contract of the on-canvas dimension tool that
 * replaced the modal dialog:
 *  - activation through the ribbon button / properties panel / "D"
 *  - controlled 尺寸类型 combobox
 *  - inline editor input[data-testid="dimension-input"] (.dimension-input)
 *  - line/point previews and explicit blank-canvas label placement before input
 *  - Flow A (body pick), B (point pair + rubber band), C (selection), D (edit)
 *  - kind inference per pick: line -> 长度, circle/arc -> 直径,
 *    parallel line pair -> 线间/点线距离 (lineDistance), intersecting pair -> 角度,
 *    point pair -> 水平距离/垂直距离/长度, spline/ellipse -> rejected
 *  - parameter expressions, Escape/tool-switch exits, no modal .dialog
 *  - blank-left editor commit, right-click cancellation and direct annotation drag
 *  - DPR 2 and a 390x844 mobile case
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
  process.env.CAD_ARTIFACTS || "artifacts/dimension-inline",
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
  externalRequests: [],
  wasm: [],
  dialogs: [],
};
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
results.browser = browser.version();

const writeResults = () =>
  fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );

/* ------------------------------------------------------------------ fixtures */

const p = (id, x, y) => ({ id, x, y });
const entity = (kind, id, coords, extra = {}) => ({
  id,
  kind,
  name: id,
  points: coords.map(([x, y], index) => p(`${id}_p${index}`, x, y)),
  ...extra,
});
const line = (id, coords) => entity("line", id, coords);
const documentFixture = (entities, constraints = [], extra = {}) => ({
  version: 1,
  name: "Dimension inline fixture",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "dimension-fixture",
      name: "Dimension fixture",
      visible: true,
      entities,
      constraints,
    },
  ],
  ...extra,
});

/** Flow A/C/D fixture: every probe point sits far from foreign handles. */
const MAIN = documentFixture([
  line("edge", [
    [-45, -30],
    [-5, -30],
  ]), // length 40, body probe (-25,-30)
  entity("circle", "hole", [[30, -30]], { radius: 8 }), // diameter 16, body probe (30,-22)
  entity(
    "arc",
    "corner",
    [
      [-30, 20],
      [-16, 20],
      [-30, 34],
    ],
    { ccw: true },
  ), // r14 -> diameter 28, body probe at 45deg
  entity(
    "ellipse",
    "oval",
    [
      [20, 20],
      [32, 20],
    ],
    { ry: 6 },
  ), // boundary probes; rejected by the dimension tool
  line("pairX", [
    [-45, 10],
    [-15, 10],
  ]), // same y -> 水平距离 30
  line("pairY", [
    [-48, 5],
    [-48, 35],
  ]), // same x -> 垂直距离 30
  line("diag", [
    [6, -40],
    [36, 0],
  ]), // diagonal -> 长度 50
]);
/** Same fixture without the point-pair lines, used for kind auto-detection. */
const DETECT = documentFixture([
  line("edge", [
    [-45, -30],
    [-5, -30],
  ]),
  entity("circle", "hole", [[30, -30]], { radius: 8 }),
  entity(
    "arc",
    "corner",
    [
      [-30, 20],
      [-16, 20],
      [-30, 34],
    ],
    { ccw: true },
  ),
  entity(
    "ellipse",
    "oval",
    [
      [20, 20],
      [32, 20],
    ],
    { ry: 6 },
  ),
]);
/** Spline-only fixture: any #267f67 ink pixel belongs to the spline curve. */
const SPLINE = documentFixture([
  entity("spline", "wave", [
    [-30, -15],
    [-10, 15],
    [10, -15],
    [30, 15],
  ]),
]);
const SINGLE = documentFixture([
  line("edge", [
    [-20, 0],
    [20, 0],
  ]),
]);
const EXPR = documentFixture([
  line("edge", [
    [-18, 0],
    [18, 0],
  ]),
]);
/**
 * Two parallel lines (perpendicular distance 30) plus two lines crossing at
 * exactly 45 degrees. rail-b starts at the fixture centre so the inline editor
 * anchored on rail-b_p0 sits well inside the canvas.
 */
const railA = line("rail-a", [
  [-40, -15],
  [20, -15],
]);
const railB = line("rail-b", [
  [-10, 15],
  [30, 15],
]);
const slantA = line("slant-a", [
  [-30, 0],
  [10, 0],
]);
const slantB = line("slant-b", [
  [-20, -20],
  [20, 20],
]);
const PAIRS = documentFixture(
  [railA, railB, slantA, slantB],
  [{ id: "c_parallel", kind: "parallel", refs: ["rail-a", "rail-b"] }],
);
/** Same shape without the parallel constraint (auto parallel regression). */
const PAIRS_LOOSE = documentFixture([railA, railB, slantA, slantB]);
/** Both lines already direction-locked by their own horizontal constraints. */
const LOCKED = documentFixture(
  [railA, railB],
  [
    {
      id: "c_horizontal_a",
      kind: "horizontal",
      refs: ["rail-a_p0", "rail-a_p1"],
    },
    {
      id: "c_horizontal_b",
      kind: "horizontal",
      refs: ["rail-b_p0", "rail-b_p1"],
    },
  ],
);

const PAIRS_LABELLED = documentFixture(
  [railA, railB, slantA, slantB],
  [
    { id: "c_parallel", kind: "parallel", refs: ["rail-a", "rail-b"] },
    { id: "c_saved_length", kind: "length", refs: ["rail-a"], value: 60 },
  ],
);
const MIXED = documentFixture([
  line("guide", [
    [-30, -12],
    [30, -12],
  ]),
  entity("point", "probe", [[8, 12]]),
]);
const GUIDE_BODY = { x: -10, y: -12 };

const RAIL_A_BODY = { x: -10, y: -15 };
const RAIL_B_BODY = { x: 10, y: 15 };
const SLANT_A_BODY = { x: -10, y: 0 };
const SLANT_B_BODY = { x: 10, y: 10 };

const arcBodyPoint = (arc) => {
  const [c, a] = arc.points;
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const angle = Math.PI / 4;
  return { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) };
};
const ellipseTopPoint = (ellipse) => ({
  x: ellipse.points[0].x,
  y: ellipse.points[0].y + (ellipse.ry ?? 1),
});
const fmt = (n) => Number(n.toFixed(3)).toString();
/** Product status bar uses a full-width colon; accept both and record the raw text. */
const normalizeStatus = (text) => (text ?? "").replace(/[：:]/g, ":").trim();
const direction = (item) => ({
  x: item.points[1].x - item.points[0].x,
  y: item.points[1].y - item.points[0].y,
});
/** |sin(angle between two lines)|: 0 when exactly parallel. */
const parallelism = (a, b) => {
  const da = direction(a);
  const db = direction(b);
  const scale = Math.hypot(da.x, da.y) * Math.hypot(db.x, db.y);
  return scale ? Math.abs(da.x * db.y - da.y * db.x) / scale : 0;
};
/** Signed angle in degrees from line a to line b (same formula as the product). */
const signedAngle = (a, b) => {
  const da = direction(a);
  const db = direction(b);
  return (
    (Math.atan2(da.x * db.y - da.y * db.x, da.x * db.x + da.y * db.y) * 180) /
    Math.PI
  );
};
/** Perpendicular distance from point P to the infinite line A-B. */
const pointLineDistance = (P, A, B) => {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  return Math.abs(dx * (A.y - P.y) - (A.x - P.x) * dy) / Math.hypot(dx, dy);
};

/* ------------------------------------------------------------------- helpers */

async function open(
  fixture,
  { dpr = 1, viewport = { width: 1440, height: 900 } } = {},
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: dpr,
  });
  try {
    await context.route("**/*", (route) => {
      const target = route.request().url();
      if (
        /^https?:/.test(target) &&
        new URL(target).origin !== new URL(url).origin
      ) {
        results.externalRequests.push(target);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error")
        results.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => results.pageErrors.push(error.message));
    page.on("response", (response) => {
      if (/\.wasm(?:\?|$)/.test(response.url()))
        results.wasm.push({ url: response.url(), status: response.status() });
    });
    await page.addInitScript(seedScript, { doc: fixture, key: storageKey });
    await page.goto(url);
    const session = {
      context,
      page,
      canvas: page.getByTestId("cad-canvas"),
      fixture,
    };
    await ready(session);
    const doc = await stored(session);
    assert.equal(
      doc.name,
      fixture.name,
      "fixture document loaded from storage",
    );
    assert.deepEqual(
      doc.sketches[0].entities.map((item) => item.id),
      fixture.sketches[0].entities.map((item) => item.id),
      "seeded fixture (not the demo document or human storage)",
    );
    return session;
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Seeding plus observation hooks; runs on every navigation of the page. */
function seedScript({ doc, key }) {
  localStorage.setItem(key, JSON.stringify(doc));
  window.__dimensionDialogLog = [];
  window.__dimensionToastLog = [];
  /*
   * React reuses the toast node and only rewrites its text, so insertions
   * alone miss most toasts: sample the current toast content instead.
   */
  let lastToastKey = null;
  const sampleToast = () => {
    const node = document.querySelector(".toast");
    const entry = node
      ? {
          text: (node.textContent || "").trim(),
          error: node.classList.contains("error"),
        }
      : null;
    const toastKey = entry ? `${entry.error ? "E" : "I"}:${entry.text}` : null;
    if (toastKey === lastToastKey) return;
    lastToastKey = toastKey;
    if (entry)
      window.__dimensionToastLog.push({
        at: Math.round(performance.now()),
        ...entry,
      });
  };
  const inspect = (node) => {
    if (!(node instanceof Element)) return;
    if (node.classList?.contains("dialog") || node.querySelector?.(".dialog"))
      window.__dimensionDialogLog.push({
        at: Math.round(performance.now()),
        cls: String(node.className || node.tagName),
      });
  };
  const start = () =>
    new MutationObserver((mutations) => {
      for (const mutation of mutations)
        for (const node of mutation.addedNodes) inspect(node);
      sampleToast();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

async function ready(session) {
  await session.page
    .locator(".loading-overlay")
    .waitFor({ state: "hidden", timeout: 120000 });
  await session.page.waitForFunction(
    () => {
      const element = document.querySelector('[data-testid="cad-canvas"]');
      return (
        element instanceof HTMLCanvasElement &&
        element.__cadViewport?.renderer === "canvas2d" &&
        element.__cadViewport.stats.frames > 0
      );
    },
    undefined,
    { timeout: 120000 },
  );
  await settle(session);
}

/**
 * Re-seed within an existing context. Each call registers a fresh init script,
 * and init scripts run in registration order, so the newest seed wins on the
 * following reload (the hooks above are re-registered by the same script).
 */
async function reseed(session, fixture) {
  await session.page.addInitScript(seedScript, {
    doc: fixture,
    key: storageKey,
  });
  await session.page.reload();
  await ready(session);
  session.fixture = fixture;
  const doc = await stored(session);
  assert.deepEqual(
    doc.sketches[0].entities.map((item) => item.id),
    fixture.sketches[0].entities.map((item) => item.id),
    "reseeded fixture",
  );
}

const settle = (session) =>
  session.page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
      ),
  );

async function stored(session, waitMs = 700) {
  await session.page.waitForTimeout(waitMs);
  await session.page
    .locator('.save-dot[data-saved="true"]')
    .waitFor({ state: "attached", timeout: 8000 });
  return session.page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
}
const sketchOf = (doc) => doc.sketches[0];
const byId = (doc, id) => sketchOf(doc).entities.find((item) => item.id === id);
const lengthOf = (item) =>
  Math.hypot(
    item.points[1].x - item.points[0].x,
    item.points[1].y - item.points[0].y,
  );
const constraintOf = (doc, kind) =>
  sketchOf(doc).constraints.find((item) => item.kind === kind);
const metadata = (session) =>
  session.canvas.evaluate((element) => element.__cadViewport);

async function screenPoint(session, world) {
  const state = await metadata(session);
  const box = await session.canvas.boundingBox();
  const local = {
    x: state.origin.x + world.x * state.scale,
    y: state.origin.y - world.y * state.scale,
  };
  assert(
    local.x >= 12 &&
      local.y >= 12 &&
      local.x <= state.width - 12 &&
      local.y <= state.height - 12,
    `visible target ${JSON.stringify({ world, local })}`,
  );
  return { x: box.x + local.x, y: box.y + local.y, local, box };
}

async function handlePoint(session, pointId) {
  const state = await metadata(session);
  const handle = state.handles.find((item) => item.pointId === pointId);
  assert(handle, `canvas handle for ${pointId}`);
  const box = await session.canvas.boundingBox();
  assert(
    handle.x >= 12 &&
      handle.y >= 12 &&
      handle.x <= state.width - 12 &&
      handle.y <= state.height - 12,
    `handle ${pointId} inside the visible canvas`,
  );
  return { x: box.x + handle.x, y: box.y + handle.y, local: handle, box };
}

const clickPoint = async (session, point) => {
  await session.page.mouse.move(point.x, point.y);
  await settle(session);
  await session.page.mouse.click(point.x, point.y);
  await settle(session);
};

async function clickWorld(session, world) {
  const point = await screenPoint(session, world);
  await clickPoint(session, point);
  return point;
}

async function clickHandle(session, pointId) {
  const point = await handlePoint(session, pointId);
  await clickPoint(session, point);
  return point;
}

async function hoverWorld(session, world) {
  const point = await screenPoint(session, world);
  await session.page.mouse.move(point.x, point.y);
  await settle(session);
  return point;
}

async function dimensionLabelTarget(session, constraintId) {
  const label = (await metadata(session)).dimensions.find(
    (item) => item.id === constraintId,
  );
  assert(
    label,
    `saved label ${constraintId} exists before the annotation click`,
  );
  const box = await session.canvas.boundingBox();
  return { x: box.x + label.x, y: box.y + label.y };
}

async function roundedWorldTarget(session, world) {
  const state = await metadata(session);
  const projected = await screenPoint(session, world);
  const point = {
    ...projected,
    x: Math.round(projected.x),
    y: Math.round(projected.y),
  };
  point.local = { x: point.x - point.box.x, y: point.y - point.box.y };
  point.world = {
    x: (point.local.x - state.origin.x) / state.scale,
    y: (state.origin.y - point.local.y) / state.scale,
  };
  return point;
}

async function editorCanvasTarget(session, world) {
  const point = await screenPoint(session, world);
  const box = await editorBox(session).boundingBox();
  assert(box, "dimension editor exists before the canvas action");
  assert(
    point.x < box.x - 2 ||
      point.x > box.x + box.width + 2 ||
      point.y < box.y - 2 ||
      point.y > box.y + box.height + 2,
    "canvas action is outside the editor overlay",
  );
  for (const label of (await metadata(session)).dimensions) {
    const bounds = label.bounds;
    assert(
      point.local.x < bounds.minX - 8 ||
        point.local.x > bounds.maxX + 8 ||
        point.local.y < bounds.minY - 8 ||
        point.local.y > bounds.maxY + 8,
      "canvas action is outside every saved dimension label",
    );
  }
  const target = await session.page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid"),
    { x: point.x, y: point.y },
  );
  assert.equal(target, "cad-canvas", "canvas action reaches the real canvas");
  return point;
}

async function assertEditorFocused(session, label) {
  assert.equal(
    await editorOpen(session),
    true,
    `${label}: editor remains open`,
  );
  assert(await editorInput(session).isVisible(), `${label}: editor is visible`);
  assert(
    await editorInput(session).evaluate(
      (input) => input === document.activeElement,
    ),
    `${label}: input retains focus`,
  );
}

function assertPointClose(actual, expected, label, tolerance = 1e-7) {
  assert(actual, `${label}: position exists`);
  for (const axis of ["x", "y"])
    assert(
      Number.isFinite(actual[axis]) &&
        Math.abs(actual[axis] - expected[axis]) <= tolerance,
      `${label}: ${axis} is ${actual[axis]}, expected ${expected[axis]}`,
    );
}

async function assertPreview(session, expected, label) {
  const state = await metadata(session);
  const preview = state.dimensionPreview;
  assert(preview, `${label}: visible dimensionPreview metadata`);
  assert.equal(preview.kind, expected.kind, `${label}: preview kind`);
  assert.deepEqual(
    preview.refs,
    expected.refs,
    `${label}: solver-normalized refs`,
  );
  assert.equal(preview.fixed, expected.fixed ?? false, `${label}: fixed state`);
  assert.equal(typeof preview.text, "string", `${label}: dimension text`);
  assert(preview.text.length > 0, `${label}: nonempty dimension text`);
  if (expected.value !== undefined) {
    const value = Number(preview.text.replace(/\u00b0$/, ""));
    const tolerance = expected.kind === "angle" ? 0.051 : 0.0051;
    assert(
      Number.isFinite(value) && Math.abs(value - expected.value) <= tolerance,
      `${label}: measured value ${preview.text}, expected ${expected.value}`,
    );
  }
  for (const axis of ["x", "y"])
    assert(Number.isFinite(preview[axis]), `${label}: screen ${axis}`);
  const bounds = preview.bounds;
  assert(bounds, `${label}: label bounds`);
  for (const key of ["minX", "minY", "maxX", "maxY"])
    assert(Number.isFinite(bounds[key]), `${label}: ${key}`);
  assert(bounds.minX < bounds.maxX, `${label}: nonempty label width`);
  assert(bounds.minY < bounds.maxY, `${label}: nonempty label height`);
  assert(
    preview.x >= bounds.minX &&
      preview.x <= bounds.maxX &&
      preview.y >= bounds.minY &&
      preview.y <= bounds.maxY,
    `${label}: screen position lies inside the rendered label bounds`,
  );
  return preview;
}

async function assertSavedLabel(session, constraint, previousLabel) {
  const state = await metadata(session);
  assert.equal(
    state.dimensionPreview,
    null,
    "saved dimension has no placement preview",
  );
  const label = state.dimensions.find((item) => item.id === constraint.id);
  assert(label, `saved dimension ${constraint.id} rendered`);
  assertPointClose(
    label,
    {
      x: (label.bounds.minX + label.bounds.maxX) / 2,
      y: (label.bounds.minY + label.bounds.maxY) / 2,
    },
    "saved label metadata matches its rendered bounds",
  );
  const world = {
    x: (label.x - state.origin.x) / state.scale,
    y: (state.origin.y - label.y) / state.scale,
  };
  if (previousLabel)
    assertPointClose(
      world,
      previousLabel.world,
      "projected world label position survives reload",
    );
  return { ...label, world };
}

/** Noncircular dimensions need an explicit blank-canvas placement, never a hidden extra pick. */
async function placeDimension(session, world = { x: 0, y: -10 }) {
  assert.equal(
    await editorOpen(session),
    false,
    "no editor before label placement",
  );
  const state = await metadata(session);
  assert(state.dimensionPreview, "a line dimension awaits placement");
  assert.equal(
    state.dimensionPreview.fixed,
    false,
    "preview is not fixed before placement",
  );
  const projected = await screenPoint(session, world);
  const point = {
    ...projected,
    x: Math.round(projected.x),
    y: Math.round(projected.y),
  };
  point.local = { x: point.x - point.box.x, y: point.y - point.box.y };
  point.world = {
    x: (point.local.x - state.origin.x) / state.scale,
    y: (state.origin.y - point.local.y) / state.scale,
  };
  await session.page.mouse.move(point.x, point.y);
  await settle(session);
  const moving = await assertPreview(
    session,
    {
      kind: state.dimensionPreview.kind,
      refs: state.dimensionPreview.refs,
    },
    "projected placement hover",
  );
  await session.page.mouse.click(point.x, point.y);
  await settle(session);
  const editor = await waitForEditor(session);
  const preview = await assertPreview(
    session,
    {
      kind: state.dimensionPreview.kind,
      refs: state.dimensionPreview.refs,
      fixed: true,
    },
    "blank-canvas placement",
  );
  assertPointClose(
    preview,
    moving,
    "blank click freezes the projected label position",
  );
  return { point, preview, editor };
}

/* ------------------------------------------------------------ app locators */

const dimensionButton = (session) =>
  session.page.locator('button[title="草图尺寸 (D)"]');
const addDimensionButton = (session) =>
  session.page.locator('button[title="添加尺寸"]');
const kindSelect = (session) =>
  session.page.getByRole("combobox", { name: "尺寸类型" });
const editorInput = (session) =>
  session.page.locator('[data-testid="dimension-input"]');
const editorBox = (session) => session.page.locator("div.dimension-input");
const toastError = (session) => session.page.locator(".toast.error");

async function modeState(session) {
  return dimensionButton(session).evaluate((element) => ({
    pressed: element.getAttribute("aria-pressed"),
    selected: element.classList.contains("selected"),
    title: element.getAttribute("title"),
  }));
}

const statusText = async (session) =>
  (await session.page.locator(".tool-status").textContent()) ?? "";

async function activate(session) {
  await dimensionButton(session).click();
  await settle(session);
  const state = await modeState(session);
  assert.equal(
    state.pressed,
    "true",
    "dimension button aria-pressed after activation",
  );
  assert(state.selected, "dimension button carries the selected class");
  return state;
}

const escape = async (session) => {
  await session.page.keyboard.press("Escape");
  await settle(session);
};

const editorOpen = async (session) => (await editorInput(session).count()) > 0;

async function waitForEditor(session) {
  await editorInput(session).waitFor({ state: "visible", timeout: 5000 });
  return editorSnapshot(session);
}

async function editorSnapshot(session) {
  const box = await editorBox(session).boundingBox();
  const inputBox = await editorInput(session).boundingBox();
  return {
    value: await editorInput(session).inputValue(),
    ariaLabel: await editorInput(session).getAttribute("aria-label"),
    unit:
      (await session.page
        .locator(".dimension-input .dimension-unit")
        .textContent()) ?? "",
    hint:
      (await session.page.locator(".dimension-input small").textContent()) ??
      "",
    box,
    inputBox,
  };
}

function assertEditorInside(editor, canvas, label) {
  const tolerance = 0.5;
  assert(editor && canvas, `${label}: editor and canvas boxes`);
  assert(
    editor.x >= canvas.x - tolerance &&
      editor.y >= canvas.y - tolerance &&
      editor.x + editor.width <= canvas.x + canvas.width + tolerance &&
      editor.y + editor.height <= canvas.y + canvas.height + tolerance,
    `${label}: editor fully inside the canvas bounds ${JSON.stringify({ editor, canvas })}`,
  );
}

/** Enter commits; returns whether the editor closed and the error toast text. */
async function commitEditor(session, text) {
  await editorInput(session).fill(String(text));
  await editorInput(session).press("Enter");
  const closed = await session.page
    .waitForFunction(
      () => !document.querySelector('[data-testid="dimension-input"]'),
      undefined,
      { timeout: 2500 },
    )
    .then(() => true)
    .catch(() => false);
  await settle(session);
  if (!closed)
    await toastError(session).waitFor({ state: "visible", timeout: 3000 });
  return {
    closed,
    toast: closed
      ? null
      : ((await toastError(session).textContent()) ?? "").trim(),
  };
}

async function assertNoDialog(session, label) {
  const present = await session.page.locator(".dialog").count();
  const log = await session.page.evaluate(
    () => window.__dimensionDialogLog ?? [],
  );
  if (present || log.length) results.dialogs.push({ label, present, log });
  assert.equal(present, 0, `${label}: no .dialog element in the DOM`);
  assert.deepEqual(log, [], `${label}: no .dialog inserted during the action`);
}

const resetDialogLog = (session) =>
  session.page.evaluate(() => {
    window.__dimensionDialogLog = [];
  });
const toastMark = (session) =>
  session.page.evaluate(() => (window.__dimensionToastLog ?? []).length);
const toastsSince = (session, mark) =>
  session.page.evaluate(
    (from) => (window.__dimensionToastLog ?? []).slice(from),
    mark,
  );
/** Current toast read straight from the DOM (independent of the log). */
const readToast = (session) =>
  session.page.evaluate(() => {
    const node = document.querySelector(".toast");
    return node
      ? {
          text: (node.textContent || "").trim(),
          error: node.classList.contains("error"),
        }
      : null;
  });
const observationTexts = (observation) =>
  [
    observation.toast?.text,
    ...observation.toasts.map((item) => item.text),
  ].filter(Boolean);

/** One canvas pick with the toasts, hit context and editor state it produced. */
async function pickObserve(session, world, intended) {
  const mark = await toastMark(session);
  const point = await screenPoint(session, world);
  await session.page.mouse.move(point.x, point.y);
  await settle(session);
  const before = await metadata(session);
  const nearest = before.handles
    .map((handle) => ({
      pointId: handle.pointId,
      entityId: handle.entityId,
      distance: Math.hypot(handle.x - point.local.x, handle.y - point.local.y),
    }))
    .sort((a, b) => a.distance - b.distance)[0];
  await session.page.mouse.click(point.x, point.y);
  await settle(session);
  const editor = (await editorOpen(session))
    ? await editorSnapshot(session)
    : null;
  return {
    intended: intended ?? null,
    world,
    screen: {
      x: Number(point.local.x.toFixed(2)),
      y: Number(point.local.y.toFixed(2)),
    },
    nearestHandle: nearest
      ? { ...nearest, distance: Number(nearest.distance.toFixed(2)) }
      : null,
    snap: before.snap ?? null,
    toast: await readToast(session),
    toasts: await toastsSince(session, mark),
    editor: editor ? { value: editor.value, box: editor.box } : null,
    status: normalizeStatus(await statusText(session)),
    modeActive: (await modeState(session)).pressed === "true",
  };
}

async function ctrlClickRow(session, title) {
  await session.page
    .locator(`.entity-row[title=${JSON.stringify(title)}]`)
    .click({ modifiers: ["Control"] });
  await settle(session);
}

/* --------------------------------------------------------------- ink probes */

/** Preview strokes use teal; saved dimensions retain their existing green ink. */
const dimensionInk = (session) =>
  session.canvas.evaluate((element) => {
    const data = element
      .getContext("2d")
      .getImageData(0, 0, element.width, element.height).data;
    let teal = 0;
    let textGreen = 0;
    for (let at = 0; at < data.length; at += 4) {
      const r = data[at],
        g = data[at + 1],
        b = data[at + 2];
      if (
        Math.abs(r - 73) <= 16 &&
        Math.abs(g - 156) <= 16 &&
        Math.abs(b - 167) <= 16
      )
        teal++;
      if (
        Math.abs(r - 57) <= 12 &&
        Math.abs(g - 123) <= 12 &&
        Math.abs(b - 101) <= 12
      )
        textGreen++;
    }
    return { teal, textGreen };
  });

/** Teal (#499ca7) dashed rubber band coverage between two local CSS points. */
const rubberBand = (session, from, to) =>
  session.canvas.evaluate(
    (element, { from, to }) => {
      const state = element.__cadViewport;
      const dpr = state.dpr;
      const ctx = element.getContext("2d");
      const total = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.max(8, Math.floor(total));
      const colors = new Map();
      let samples = 0;
      let teal = 0;
      for (let index = 0; index <= steps; index++) {
        const t = index / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        if (Math.hypot(x - from.x, y - from.y) < 12) continue;
        if (Math.hypot(x - to.x, y - to.y) < 14) continue;
        const px = Math.max(0, Math.floor((x - 3) * dpr));
        const py = Math.max(0, Math.floor((y - 3) * dpr));
        const width = Math.min(element.width - px, Math.ceil(7 * dpr));
        const height = Math.min(element.height - py, Math.ceil(7 * dpr));
        if (width <= 0 || height <= 0) continue;
        samples++;
        const data = ctx.getImageData(px, py, width, height).data;
        for (let at = 0; at < data.length; at += 4) {
          const r = data[at];
          const g = data[at + 1];
          const b = data[at + 2];
          if (
            Math.abs(r - 73) <= 45 &&
            Math.abs(g - 156) <= 45 &&
            Math.abs(b - 167) <= 45 &&
            g > r + 20 &&
            b > r + 20
          ) {
            const key = `${r},${g},${b}`;
            colors.set(key, (colors.get(key) ?? 0) + 1);
            teal++;
            break;
          }
        }
      }
      return {
        samples,
        teal,
        ratio: samples ? teal / samples : 0,
        colors: [...colors.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([color, count]) => ({ color, count })),
      };
    },
    { from, to },
  );

/** Locate an entity ink pixel (#267f67) far from every listed handle. */
const inkProbe = (session, exclude) =>
  session.canvas.evaluate((element, excludePoints) => {
    const state = element.__cadViewport;
    const dpr = state.dpr;
    const data = element
      .getContext("2d")
      .getImageData(0, 0, element.width, element.height).data;
    const found = [];
    for (let py = 0; py < element.height; py += 2) {
      for (let px = 0; px < element.width; px += 2) {
        const at = (py * element.width + px) * 4;
        const r = data[at];
        const g = data[at + 1];
        const b = data[at + 2];
        if (
          Math.abs(r - 38) > 26 ||
          Math.abs(g - 127) > 26 ||
          Math.abs(b - 103) > 26
        )
          continue;
        const x = px / dpr;
        const y = py / dpr;
        if (
          Math.abs(x - state.origin.x) < 8 ||
          Math.abs(y - state.origin.y) < 8
        )
          continue;
        if (
          excludePoints.every(
            (point) => Math.hypot(point.x - x, point.y - y) >= 26,
          )
        )
          found.push({ x, y });
      }
    }
    return {
      count: found.length,
      sample: found.length ? found[Math.floor(found.length / 2)] : null,
      dpr,
    };
  }, exclude);

/* -------------------------------------------------------------------- suite */

const check = async (name, action) => {
  const started = Date.now();
  try {
    const detail = await action();
    results.checks.push({
      name,
      passed: true,
      ms: Date.now() - started,
      detail,
    });
    console.log(`PASS ${name}`);
    return detail;
  } catch (error) {
    results.checks.push({
      name,
      passed: false,
      ms: Date.now() - started,
      error: error.stack,
    });
    console.error(`FAIL ${name}: ${error.message}`);
    return null;
  } finally {
    await writeResults();
  }
};

const suite = async (fixture, options, body) => {
  let session;
  try {
    session = await open(fixture, options);
  } catch (error) {
    results.checks.push({
      name: `open context ${options?.viewport?.width ?? 1440}`,
      passed: false,
      error: error.stack,
    });
    console.error(error);
    return;
  }
  try {
    await body(session);
  } finally {
    await session.context.close();
  }
};

try {
  /* ---------------------------------------------------------- activation */
  await suite(MAIN, {}, async (session) => {
    await check(
      "Ribbon / properties / keyboard activation and controlled 尺寸类型 combobox",
      async () => {
        const button = dimensionButton(session);
        assert.equal(await button.count(), 1, "ribbon 尺寸 button present");
        assert.equal(
          await button.getAttribute("title"),
          "草图尺寸 (D)",
          "ribbon button title",
        );
        assert.equal(
          await session.page
            .getByRole("button", { name: "尺寸", exact: true })
            .count(),
          1,
          "ribbon button accessible name is 尺寸 with an empty selection",
        );
        const idle = await modeState(session);
        assert.equal(idle.pressed, "false", "aria-pressed false while idle");
        assert(!idle.selected, "selected class absent while idle");

        const select = kindSelect(session);
        assert.equal(
          await select.inputValue(),
          "auto",
          "combobox is controlled (auto)",
        );
        assert.deepEqual(
          await select.locator("option").evaluateAll((options) =>
            options.map((option) => ({
              value: option.value,
              label: option.textContent,
            })),
          ),
          [
            { value: "auto", label: "自动" },
            { value: "length", label: "长度" },
            { value: "lineDistance", label: "线间/点线距离" },
            { value: "distanceX", label: "水平距离" },
            { value: "distanceY", label: "垂直距离" },
            { value: "radius", label: "半径" },
            { value: "diameter", label: "直径" },
            { value: "angle", label: "角度" },
          ],
          "尺寸类型 options",
        );

        await resetDialogLog(session);
        await session.page.keyboard.press("d");
        await settle(session);
        const keyboard = await modeState(session);
        assert.equal(
          keyboard.pressed,
          "true",
          "keyboard D activates dimension mode",
        );
        assert(
          keyboard.selected,
          "keyboard D marks the ribbon button selected",
        );
        const prompt = normalizeStatus(await statusText(session));
        assert(
          /^尺寸:.*点击/.test(prompt),
          `status bar prompts for a pick after activation: ${prompt}`,
        );
        await assertNoDialog(session, "keyboard D activation");
        await escape(session);
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "Escape without an editor exits dimension mode",
        );

        await activate(session);
        await assertNoDialog(session, "ribbon activation");
        await escape(session);

        await addDimensionButton(session).click();
        await settle(session);
        const properties = await modeState(session);
        assert.equal(
          properties.pressed,
          "true",
          "properties 添加尺寸 activates",
        );
        assert.equal(
          await addDimensionButton(session).getAttribute("aria-pressed"),
          "true",
          "properties 添加尺寸 reports its own active state",
        );
        await assertNoDialog(session, "properties activation");
        await escape(session);

        const restored = await select.evaluate((element) => element.value);
        assert.equal(
          restored,
          "auto",
          "combobox stays controlled after cancelling",
        );
        return { idle, keyboard, properties, prompt, options: 8 };
      },
    );

    /* --------------------------------------------------- Flow A and Flow D */
    await check(
      "Flow A: body pick previews length, blank click opens the inline editor",
      async () => {
        const before = await stored(session);
        await activate(session);
        await resetDialogLog(session);
        const pick = await clickWorld(session, { x: -25, y: -30 });
        const preview = await assertPreview(
          session,
          {
            kind: "length",
            refs: ["edge"],
            value: 40,
          },
          "first line body",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "body pick does not open the editor",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "preview does not change the document",
        );
        const placement = await placeDimension(session, { x: -25, y: -42 });
        const editor = placement.editor;
        assert.equal(editor.value, "40", "prefilled with the measured length");
        assert.equal(editor.ariaLabel, "尺寸数值", "input aria-label");
        assert.equal(editor.unit, "mm", "editor renders the document unit");
        assert.equal(
          editor.hint,
          "Enter 确认 · Esc 取消",
          "editor renders the hint",
        );
        assert.equal(
          normalizeStatus(await statusText(session)),
          "长度:输入数值后按 Enter",
          "status bar describes the pending dimension",
        );
        const canvasBox = await session.canvas.boundingBox();
        assertEditorInside(editor.box, canvasBox, "desktop inline editor");
        const centerX = editor.box.x + editor.box.width / 2;
        assert(
          Math.abs(centerX - placement.point.x) <= 2,
          `editor centred over the placed label (${centerX} vs ${placement.point.x})`,
        );
        assert(
          editor.box.y + editor.box.height <= placement.point.y + 1,
          "editor floats above the placed label",
        );
        assert.equal(
          await session.page.locator(".dialog").count(),
          0,
          "no modal dialog for a body pick",
        );
        await session.page.screenshot({
          path: path.join(output, "desktop-inline-editor.png"),
        });
        await assertNoDialog(session, "Flow A body pick");
        return {
          pick,
          preview,
          placement: placement.point.world,
          editor: { value: editor.value, unit: editor.unit, hint: editor.hint },
        };
      },
    );

    await check(
      "Flow A commit: Enter creates the constraint, closes the editor and keeps dimension mode",
      async () => {
        const before = await stored(session);
        const outcome = await commitEditor(session, "25");
        assert(
          outcome.closed,
          `Enter closes the editor (toast: ${outcome.toast})`,
        );
        const after = await stored(session);
        const constraint = sketchOf(after).constraints.find(
          (item) => item.kind === "length" && item.refs.includes("edge"),
        );
        assert(constraint, "length constraint created");
        assert.equal(constraint.value, 25, "constraint driving value");
        assert(
          Math.abs(lengthOf(byId(after, "edge")) - 25) < 1e-5,
          `geometry solved to the new value (${lengthOf(byId(after, "edge"))})`,
        );
        assert(
          sketchOf(after).constraints.length ===
            sketchOf(before).constraints.length + 1,
          "exactly one constraint added",
        );
        const state = await modeState(session);
        assert.equal(
          state.pressed,
          "true",
          "dimension mode stays active after commit",
        );
        const prompt = normalizeStatus(await statusText(session));
        assert(
          /^尺寸:.*点击/.test(prompt),
          `status bar ready for the next dimension: ${prompt}`,
        );
        await assertNoDialog(session, "Flow A commit");
        // Next dimension without touching the ribbon button again.
        await clickWorld(session, { x: 30, y: -22 });
        const next = await waitForEditor(session);
        assert.equal(next.value, "16", "circle auto-detected as 直径 (2r)");
        assert.equal(
          normalizeStatus(await statusText(session)),
          "直径:输入数值后按 Enter",
          "second dimension reuses the active mode",
        );
        await escape(session);
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "Escape closes the editor and the mode",
        );
        return {
          value: constraint.value,
          solved: lengthOf(byId(after, "edge")),
        };
      },
    );

    await check(
      "Rejected value keeps the editor open with .toast.error and no document mutation",
      async () => {
        await activate(session);
        await resetDialogLog(session);
        await clickWorld(session, { x: -25, y: -30 });
        await placeDimension(session, { x: 0, y: -42 });
        const editor = await waitForEditor(session);
        assert.equal(editor.value, "25", "existing length prefilled");
        const before = await stored(session);
        const mark = await toastMark(session);
        const outcome = await commitEditor(session, "99");
        assert.equal(
          outcome.closed,
          false,
          "rejected value keeps the editor open",
        );
        assert(
          /已经存在|不适用|不存在/.test(outcome.toast),
          `duplicate rejected with an error toast: ${outcome.toast}`,
        );
        const rejectionEvidence = {
          toast: outcome.toast,
          current: await readToast(session),
          logged: await toastsSince(session, mark),
        };
        assert(
          (await toastsSince(session, mark)).some((toast) => toast.error) ||
            rejectionEvidence.current?.error,
          `rejection raised a fresh error toast ${JSON.stringify(rejectionEvidence)}`,
        );
        assert.equal(
          await editorInput(session).inputValue(),
          "99",
          "rejected value stays for correction",
        );
        assert.deepEqual(await stored(session), before, "document unchanged");
        await assertNoDialog(session, "rejected dimension value");
        await escape(session);
        assert.equal(
          await editorOpen(session),
          false,
          "Escape closes the editor",
        );
        return { toast: outcome.toast };
      },
    );

    await check(
      "Blur cancels the inline editor without committing",
      async () => {
        await activate(session);
        await clickWorld(session, { x: 30, y: -22 });
        await waitForEditor(session);
        const before = await stored(session);
        await editorInput(session).fill("33");
        await session.page.locator(".panel-heading").first().click();
        await settle(session);
        await editorInput(session).waitFor({
          state: "detached",
          timeout: 5000,
        });
        assert.deepEqual(
          await stored(session),
          before,
          "blur cancel leaves the document",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "blur cancel also leaves dimension mode",
        );
        return { cancelled: true };
      },
    );

    await check(
      "Flow C: selected entity row plus 尺寸 previews before blank placement",
      async () => {
        await session.page.locator('.entity-row[title="hole"]').click();
        await settle(session);
        assert(
          await session.page
            .locator('.entity-row[title="hole"]')
            .evaluate((element) => element.classList.contains("selected")),
          "entity row selected in the browser panel",
        );
        await resetDialogLog(session);
        await activate(session);
        const editor = await waitForEditor(session);
        assert.equal(
          editor.value,
          "16",
          "diameter prefilled from the selection",
        );
        assert.equal(
          normalizeStatus(await statusText(session)),
          "直径:输入数值后按 Enter",
          "selection resolved as 直径",
        );
        await assertNoDialog(session, "Flow C selection dimension");
        await escape(session);
        return { value: editor.value };
      },
    );

    await check(
      "Flow D: double-click edits the driving value; Escape leaves geometry unchanged",
      async () => {
        const labelPoint = async (text) => {
          await session.page.waitForFunction(
            (needle) =>
              document
                .querySelector('[data-testid="cad-canvas"]')
                ?.__cadViewport?.dimensions.some(
                  (dimension) => dimension.text === needle,
                ),
            String(text),
            { timeout: 5000 },
          );
          const state = await metadata(session);
          const dimension = state.dimensions.find(
            (item) => item.text === String(text),
          );
          assert(dimension, `dimension label ${text} rendered on the canvas`);
          const box = await session.canvas.boundingBox();
          return {
            x: box.x + (dimension.bounds.minX + dimension.bounds.maxX) / 2,
            y: box.y + (dimension.bounds.minY + dimension.bounds.maxY) / 2,
          };
        };
        const target = await labelPoint("25");
        const beforeEdit = constraintOf(await stored(session), "length");
        await resetDialogLog(session);
        await session.page.mouse.dblclick(target.x, target.y);
        const editor = await waitForEditor(session);
        assert.equal(editor.value, "25", "existing value prefilled");
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "saved-label edit does not enter placement",
        );
        await assertNoDialog(session, "double-click dimension edit");
        const outcome = await commitEditor(session, "30");
        assert(outcome.closed, `edit committed (toast: ${outcome.toast})`);
        const edited = await stored(session);
        const constraint = sketchOf(edited).constraints.find(
          (item) => item.kind === "length" && item.refs.includes("edge"),
        );
        assert.equal(constraint.value, 30, "driving value updated");
        assert.deepEqual(
          constraint.labelPosition,
          beforeEdit.labelPosition,
          "double-click edit retains the placed label",
        );
        assert(
          Math.abs(lengthOf(byId(edited, "edge")) - 30) < 1e-5,
          `geometry follows the edited dimension (${lengthOf(byId(edited, "edge"))})`,
        );
        const again = await labelPoint("30");
        await session.page.mouse.dblclick(again.x, again.y);
        const second = await waitForEditor(session);
        assert.equal(
          second.value,
          "30",
          "re-opened editor shows the current value",
        );
        await editorInput(session).fill("48");
        await escape(session);
        assert.equal(
          await editorOpen(session),
          false,
          "Escape closes the editor",
        );
        assert.deepEqual(
          await stored(session),
          edited,
          "Escape leaves the committed geometry unchanged",
        );
        return {
          value: constraint.value,
          length: lengthOf(byId(edited, "edge")),
        };
      },
    );

    await check(
      "Escape, tool switching and 修剪/偏移 all leave dimension mode",
      async () => {
        await activate(session);
        await escape(session);
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "Escape exits",
        );
        await activate(session);
        await session.page.locator('button[title="直线"]').click();
        await settle(session);
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "switching to the line tool exits dimension mode",
        );
        assert(
          await session.page
            .locator('button[title="直线"]')
            .evaluate((element) => element.classList.contains("selected")),
          "line tool is the active tool",
        );
        // A body click must no longer open the dimension editor.
        await clickWorld(session, { x: -25, y: -30 });
        assert.equal(
          await editorOpen(session),
          false,
          "no inline editor once dimension mode has been left",
        );
        await escape(session);
        await activate(session);
        await session.page.locator('button[title="修剪"]').click();
        await settle(session);
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "修剪 exits dimension mode",
        );
        assert(
          await session.page
            .locator('button[title="修剪"]')
            .evaluate((element) => element.classList.contains("selected")),
          "修剪 entered its pick operation",
        );
        await escape(session);
        // 偏移 opens its own parameter dialog when something is selected, so
        // clear the selection first: the assertion below covers dimension
        // actions only.
        await session.page.locator('button[title="选择"]').click();
        await settle(session);
        await clickWorld(session, { x: -40, y: -38 });
        assert.equal(
          await session.page.locator(".entity-row.selected").count(),
          0,
          "selection cleared before 偏移",
        );
        await activate(session);
        await session.page.locator('button[title="偏移"]').click();
        await settle(session);
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "偏移 exits dimension mode",
        );
        assert.equal(
          await session.page.locator(".dialog").count(),
          0,
          "偏移 without a selection opens no dialog",
        );
        await escape(session);
        await assertNoDialog(session, "tool switching");
        return { tools: ["直线", "修剪", "偏移"] };
      },
    );
  });

  /* ------------------------------------------------- Flow B (point pairs) */
  await suite(MAIN, {}, async (session) => {
    await check(
      "Flow B: point pairs, rubber band draft and axis auto-detection",
      async () => {
        const cases = [
          {
            name: "horizontal pair",
            first: "pairX_p0",
            second: "pairX_p1",
            kind: "水平距离",
            value: "30",
          },
          {
            name: "vertical pair",
            first: "pairY_p0",
            second: "pairY_p1",
            kind: "垂直距离",
            value: "30",
          },
          {
            // Cross-entity diagonal pair: the corridor is empty canvas, so the
            // dashed draft guide is the only teal ink along it.
            name: "diagonal pair",
            first: "edge_p1",
            second: "pairX_p0",
            kind: "长度",
            value: fmt(Math.hypot(40, 40)),
            bandBaseline: true,
          },
        ];
        const samples = [];
        for (const item of cases) {
          await reseed(session, MAIN);
          const before = await stored(session);
          await activate(session);
          const first = await handlePoint(session, item.first);
          const second = await handlePoint(session, item.second);
          const cursor = {
            x:
              first.local.x +
              (second.local.x - first.local.x) * 0.55 +
              (item.kind === "垂直距离" ? -28 : 0),
            y:
              first.local.y +
              (second.local.y - first.local.y) * 0.55 +
              (item.kind === "水平距离" ? 48 : 0),
          };
          let clean = null;
          if (item.bandBaseline) {
            // Same cursor position before the pick: the corridor must be clean.
            await session.page.mouse.move(first.x, first.y);
            await settle(session);
            await session.page.mouse.move(
              first.box.x + cursor.x,
              first.box.y + cursor.y,
            );
            await settle(session);
            clean = await rubberBand(session, first.local, cursor);
          }
          await clickPoint(session, first);
          assert.equal(
            await editorOpen(session),
            false,
            `${item.name}: first point does not open the editor`,
          );
          assert.equal(
            normalizeStatus(await statusText(session)),
            "尺寸:请选择第二个点",
            `${item.name}: status asks for the second point`,
          );
          await session.page.mouse.move(
            first.box.x + cursor.x,
            first.box.y + cursor.y,
          );
          await settle(session);
          const band = await rubberBand(session, first.local, cursor);
          assert(
            band.samples >= 8,
            `${item.name}: rubber band corridor sampled (${JSON.stringify(band)})`,
          );
          assert(
            band.ratio >= 0.3 && band.teal > 0,
            `${item.name}: dashed canvas draft guide along the corridor ${JSON.stringify(band)}`,
          );
          if (clean)
            assert.equal(
              clean.teal,
              0,
              `${item.name}: no guide before the first pick (${JSON.stringify(clean)})`,
            );
          if (item.bandBaseline)
            await session.page.screenshot({
              path: path.join(output, "desktop-rubber-band.png"),
            });
          await session.page.mouse.move(second.x, second.y);
          await settle(session);
          const previewKind = {
            水平距离: "distanceX",
            垂直距离: "distanceY",
            长度: "length",
          }[item.kind];
          const expectedPreview = {
            kind: previewKind,
            refs: [item.first, item.second],
            value: Number(item.value),
          };
          const hover = await assertPreview(
            session,
            expectedPreview,
            `${item.name}: hover second point`,
          );
          assert.equal(
            await editorOpen(session),
            false,
            `${item.name}: hover opens no editor`,
          );
          assert.deepEqual(
            await stored(session),
            before,
            `${item.name}: hover leaves the document`,
          );
          await hoverWorld(session, { x: 0, y: -10 });
          assert.equal(
            (await metadata(session)).dimensionPreview,
            null,
            `${item.name}: leaving point restores rubber band`,
          );
          await clickPoint(session, second);
          await assertPreview(
            session,
            expectedPreview,
            `${item.name}: confirmed point pair`,
          );
          assert.equal(
            await editorOpen(session),
            false,
            `${item.name}: second point still requires placement`,
          );
          assert.deepEqual(
            await stored(session),
            before,
            `${item.name}: confirming points does not create a constraint`,
          );
          const placement = await placeDimension(session);
          const editor = placement.editor;
          assert.equal(
            editor.value,
            item.value,
            `${item.name}: prefilled value`,
          );
          assert.equal(
            normalizeStatus(await statusText(session)),
            `${item.kind}:输入数值后按 Enter`,
            `${item.name}: auto-detected as ${item.kind}`,
          );
          const canvasBox = await session.canvas.boundingBox();
          assertEditorInside(editor.box, canvasBox, `${item.name} editor`);
          await assertNoDialog(session, `${item.name} dimension`);
          await escape(session);
          samples.push({
            name: item.name,
            kind: item.kind,
            value: editor.value,
            clean,
            band,
          });
        }
        return { samples };
      },
    );
  });

  /* ------------------------------------------- auto detection and rejection */
  await suite(DETECT, {}, async (session) => {
    await check(
      "Auto detection: line 长度, circle 直径, arc 直径, ellipse rejected with .toast.error",
      async () => {
        const entityAt = (id) =>
          session.fixture.sketches[0].entities.find((e) => e.id === id);
        const detections = [];
        for (const probe of [
          { id: "edge", point: { x: -25, y: -30 }, kind: "长度", value: "40" },
          { id: "hole", point: { x: 30, y: -22 }, kind: "直径", value: "16" },
          {
            id: "corner",
            point: arcBodyPoint(entityAt("corner")),
            kind: "直径",
            value: "28",
          },
        ]) {
          await activate(session);
          await resetDialogLog(session);
          await clickWorld(session, probe.point);
          if (probe.id === "edge") await placeDimension(session);
          const editor = await waitForEditor(session);
          assert.equal(
            editor.value,
            probe.value,
            `${probe.id}: prefilled measured value`,
          );
          assert.equal(
            normalizeStatus(await statusText(session)),
            `${probe.kind}:输入数值后按 Enter`,
            `${probe.id}: detected as ${probe.kind}`,
          );
          await assertNoDialog(session, `${probe.id} detection`);
          await escape(session);
          detections.push({
            id: probe.id,
            kind: probe.kind,
            value: editor.value,
          });
        }
        const before = await stored(session);
        await activate(session);
        await resetDialogLog(session);
        const mark = await toastMark(session);
        await clickWorld(session, ellipseTopPoint(entityAt("oval")));
        assert.equal(
          await editorOpen(session),
          false,
          "ellipse pick must not open the editor",
        );
        const toasts = await toastsSince(session, mark);
        const current = await readToast(session);
        assert(
          current?.error && /不适用/.test(current.text),
          `ellipse rejection toast in the DOM: ${JSON.stringify(current)}`,
        );
        assert(
          toasts.some((toast) => toast.error && /不适用/.test(toast.text)),
          `ellipse rejection message: ${JSON.stringify(toasts)}`,
        );
        assert.deepEqual(
          await stored(session),
          before,
          "rejected ellipse pick mutates nothing",
        );
        await assertNoDialog(session, "ellipse rejection");
        await escape(session);
        return { detections, ellipse: toasts };
      },
    );

    await check(
      "Auto detection: spline pick is rejected with .toast.error and no editor",
      async () => {
        await reseed(session, SPLINE);
        const state = await metadata(session);
        const exclude = state.handles.map((handle) => ({
          x: handle.x,
          y: handle.y,
        }));
        const probe = await inkProbe(session, exclude);
        assert(
          probe.count > 40,
          `spline curve ink located on the canvas frame (${probe.count} pixels)`,
        );
        const box = await session.canvas.boundingBox();
        const before = await stored(session);
        await activate(session);
        await resetDialogLog(session);
        const mark = await toastMark(session);
        await clickPoint(session, {
          x: box.x + probe.sample.x,
          y: box.y + probe.sample.y,
        });
        assert.equal(
          await editorOpen(session),
          false,
          "spline pick opens no editor",
        );
        const toasts = await toastsSince(session, mark);
        const current = await readToast(session);
        assert(
          current?.error && /不适用/.test(current.text),
          `spline rejection toast in the DOM: ${JSON.stringify(current)}`,
        );
        assert(
          toasts.some((toast) => toast.error && /不适用/.test(toast.text)),
          `spline rejection message: ${JSON.stringify(toasts)}`,
        );
        assert.deepEqual(
          await stored(session),
          before,
          "rejected spline pick mutates nothing",
        );
        await assertNoDialog(session, "spline rejection");
        return { probe: { count: probe.count, sample: probe.sample }, toasts };
      },
    );
  });

  /* ------------------------------- lineDistance / angle inference (new) */
  await suite(PAIRS, {}, async (session) => {
    await check(
      "Two parallel lines: selection previews 线间/点线距离, blank click opens input, distance solved",
      async () => {
        await ctrlClickRow(session, "rail-b");
        await ctrlClickRow(session, "rail-a");
        const selected = await session.page
          .locator(".entity-row.selected")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("title")));
        assert.deepEqual(
          selected.sort(),
          ["rail-a", "rail-b"],
          "two rows selected with Ctrl+click",
        );
        await resetDialogLog(session);
        await activate(session);
        await assertPreview(
          session,
          {
            kind: "lineDistance",
            refs: ["rail-b_p0", "rail-a"],
            value: 30,
          },
          "preselected parallel pair",
        );
        await placeDimension(session);
        const editor = await waitForEditor(session);
        const before = await stored(session);
        const distanceBefore = pointLineDistance(
          byId(before, "rail-b").points[0],
          byId(before, "rail-a").points[0],
          byId(before, "rail-a").points[1],
        );
        assert(
          Math.abs(distanceBefore - 30) < 1e-9,
          `fixture perpendicular distance is 30 (${distanceBefore})`,
        );
        assert.equal(
          editor.value,
          "30",
          "editor prefilled with the perpendicular distance",
        );
        assert.equal(
          normalizeStatus(await statusText(session)),
          "线间/点线距离:输入数值后按 Enter",
          "status bar reports the inferred kind",
        );
        const canvasBox = await session.canvas.boundingBox();
        assertEditorInside(editor.box, canvasBox, "lineDistance editor");
        await session.page.screenshot({
          path: path.join(output, "desktop-line-distance-editor.png"),
        });
        await assertNoDialog(session, "lineDistance selection");
        const outcome = await commitEditor(session, "18");
        assert(
          outcome.closed,
          `lineDistance committed (toast: ${outcome.toast})`,
        );
        const after = await stored(session);
        const constraint = constraintOf(after, "lineDistance");
        assert(constraint, "lineDistance constraint created");
        assert.deepEqual(
          constraint.refs,
          ["rail-b_p0", "rail-a"],
          "refs are [first line points[0].id, second line id]",
        );
        assert.equal(constraint.value, 18, "driving value");
        const railA = byId(after, "rail-a");
        const railB = byId(after, "rail-b");
        const parallel = parallelism(railA, railB);
        assert(
          parallel < 1e-6,
          `lines stay parallel (|sin|=${parallel}, angle=${signedAngle(railA, railB)})`,
        );
        const distance = pointLineDistance(
          railB.points[0],
          railA.points[0],
          railA.points[1],
        );
        assert(
          Math.abs(distance - 18) < 1e-4,
          `perpendicular distance solved to 18 (${distance})`,
        );
        assert.equal(
          sketchOf(after).constraints.length,
          2,
          "parallel + lineDistance constraints only",
        );
        return {
          refs: constraint.refs,
          value: constraint.value,
          perpendicularDistance: distance,
          parallelism: parallel,
        };
      },
    );

    await check(
      "lineDistance label on the canvas can be double-clicked and re-driven",
      async () => {
        await reseed(session, PAIRS);
        await ctrlClickRow(session, "rail-b");
        await ctrlClickRow(session, "rail-a");
        await activate(session);
        await placeDimension(session);
        await waitForEditor(session);
        const outcome = await commitEditor(session, "18");
        assert(outcome.closed, `seed dimension committed (${outcome.toast})`);
        await session.page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="cad-canvas"]')
              ?.__cadViewport?.dimensions.some((d) =>
                /^18(\.0+)?$/.test(d.text),
              ),
          undefined,
          { timeout: 5000 },
        );
        const state = await metadata(session);
        const label = state.dimensions.find((item) =>
          /^18(\.0+)?$/.test(item.text),
        );
        assert(label, "lineDistance label rendered on the canvas");
        const box = await session.canvas.boundingBox();
        await session.page.mouse.dblclick(
          box.x + (label.bounds.minX + label.bounds.maxX) / 2,
          box.y + (label.bounds.minY + label.bounds.maxY) / 2,
        );
        const editor = await waitForEditor(session);
        assert.equal(
          editor.value,
          "18",
          "label edit prefilled with the distance",
        );
        const edited = await commitEditor(session, "24");
        assert(edited.closed, `label edit committed (${edited.toast})`);
        const doc = await stored(session);
        const constraint = constraintOf(doc, "lineDistance");
        assert.equal(constraint.value, 24, "edited driving value");
        assert.deepEqual(
          constraint.refs,
          ["rail-b_p0", "rail-a"],
          "refs unchanged",
        );
        const distance = pointLineDistance(
          byId(doc, "rail-b").points[0],
          byId(doc, "rail-a").points[0],
          byId(doc, "rail-a").points[1],
        );
        assert(
          Math.abs(distance - 24) < 1e-4,
          `perpendicular distance follows the label edit (${distance})`,
        );
        assert(
          parallelism(byId(doc, "rail-a"), byId(doc, "rail-b")) < 1e-6,
          "lines stay parallel after the label edit",
        );
        return {
          labelText: label.text,
          value: constraint.value,
          perpendicularDistance: distance,
        };
      },
    );

    await check("Single line pick still infers 长度 (regression)", async () => {
      await reseed(session, PAIRS);
      await activate(session);
      await clickWorld(session, RAIL_A_BODY);
      await assertPreview(
        session,
        {
          kind: "length",
          refs: ["rail-a"],
          value: 60,
        },
        "single line length",
      );
      await placeDimension(session);
      const editor = await waitForEditor(session);
      assert.equal(editor.value, "60", "line length prefilled");
      assert.equal(
        normalizeStatus(await statusText(session)),
        "长度:输入数值后按 Enter",
        "single line still infers 长度",
      );
      await escape(session);
      return { value: editor.value };
    });

    await check(
      "Keyboard D with a selected row does not type the shortcut into the editor",
      async () => {
        await reseed(session, PAIRS);
        const row = session.page.locator('.entity-row[title="rail-a"]');
        await row.click();
        await settle(session);
        assert(
          await row.evaluate((element) =>
            element.classList.contains("selected"),
          ),
          "rail-a row selected before the shortcut",
        );
        assert.equal(
          await session.page.locator("input:focus").count(),
          0,
          "focus is outside a text field before the shortcut",
        );
        await session.page.keyboard.press("d");
        await settle(session);
        assert.equal(
          await editorOpen(session),
          false,
          "keyboard D with a line enters placement",
        );
        await assertPreview(
          session,
          {
            kind: "length",
            refs: ["rail-a"],
            value: 60,
          },
          "keyboard selected line",
        );
        await placeDimension(session);
        const editor = await waitForEditor(session);
        const focused = await editorInput(session).evaluate(
          (element) => element === document.activeElement,
        );
        const measured = lengthOf(byId(session.fixture, "rail-a"));
        assert.equal(
          editor.value,
          fmt(measured),
          `editor prefilled with the measured length (${measured})`,
        );
        assert(
          /^-?[0-9]+(\.[0-9]+)?$/.test(editor.value),
          `shortcut letter must not be typed into the editor (value ${JSON.stringify(editor.value)})`,
        );
        assert(focused, "inline editor input holds the focus");
        assert.equal(
          normalizeStatus(await statusText(session)),
          "长度:输入数值后按 Enter",
          "status bar shows the pending length dimension",
        );
        await escape(session);
        assert.equal(
          await editorOpen(session),
          false,
          "Escape closes the editor",
        );
        return { value: editor.value, focused, expected: fmt(measured) };
      },
    );

    await check(
      "Plain parallel lines: lineDistance auto-adds parallel and keeps the pair parallel",
      async () => {
        await reseed(session, PAIRS_LOOSE);
        await ctrlClickRow(session, "rail-b");
        await ctrlClickRow(session, "rail-a");
        await activate(session);
        await placeDimension(session);
        await waitForEditor(session);
        const outcome = await commitEditor(session, "18");
        assert(outcome.closed, `loose pair committed (${outcome.toast})`);
        const doc = await stored(session);
        const constraint = constraintOf(doc, "lineDistance");
        assert.equal(constraint.value, 18, "loose pair driving value");
        const distance = pointLineDistance(
          byId(doc, "rail-b").points[0],
          byId(doc, "rail-a").points[0],
          byId(doc, "rail-a").points[1],
        );
        assert(
          Math.abs(distance - 18) < 1e-4,
          `loose perpendicular distance solved (${distance})`,
        );
        const residual = parallelism(byId(doc, "rail-a"), byId(doc, "rail-b"));
        const auto = constraintOf(doc, "parallel");
        assert(
          residual < 1e-9,
          `lines stay parallel now that the fix lands (|sin|=${residual})`,
        );
        assert(
          auto,
          `parallel constraint auto-added ${JSON.stringify(sketchOf(doc).constraints)}`,
        );
        return {
          perpendicularDistance: distance,
          parallelism: residual,
          autoParallelRefs: auto.refs,
          angle: signedAngle(byId(doc, "rail-a"), byId(doc, "rail-b")),
          note: "previously drifted to 14.53 degrees; fixed by the auto parallel constraint",
        };
      },
    );

    await check(
      "lineDistance auto-adds parallel for a plain pair (value 9, exact refs)",
      async () => {
        await reseed(session, PAIRS_LOOSE);
        await ctrlClickRow(session, "rail-b");
        await ctrlClickRow(session, "rail-a");
        await activate(session);
        await placeDimension(session);
        const editor = await waitForEditor(session);
        assert.equal(editor.value, "30", "prefilled perpendicular distance");
        const outcome = await commitEditor(session, "9");
        assert(outcome.closed, `committed (${outcome.toast})`);
        const doc = await stored(session);
        const constraints = sketchOf(doc).constraints;
        const distance = constraintOf(doc, "lineDistance");
        assert(distance, "lineDistance created");
        assert.deepEqual(
          distance.refs,
          ["rail-b_p0", "rail-a"],
          "lineDistance refs are [first line points[0].id, second line id]",
        );
        assert.equal(distance.value, 9, "lineDistance value");
        const parallel = constraintOf(doc, "parallel");
        assert(
          parallel,
          `parallel constraint created ${JSON.stringify(constraints)}`,
        );
        assert.deepEqual(
          [...parallel.refs].sort(),
          ["rail-a", "rail-b"],
          "parallel refs are the two line ids",
        );
        assert.equal(
          constraints.length,
          2,
          `exactly lineDistance + parallel added ${JSON.stringify(constraints.map((c) => c.kind))}`,
        );
        const residual = parallelism(byId(doc, "rail-a"), byId(doc, "rail-b"));
        assert(residual < 1e-9, `|sin(theta)| < 1e-9 (${residual})`);
        const measured = pointLineDistance(
          byId(doc, "rail-b").points[0],
          byId(doc, "rail-a").points[0],
          byId(doc, "rail-a").points[1],
        );
        assert(
          Math.abs(measured - 9) < 1e-4,
          `perpendicular distance = 9 (${measured})`,
        );
        return {
          lineDistance: { refs: distance.refs, value: distance.value },
          parallel: { refs: parallel.refs },
          residual,
          measured,
          kinds: constraints.map((c) => c.kind),
        };
      },
    );

    await check(
      "Direction-locked parallel lines get no duplicate parallel constraint",
      async () => {
        await reseed(session, LOCKED);
        assert.deepEqual(
          sketchOf(await stored(session)).constraints.map((c) => c.kind),
          ["horizontal", "horizontal"],
          "fixture starts with one horizontal constraint per line",
        );
        await ctrlClickRow(session, "rail-b");
        await ctrlClickRow(session, "rail-a");
        await activate(session);
        await placeDimension(session);
        const editor = await waitForEditor(session);
        assert.equal(editor.value, "30", "prefilled perpendicular distance");
        const outcome = await commitEditor(session, "9");
        assert(outcome.closed, `committed (${outcome.toast})`);
        const doc = await stored(session);
        const kinds = sketchOf(doc).constraints.map((c) => c.kind);
        assert(
          !kinds.includes("parallel"),
          `no duplicate parallel constraint ${JSON.stringify(kinds)}`,
        );
        assert.equal(
          kinds.filter((kind) => kind === "lineDistance").length,
          1,
          `one lineDistance added ${JSON.stringify(kinds)}`,
        );
        assert.equal(
          kinds.length,
          3,
          `only lineDistance added to the two horizontals ${JSON.stringify(kinds)}`,
        );
        const distance = constraintOf(doc, "lineDistance");
        assert.deepEqual(
          distance.refs,
          ["rail-b_p0", "rail-a"],
          "lineDistance refs",
        );
        assert.equal(distance.value, 9, "lineDistance value");
        const residual = parallelism(byId(doc, "rail-a"), byId(doc, "rail-b"));
        assert(residual < 1e-9, `still parallel (|sin|=${residual})`);
        const measured = pointLineDistance(
          byId(doc, "rail-b").points[0],
          byId(doc, "rail-a").points[0],
          byId(doc, "rail-a").points[1],
        );
        assert(
          Math.abs(measured - 9) < 1e-4,
          `perpendicular distance = 9 (${measured})`,
        );
        return { kinds, residual, measured };
      },
    );

    await check(
      "尺寸类型 线间/点线距离 then two line picks creates lineDistance",
      async () => {
        await reseed(session, PAIRS);
        const before = await stored(session);
        const select = kindSelect(session);
        await select.selectOption("lineDistance");
        await settle(session);
        assert.equal(
          await select.inputValue(),
          "lineDistance",
          "combobox is controlled on 线间/点线距离",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "choosing a type activates dimension mode",
        );
        assert.equal(
          await session.page.locator(".entity-row.selected").count(),
          0,
          "nothing is selected",
        );
        const first = await pickObserve(session, RAIL_A_BODY, "rail-a body");
        assert.equal(
          first.editor,
          null,
          `first line pick must not open the editor ${JSON.stringify(first)}`,
        );
        assert(first.modeActive, "dimension mode stays active after one line");
        assert(
          /请选择/.test(first.status),
          `status bar asks for the second line: ${first.status}`,
        );
        await hoverWorld(session, RAIL_B_BODY);
        await assertPreview(
          session,
          {
            kind: "lineDistance",
            refs: ["rail-a_p0", "rail-b"],
            value: 30,
          },
          "fixed distance hover",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "fixed distance hover opens no editor",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "fixed distance hover changes no document",
        );
        const second = await pickObserve(session, RAIL_B_BODY, "rail-b body");
        assert.equal(second.editor, null, "second line confirms without input");
        await assertPreview(
          session,
          {
            kind: "lineDistance",
            refs: ["rail-a_p0", "rail-b"],
            value: 30,
          },
          "fixed distance confirmed pair",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "confirmed pair changes no document",
        );
        const { editor } = await placeDimension(session);
        assert.equal(
          editor.value,
          "30",
          `prefilled perpendicular distance ${JSON.stringify({ first, second })}`,
        );
        assert.equal(
          normalizeStatus(await statusText(session)),
          "线间/点线距离:输入数值后按 Enter",
          "status bar reports 线间/点线距离 once both lines are picked",
        );
        const outcome = await commitEditor(session, "18");
        assert(
          outcome.closed,
          `forced lineDistance committed (${outcome.toast})`,
        );
        const doc = await stored(session);
        const constraint = constraintOf(doc, "lineDistance");
        assert(constraint, "forced lineDistance constraint created");
        assert.deepEqual(
          constraint.refs,
          ["rail-a_p0", "rail-b"],
          "forced refs are [first line points[0].id, second line id]",
        );
        assert.equal(constraint.value, 18, "forced driving value");
        const distance = pointLineDistance(
          byId(doc, "rail-b").points[0],
          byId(doc, "rail-a").points[0],
          byId(doc, "rail-a").points[1],
        );
        assert(
          Math.abs(distance - 18) < 1e-4,
          `forced perpendicular distance solved (${distance})`,
        );
        assert(
          parallelism(byId(doc, "rail-a"), byId(doc, "rail-b")) < 1e-6,
          "forced pair stays parallel",
        );
        return {
          firstPick: {
            editor: first.editor,
            toasts: first.toasts,
            status: first.status,
          },
          editor: editor.value,
          refs: constraint.refs,
          perpendicularDistance: distance,
        };
      },
    );

    await check(
      "Two intersecting lines: selection previews 角度, placement opens the signed-angle input",
      async () => {
        // Fresh page: the combobox must be back on 自动 so the kind is inferred.
        await reseed(session, PAIRS);
        assert.equal(
          await kindSelect(session).inputValue(),
          "auto",
          "combobox back on 自动 before the inference check",
        );
        await ctrlClickRow(session, "slant-a");
        await ctrlClickRow(session, "slant-b");
        const before = await stored(session);
        const expected = signedAngle(
          byId(before, "slant-a"),
          byId(before, "slant-b"),
        );
        assert(
          Math.abs(expected - 45) < 1e-9,
          `fixture angle is 45 degrees (${expected})`,
        );
        await resetDialogLog(session);
        await activate(session);
        await assertPreview(
          session,
          {
            kind: "angle",
            refs: ["slant-a", "slant-b"],
            value: 45,
          },
          "preselected angle pair",
        );
        await placeDimension(session);
        const editor = await waitForEditor(session);
        assert.equal(
          editor.value,
          fmt(expected),
          `angle prefilled with the signed angle (${expected})`,
        );
        assert.equal(
          normalizeStatus(await statusText(session)),
          "角度:输入数值后按 Enter",
          "status bar reports 角度",
        );
        await assertNoDialog(session, "angle selection");
        const outcome = await commitEditor(session, "60");
        assert(outcome.closed, `angle committed (${outcome.toast})`);
        const after = await stored(session);
        const constraint = constraintOf(after, "angle");
        assert(constraint, "angle constraint created");
        assert.deepEqual(
          constraint.refs,
          ["slant-a", "slant-b"],
          "angle refs are the two selected lines",
        );
        assert.equal(constraint.value, 60, "angle driving value");
        const measured = signedAngle(
          byId(after, "slant-a"),
          byId(after, "slant-b"),
        );
        assert(
          Math.abs(measured - 60) < 1e-3,
          `measured angle follows the dimension (${measured})`,
        );
        return {
          prefilled: editor.value,
          value: constraint.value,
          measured,
          refs: constraint.refs,
        };
      },
    );

    await check(
      "尺寸类型 角度 then two line picks creates a two-line angle",
      async () => {
        await reseed(session, PAIRS);
        const before = await stored(session);
        const select = kindSelect(session);
        await select.selectOption("angle");
        await settle(session);
        assert.equal(
          await select.inputValue(),
          "angle",
          "combobox is controlled on 角度",
        );
        assert.equal(
          await session.page.locator(".entity-row.selected").count(),
          0,
          "nothing is selected",
        );
        const first = await pickObserve(session, SLANT_A_BODY, "slant-a body");
        assert.equal(
          first.editor,
          null,
          `first line pick must not open the editor ${JSON.stringify(first)}`,
        );
        assert(first.modeActive, "dimension mode stays active after one line");
        assert(
          /请选择/.test(first.status),
          `status bar asks for the second line: ${first.status}`,
        );
        await hoverWorld(session, SLANT_B_BODY);
        await assertPreview(
          session,
          {
            kind: "angle",
            refs: ["slant-a", "slant-b"],
            value: 45,
          },
          "fixed angle hover",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "fixed angle hover opens no editor",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "fixed angle hover changes no document",
        );
        const second = await pickObserve(session, SLANT_B_BODY, "slant-b body");
        assert.equal(second.editor, null, "second line confirms without input");
        await assertPreview(
          session,
          {
            kind: "angle",
            refs: ["slant-a", "slant-b"],
            value: 45,
          },
          "fixed angle confirmed pair",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "confirmed angle changes no document",
        );
        const { editor } = await placeDimension(session);
        assert.equal(
          editor.value,
          "45",
          `prefilled two-line angle ${JSON.stringify({ first, second })}`,
        );
        const outcome = await commitEditor(session, "60");
        assert(outcome.closed, `forced angle committed (${outcome.toast})`);
        const doc = await stored(session);
        const constraint = constraintOf(doc, "angle");
        assert(constraint, "forced angle constraint created");
        assert.deepEqual(
          constraint.refs,
          ["slant-a", "slant-b"],
          "forced angle refs must be the two picked lines",
        );
        const measured = signedAngle(
          byId(doc, "slant-a"),
          byId(doc, "slant-b"),
        );
        assert(
          Math.abs(measured - 60) < 1e-3,
          `forced two-line angle solved (${measured})`,
        );
        return {
          firstPick: {
            editor: first.editor,
            toasts: first.toasts,
            status: first.status,
          },
          editor: editor.value,
          refs: constraint.refs,
          measured,
        };
      },
    );

    await check(
      "Auto mode two line picks confirm distance without input until blank placement",
      async () => {
        await reseed(session, PAIRS);
        const before = await stored(session);
        await activate(session);
        const first = await pickObserve(session, RAIL_A_BODY);
        assert.equal(first.editor, null, "auto first line opens no editor");
        await assertPreview(
          session,
          {
            kind: "length",
            refs: ["rail-a"],
            value: 60,
          },
          "auto first line",
        );
        const second = await pickObserve(session, RAIL_B_BODY);
        assert.equal(
          second.editor,
          null,
          "auto second line still opens no editor",
        );
        await assertPreview(
          session,
          {
            kind: "lineDistance",
            refs: ["rail-a_p0", "rail-b"],
            value: 30,
          },
          "auto confirmed pair",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "auto picks do not add constraints",
        );
        const placement = await placeDimension(session);
        assert.equal(
          placement.editor.value,
          "30",
          "blank placement opens auto distance input",
        );
        await escape(session);
        return { first, second, placement: placement.point.world };
      },
    );
  });

  /* ----------------------------------------------- line placement previews */
  await suite(PAIRS_LABELLED, {}, async (session) => {
    for (const item of [
      {
        name: "parallel",
        firstId: "rail-a",
        first: RAIL_A_BODY,
        length: 60,
        secondId: "rail-b",
        second: RAIL_B_BODY,
        kind: "lineDistance",
        refs: ["rail-a_p0", "rail-b"],
        value: 30,
        other: SLANT_B_BODY,
      },
      {
        name: "nonparallel",
        firstId: "slant-a",
        first: SLANT_A_BODY,
        length: 40,
        secondId: "slant-b",
        second: SLANT_B_BODY,
        kind: "angle",
        refs: ["slant-a", "slant-b"],
        value: 45,
        other: RAIL_A_BODY,
      },
    ]) {
      await check(
        `Auto ${item.name} hover is temporary; confirmed pair awaits blank placement`,
        async () => {
          await reseed(session, PAIRS_LABELLED);
          const before = await stored(session);
          const base = await metadata(session);
          assert(
            base.dimensions.length > 0,
            "fixture has an existing saved dimension",
          );
          assert.equal(
            base.dimensionPreview,
            null,
            "no preview before activation",
          );
          const baseInk = await dimensionInk(session);
          await activate(session);
          await clickWorld(session, item.first);
          const lengthPreview = {
            kind: "length",
            refs: [item.firstId],
            value: item.length,
          };
          const first = await assertPreview(
            session,
            lengthPreview,
            "first line body",
          );
          assert.equal(
            await editorOpen(session),
            false,
            "first body click opens no editor",
          );
          assert.deepEqual(
            (await metadata(session)).dimensions,
            base.dimensions,
            "length preview is separate from saved labels",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "first body pick changes no document",
          );
          const ink = await dimensionInk(session);
          assert(
            ink.teal > baseInk.teal,
            `visible teal preview ink ${JSON.stringify({ baseInk, ink })}`,
          );
          await hoverWorld(session, item.first);
          await assertPreview(
            session,
            lengthPreview,
            "hovering the same line keeps length",
          );
          const selectedBefore = await session.page
            .locator(".entity-row.selected")
            .evaluateAll((rows) =>
              rows.map((row) => row.getAttribute("title")),
            );
          const pairPreview = {
            kind: item.kind,
            refs: item.refs,
            value: item.value,
          };
          await hoverWorld(session, item.second);
          const hovered = await assertPreview(
            session,
            pairPreview,
            "hover candidate line",
          );
          assert.equal(
            await editorOpen(session),
            false,
            "hover candidate opens no editor",
          );
          assert.deepEqual(
            await session.page
              .locator(".entity-row.selected")
              .evaluateAll((rows) =>
                rows.map((row) => row.getAttribute("title")),
              ),
            selectedBefore,
            "hover does not change selection",
          );
          assert.equal(
            await session.page
              .locator(`.entity-row[title=${JSON.stringify(item.secondId)}]`)
              .evaluate((row) => row.classList.contains("selected")),
            false,
            "hover candidate is not selected",
          );
          assert.deepEqual(
            (await metadata(session)).dimensions,
            base.dimensions,
            "candidate preview is not added to dimensions[]",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "hover changes no document",
          );
          await session.page.screenshot({
            path: path.join(output, `desktop-${item.name}-hover-preview.png`),
          });
          await hoverWorld(session, { x: 0, y: -10 });
          await assertPreview(
            session,
            lengthPreview,
            "leaving candidate restores first length",
          );
          await hoverWorld(session, item.second);
          const box = await session.canvas.boundingBox();
          await session.page.mouse.move(box.x - 8, box.y + box.height * 0.45);
          await settle(session);
          await assertPreview(
            session,
            lengthPreview,
            "canvas pointer leave restores first length",
          );
          await clickWorld(session, item.second);
          const confirmed = await assertPreview(
            session,
            pairPreview,
            "click confirms pair",
          );
          assert.equal(
            await editorOpen(session),
            false,
            "confirmed pair still has no editor",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "pair confirmation changes no document",
          );
          await hoverWorld(session, item.other);
          await assertPreview(
            session,
            pairPreview,
            "confirmed pair survives a different hover",
          );
          const placement = await placeDimension(session);
          assert.equal(
            placement.editor.value,
            String(item.value),
            "blank click opens measured pair value",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "blank click only opens the editor",
          );
          assert.deepEqual(
            (await metadata(session)).dimensions,
            base.dimensions,
            "fixed preview stays separate from saved labels",
          );
          await editorInput(session).fill("22");
          for (const target of [item.second, item.other, { x: 12, y: 4 }]) {
            await hoverWorld(session, target);
            const fixed = await assertPreview(
              session,
              {
                kind: item.kind,
                refs: item.refs,
                fixed: true,
              },
              "editor-open pointer movement",
            );
            assertPointClose(
              fixed,
              placement.preview,
              "fixed label survives pointer movement",
            );
            assert.deepEqual(
              (await editorSnapshot(session)).box,
              placement.editor.box,
              "editor stays at the placed label",
            );
          }
          assert.deepEqual(
            await stored(session),
            before,
            "typing and pointer motion do not commit",
          );
          await escape(session);
          assert.equal(
            (await metadata(session)).dimensionPreview,
            null,
            "Escape clears the placement preview",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "Escape cancels without document changes",
          );
          await assertNoDialog(session, `${item.name} hover placement`);
          return {
            first,
            hovered,
            confirmed,
            placement: placement.point.world,
            ink,
          };
        },
      );
    }
  });

  /* ----------------------------------------- placed label Enter and reload */
  await suite(PAIRS, {}, async (session) => {
    await check(
      "Delete clears preselected dimension refs and allows another pick",
      async () => {
        await reseed(session, PAIRS);
        await session.page.locator('.entity-row[title="rail-a"]').click();
        await activate(session);
        await assertPreview(
          session,
          { kind: "length", refs: ["rail-a"], value: 60 },
          "preselected line before delete",
        );
        await session.page.keyboard.press("Delete");
        await settle(session);
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "delete clears preview",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "delete exits dimension mode",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "delete leaves no editor",
        );
        assert(
          !(await stored(session)).sketches[0].entities.some(
            (item) => item.id === "rail-a",
          ),
          "picked geometry deleted",
        );
        await activate(session);
        await clickWorld(session, RAIL_B_BODY);
        await assertPreview(
          session,
          { kind: "length", refs: ["rail-b"], value: 40 },
          "fresh reference after delete",
        );
        await escape(session);
        await reseed(session, PAIRS);
        return { cleared: true };
      },
    );
    await check(
      "Undo and redo clear pending dimension refs and allow a fresh pick",
      async () => {
        const before = await stored(session);
        await activate(session);
        await clickWorld(session, RAIL_A_BODY);
        await placeDimension(session);
        const outcome = await commitEditor(session, "48");
        assert(outcome.closed, `seed dimension committed (${outcome.toast})`);
        const committed = await stored(session);
        await clickWorld(session, RAIL_B_BODY);
        await assertPreview(
          session,
          { kind: "length", refs: ["rail-b"], value: 40 },
          "preview before undo",
        );
        await session.page.keyboard.press("Control+z");
        await settle(session);
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "undo clears the pending preview",
        );
        assert.equal(await editorOpen(session), false, "undo leaves no editor");
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "undo exits dimension mode",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "undo restores the pre-dimension document",
        );
        await session.page.keyboard.press("Control+Shift+z");
        await settle(session);
        assert.deepEqual(
          await stored(session),
          committed,
          "redo restores the committed dimension",
        );
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "redo leaves no stale refs",
        );
        assert.equal(await editorOpen(session), false, "redo leaves no editor");
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "redo leaves dimension mode inactive",
        );
        await activate(session);
        await clickWorld(session, RAIL_B_BODY);
        await assertPreview(
          session,
          { kind: "length", refs: ["rail-b"], value: 40 },
          "fresh pick after redo",
        );
        await escape(session);
        return { restored: true };
      },
    );
    for (const item of [
      {
        kind: "lineDistance",
        firstId: "rail-a",
        second: RAIL_B_BODY,
        refs: ["rail-a_p0", "rail-b"],
        value: 30,
      },
      {
        kind: "angle",
        firstId: "slant-a",
        second: SLANT_B_BODY,
        refs: ["slant-a", "slant-b"],
        value: 45,
      },
    ]) {
      await check(
        `Fixed ${item.kind} with one preselected line still awaits second and blank click`,
        async () => {
          await reseed(session, PAIRS);
          const before = await stored(session);
          await session.page
            .locator(`.entity-row[title=${JSON.stringify(item.firstId)}]`)
            .click();
          await kindSelect(session).selectOption(item.kind);
          await settle(session);
          assert.equal(
            (await modeState(session)).pressed,
            "true",
            "fixed mode activates from selection",
          );
          assert.equal(
            await editorOpen(session),
            false,
            "one preselected line has no editor",
          );
          await clickWorld(session, { x: 0, y: -10 });
          assert.equal(
            await editorOpen(session),
            false,
            "blank cannot complete an incomplete fixed pair",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "incomplete fixed pair does not mutate the document",
          );
          await hoverWorld(session, item.second);
          await assertPreview(
            session,
            item,
            "fixed preselection candidate hover",
          );
          assert.equal(
            await editorOpen(session),
            false,
            "fixed preselection hover opens no editor",
          );
          await clickWorld(session, item.second);
          await assertPreview(
            session,
            item,
            "fixed preselection confirmed pair",
          );
          assert.equal(
            await editorOpen(session),
            false,
            "fixed preselection pair awaits placement",
          );
          const placement = await placeDimension(session);
          assert.equal(
            placement.editor.value,
            String(item.value),
            "blank placement opens the completed pair",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "opening fixed preselection editor does not commit",
          );
          await escape(session);
          assert.equal(
            (await metadata(session)).dimensionPreview,
            null,
            "cancel clears fixed preselection preview",
          );
          return {
            kind: item.kind,
            refs: item.refs,
            placement: placement.point.world,
          };
        },
      );
    }
    for (const item of [
      {
        name: "line length",
        fixture: PAIRS,
        first: RAIL_A_BODY,
        kind: "length",
        refs: ["rail-a"],
        measured: 60,
        value: 48,
      },
      {
        name: "line distance",
        fixture: PAIRS,
        first: RAIL_A_BODY,
        second: RAIL_B_BODY,
        kind: "lineDistance",
        refs: ["rail-a_p0", "rail-b"],
        measured: 30,
        value: 18,
      },
      {
        name: "two-line angle",
        fixture: PAIRS,
        first: SLANT_A_BODY,
        second: SLANT_B_BODY,
        kind: "angle",
        refs: ["slant-a", "slant-b"],
        measured: 45,
        value: 60,
      },
      {
        name: "horizontal point pair",
        fixture: MAIN,
        firstPoint: "pairX_p0",
        secondPoint: "pairX_p1",
        kind: "distanceX",
        refs: ["pairX_p0", "pairX_p1"],
        measured: 30,
        value: 24,
      },
      {
        name: "vertical point pair",
        fixture: MAIN,
        firstPoint: "pairY_p0",
        secondPoint: "pairY_p1",
        kind: "distanceY",
        refs: ["pairY_p0", "pairY_p1"],
        measured: 30,
        value: 24,
      },
      {
        name: "diagonal point pair",
        fixture: MAIN,
        firstPoint: "edge_p1",
        secondPoint: "pairX_p0",
        kind: "length",
        refs: ["edge_p1", "pairX_p0"],
        measured: Number(fmt(Math.hypot(40, 40))),
        value: 48,
      },
    ]) {
      await check(
        `Placed ${item.name} persists world labelPosition through Enter and reload`,
        async () => {
          await reseed(session, item.fixture);
          const before = await stored(session);
          await activate(session);
          if (item.firstPoint) await clickHandle(session, item.firstPoint);
          else await clickWorld(session, item.first);
          assert.equal(
            await editorOpen(session),
            false,
            "first pick has no editor",
          );
          if (item.secondPoint) await clickHandle(session, item.secondPoint);
          else if (item.second) await clickWorld(session, item.second);
          await assertPreview(
            session,
            {
              kind: item.kind,
              refs: item.refs,
              value: item.measured,
            },
            "geometry complete before placement",
          );
          assert.equal(
            await editorOpen(session),
            false,
            "completed geometry still has no editor",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "completed picks leave the document unchanged",
          );
          const placement = await placeDimension(session);
          assert.deepEqual(
            await stored(session),
            before,
            "placement alone does not create a constraint",
          );
          await editorInput(session).fill(String(item.value));
          await hoverWorld(session, { x: 12, y: 4 });
          const fixed = await assertPreview(
            session,
            {
              kind: item.kind,
              refs: item.refs,
              fixed: true,
            },
            "typed value with pointer motion",
          );
          assertPointClose(
            fixed,
            placement.preview,
            "typed-value label stays fixed",
          );
          const outcome = await commitEditor(session, item.value);
          assert(
            outcome.closed,
            `Enter commits placed dimension (${outcome.toast})`,
          );
          const after = await stored(session);
          const constraint = sketchOf(after).constraints.find(
            (candidate) =>
              candidate.kind === item.kind &&
              JSON.stringify(candidate.refs) === JSON.stringify(item.refs),
          );
          assert(constraint, "constraint uses the preview's normalized refs");
          assert.equal(
            constraint.value,
            item.value,
            "typed driving value persisted",
          );
          assertPointClose(
            constraint.labelPosition,
            placement.point.world,
            "persisted world labelPosition",
          );
          const savedLabel = await assertSavedLabel(session, constraint);
          // Init scripts otherwise restore the original fixture on every reload.
          await reseed(session, after);
          assert.deepEqual(
            await stored(session),
            after,
            "committed document survives reload",
          );
          const reloaded = sketchOf(await stored(session)).constraints.find(
            (candidate) => candidate.id === constraint.id,
          );
          assertPointClose(
            reloaded.labelPosition,
            placement.point.world,
            "reloaded world labelPosition",
          );
          const label = await assertSavedLabel(session, reloaded, savedLabel);
          return {
            kind: item.kind,
            refs: constraint.refs,
            value: constraint.value,
            labelPosition: constraint.labelPosition,
            rendered: label,
          };
        },
      );
    }
  });

  /* -------------------------------------- point-line perpendicular distance */
  await suite(MIXED, {}, async (session) => {
    for (const mode of ["auto", "lineDistance"]) {
      for (const order of ["line-point", "point-line"]) {
        await check(
          `${mode} ${order}: hover previews perpendicular distance, blank placement commits`,
          async () => {
            await reseed(session, MIXED);
            const before = await stored(session);
            if (mode === "auto") await activate(session);
            else {
              await kindSelect(session).selectOption(mode);
              await settle(session);
            }
            const lineFirst = order === "line-point";
            if (lineFirst) await clickWorld(session, GUIDE_BODY);
            else await clickHandle(session, "probe_p0");
            assert.equal(
              await editorOpen(session),
              false,
              "first mixed pick opens no editor",
            );
            if (lineFirst && mode === "auto")
              await assertPreview(
                session,
                { kind: "length", refs: ["guide"], value: 60 },
                "mixed first line",
              );
            const candidate = lineFirst
              ? await handlePoint(session, "probe_p0")
              : await screenPoint(session, GUIDE_BODY);
            const selectedBefore = await session.page
              .locator(".entity-row.selected")
              .evaluateAll((rows) =>
                rows.map((row) => row.getAttribute("title")),
              );
            await session.page.mouse.move(candidate.x, candidate.y);
            await settle(session);
            const expected = {
              kind: "lineDistance",
              refs: ["probe_p0", "guide"],
              value: 24,
            };
            const hover = await assertPreview(
              session,
              expected,
              "mixed candidate hover",
            );
            assert.equal(
              await editorOpen(session),
              false,
              "mixed hover opens no editor",
            );
            assert.deepEqual(
              await session.page
                .locator(".entity-row.selected")
                .evaluateAll((rows) =>
                  rows.map((row) => row.getAttribute("title")),
                ),
              selectedBefore,
              "mixed hover does not select its candidate",
            );
            assert.deepEqual(
              await stored(session),
              before,
              "mixed hover changes no document",
            );
            await hoverWorld(session, { x: 0, y: -4 });
            if (lineFirst && mode === "auto")
              await assertPreview(
                session,
                { kind: "length", refs: ["guide"], value: 60 },
                "leaving mixed candidate restores length",
              );
            if (!lineFirst)
              assert.equal(
                (await metadata(session)).dimensionPreview,
                null,
                "leaving line restores first-point rubber band",
              );
            await clickPoint(session, candidate);
            await assertPreview(session, expected, "confirmed mixed pair");
            assert.equal(
              await editorOpen(session),
              false,
              "confirmed mixed pair still awaits placement",
            );
            assert.deepEqual(
              await stored(session),
              before,
              "confirming mixed pair changes no document",
            );
            const placement = await placeDimension(session, { x: 14, y: -4 });
            assert.equal(
              placement.editor.value,
              "24",
              "perpendicular distance prefilled",
            );
            assert.deepEqual(
              await stored(session),
              before,
              "mixed placement alone changes no document",
            );
            await hoverWorld(session, GUIDE_BODY);
            const fixed = await assertPreview(
              session,
              { ...expected, fixed: true },
              "mixed editor-open hover",
            );
            assertPointClose(
              fixed,
              placement.preview,
              "mixed placement survives pointer motion",
            );
            const outcome = await commitEditor(session, "18");
            assert(
              outcome.closed,
              `mixed distance committed (${outcome.toast})`,
            );
            const after = await stored(session);
            const constraint = constraintOf(after, "lineDistance");
            assert(constraint, "perpendicular distance constraint created");
            assert.deepEqual(
              constraint.refs,
              ["probe_p0", "guide"],
              "refs normalized regardless of pick order",
            );
            assert.equal(constraint.value, 18, "typed mixed distance value");
            assertPointClose(
              constraint.labelPosition,
              placement.point.world,
              "mixed world labelPosition",
            );
            assert.equal(
              sketchOf(after).constraints.length,
              1,
              "standalone point needs only the distance constraint",
            );
            assert(
              !constraintOf(after, "parallel"),
              "no parallel helper for a standalone point",
            );
            const guide = byId(after, "guide");
            const measured = pointLineDistance(
              byId(after, "probe").points[0],
              guide.points[0],
              guide.points[1],
            );
            assert(
              Math.abs(measured - 18) < 1e-4,
              `perpendicular distance solved to 18 (${measured})`,
            );
            await assertSavedLabel(session, constraint);
            return {
              mode,
              order,
              hover,
              refs: constraint.refs,
              labelPosition: constraint.labelPosition,
              measured,
            };
          },
        );
      }
    }
  });

  /* --------------------------------------- editor mouse commit and cancel */
  await suite(SINGLE, {}, async (session) => {
    const openPlacedLength = async () => {
      await reseed(session, SINGLE);
      const before = await stored(session);
      await activate(session);
      await clickWorld(session, { x: 0, y: 0 });
      const placement = await placeDimension(session, { x: 0, y: 8 });
      return { before, placement };
    };

    await check(
      "Editor left blank click commits local text without a phantom pick",
      async () => {
        const { before, placement } = await openPlacedLength();
        await editorInput(session).fill("24");
        const blank = await editorCanvasTarget(session, { x: 0, y: -10 });
        await clickPoint(session, blank);
        await editorInput(session).waitFor({
          state: "detached",
          timeout: 5000,
        });
        const after = await stored(session);
        const constraint = constraintOf(after, "length");
        assert(constraint, "left blank click creates a length dimension");
        assert.equal(
          constraint.value,
          24,
          "blank click reads the latest local text",
        );
        assert.deepEqual(
          constraint.refs,
          ["edge"],
          "blank confirmation preserves picked refs",
        );
        assertPointClose(
          constraint.labelPosition,
          placement.point.world,
          "blank confirmation preserves placement",
        );
        assert.equal(
          sketchOf(after).constraints.length,
          sketchOf(before).constraints.length + 1,
          "one dimension committed",
        );
        assert(
          Math.abs(lengthOf(byId(after, "edge")) - 24) < 1e-5,
          "blank commit solves line length",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "dimension mode remains active after blank commit",
        );
        await assertSavedLabel(session, constraint);
        await hoverWorld(session, { x: 0, y: 0 });
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "confirmation leaves no phantom pick",
        );
        await clickWorld(session, { x: 0, y: 0 });
        await assertPreview(
          session,
          { kind: "length", refs: ["edge"], value: 24 },
          "fresh dimension after blank commit",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "next genuine pick starts placement rather than input",
        );
        assert.deepEqual(
          await stored(session),
          after,
          "starting the next dimension does not commit again",
        );
        await escape(session);
        return {
          value: constraint.value,
          labelPosition: constraint.labelPosition,
        };
      },
    );

    await check(
      "Invalid and empty blank commits retain focus until corrected",
      async () => {
        const { before, placement } = await openPlacedLength();
        for (const text of ["", "missing_parameter"]) {
          await editorInput(session).fill(text);
          const blank = await editorCanvasTarget(session, { x: 0, y: -10 });
          await clickPoint(session, blank);
          await assertEditorFocused(
            session,
            `rejected blank commit ${JSON.stringify(text)}`,
          );
          assert.equal(
            await editorInput(session).inputValue(),
            text,
            "rejected local text remains editable",
          );
          const fixed = await assertPreview(
            session,
            { kind: "length", refs: ["edge"], fixed: true },
            "rejected blank commit preview",
          );
          assertPointClose(
            fixed,
            placement.preview,
            "rejected blank commit leaves the label fixed",
          );
          assert.deepEqual(
            await stored(session),
            before,
            "rejected blank commit changes no document",
          );
        }
        await editorInput(session).fill("26");
        await clickPoint(
          session,
          await editorCanvasTarget(session, { x: 0, y: -10 }),
        );
        await editorInput(session).waitFor({
          state: "detached",
          timeout: 5000,
        });
        const after = await stored(session);
        const constraint = constraintOf(after, "length");
        assert.equal(
          constraint.value,
          26,
          "corrected blank click commits the new local text",
        );
        assertPointClose(
          constraint.labelPosition,
          placement.point.world,
          "correction preserves placement",
        );
        assert.equal(
          sketchOf(after).constraints.length,
          1,
          "failed attempts did not create extra dimensions",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "successful correction keeps dimension mode",
        );
        await assertSavedLabel(session, constraint);
        await escape(session);
        return {
          rejected: ["", "missing_parameter"],
          corrected: constraint.value,
        };
      },
    );

    await check(
      "Editor left geometry click neither commits nor cancels",
      async () => {
        const { before, placement } = await openPlacedLength();
        await editorInput(session).fill("23");
        const body = await editorCanvasTarget(session, { x: 0, y: 0 });
        await clickPoint(session, body);
        await assertEditorFocused(session, "left line-body click");
        assert.equal(
          await editorInput(session).inputValue(),
          "23",
          "geometry click keeps local text",
        );
        const fixed = await assertPreview(
          session,
          { kind: "length", refs: ["edge"], fixed: true },
          "geometry click retains draft",
        );
        assertPointClose(
          fixed,
          placement.preview,
          "geometry click does not move the label",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "geometry click leaves dimension mode active",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "geometry click changes no document or refs",
        );
        await escape(session);
        assert.deepEqual(
          await stored(session),
          before,
          "cancelled ignored click creates no dimension",
        );
        return { ignored: true };
      },
    );

    await check(
      "Editor right blank gesture cancels without a commit or pan",
      async () => {
        const { before } = await openPlacedLength();
        await editorInput(session).fill("21");
        const blank = await editorCanvasTarget(session, { x: 0, y: -10 });
        const view = await metadata(session);
        await session.page.mouse.move(blank.x, blank.y);
        await session.page.mouse.down({ button: "right" });
        await session.page.mouse.move(blank.x + 28, blank.y - 12, { steps: 4 });
        await session.page.mouse.up({ button: "right" });
        await settle(session);
        await editorInput(session).waitFor({
          state: "detached",
          timeout: 5000,
        });
        const afterView = await metadata(session);
        assert.deepEqual(
          afterView.origin,
          view.origin,
          "right cancellation does not start panning",
        );
        assert.equal(
          afterView.scale,
          view.scale,
          "right cancellation does not zoom",
        );
        assert.equal(
          afterView.dimensionPreview,
          null,
          "right cancellation clears the preview",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "right cancellation exits dimension mode",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "right blank cancellation leaves the document unchanged",
        );
        return {
          cancelled: true,
          origin: afterView.origin,
          scale: afterView.scale,
        };
      },
    );

    await check(
      "Editor right click on the input cancels current local text",
      async () => {
        const { before } = await openPlacedLength();
        await editorInput(session).fill("19");
        const view = await metadata(session);
        const { inputBox } = await editorSnapshot(session);
        assert(inputBox, "input has a real browser box");
        await session.page.mouse.click(
          inputBox.x + inputBox.width / 2,
          inputBox.y + inputBox.height / 2,
          { button: "right" },
        );
        await settle(session);
        await editorInput(session).waitFor({
          state: "detached",
          timeout: 5000,
        });
        const afterView = await metadata(session);
        assert.equal(
          afterView.dimensionPreview,
          null,
          "input right click clears the preview",
        );
        assert.deepEqual(
          afterView.origin,
          view.origin,
          "input right click does not pan",
        );
        assert.equal(
          afterView.scale,
          view.scale,
          "input right click does not zoom",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "input right click exits dimension mode",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "input right click never commits local text",
        );
        return { cancelled: true };
      },
    );
  });

  const SAVED_MOUSE = documentFixture(sketchOf(SINGLE).entities, [
    {
      id: "c_mouse_length",
      kind: "length",
      refs: ["edge"],
      value: 40,
      labelPosition: { x: 0, y: 8 },
    },
  ]);
  await suite(SAVED_MOUSE, {}, async (session) => {
    for (const item of [
      { button: "left", value: 28, committed: true },
      { button: "right", value: 32, committed: false },
    ]) {
      await check(
        `Saved-label editor ${item.button} blank click ${item.committed ? "commits while retaining saved placement" : "cancels without changing value"}`,
        async () => {
          await reseed(session, SAVED_MOUSE);
          const before = await stored(session);
          const original = constraintOf(before, "length");
          const label = await assertSavedLabel(session, original);
          const canvasBox = await session.canvas.boundingBox();
          await session.page.mouse.dblclick(
            canvasBox.x + label.x,
            canvasBox.y + label.y,
          );
          const editor = await waitForEditor(session);
          assert.equal(
            editor.value,
            "40",
            "saved-label edit opens with its current value",
          );
          assert.equal(
            (await metadata(session)).dimensionPreview,
            null,
            "saved-label edit does not require placement",
          );
          await editorInput(session).fill(String(item.value));
          const blank = await editorCanvasTarget(session, { x: 0, y: -10 });
          const view = await metadata(session);
          await session.page.mouse.click(blank.x, blank.y, {
            button: item.button,
          });
          await settle(session);
          await editorInput(session).waitFor({
            state: "detached",
            timeout: 5000,
          });
          const after = await stored(session);
          const constraint = sketchOf(after).constraints.find(
            (candidate) => candidate.id === original.id,
          );
          assert(constraint, "saved dimension identity is retained");
          assert.equal(
            sketchOf(after).constraints.length,
            1,
            "saved-label interaction creates no extra dimension",
          );
          assert.deepEqual(
            constraint.labelPosition,
            original.labelPosition,
            "saved-label interaction retains stored placement",
          );
          const savedLabel = await assertSavedLabel(
            session,
            constraint,
            item.committed ? undefined : label,
          );
          if (item.committed) {
            const [a, b] = byId(after, "edge").points;
            const size = Math.hypot(b.x - a.x, b.y - a.y);
            const normal = { x: -(b.y - a.y) / size, y: (b.x - a.x) / size };
            const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const offset =
              (constraint.labelPosition.x - midpoint.x) * normal.x +
              (constraint.labelPosition.y - midpoint.y) * normal.y;
            assert(
              Math.abs(offset) * view.scale >= 12,
              "saved placement has a readable offset",
            );
            assertPointClose(
              savedLabel.world,
              {
                x: midpoint.x + normal.x * offset,
                y: midpoint.y + normal.y * offset,
              },
              "edited label follows the saved placement projected onto solved geometry",
            );
            assert.equal(
              constraint.value,
              item.value,
              "left blank click updates the driving value",
            );
            assert(
              Math.abs(lengthOf(byId(after, "edge")) - item.value) < 1e-5,
              "saved blank commit solves geometry",
            );
          } else {
            assert.deepEqual(
              after,
              before,
              "right saved-label cancellation changes nothing",
            );
            assert.deepEqual(
              (await metadata(session)).origin,
              view.origin,
              "right saved-label cancellation does not pan",
            );
            assert.equal(
              (await metadata(session)).scale,
              view.scale,
              "right saved-label cancellation does not zoom",
            );
          }
          await assertNoDialog(
            session,
            `saved-label ${item.button} blank action`,
          );
          return {
            button: item.button,
            value: constraint.value,
            labelPosition: constraint.labelPosition,
          };
        },
      );
    }
  });

  /* ---------------------------------------- saved annotation positioning */
  const POSITIONED_MOUSE = documentFixture(
    [
      ...sketchOf(SINGLE).entities,
      line("other", [
        [-18, 0],
        [-10, 0],
      ]),
    ],
    [
      {
        id: "c_position_length",
        kind: "length",
        refs: ["edge"],
        value: 40,
        expression: "40",
        labelPosition: { x: 0, y: 8 },
      },
      {
        id: "c_other_length",
        kind: "length",
        refs: ["other"],
        value: 8,
        labelPosition: { x: -14, y: -4 },
      },
    ],
  );
  await suite(POSITIONED_MOUSE, {}, async (session) => {
    const beginLabelDrag = async (world = { x: 0, y: -6 }) => {
      const before = await stored(session);
      const constraint = sketchOf(before).constraints.find(
        (item) => item.id === "c_position_length",
      );
      const saved = await metadata(session);
      const label = await assertSavedLabel(session, constraint);
      await activate(session);
      const annotation = await dimensionLabelTarget(session, constraint.id);
      const start = {
        x: Math.round(annotation.x),
        y: Math.round(annotation.y),
      };
      const target = await roundedWorldTarget(session, world);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await settle(session);
      assert.equal(
        (await metadata(session)).dimensionPreview,
        null,
        "pointer down alone does not start adjustment",
      );
      assert.deepEqual(
        (await metadata(session)).dimensions,
        saved.dimensions,
        "pointer down keeps every saved label",
      );
      await session.page.mouse.move(target.x, target.y, { steps: 6 });
      await settle(session);
      const preview = await assertPreview(
        session,
        {
          kind: "length",
          refs: ["edge"],
          value: 40,
        },
        "actual annotation drag preview",
      );
      assert.equal(
        preview.constraintId,
        constraint.id,
        "drag identifies the existing annotation",
      );
      assert.equal(
        await editorOpen(session),
        false,
        "annotation drag opens no value editor",
      );
      assert.deepEqual(
        (await metadata(session)).dimensions,
        saved.dimensions.filter((item) => item.id !== constraint.id),
        "only the dragged saved label is hidden",
      );
      assert.deepEqual(
        await stored(session),
        before,
        "active drag does not write the document before release",
      );
      return { before, constraint, saved, label, start, target, preview };
    };

    await check(
      "Saved annotation drag previews until release, then persists position with history",
      async () => {
        await reseed(session, POSITIONED_MOUSE);
        const { before, constraint, saved, label, start, preview } =
          await beginLabelDrag();
        const baseDraws = (await metadata(session)).stats.baseDraws;
        const target = await roundedWorldTarget(session, { x: 0, y: -8 });
        await session.page.mouse.move(target.x, target.y, { steps: 4 });
        await settle(session);
        const movedPreview = await assertPreview(
          session,
          {
            kind: "length",
            refs: ["edge"],
            value: 40,
          },
          "continued annotation drag",
        );
        assert.equal(
          movedPreview.constraintId,
          constraint.id,
          "drag preserves annotation identity",
        );
        assert(
          Math.abs(movedPreview.y - preview.y) > 3,
          "continued drag moves the preview",
        );
        assert.equal(
          (await metadata(session)).stats.baseDraws,
          baseDraws,
          "continued drag does not redraw the cached base",
        );
        assert.deepEqual(
          (await metadata(session)).dimensions,
          saved.dimensions.filter((item) => item.id !== constraint.id),
          "other saved labels remain unchanged during drag",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "drag movement does not write the document",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "drag never opens a numeric editor",
        );
        const expectedWorld = {
          x: label.world.x + (target.x - start.x) / saved.scale,
          y: label.world.y - (target.y - start.y) / saved.scale,
        };
        assertPointClose(
          movedPreview,
          {
            x: saved.origin.x + label.world.x * saved.scale,
            y: saved.origin.y - expectedWorld.y * saved.scale,
          },
          "drag metadata uses the projected label position",
        );
        await session.page.mouse.up();
        await settle(session);
        assert.equal(
          await editorOpen(session),
          false,
          "drag release confirms without an editor or extra click",
        );
        const after = await stored(session);
        const adjusted = sketchOf(after).constraints.find(
          (item) => item.id === constraint.id,
        );
        assertPointClose(
          adjusted.labelPosition,
          expectedWorld,
          "release saves the dragged world label position",
        );
        assert.equal(
          adjusted.value,
          constraint.value,
          "drag preserves numeric value",
        );
        assert.equal(
          adjusted.expression,
          constraint.expression,
          "drag preserves the expression",
        );
        const expected = structuredClone(before);
        sketchOf(expected).constraints.find(
          (item) => item.id === constraint.id,
        ).labelPosition = adjusted.labelPosition;
        assert.deepEqual(
          after,
          expected,
          "release changes only labelPosition, not geometry or value",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "drag release keeps dimension mode active",
        );
        const movedLabel = await assertSavedLabel(session, adjusted);
        assert.deepEqual(
          (await metadata(session)).dimensions.filter(
            (item) => item.id !== constraint.id,
          ),
          saved.dimensions.filter((item) => item.id !== constraint.id),
          "other saved labels remain unchanged after release",
        );
        await session.page.keyboard.press("Control+z");
        await settle(session);
        assert.deepEqual(
          await stored(session),
          before,
          "undo restores the previous label position",
        );
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "undo leaves no drag preview",
        );
        await session.page.keyboard.press("Control+Shift+z");
        await settle(session);
        assert.deepEqual(
          await stored(session),
          after,
          "redo restores the dragged label position",
        );
        await reseed(session, after);
        assert.deepEqual(
          await stored(session),
          after,
          "position-only document survives reload",
        );
        const reloaded = sketchOf(after).constraints.find(
          (item) => item.id === constraint.id,
        );
        await assertSavedLabel(session, reloaded, movedLabel);
        return {
          value: adjusted.value,
          expression: adjusted.expression,
          labelPosition: adjusted.labelPosition,
        };
      },
    );

    await check(
      "Escape and right click cancel annotation drag even after left release",
      async () => {
        for (const action of ["Escape", "right"]) {
          await reseed(session, POSITIONED_MOUSE);
          const { before, saved } = await beginLabelDrag({ x: 0, y: -8 });
          if (action === "right") {
            await session.page.mouse.down({ button: "right" });
            await session.page.mouse.up({ button: "right" });
          } else await session.page.keyboard.press("Escape");
          await settle(session);
          assert.equal(
            (await metadata(session)).dimensionPreview,
            null,
            `${action} clears the active drag preview`,
          );
          await session.page.mouse.up();
          await settle(session);
          const restored = await metadata(session);
          assert.equal(
            restored.dimensionPreview,
            null,
            "later left release does not revive the cancelled drag",
          );
          assert.equal(
            await editorOpen(session),
            false,
            `${action} opens no value editor`,
          );
          assert.deepEqual(
            restored.dimensions,
            saved.dimensions,
            `${action} restores every saved label`,
          );
          assert.deepEqual(
            restored.origin,
            saved.origin,
            `${action} does not pan the viewport`,
          );
          assert.equal(
            restored.scale,
            saved.scale,
            `${action} does not zoom the viewport`,
          );
          assert.equal(
            (await modeState(session)).pressed,
            "false",
            `${action} exits dimension mode`,
          );
          assert.deepEqual(
            await stored(session),
            before,
            `${action} and later release leave the original document`,
          );
        }
        return { cancelled: ["Escape", "right"] };
      },
    );

    await check(
      "Annotation clicks stay inert; active native double click adds no position history",
      async () => {
        await reseed(session, POSITIONED_MOUSE);
        const idle = await stored(session);
        const idleDimensions = (await metadata(session)).dimensions;
        const idleLabel = await dimensionLabelTarget(
          session,
          "c_position_length",
        );
        await clickPoint(session, idleLabel);
        assert.equal(
          await editorOpen(session),
          false,
          "normal single click does not open a value editor",
        );
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "normal single click does not start adjustment",
        );
        const idleTarget = await roundedWorldTarget(session, { x: 0, y: -8 });
        await session.page.mouse.move(idleLabel.x, idleLabel.y);
        await session.page.mouse.down();
        await session.page.mouse.move(idleTarget.x, idleTarget.y, { steps: 6 });
        await settle(session);
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "inactive dimension mode cannot drag annotations",
        );
        await session.page.mouse.up();
        await settle(session);
        assert.deepEqual(
          await stored(session),
          idle,
          "inactive annotation drag leaves position and document unchanged",
        );
        assert.deepEqual(
          (await metadata(session)).dimensions,
          idleDimensions,
          "inactive drag keeps saved labels",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "false",
          "inactive gesture does not enter dimension mode",
        );

        await reseed(session, POSITIONED_MOUSE);
        const activeBefore = await stored(session);
        const activeDimensions = (await metadata(session)).dimensions;
        await activate(session);
        await clickPoint(
          session,
          await dimensionLabelTarget(session, "c_position_length"),
        );
        assert.equal(
          await editorOpen(session),
          false,
          "active single click opens no numeric editor",
        );
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "active single click starts no adjustment stage",
        );
        assert.deepEqual(
          (await metadata(session)).dimensions,
          activeDimensions,
          "active single click hides no saved labels",
        );
        assert.deepEqual(
          await stored(session),
          activeBefore,
          "active single click changes no document",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "active single click leaves dimension mode active",
        );
        await escape(session);

        await reseed(session, POSITIONED_MOUSE);
        const { before, constraint } = await beginLabelDrag({ x: 0, y: -8 });
        await session.page.mouse.up();
        await settle(session);
        const moved = await stored(session);
        assert.notDeepEqual(
          moved,
          before,
          "one real completed drag establishes history",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "drag leaves dimension mode active before double click",
        );
        const annotation = await dimensionLabelTarget(session, constraint.id);
        await session.page.mouse.dblclick(annotation.x, annotation.y);
        const editor = await waitForEditor(session);
        assert.equal(
          editor.value,
          "40",
          "native active double click opens the numeric editor",
        );
        await assertEditorFocused(session, "active annotation double click");
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "double click has no transient drag preview",
        );
        assert.deepEqual(
          await stored(session),
          moved,
          "double click commits no annotation position",
        );
        await editorInput(session).fill("31");
        assert.equal(
          await editorInput(session).inputValue(),
          "31",
          "active numeric label remains editable",
        );
        await escape(session);
        assert.deepEqual(
          await stored(session),
          moved,
          "cancelled numeric editor leaves the dragged document",
        );
        await session.page.keyboard.press("Control+z");
        await settle(session);
        assert.deepEqual(
          await stored(session),
          before,
          "one undo reaches the prior real position, with no phantom transaction",
        );
        await session.page.keyboard.press("Control+Shift+z");
        await settle(session);
        assert.deepEqual(
          await stored(session),
          moved,
          "redo restores that one real drag transaction",
        );
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "history leaves no stale annotation drag",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "history leaves no numeric editor",
        );
        return {
          inactiveDragIgnored: true,
          singleClicksIgnored: true,
          undoEntriesAddedByDoubleClick: 0,
        };
      },
    );
  });

  const CIRCULAR_POSITION = documentFixture(
    [entity("circle", "hole", [[0, 0]], { radius: 8 })],
    [
      {
        id: "c_position_diameter",
        kind: "diameter",
        refs: ["hole"],
        value: 16,
        expression: "16",
        labelPosition: { x: 10, y: 5 },
      },
    ],
  );
  await suite(CIRCULAR_POSITION, {}, async (session) => {
    await check(
      "Saved circular annotation drags its leader without editing diameter",
      async () => {
        const before = await stored(session);
        const constraint = constraintOf(before, "diameter");
        const original = await assertSavedLabel(session, constraint);
        const saved = await metadata(session);
        await activate(session);
        const annotation = await dimensionLabelTarget(session, constraint.id);
        const start = {
          x: Math.round(annotation.x),
          y: Math.round(annotation.y),
        };
        const target = await roundedWorldTarget(session, { x: 10, y: -5 });
        await session.page.mouse.move(start.x, start.y);
        await session.page.mouse.down();
        await settle(session);
        assert.equal(
          (await metadata(session)).dimensionPreview,
          null,
          "circular pointer down alone does not start adjustment",
        );
        await session.page.mouse.move(target.x, target.y, { steps: 6 });
        await settle(session);
        const preview = await assertPreview(
          session,
          { kind: "diameter", refs: ["hole"] },
          "circular annotation drag",
        );
        assert.equal(
          preview.constraintId,
          constraint.id,
          "circular drag identifies its saved dimension",
        );
        assert.equal(
          await editorOpen(session),
          false,
          "circular drag opens no value input",
        );
        assert.equal(
          (await metadata(session)).dimensions.length,
          0,
          "original circular label is hidden during actual drag",
        );
        assert(
          Math.hypot(preview.x - original.x, preview.y - original.y) > 8,
          "circular leader follows the dragged label",
        );
        assert.deepEqual(
          await stored(session),
          before,
          "circular drag does not write before release",
        );
        const expectedWorld = {
          x: original.world.x + (target.x - start.x) / saved.scale,
          y: original.world.y - (target.y - start.y) / saved.scale,
        };
        await session.page.mouse.up();
        await settle(session);
        assert.equal(
          await editorOpen(session),
          false,
          "circular release confirms without a numeric editor or blank click",
        );
        const after = await stored(session);
        const adjusted = constraintOf(after, "diameter");
        assertPointClose(
          adjusted.labelPosition,
          expectedWorld,
          "circular release saves the dragged world position",
        );
        const expected = structuredClone(before);
        constraintOf(expected, "diameter").labelPosition =
          adjusted.labelPosition;
        assert.deepEqual(
          after,
          expected,
          "circular drag changes only labelPosition, not radius, value, or expression",
        );
        const rendered = await assertSavedLabel(session, adjusted);
        assertPointClose(
          rendered.world,
          expectedWorld,
          "saved circular leader uses the dragged label position",
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "circular release keeps dimension mode active",
        );
        await escape(session);
        return {
          value: adjusted.value,
          expression: adjusted.expression,
          labelPosition: adjusted.labelPosition,
        };
      },
    );
  });

  await suite(MIXED, {}, async (session) => {
    await check(
      "Point-line editor blank click commits the perpendicular value",
      async () => {
        const before = await stored(session);
        await activate(session);
        await clickHandle(session, "probe_p0");
        await clickWorld(session, GUIDE_BODY);
        const placement = await placeDimension(session, { x: 14, y: -4 });
        assert.equal(
          placement.editor.value,
          "24",
          "perpendicular distance starts with measured value",
        );
        await editorInput(session).fill("18");
        const blank = await editorCanvasTarget(session, { x: 0, y: -4 });
        await clickPoint(session, blank);
        await editorInput(session).waitFor({
          state: "detached",
          timeout: 5000,
        });
        const after = await stored(session);
        const constraint = constraintOf(after, "lineDistance");
        assert(
          constraint,
          "generic blank commit creates a perpendicular dimension",
        );
        assert.equal(
          constraint.value,
          18,
          "blank commit uses the typed point-line value",
        );
        assert.deepEqual(
          constraint.refs,
          ["probe_p0", "guide"],
          "blank commit preserves normalized point-line refs",
        );
        assertPointClose(
          constraint.labelPosition,
          placement.point.world,
          "point-line blank confirmation retains placement",
        );
        assert.equal(
          sketchOf(after).constraints.length,
          sketchOf(before).constraints.length + 1,
          "blank commit adds only distance, not parallel",
        );
        assert(
          !constraintOf(after, "parallel"),
          "standalone point still needs no parallel helper",
        );
        const guide = byId(after, "guide");
        const measured = pointLineDistance(
          byId(after, "probe").points[0],
          guide.points[0],
          guide.points[1],
        );
        assert(
          Math.abs(measured - 18) < 1e-4,
          `point-line blank commit solves distance (${measured})`,
        );
        assert.equal(
          (await modeState(session)).pressed,
          "true",
          "generic blank commit keeps dimension mode active",
        );
        await assertSavedLabel(session, constraint);
        await escape(session);
        return {
          value: constraint.value,
          refs: constraint.refs,
          labelPosition: constraint.labelPosition,
          measured,
        };
      },
    );
  });

  /* ------------------------------------------------------ expressions */
  await suite(EXPR, {}, async (session) => {
    await check(
      "Expressions: unknown parameter rejected, then parameter-driven dimension follows changes",
      async () => {
        await activate(session);
        await clickWorld(session, { x: 0, y: 0 });
        await placeDimension(session);
        const editor = await waitForEditor(session);
        assert.equal(editor.value, "36", "measured length prefilled");
        const before = await stored(session);
        const unknown = await commitEditor(session, "width");
        assert.equal(
          unknown.closed,
          false,
          "unknown parameter keeps the editor open",
        );
        assert(
          /width/.test(unknown.toast),
          `unknown parameter reported: ${unknown.toast}`,
        );
        assert.deepEqual(
          await stored(session),
          before,
          "no mutation for a rejected expression",
        );
        await escape(session);

        // Legitimate dialog use: define the parameter once.
        await session.page
          .getByRole("button", { name: "修改", exact: true })
          .click();
        await session.page
          .locator(".ribbon-menu")
          .getByRole("button", { name: "更改参数", exact: true })
          .click();
        await session.page
          .getByRole("textbox", {
            name: "名称, 表达式, 单位（每行一项）",
            exact: true,
          })
          .fill("width, 22, mm");
        await session.page
          .getByRole("button", { name: "确定", exact: true })
          .click();
        await session.page.locator(".dialog").waitFor({ state: "hidden" });
        await resetDialogLog(session);

        await activate(session);
        await clickWorld(session, { x: 0, y: 0 });
        await placeDimension(session);
        await waitForEditor(session);
        const committed = await commitEditor(session, "width");
        assert(
          committed.closed,
          `expression committed (toast: ${committed.toast})`,
        );
        const after = await stored(session);
        const constraint = sketchOf(after).constraints.find(
          (item) => item.kind === "length" && item.refs.includes("edge"),
        );
        assert.equal(
          constraint.expression,
          "width",
          "expression stored on the constraint",
        );
        assert.equal(
          constraint.value,
          22,
          "expression evaluated to the parameter value",
        );
        assert(
          Math.abs(lengthOf(byId(after, "edge")) - 22) < 1e-5,
          `geometry driven by width=22 (${lengthOf(byId(after, "edge"))})`,
        );

        // Change the parameter: the geometry must follow.
        await session.page
          .getByRole("button", { name: "修改", exact: true })
          .click();
        await session.page
          .locator(".ribbon-menu")
          .getByRole("button", { name: "更改参数", exact: true })
          .click();
        await session.page
          .getByRole("textbox", {
            name: "名称, 表达式, 单位（每行一项）",
            exact: true,
          })
          .fill("width, 34, mm");
        await session.page
          .getByRole("button", { name: "确定", exact: true })
          .click();
        await session.page.locator(".dialog").waitFor({ state: "hidden" });
        await resetDialogLog(session);
        const updated = await stored(session);
        const updatedConstraint = sketchOf(updated).constraints.find(
          (item) => item.kind === "length" && item.refs.includes("edge"),
        );
        assert.equal(
          updatedConstraint.expression,
          "width",
          "expression retained",
        );
        assert.equal(
          updatedConstraint.value,
          34,
          "parameter change re-evaluated",
        );
        assert(
          Math.abs(lengthOf(byId(updated, "edge")) - 34) < 1e-5,
          `geometry follows width=34 (${lengthOf(byId(updated, "edge"))})`,
        );
        await assertNoDialog(session, "after the parameter dialogs");
        return {
          unknown: unknown.toast,
          expression: updatedConstraint.expression,
          values: [constraint.value, updatedConstraint.value],
          lengths: [
            lengthOf(byId(after, "edge")),
            lengthOf(byId(updated, "edge")),
          ],
        };
      },
    );
  });

  /* -------------------------------------------------------------- DPR 2 */
  await suite(SINGLE, { dpr: 2 }, async (session) => {
    await check(
      "DPR 2 desktop: inline editor geometry and commit stay exact",
      async () => {
        const state = await metadata(session);
        assert.equal(state.dpr, 2, "metadata reports dpr 2");
        const backing = await session.canvas.evaluate((element) => ({
          width: element.width,
          height: element.height,
        }));
        assert(
          Math.abs(backing.width - Math.round(state.width * 2)) <= 1,
          "dpr2 backing width",
        );
        assert(
          Math.abs(backing.height - Math.round(state.height * 2)) <= 1,
          "dpr2 backing height",
        );
        await activate(session);
        const pick = await clickWorld(session, { x: 0, y: 0 });
        const placement = await placeDimension(session, { x: 0, y: -10 });
        const editor = placement.editor;
        assert.equal(editor.value, "40", "prefilled at dpr 2");
        const canvasBox = await session.canvas.boundingBox();
        assertEditorInside(editor.box, canvasBox, "dpr2 editor");
        const centerX = editor.box.x + editor.box.width / 2;
        assert(
          Math.abs(centerX - placement.point.x) <= 2,
          `dpr2 editor centred over the label (${centerX} vs ${placement.point.x})`,
        );
        await session.page.screenshot({
          path: path.join(output, "dpr2-inline-editor.png"),
        });
        const outcome = await commitEditor(session, "24");
        assert(
          outcome.closed,
          `dpr2 commit closed the editor (${outcome.toast})`,
        );
        const doc = await stored(session);
        assert(
          Math.abs(lengthOf(byId(doc, "edge")) - 24) < 1e-5,
          `dpr2 geometry solved (${lengthOf(byId(doc, "edge"))})`,
        );
        await assertNoDialog(session, "dpr2 dimension");
        return { dpr: state.dpr, backing, value: 24 };
      },
    );
  });

  /* ----------------------------------------------------- 390x844 mobile */
  await suite(
    SINGLE,
    { dpr: 2, viewport: { width: 390, height: 844 } },
    async (session) => {
      await check(
        "Mobile 390x844 DPR 2: activate, pick a line, editor fully inside the canvas",
        async () => {
          const state = await metadata(session);
          assert.equal(state.dpr, 2, "mobile metadata dpr 2");
          assert(
            state.width >= 300 && state.width <= 390,
            `mobile canvas width ${state.width}`,
          );
          const button = dimensionButton(session);
          const buttonBox = await button.boundingBox();
          const inWindow =
            buttonBox &&
            buttonBox.x >= 0 &&
            buttonBox.y >= 0 &&
            buttonBox.x + buttonBox.width <= 390 &&
            buttonBox.y + buttonBox.height <= 844;
          let activatedBy = "ribbon";
          if (inWindow && (await button.isVisible())) await button.click();
          else {
            activatedBy =
              "keyboard D (ribbon button outside the 390x844 window)";
            await session.page.keyboard.press("d");
          }
          await settle(session);
          const mode = await modeState(session);
          assert.equal(
            mode.pressed,
            "true",
            `dimension mode active via ${activatedBy}`,
          );
          const pick = await clickWorld(session, { x: 0, y: 0 });
          const placement = await placeDimension(session, { x: 0, y: -12 });
          const editor = placement.editor;
          assert.equal(
            editor.value,
            "40",
            "mobile prefill equals the measured length",
          );
          assert.equal(editor.unit, "mm", "mobile editor renders the unit");
          assert.equal(
            editor.hint,
            "Enter 确认 · Esc 取消",
            "mobile editor renders the hint",
          );
          const canvasBox = await session.canvas.boundingBox();
          assertEditorInside(editor.box, canvasBox, "mobile editor");
          assertEditorInside(editor.inputBox, canvasBox, "mobile editor input");
          const centerX = editor.box.x + editor.box.width / 2;
          assert(
            Math.abs(centerX - placement.point.x) <= 2,
            `mobile editor centred over the label (${centerX} vs ${placement.point.x})`,
          );
          await session.page.screenshot({
            path: path.join(output, "mobile-inline-editor.png"),
          });
          const outcome = await commitEditor(session, "12");
          assert(
            outcome.closed,
            `mobile commit closed the editor (${outcome.toast})`,
          );
          const doc = await stored(session);
          assert(
            Math.abs(lengthOf(byId(doc, "edge")) - 12) < 1e-5,
            `mobile geometry solved (${lengthOf(byId(doc, "edge"))})`,
          );
          const layout = await session.page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth,
          }));
          await assertNoDialog(session, "mobile dimension");
          return {
            activatedBy,
            canvas: canvasBox,
            editor: editor.box,
            value: editor.value,
            layout,
          };
        },
      );
    },
  );

  /* ---------------------------------------------------------- global gates */
  assert(results.checks.length >= 25, "dimension suite executed every case");
  assert(
    results.wasm.some((response) => response.status === 200),
    "native WASM solver loaded",
  );
  assert.deepEqual(results.externalRequests, [], "zero external requests");
  assert.deepEqual(results.consoleErrors, [], "zero console errors");
  assert.deepEqual(results.pageErrors, [], "zero page errors");
  results.passed = results.checks.every((item) => item.passed);
  if (!results.passed) process.exitCode = 1;
} catch (error) {
  results.passed = false;
  results.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  results.finished = new Date().toISOString();
  results.passedChecks = results.checks.filter((item) => item.passed).length;
  results.failedChecks = results.checks.filter((item) => !item.passed).length;
  results.passed = results.failedChecks === 0 && !results.failure;
  await writeResults();
  await browser.close();
  console.log(
    `${results.passedChecks}/${results.checks.length} dimension checks passed; ` +
      `artifacts: ${output}`,
  );
}
