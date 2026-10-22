import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/snap-options",
);
const storage = "sketchworks.document.v1";
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const labels = {
  grid: "\u7f51\u683c\u6355\u83b7",
  midpoint: "\u4e2d\u70b9\u6355\u83b7",
  endpoint: "\u7aef\u70b9\u6355\u83b7",
  tangent: "\u5207\u70b9\u6355\u83b7",
  intersection: "\u76f8\u4ea4\u70b9\u6355\u83b7",
};
const names = {
  grid: "\u7f51\u683c",
  master: "\u5207\u6362\u5438\u9644",
  snap: "\u5438\u9644",
  auto: "\u81ea\u52a8\u7ea6\u675f",
  line: "\u76f4\u7ebf",
  select: "\u9009\u62e9",
  point: "\u70b9",
  fit: "\u9002\u914d\u5168\u90e8",
};
const allEnabled = Object.fromEntries(
  Object.keys(labels).map((key) => [key, true]),
);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CAD_BROWSER_PATH ||
    (!existsSync(chromium.executablePath()) && existsSync(chrome)
      ? chrome
      : undefined),
});
const results = {
  url,
  browser: browser.version(),
  started: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  pageErrors: [],
  externalRequests: [],
  wasm: [],
};
await fs.mkdir(output, { recursive: true });

const entity = (kind, id, coords, extra = {}) => ({
  id,
  kind,
  name: id,
  points: coords.map(([x, y], index) => ({ id: `${id}_p${index}`, x, y })),
  ...extra,
});
const guide = entity(
  "line",
  "extent-guide",
  [
    [-50, -40],
    [50, 40],
  ],
  { construction: true },
);
const fixture = (entities = []) => ({
  version: 1,
  name: "Snap options regression",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "snap-fixture",
      name: "Snap options fixture",
      visible: true,
      entities: [guide, ...entities],
      constraints: [guide, ...entities].map((item) => ({
        id: `${item.id}-fixed`,
        kind: "fixed",
        refs: [item.id],
      })),
    },
  ],
});
const sourceA = entity("line", "source-a", [
  [-28, 15],
  [-10, 22],
]);
const sourceB = entity("line", "source-b", [
  [20, -18],
  [34, -25],
]);
const midSource = entity("line", "mid-source", [
  [-24, 19],
  [16, 19],
]);
const midpoint = { x: -4, y: 19 };
const crossing = { x: 7, y: 11 };
const crossA = entity("line", "cross-a", [
  [-32, 11],
  [34, 11],
]);
const crossB = entity("line", "cross-b", [
  [7, -27],
  [7, 31],
]);
const circle = entity("circle", "tangent-circle", [[0, 0]], { radius: 10 });
const anchor = { x: -20, y: 0 };
const anchorPoint = entity("point", "tangent-anchor", [[anchor.x, anchor.y]]);
const tangent = { x: -5, y: Math.sqrt(75) };
const mixed = () =>
  fixture([sourceA, sourceB, midSource, crossA, crossB, circle, anchorPoint]);
const sketch = (doc) => doc.sketches[0];
const near = (actual, expected, tolerance = 1e-5) =>
  assert(
    actual &&
      Math.hypot(actual.x - expected.x, actual.y - expected.y) <= tolerance,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
const toolButton = (session, name) =>
  session.page
    .getByRole("button", { name, exact: true })
    .or(
      session.page.locator(
        `button:not(.entity-row)[title=${JSON.stringify(name)}]`,
      ),
    );
const captureButton = (session, key) =>
  session.page
    .locator(".bottom-actions")
    .getByRole("button", { name: labels[key], exact: true });
const masterButton = (session) =>
  session.page
    .locator(".bottom-actions")
    .getByRole("button", { name: names.master, exact: true });
const checkbox = (session, name) =>
  session.page.getByRole("checkbox", { name, exact: true });
const settle = (session) =>
  session.page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
      ),
  );
const saved = async (session) => {
  await session.page.waitForTimeout(750);
  await session.page
    .locator('.save-dot[data-saved="true"]')
    .waitFor({ state: "attached" });
  return session.page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storage,
  );
};
const entityCount = (session) =>
  session.page.evaluate((key) => {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    return (parsed?.sketches ?? []).reduce(
      (total, sketch) => total + sketch.entities.length,
      0,
    );
  }, storage);
const commitEntities = (session, expected) =>
  session.page.waitForFunction(
    ({ key, expected }) => {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
      return (
        (parsed?.sketches ?? []).reduce(
          (total, sketch) => total + sketch.entities.length,
          0,
        ) >= expected
      );
    },
    { key: storage, expected },
    { timeout: 20000 },
  );

async function open(
  fixtureDoc,
  { viewport = { width: 1440, height: 900 }, dpr = 1 } = {},
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
    page.on("pageerror", (error) => results.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        results.consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (/\.wasm(?:\?|$)/.test(response.url()))
        results.wasm.push({ url: response.url(), status: response.status() });
    });
    await page.addInitScript(
      ({ fixtureDoc, storage }) => {
        localStorage.setItem(storage, JSON.stringify(fixtureDoc));
        document.addEventListener(
          "pointermove",
          (event) => {
            if (event.target.matches?.('[data-testid="cad-canvas"]'))
              event.target.__snapOptionsMoves =
                (event.target.__snapOptionsMoves || 0) + 1;
          },
          true,
        );
      },
      { fixtureDoc, storage },
    );
    await page.goto(url);
    await page
      .locator(".loading-overlay")
      .waitFor({ state: "hidden", timeout: 120000 });
    await page.waitForFunction(
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
    const canvas = page.getByTestId("cad-canvas");
    const session = {
      context,
      page,
      canvas,
      metadata: () => canvas.evaluate((element) => element.__cadViewport),
    };
    await settle(session);
    const projectToggle = page.locator(
      '.app-header button[aria-label="项目管理"]',
    );
    if ((await projectToggle.getAttribute("aria-pressed")) === "true")
      await projectToggle.click();
    await settle(session);
    if (viewport.width > 700) {
      const zoomOut = page.locator('.view-controls button[title="缩小"]');
      await zoomOut.click();
      await zoomOut.click();
      const box = await canvas.boundingBox();
      const from = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.7 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(from.x - 148, from.y, { steps: 5 });
      await page.mouse.up({ button: "middle" });
      await settle(session);
    }
    assert.deepEqual(
      sketch(await saved(session)).entities.map((item) => item.id),
      sketch(fixtureDoc).entities.map((item) => item.id),
      "isolated seeded fixture loaded",
    );
    return session;
  } catch (error) {
    await context.close();
    throw error;
  }
}
async function screen(session, point) {
  await session.page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="cad-canvas"]');
    const frame = canvas?.__cadViewport;
    const box = canvas?.getBoundingClientRect();
    return (
      frame &&
      box &&
      Math.abs(frame.width - box.width) < 1 &&
      Math.abs(frame.height - box.height) < 1
    );
  });
  const state = await session.metadata();
  const box = await session.canvas.boundingBox();
  const local = {
    x: state.origin.x + point.x * state.scale,
    y: state.origin.y - point.y * state.scale,
  };
  assert(
    local.x > 12 &&
      local.y > 12 &&
      local.x < state.width - 12 &&
      local.y < state.height - 12,
    `visible target ${JSON.stringify({ point, local, width: state.width, height: state.height })}`,
  );
  return { x: box.x + local.x, y: box.y + local.y, local };
}
async function moveNear(session, point, dx = 6, dy = 2) {
  const position = await screen(session, point);
  await session.page.mouse.move(position.x + dx, position.y + dy);
  await settle(session);
  const state = await session.metadata();
  return {
    position,
    state,
    dx,
    dy,
    raw: { x: point.x + dx / state.scale, y: point.y - dy / state.scale },
  };
}
function assertSnap(moved, kind, tolerance = 1e-4) {
  assert.equal(
    moved.state.snap?.kind,
    kind,
    `expected ${kind}, got ${JSON.stringify(moved.state.snap)}`,
  );
  near(moved.state.snap, moved.position.local, tolerance);
  return moved.state.snap;
}
async function clickMoved(session, moved) {
  await session.page.mouse.click(
    moved.position.x + moved.dx,
    moved.position.y + moved.dy,
  );
  await settle(session);
}
async function finish(session, expected = null) {
  // Fixed-count tools commit the final canvas pick without a confirm button;
  // Escape waits until the persisted sketch really contains the new geometry.
  if (expected !== null) await commitEntities(session, expected);
  await session.page.keyboard.press("Escape");
  await toolButton(session, names.select).click();
  await settle(session);
}
async function option(session, name, enabled) {
  await checkbox(session, name).setChecked(enabled);
  await settle(session);
}
async function capture(session, key, enabled, stationary = false) {
  const button = captureButton(session, key);
  const pressed = await button.getAttribute("aria-pressed");
  assert(
    ["true", "false"].includes(pressed),
    `${labels[key]} exposes its pressed state`,
  );
  assert(await button.isEnabled(), `${labels[key]} remains configurable`);
  if (pressed !== String(enabled)) {
    // Native button activation preserves the canvas pointer for stale-marker checks.
    if (stationary) await button.evaluate((element) => element.click());
    else await button.click();
    await settle(session);
  }
  assert.equal(await button.getAttribute("aria-pressed"), String(enabled));
  assert.equal((await session.metadata()).snapOptions?.[key], enabled);
}
async function only(session, keys) {
  for (const key of Object.keys(labels))
    await capture(session, key, keys.includes(key), true);
}
async function master(session, enabled, stationary = false) {
  const button = masterButton(session);
  if ((await button.getAttribute("aria-pressed")) !== String(enabled)) {
    if (stationary) await button.evaluate((element) => element.click());
    else await button.click();
    await settle(session);
  }
  assert.equal(await button.getAttribute("aria-pressed"), String(enabled));
  assert.equal(await checkbox(session, names.snap).isChecked(), enabled);
}
async function drawPoint(session, point, dx = 6, dy = 2) {
  const before = await saved(session);
  await session.page
    .getByRole("button", { name: "\u521b\u5efa", exact: true })
    .click();
  await session.page
    .locator(".create-menu")
    .getByRole("button", { name: names.point, exact: true })
    .click();
  const moved = await moveNear(session, point, dx, dy);
  await clickMoved(session, moved);
  await finish(session, sketch(before).entities.length + 1);
  const doc = await saved(session);
  const ids = new Set(sketch(before).entities.map((item) => item.id));
  const added = sketch(doc).entities.filter((item) => !ids.has(item.id));
  assert.equal(added.length, 1, "one real point committed");
  assert.equal(added[0].kind, "point");
  return { moved, entity: added[0], doc };
}
async function drawLine(session, start, end) {
  const before = await saved(session);
  await toolButton(session, names.line).click();
  const first = await moveNear(session, start);
  await clickMoved(session, first);
  const last = await moveNear(session, end);
  await clickMoved(session, last);
  await finish(session, sketch(before).entities.length + 1);
  const doc = await saved(session);
  const ids = new Set(sketch(before).entities.map((item) => item.id));
  const added = sketch(doc).entities.filter((item) => !ids.has(item.id));
  assert.equal(added.length, 1, "one real line committed");
  assert.equal(added[0].kind, "line");
  return { first, last, entity: added[0], doc };
}
function assertRaw(actual, moved) {
  near(actual, moved.raw, 1.1 / moved.state.scale);
  const target = {
    x: (moved.position.local.x - moved.state.origin.x) / moved.state.scale,
    y: (moved.state.origin.y - moved.position.local.y) / moved.state.scale,
  };
  assert(
    Math.hypot(actual.x - target.x, actual.y - target.y) >
      3 / moved.state.scale,
    "capture OFF commits the offset pointer, not the nearby snap target",
  );
}
const gridPoint = (state, x = 25, y = -25) => ({
  x: Math.round(x / state.gridStep) * state.gridStep,
  y: Math.round(y / state.gridStep) * state.gridStep,
});
async function patch(session, target) {
  return session.canvas.evaluate((element, target) => {
    const dpr = element.__cadViewport.dpr;
    const x = Math.max(0, Math.floor((target.x - 10) * dpr));
    const y = Math.max(0, Math.floor((target.y - 10) * dpr));
    const width = Math.min(element.width - x, Math.ceil(20 * dpr));
    const height = Math.min(element.height - y, Math.ceil(20 * dpr));
    return Array.from(
      element.getContext("2d").getImageData(x, y, width, height).data,
    );
  }, target);
}
function pixelDelta(before, after) {
  assert.equal(before.length, after.length);
  let changed = 0;
  for (let at = 0; at < before.length; at += 4)
    if (
      Math.max(
        ...[0, 1, 2].map((channel) =>
          Math.abs(before[at + channel] - after[at + channel]),
        ),
      ) > 3
    )
      changed++;
  return changed;
}
const moves = (session) =>
  session.canvas.evaluate((element) => element.__snapOptionsMoves || 0);
const screenshot = (session, filename) =>
  session.page.screenshot({ path: path.join(output, filename), scale: "css" });
async function check(name, doc, action, options = {}) {
  if (
    process.env.CAD_SNAP_FILTER &&
    !name.toLowerCase().includes(process.env.CAD_SNAP_FILTER.toLowerCase())
  )
    return;
  let session;
  const started = Date.now();
  try {
    session = await open(doc, options);
    const detail = await action(session);
    results.checks.push({
      name,
      passed: true,
      ms: Date.now() - started,
      detail,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.checks.push({
      name,
      passed: false,
      ms: Date.now() - started,
      error: error.stack,
    });
    console.error(`FAIL ${name}: ${error.message}`);
    if (session) {
      results.checks.at(-1).metadata = await session
        .metadata()
        .catch(() => null);
      results.checks.at(-1).document = await session.page
        .evaluate((key) => JSON.parse(localStorage.getItem(key)), storage)
        .catch(() => null);
      await screenshot(session, `${results.checks.length}-failure.png`).catch(
        () => {},
      );
    }
  } finally {
    if (session) await session.context.close();
    await fs.writeFile(
      path.join(output, "results.json"),
      JSON.stringify(results, null, 2),
    );
  }
}

async function exerciseTangent(session) {
  await only(session, ["tangent"]);
  await option(session, names.grid, false);
  await option(session, names.auto, false);
  const before = await saved(session);
  await toolButton(session, names.line).click();
  const noReference = await moveNear(session, tangent);
  assert.equal(
    noReference.state.snap,
    null,
    "no false tangent before the first line point",
  );
  await clickMoved(session, await moveNear(session, anchor, 0, 0));
  const captured = await moveNear(session, tangent);
  assertSnap(captured, "tangent");
  assert.equal(
    captured.state.snap.ref,
    undefined,
    "tangent is a virtual coordinate",
  );
  const eventCount = await moves(session);
  await capture(session, "tangent", false, true);
  assert.equal(
    (await session.metadata()).snap,
    null,
    "tangent OFF clears a stationary cue",
  );
  assert.equal(await moves(session), eventCount);
  await capture(session, "tangent", true, true);
  assert.equal((await session.metadata()).snap?.kind, "tangent");
  await clickMoved(session, captured);
  await finish(session, sketch(before).entities.length + 1);
  const doc = await saved(session);
  const ids = new Set(sketch(before).entities.map((item) => item.id));
  const added = sketch(doc).entities.find((item) => !ids.has(item.id));
  assert.equal(added?.kind, "line");
  near(added.points[0], anchor);
  near(added.points[1], tangent, 1e-4);
  assert.equal(
    sketch(doc).constraints.filter((item) => item.kind === "coincident").length,
    0,
  );
  return {
    noReference: noReference.state.snap,
    cue: captured.state.snap,
    points: added.points,
  };
}
async function inspectLayout(session, filename) {
  await session.page.mouse.move(5, 5);
  await settle(session);
  const toolbar = session.page.locator(".bottom-actions");
  const expected = [names.fit, ...Object.values(labels), names.master];
  assert.equal(
    await toolbar.locator("button").count(),
    7,
    "fit, five capture switches and master",
  );
  for (const name of expected) {
    const button = toolbar.getByRole("button", { name, exact: true });
    assert(await button.isVisible(), `${name} visible`);
    assert.equal(await button.getAttribute("title"), name);
    assert.equal(
      await button.locator("svg").count(),
      1,
      `${name} has its real icon`,
    );
    assert.equal(
      (await button.textContent()).trim(),
      "",
      `${name} stays icon-only`,
    );
  }
  const layout = await toolbar.evaluate((element) => {
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageWidth: document.documentElement.scrollWidth,
      toolbar: rect(element),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      buttons: [...element.querySelectorAll("button")].map((button) => {
        const r = rect(button);
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return {
          title: button.title,
          ...r,
          reachable: hit === button || button.contains(hit),
        };
      }),
    };
  });
  assert(
    layout.pageWidth <= layout.viewport.width + 1,
    "no horizontal page overflow",
  );
  assert(
    layout.scrollWidth <= layout.clientWidth + 1,
    "toolbar does not clip its controls",
  );
  for (const button of layout.buttons) {
    assert(
      button.width >= 20 && button.height >= 20,
      `${button.title} keeps a usable fixed footprint`,
    );
    assert(
      button.x >= layout.toolbar.x - 1 &&
        button.right <= layout.toolbar.right + 1 &&
        button.y >= 0 &&
        button.bottom <= layout.viewport.height &&
        button.x >= 0 &&
        button.right <= layout.viewport.width,
      `${button.title} fits within toolbar and viewport`,
    );
    assert(
      button.reachable,
      `${button.title} is not covered by another element`,
    );
  }
  for (let i = 0; i < layout.buttons.length; i++) {
    for (let j = i + 1; j < layout.buttons.length; j++) {
      const a = layout.buttons[i],
        b = layout.buttons[j];
      assert(
        Math.min(a.right, b.right) - Math.max(a.x, b.x) <= 0.5 ||
          Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= 0.5,
        "toolbar buttons never overlap",
      );
    }
  }
  const raster = await session.canvas.evaluate((element) => {
    const { width, height } = element;
    const pixels = element
      .getContext("2d")
      .getImageData(0, 0, width, height).data;
    let ink = 0;
    for (let at = 0; at < pixels.length; at += 4)
      if (pixels[at] < 200 && pixels[at + 1] < 220 && pixels[at + 2] < 220)
        ink++;
    return { width, height, ink, dpr: element.__cadViewport.dpr };
  });
  assert(raster.ink > 100, "genuine canvas geometry and axes are nonblank");
  assert.equal(raster.dpr, 2);
  await screenshot(session, filename);
  return { layout, raster };
}

try {
  await check(
    "Capture follows coordinate input instead of idle selection",
    mixed(),
    async (session) => {
      const probes = [
        sourceA.points[0],
        midpoint,
        crossing,
        tangent,
        gridPoint(await session.metadata()),
        anchor,
        { x: 0, y: 0 },
      ];
      for (const point of probes)
        assert.equal((await moveNear(session, point)).state.snap, null);

      await moveNear(session, sourceA.points[0]);
      await toolButton(session, names.line).evaluate((element) =>
        element.click(),
      );
      await settle(session);
      // Entering drawing reserves the right dock and shifts the endpoint on screen.
      const target = await moveNear(session, sourceA.points[0]);
      assertSnap(target, "endpoint");
      await session.page.keyboard.press("Escape");
      await settle(session);
      assert.equal((await session.metadata()).snap, null);

      await moveNear(
        session,
        gridPoint(await session.metadata(), 40, -30),
        2,
        1,
      );
      await session.page.mouse.down();
      await moveNear(
        session,
        gridPoint(await session.metadata(), 30, 25),
        2,
        1,
      );
      assert.equal(
        (await session.metadata()).snap,
        null,
        "box selection does not capture",
      );
      await session.page.mouse.up();
      await toolButton(session, names.line).click();
      assertSnap(await moveNear(session, sourceA.points[0]), "endpoint");
      await session.page.keyboard.down("Space");
      await settle(session);
      assert.equal(
        (await session.metadata()).snap,
        null,
        "pan intent suspends capture",
      );
      await session.page.keyboard.up("Space");
      await settle(session);
      assert.equal((await session.metadata()).snap?.kind, "endpoint");
      await session.page.mouse.down({ button: "middle" });
      await settle(session);
      assert.equal(
        (await session.metadata()).snap,
        null,
        "panning suspends capture",
      );
      await session.page.mouse.up({ button: "middle" });
      await settle(session);
      assert.equal((await session.metadata()).snap?.kind, "endpoint");
      await finish(session);

      await toolButton(session, "修剪").click();
      const panel = session.page.getByTestId("parameter-panel");
      await panel.waitFor();
      await panel
        .getByRole("button", { name: "选择对象", exact: true })
        .click();
      assert.equal(
        (await moveNear(session, sourceA.points[0])).state.snap,
        null,
      );
      await panel
        .getByRole("button", { name: "选择修剪位置", exact: true })
        .evaluate((element) => element.click());
      await settle(session);
      assert.equal((await session.metadata()).snap?.kind, "endpoint");
      await panel
        .getByRole("button", { name: "选择对象", exact: true })
        .evaluate((element) => element.click());
      await settle(session);
      assert.equal((await session.metadata()).snap, null);
      await panel
        .getByRole("button", { name: "取消操作", exact: true })
        .click();

      await session.page.locator('button[title="草图尺寸 (D)"]').click();
      assert.equal(
        (await moveNear(session, sourceA.points[0])).state.snap,
        null,
      );
      await finish(session);
      assert.equal((await session.metadata()).snap, null);
      assert.deepEqual((await session.metadata()).snapOptions, allEnabled);
      return { probes: probes.length, target: target.position.local };
    },
  );

  await check(
    "Default controls and grid visibility are independent session state",
    fixture(),
    async (session) => {
      const initialDoc = await saved(session);
      const initial = await session.metadata();
      assert.deepEqual(initial.snapOptions, allEnabled);
      assert.equal(initial.gridVisible, true);
      assert(await checkbox(session, names.grid).isChecked());
      for (const key of Object.keys(labels)) {
        const button = captureButton(session, key);
        assert.equal(await button.getAttribute("title"), labels[key]);
        assert.equal(await button.getAttribute("aria-pressed"), "true");
      }
      assert.equal(
        await session.page
          .locator('.bottom-actions button[title="\u5207\u6362\u7f51\u683c"]')
          .count(),
        0,
      );
      await session.page.mouse.move(5, 5);
      await settle(session);
      const target = await screen(session, gridPoint(initial));
      const visible = await patch(session, target.local);
      await capture(session, "grid", false);
      assert(
        await checkbox(session, names.grid).isChecked(),
        "capture OFF does not hide the grid",
      );
      assert.equal((await session.metadata()).gridVisible, true);
      const captureOff = await patch(session, target.local);
      assert.equal(
        pixelDelta(visible, captureOff),
        0,
        "grid ink is unchanged by capture OFF",
      );
      await option(session, names.grid, false);
      assert.equal((await session.metadata()).gridVisible, false);
      assert.equal((await session.metadata()).snapOptions.grid, false);
      const hidden = await patch(session, target.local);
      const removedPixels = pixelDelta(visible, hidden);
      assert(
        removedPixels > 8,
        "the display checkbox actually removes raster grid lines",
      );
      await capture(session, "grid", true);
      assert.equal(await checkbox(session, names.grid).isChecked(), false);
      assert.equal(
        pixelDelta(hidden, await patch(session, target.local)),
        0,
        "capture ON with display OFF does not paint grid lines",
      );
      assert.deepEqual(
        await saved(session),
        initialDoc,
        "capture flags do not become document properties",
      );
      return {
        snapOptions: (await session.metadata()).snapOptions,
        removedPixels,
      };
    },
    { dpr: 2 },
  );

  await check(
    "Grid clicks snap or stay raw with display ON and OFF",
    fixture(),
    async (session) => {
      await option(session, names.auto, false);
      const samples = [];
      const combinations = [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ];
      const locations = [
        [25, -20],
        [-25, 20],
        [35, -25],
        [-35, 25],
      ];
      for (let index = 0; index < combinations.length; index++) {
        const [visible, enabled] = combinations[index];
        await option(session, names.grid, visible);
        await only(session, enabled ? ["grid"] : []);
        const state = await session.metadata();
        const point = gridPoint(state, ...locations[index]);
        const drawn = await drawPoint(session, point, 6, 3);
        assert.equal(drawn.moved.state.gridVisible, visible);
        if (enabled) {
          assertSnap(drawn.moved, "grid");
          near(drawn.entity.points[0], point);
        } else {
          assert.equal(drawn.moved.state.snap, null);
          assertRaw(drawn.entity.points[0], drawn.moved);
        }
        samples.push({
          visible,
          enabled,
          target: point,
          cue: drawn.moved.state.snap,
          point: drawn.entity.points[0],
        });
      }
      return { samples };
    },
  );

  await check(
    "Endpoint switch gates drawing coordinates and automatic coincidence",
    fixture([sourceA, sourceB]),
    async (session) => {
      await only(session, []);
      assert(
        await checkbox(session, names.auto).isChecked(),
        "auto constraints remain ON for this regression",
      );
      const disabled = await drawLine(
        session,
        sourceA.points[1],
        sourceB.points[0],
      );
      assert.equal(disabled.first.state.snap, null);
      assert.equal(disabled.last.state.snap, null);
      assertRaw(disabled.entity.points[0], disabled.first);
      assertRaw(disabled.entity.points[1], disabled.last);
      assert.equal(
        sketch(disabled.doc).constraints.filter(
          (item) => item.kind === "coincident",
        ).length,
        0,
        "endpoint OFF must not retain an automatic coincidence ref",
      );
      await only(session, ["endpoint"]);
      const enabled = await drawLine(
        session,
        sourceA.points[0],
        sourceB.points[1],
      );
      assertSnap(enabled.first, "endpoint");
      assertSnap(enabled.last, "endpoint");
      assert.equal(enabled.first.state.snap.ref, sourceA.points[0].id);
      assert.equal(enabled.last.state.snap.ref, sourceB.points[1].id);
      near(enabled.entity.points[0], sourceA.points[0]);
      near(enabled.entity.points[1], sourceB.points[1]);
      const coincidence = sketch(enabled.doc).constraints.filter(
        (item) => item.kind === "coincident",
      );
      assert.equal(coincidence.length, 2);
      for (const [added, existing] of [
        [enabled.entity.points[0], sourceA.points[0]],
        [enabled.entity.points[1], sourceB.points[1]],
      ])
        assert(
          coincidence.some(
            (item) =>
              item.refs.includes(added.id) && item.refs.includes(existing.id),
          ),
        );
      return {
        disabled: disabled.entity.points,
        enabled: enabled.entity.points,
        coincidence,
      };
    },
  );

  await check(
    "Midpoint switch controls hover and committed line starts",
    fixture([midSource]),
    async (session) => {
      await option(session, names.auto, false);
      await only(session, ["midpoint"]);
      const enabled = await drawLine(session, midpoint, { x: 28, y: -21 });
      assertSnap(enabled.first, "midpoint");
      near(enabled.entity.points[0], midpoint);
      await only(session, []);
      const disabled = await drawLine(session, midpoint, { x: -30, y: -23 });
      assert.equal(
        disabled.first.state.snap,
        null,
        "disabled endpoints do not leak back as ordinary points",
      );
      assertRaw(disabled.entity.points[0], disabled.first);
      return {
        enabled: enabled.entity.points[0],
        disabled: disabled.entity.points[0],
      };
    },
  );

  await check(
    "External circle and arc tangents require a first line point",
    fixture([circle, anchorPoint]),
    async (session) => {
      const circleResult = await exerciseTangent(session);
      const arc = entity(
        "arc",
        "tangent-arc",
        [
          [0, 0],
          [0, 10],
          [-10, 0],
        ],
        { ccw: true },
      );
      const arcSession = await open(fixture([arc, anchorPoint]));
      try {
        return { circle: circleResult, arc: await exerciseTangent(arcSession) };
      } finally {
        await arcSession.context.close();
      }
    },
  );

  for (const sample of [
    {
      name: "endpoint",
      doc: fixture([sourceA]),
      target: sourceA.points[0],
      options: ["endpoint"],
      kind: "coincident",
      source: sourceA.points[0].id,
    },
    {
      name: "midpoint",
      doc: fixture([midSource]),
      target: midpoint,
      options: ["midpoint"],
      kind: "midpoint",
      source: midSource.id,
    },
    {
      name: "center",
      doc: fixture([
        entity("circle", "center-source", [[21, -13]], { radius: 6 }),
      ]),
      target: { x: 21, y: -13 },
      options: [],
      kind: "coincident",
      source: "center-source_p0",
    },
    {
      name: "intersection",
      doc: fixture([crossA, crossB]),
      target: crossing,
      options: ["intersection"],
      kind: "intersection",
      source: crossA.id,
    },
    {
      name: "origin",
      doc: fixture(),
      target: { x: 0, y: 0 },
      options: [],
      kind: "origin",
    },
  ]) {
    await check(
      `Automatic binding persists for ${sample.name}`,
      sample.doc,
      async (session) => {
        await only(session, sample.options);
        await option(session, names.auto, true);
        const drawn = await drawPoint(session, sample.target, 4, 1);
        assertSnap(
          drawn.moved,
          sample.name === "center" ? "point" : sample.name,
        );
        near(drawn.entity.points[0], sample.target);
        const binding = sketch(drawn.doc).constraints.find(
          (item) =>
            item.kind === sample.kind &&
            item.refs.includes(drawn.entity.points[0].id),
        );
        assert(binding, `${sample.name} creates a persisted binding`);
        if (sample.source) assert(binding.refs.includes(sample.source));
        const restored = await open(drawn.doc);
        try {
          const doc = await saved(restored);
          assert(
            sketch(doc).constraints.some((item) => item.id === binding.id),
            "binding survives save/load validation and solving",
          );
          near(
            sketch(doc).entities.find((item) => item.id === drawn.entity.id)
              .points[0],
            sample.target,
          );
        } finally {
          await restored.context.close();
        }
        return { binding, point: drawn.entity.points[0] };
      },
    );
  }

  await check(
    "Automatic binding keeps a tangent endpoint on its circle",
    fixture([circle, anchorPoint]),
    async (session) => {
      await only(session, ["tangent"]);
      await option(session, names.auto, true);
      const drawn = await drawLine(session, anchor, tangent);
      assertSnap(drawn.last, "tangent");
      near(drawn.entity.points[0], anchor);
      near(drawn.entity.points[1], tangent);
      const constraints = sketch(drawn.doc).constraints;
      assert(
        constraints.some(
          (item) =>
            item.kind === "tangent" &&
            item.refs.includes(drawn.entity.id) &&
            item.refs.includes(circle.id),
        ),
      );
      assert(
        constraints.some(
          (item) =>
            item.kind === "onCurve" &&
            item.refs.includes(drawn.entity.points[1].id) &&
            item.refs.includes(circle.id),
        ),
      );
      await screenshot(session, "automatic-tangent-binding.png");
      return {
        points: drawn.entity.points,
        constraints: constraints.filter((item) =>
          item.refs.includes(circle.id),
        ),
      };
    },
  );

  const movableMidpointDoc = fixture([midSource]);
  movableMidpointDoc.sketches[0].constraints =
    movableMidpointDoc.sketches[0].constraints.filter(
      (item) => !item.refs.includes(midSource.id),
    );
  await check(
    "Automatic binding follows source midpoint dragging and supports undo redo",
    movableMidpointDoc,
    async (session) => {
      await only(session, ["midpoint"]);
      await option(session, names.auto, true);
      const drawn = await drawLine(session, midpoint, { x: 28, y: -21 });
      await master(session, false);
      const from = await screen(session, midSource.points[0]),
        to = await screen(session, { x: -33, y: 27 });
      await session.page.mouse.move(from.x, from.y);
      await session.page.mouse.down();
      await session.page.mouse.move(to.x, to.y, { steps: 10 });
      await session.page.mouse.up();
      await settle(session);
      const moved = await saved(session);
      const source = sketch(moved).entities.find(
          (item) => item.id === midSource.id,
        ),
        attached = sketch(moved).entities.find(
          (item) => item.id === drawn.entity.id,
        );
      const expected = {
        x: (source.points[0].x + source.points[1].x) / 2,
        y: (source.points[0].y + source.points[1].y) / 2,
      };
      near(attached.points[0], expected);
      assert(
        Math.hypot(
          attached.points[0].x - midpoint.x,
          attached.points[0].y - midpoint.y,
        ) > 1,
        "binding moves with source instead of retaining captured XY",
      );
      await session.page.keyboard.press("Control+z");
      await settle(session);
      const undone = await saved(session);
      near(
        sketch(undone).entities.find((item) => item.id === drawn.entity.id)
          .points[0],
        midpoint,
      );
      await session.page.keyboard.press("Control+Shift+z");
      await settle(session);
      const redone = await saved(session);
      near(
        sketch(redone).entities.find((item) => item.id === drawn.entity.id)
          .points[0],
        expected,
      );
      await screenshot(session, "automatic-midpoint-follow.png");
      return { expected, actual: attached.points[0] };
    },
  );

  const preciseStart = { x: -1000, y: 20 };
  const lengthSquared = preciseStart.x ** 2 + preciseStart.y ** 2;
  const tangentOffset = (10 * Math.sqrt(lengthSquared - 100)) / lengthSquared;
  const preciseTangent = {
    x: (preciseStart.x * 100) / lengthSquared + preciseStart.y * tangentOffset,
    y: (preciseStart.y * 100) / lengthSquared - preciseStart.x * tangentOffset,
  };
  await check(
    "Near-axis tangent capture survives automatic axis inference",
    fixture([
      circle,
      entity("point", "precise-anchor", [[preciseStart.x, preciseStart.y]]),
    ]),
    async (session) => {
      await only(session, ["tangent"]);
      await option(session, names.auto, true);
      const before = await saved(session);
      await toolButton(session, names.line).click();
      await clickMoved(session, await moveNear(session, preciseStart, 0, 0));
      const last = await moveNear(session, preciseTangent);
      assertSnap(last, "tangent");
      await clickMoved(session, last);
      await finish(session, sketch(before).entities.length + 1);
      const doc = await saved(session);
      const ids = new Set(sketch(before).entities.map((item) => item.id));
      const added = sketch(doc).entities.find((item) => !ids.has(item.id));
      assert.equal(added?.kind, "line");
      near(added.points[0], preciseStart);
      near(added.points[1], preciseTangent);
      assert(
        !sketch(doc).constraints.some(
          (c) =>
            ["horizontal", "vertical"].includes(c.kind) &&
            c.refs.includes(added.id),
        ),
        "no conflicting inferred direction pulls the captured endpoint away",
      );
      assert(
        sketch(doc).constraints.some(
          (c) =>
            c.kind === "coincident" && c.refs.includes("precise-anchor_p0"),
        ),
        "real point coincidence remains enabled",
      );
      const [a, b] = added.points;
      const error =
        Math.abs(b.x * (b.x - a.x) + b.y * (b.y - a.y)) /
        (10 * Math.hypot(b.x - a.x, b.y - a.y));
      assert(error < 1e-8, `committed line is tangent (${error})`);
      return { points: added.points, angularError: error };
    },
  );

  const dragLine = entity("line", "tangent-drag-line", [
    [anchor.x, anchor.y],
    [-4, 11],
  ]);
  const tangentDragDoc = fixture([circle, dragLine]);
  tangentDragDoc.sketches[0].constraints =
    tangentDragDoc.sketches[0].constraints.filter(
      (c) => !c.refs.includes(dragLine.id),
    );
  tangentDragDoc.sketches[0].constraints.push({
    id: "tangent-drag-start-fixed",
    kind: "fixed",
    refs: ["tangent-drag-line_p0"],
  });
  await check(
    "Line endpoint dragging uses the other endpoint for tangent capture",
    tangentDragDoc,
    async (session) => {
      await only(session, ["tangent"]);
      const first = await screen(session, dragLine.points[1]);
      await session.page.mouse.move(first.x, first.y);
      await session.page.mouse.down();
      const last = await moveNear(session, tangent);
      assertSnap(last, "tangent");
      await session.page.mouse.up();
      await settle(session);
      const doc = await saved(session);
      const changed = sketch(doc).entities.find(
        (item) => item.id === dragLine.id,
      );
      near(changed.points[0], anchor);
      near(changed.points[1], tangent);
      return { points: changed.points, cue: last.state.snap };
    },
  );

  const intersectionDoc = fixture([crossA, crossB]);
  for (const [id, visible, point] of [
    ["inactive", true, { x: -22, y: 27 }],
    ["hidden", false, { x: -20, y: -18 }],
  ]) {
    const entities = [
      entity("line", `${id}-a`, [
        [point.x - 16, point.y],
        [point.x + 19, point.y],
      ]),
      entity("line", `${id}-b`, [
        [point.x, point.y - 18],
        [point.x, point.y + 7],
      ]),
    ];
    intersectionDoc.sketches.push({
      id,
      name: id,
      visible,
      entities,
      constraints: [],
    });
  }
  await check(
    "Line intersections are virtual captures from active visible paths only",
    intersectionDoc,
    async (session) => {
      await only(session, ["intersection"]);
      await toolButton(session, names.line).click();
      const enabled = await moveNear(session, crossing);
      assertSnap(enabled, "intersection");
      assert.equal(enabled.state.snap.ref, undefined);
      for (const point of [
        { x: -22, y: 27 },
        { x: -20, y: -18 },
      ])
        assert.equal(
          (await moveNear(session, point)).state.snap,
          null,
          "inactive or hidden sketch is not a capture source",
        );
      await only(session, []);
      const disabled = await drawPoint(session, crossing);
      assert.equal(disabled.moved.state.snap, null);
      assertRaw(disabled.entity.points[0], disabled.moved);
      await only(session, ["intersection"]);
      const drawn = await drawPoint(session, crossing);
      assertSnap(drawn.moved, "intersection");
      near(drawn.entity.points[0], crossing);
      assert.equal(drawn.moved.state.snap.ref, undefined);
      assert.equal(
        sketch(drawn.doc).constraints.filter(
          (item) => item.kind === "coincident",
        ).length,
        0,
        "virtual intersections must not generate point coincidence refs",
      );
      return {
        enabled: enabled.state.snap,
        disabled: disabled.entity.points[0],
        committed: drawn.entity.points[0],
      };
    },
  );

  await check(
    "Circle and Bezier intersections commit exact native circle coordinates",
    fixture([
      entity("circle", "curve-circle", [[12, 9]], { radius: 10 }),
      entity("bezier", "crossing-curve", [
        [-14, 15],
        [0, 15],
        [26, 15],
        [38, 15],
      ]),
    ]),
    async (session) => {
      await only(session, ["intersection"]);
      await toolButton(session, names.line).click();
      const target = { x: 4, y: 15 };
      const captured = await moveNear(session, target, 2, 1);
      assert.equal(captured.state.snap?.kind, "intersection");
      const actual = {
        x:
          (captured.state.snap.x - captured.state.origin.x) /
          captured.state.scale,
        y:
          (captured.state.origin.y - captured.state.snap.y) /
          captured.state.scale,
      };
      // Paper's circle is cubic-backed, so compare its intersection within geometric approximation tolerance.
      near(actual, target, 0.01);
      assert.equal(captured.state.snap.ref, undefined);
      await capture(session, "intersection", false, true);
      assert.equal((await session.metadata()).snap, null);
      await capture(session, "intersection", true, true);
      const drawn = await drawPoint(session, target, 2, 1);
      near(drawn.entity.points[0], target);
      assert(
        Math.abs(
          Math.hypot(
            drawn.entity.points[0].x - 12,
            drawn.entity.points[0].y - 9,
          ) - 10,
        ) <= 1e-7,
        "the persistent intersection must satisfy the exact circle radius",
      );
      assert.equal(
        sketch(drawn.doc).constraints.filter(
          (item) => item.kind === "coincident",
        ).length,
        0,
      );
      return {
        analytic: target,
        actual,
        cue: captured.state.snap,
        committed: drawn.entity.points[0],
      };
    },
  );

  await check(
    "Master and checkbox disable all captures and retain configured flags",
    mixed(),
    async (session) => {
      await only(session, ["endpoint", "tangent"]);
      await toolButton(session, names.line).click();
      assertSnap(await moveNear(session, sourceA.points[0]), "endpoint");
      await master(session, false, true);
      assert.equal((await session.metadata()).snap, null);
      await only(session, ["grid", "midpoint", "intersection"]);
      const retained = {
        grid: true,
        midpoint: true,
        endpoint: false,
        tangent: false,
        intersection: true,
      };
      assert.deepEqual((await session.metadata()).snapOptions, retained);
      const grid = gridPoint(await session.metadata());
      const probes = [
        sourceA.points[0],
        midpoint,
        crossing,
        grid,
        tangent,
        { x: 0, y: 0 },
      ];
      for (const point of probes)
        assert.equal((await moveNear(session, point)).state.snap, null);
      await toolButton(session, names.line).click();
      await clickMoved(session, await moveNear(session, anchor, 0, 0));
      assert.equal(
        (await moveNear(session, tangent)).state.snap,
        null,
        "meaningful reference does not bypass master OFF",
      );
      await master(session, true, true);
      assert.deepEqual((await session.metadata()).snapOptions, retained);
      assert.notEqual(
        (await moveNear(session, tangent)).state.snap?.kind,
        "tangent",
      );
      await finish(session);
      await toolButton(session, names.line).click();
      assert.notEqual(
        (await moveNear(session, sourceA.points[0])).state.snap?.kind,
        "endpoint",
      );
      assertSnap(await moveNear(session, midpoint), "midpoint");
      assertSnap(await moveNear(session, crossing), "intersection");
      assertSnap(await moveNear(session, grid, 2, 1), "grid");
      await option(session, names.snap, false);
      assert.equal(
        await masterButton(session).getAttribute("aria-pressed"),
        "false",
      );
      assert.deepEqual((await session.metadata()).snapOptions, retained);
      await option(session, names.snap, true);
      assert.equal(
        await masterButton(session).getAttribute("aria-pressed"),
        "true",
      );
      assert.deepEqual((await session.metadata()).snapOptions, retained);
      return { retained, probes: probes.length };
    },
  );

  await check(
    "Every capture switch clears and restores a stationary raster cue",
    mixed(),
    async (session) => {
      await option(session, names.grid, false);
      await option(session, names.auto, false);
      const samples = [];
      const points = {
        grid: gridPoint(await session.metadata()),
        midpoint,
        endpoint: sourceA.points[0],
        tangent,
        intersection: crossing,
      };
      for (const key of Object.keys(labels)) {
        await only(session, [key]);
        await toolButton(session, names.line).click();
        if (key === "tangent") {
          await clickMoved(session, await moveNear(session, anchor, 0, 0));
        }
        const captured = await moveNear(session, points[key], 4, 2);
        assertSnap(captured, key);
        const before = await patch(session, captured.position.local);
        const eventCount = await moves(session);
        await capture(session, key, false, true);
        assert.equal(
          await moves(session),
          eventCount,
          "toggle does not generate a canvas pointer move",
        );
        assert.equal(
          (await session.metadata()).snap,
          null,
          `${key} has no stale marker`,
        );
        const cleared = await patch(session, captured.position.local);
        const changedPixels = pixelDelta(before, cleared);
        assert(changedPixels > 8, `${key} clears actual raster cue pixels`);
        await capture(session, key, true, true);
        assert.equal(await moves(session), eventCount);
        assert.equal(
          (await session.metadata()).snap?.kind,
          key,
          `${key} restores without pointer movement`,
        );
        assert(
          pixelDelta(cleared, await patch(session, captured.position.local)) >
            8,
        );
        samples.push({
          key,
          cue: captured.state.snap,
          changedPixels,
          eventCount,
        });
        if (key === "tangent") await finish(session);
      }
      return { samples };
    },
    { dpr: 2 },
  );

  const layoutDoc = fixture([sourceA, circle]);
  layoutDoc.sketches[0].name = "Snap options fixture with a long name";
  await check(
    "Desktop and mobile fit all seven toolbar icons without overflow",
    layoutDoc,
    async (session) => {
      const desktop = await inspectLayout(session, "desktop.png");
      const mobileSession = await open(layoutDoc, {
        viewport: { width: 390, height: 844 },
        dpr: 2,
      });
      try {
        return {
          desktop,
          mobile: await inspectLayout(mobileSession, "mobile.png"),
        };
      } finally {
        await mobileSession.context.close();
      }
    },
    { dpr: 2 },
  );

  assert(results.checks.length > 0, "at least one snap-options check executed");
  assert(
    results.wasm.some((response) => response.status === 200),
    "actual native WASM solver loaded",
  );
  assert.deepEqual(results.consoleErrors, []);
  assert.deepEqual(results.pageErrors, []);
  assert.deepEqual(results.externalRequests, []);
  results.passed = results.checks.every((item) => item.passed);
  if (!results.passed) process.exitCode = 1;
} catch (error) {
  results.passed = false;
  results.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  results.finished = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  console.log(
    `${results.checks.filter((item) => item.passed).length}/${results.checks.length} snap-options checks passed; artifacts: ${output}`,
  );
}
