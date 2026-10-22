import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/endpoint-capture",
);
const storage = "sketchworks.document.v1";
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
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
const documentFixture = (entities, constraints = []) => ({
  version: 1,
  name: "Endpoint capture fixture",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "endpoint-fixture",
      name: "Endpoint fixture",
      visible: true,
      entities,
      constraints,
    },
  ],
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
const fixture = (entities, constraints = []) =>
  documentFixture(
    [guide, ...entities],
    [{ id: "extent-fixed", kind: "fixed", refs: [guide.id] }, ...constraints],
  );
const sketch = (doc) => doc.sketches[0];
const byId = (doc, id) => sketch(doc).entities.find((item) => item.id === id);
const near = (actual, expected, tolerance = 1e-6) =>
  assert(
    Math.hypot(actual.x - expected.x, actual.y - expected.y) <= tolerance,
    `expected (${expected.x},${expected.y}), got (${actual.x},${actual.y})`,
  );
const button = (page, name) =>
  page
    .getByRole("button", { name, exact: true })
    .or(page.locator(`button:not(.entity-row)[title=${JSON.stringify(name)}]`));

async function open(
  fixtureDoc,
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
    await page.addInitScript(
      ({ fixtureDoc, storage }) => {
        localStorage.setItem(storage, JSON.stringify(fixtureDoc));
        // Keep the native draw calls intact while observing the actual Canvas cue.
        const prototype = CanvasRenderingContext2D.prototype;
        for (const name of ["fillText", "strokeText", "arc"]) {
          const original = prototype[name];
          prototype[name] = function (...args) {
            if (this.canvas.matches?.('[data-testid="cad-canvas"]')) {
              const log = (this.canvas.__endpointDraws ??= []);
              if (log.length < 4000)
                log.push({
                  name,
                  args,
                  fill: this.fillStyle,
                  stroke: this.strokeStyle,
                });
            }
            return original.apply(this, args);
          };
        }
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
    const initial = await saved(session);
    assert.deepEqual(
      sketch(initial).entities.map((item) => item.id),
      sketch(fixtureDoc).entities.map((item) => item.id),
      "fixture loaded without falling back to demo or human storage",
    );
    return session;
  } catch (error) {
    await context.close();
    throw error;
  }
}
async function settle(session) {
  await session.page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
      ),
  );
}
async function saved(session) {
  await session.page.waitForTimeout(750);
  await session.page
    .locator('.save-dot[data-saved="true"]')
    .waitFor({ state: "attached" });
  return session.page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storage,
  );
}
// Fixed-count tools commit the final canvas pick without a confirm button;
// Escape waits until the persisted sketch really contains the new geometry.
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
async function screen(session, point) {
  const state = await session.metadata(),
    box = await session.canvas.boundingBox();
  const local = {
    x: state.origin.x + point.x * state.scale,
    y: state.origin.y - point.y * state.scale,
  };
  assert(
    local.x >= 12 &&
      local.y >= 12 &&
      local.x <= state.width - 12 &&
      local.y <= state.height - 12,
    `visible target ${JSON.stringify({ point, local, state })}`,
  );
  return { x: box.x + local.x, y: box.y + local.y, local };
}
async function moveNear(session, point, dx = 7, dy = 1) {
  const position = await screen(session, point);
  await session.canvas.evaluate((element) => {
    element.__endpointDraws = [];
  });
  await session.page.mouse.move(position.x + dx, position.y + dy);
  await settle(session);
  return { state: await session.metadata(), position };
}
async function option(session, name, enabled) {
  await session.page
    .getByRole("checkbox", { name, exact: true })
    .setChecked(enabled);
  await settle(session);
}
async function disableGrid(session) {
  await option(session, "\u7f51\u683c", false);
  const capture = session.page.getByRole("button", {
    name: "\u7f51\u683c\u6355\u83b7",
    exact: true,
  });
  if ((await capture.getAttribute("aria-pressed")) === "true")
    await capture.click();
  await settle(session);
}
async function endpoint(session, point, ref, dx = 9.2, dy = 1) {
  const { state, position } = await moveNear(session, point, dx, dy);
  assert.equal(
    state.snap?.kind,
    "endpoint",
    `endpoint cue at ${JSON.stringify(point)}, got ${JSON.stringify(state.snap)}`,
  );
  near(state.snap, position.local);
  if (ref === null)
    assert.equal(
      state.snap.ref,
      undefined,
      "derived endpoint must have no constraint ref",
    );
  else
    assert.equal(
      state.snap.ref,
      ref,
      "base endpoint must retain its stable point ID",
    );
  const ink = await cuePixels(session, position.local);
  assert(
    ink.greenRing > 8 * state.dpr,
    "actual green circular endpoint indicator rasterized outside the ordinary handle",
  );
  assert(ink.endpointText, "actual Canvas endpoint label is drawn");
  assert(ink.circularDraw, "endpoint indicator uses a small Canvas circle");
  return { snap: state.snap, dpr: state.dpr, scale: state.scale, ink };
}
async function cuePixels(session, target) {
  return session.canvas.evaluate((element, target) => {
    const state = element.__cadViewport,
      dpr = state.dpr,
      radius = 10;
    const x = Math.max(0, Math.floor((target.x - radius) * dpr));
    const y = Math.max(0, Math.floor((target.y - radius) * dpr));
    const width = Math.min(element.width - x, Math.ceil(2 * radius * dpr));
    const height = Math.min(element.height - y, Math.ceil(2 * radius * dpr));
    const data = element
      .getContext("2d")
      .getImageData(x, y, width, height).data;
    let greenRing = 0,
      amber = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index],
        g = data[index + 1],
        b = data[index + 2];
      const px = (x + ((index / 4) % width) + 0.5) / dpr;
      const py = (y + Math.floor(index / 4 / width) + 0.5) / dpr;
      const distance = Math.hypot(px - target.x, py - target.y);
      if (
        distance > 3.2 &&
        distance < 8.5 &&
        g > r * 1.18 &&
        g > b * 1.12 &&
        r < 170
      )
        greenRing++;
      if (r > 160 && g > 80 && g < 190 && b < 110) amber++;
    }
    const draws = element.__endpointDraws || [];
    return {
      greenRing,
      amber,
      endpointText: draws.some(
        (draw) => /Text$/.test(draw.name) && draw.args[0] === "\u7aef\u70b9",
      ),
      circularDraw: draws.some(
        (draw) =>
          draw.name === "arc" &&
          Math.hypot(draw.args[0] - target.x, draw.args[1] - target.y) < 1 &&
          draw.args[2] >= 3.3 &&
          draw.args[2] <= 9,
      ),
    };
  }, target);
}
async function panZoom(session) {
  const box = await session.canvas.boundingBox(),
    before = await session.metadata();
  const x = box.x + box.width * 0.53,
    y = box.y + box.height * 0.53;
  await session.page.mouse.move(x, y);
  await session.page.mouse.down({ button: "middle" });
  await session.page.mouse.move(x + 23, y - 17, { steps: 5 });
  await session.page.mouse.up({ button: "middle" });
  await settle(session);
  const panned = await session.metadata();
  assert(Math.abs(panned.origin.x - before.origin.x - 23) <= 1);
  assert(Math.abs(panned.origin.y - before.origin.y + 17) <= 1);
  await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await session.page.mouse.wheel(0, 100);
  await session.page.waitForFunction(
    (scale) =>
      document.querySelector('[data-testid="cad-canvas"]').__cadViewport
        .scale !== scale,
    before.scale,
  );
  await settle(session);
  return {
    before: { origin: before.origin, scale: before.scale },
    after: await session.metadata(),
  };
}
// Pan/zoom through real controls so creation fixtures remain on uncovered canvas.
async function prepareDrawingView(session) {
  if (session.creationViewPrepared) return;
  session.creationViewPrepared = true;
  const zoomOut = session.page.locator('.view-controls button[title="缩小"]');
  await zoomOut.click();
  await zoomOut.click();
  const box = await session.canvas.boundingBox();
  const narrow = box.width < 700;
  const from = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.65 };
  await session.page.mouse.move(from.x, from.y);
  await session.page.mouse.down({ button: "middle" });
  await session.page.mouse.move(
    from.x - (narrow ? 0 : 148),
    from.y + (narrow ? box.height * 0.28 : 0),
    { steps: 5 },
  );
  await session.page.mouse.up({ button: "middle" });
  await settle(session);
}
// Endpoint/grid cues are only captured while a drawing tool collects points,
// so hover expectations enter the line tool explicitly.
async function startDrawing(session) {
  await button(session.page, "\u76f4\u7ebf").click();
  await settle(session);
  await prepareDrawingView(session);
}
async function lineBetween(session, start, end, offsets = [7, 1]) {
  const before = await entityCount(session);
  await button(session.page, "\u76f4\u7ebf").click();
  await prepareDrawingView(session);
  const first = await moveNear(session, start, ...offsets);
  await session.page.mouse.click(
    first.position.x + offsets[0],
    first.position.y + offsets[1],
  );
  await settle(session);
  const last = await moveNear(session, end, ...offsets);
  await session.page.mouse.click(
    last.position.x + offsets[0],
    last.position.y + offsets[1],
  );
  await settle(session);
  // The second pick auto-commits the segment; Escape leaves the still-active
  // line tool only once the persisted document gained the new entity.
  await commitEntities(session, before + 1);
  await session.page.keyboard.press("Escape");
  await button(session.page, "\u9009\u62e9").click();
  return {
    first: first.state.snap,
    last: last.state.snap,
    doc: await saved(session),
  };
}
async function dragStart(session, start, end, offset = [7, 1]) {
  const from = await screen(session, start),
    to = await screen(session, end);
  await session.page.mouse.move(from.x, from.y);
  await session.page.mouse.down();
  await session.page.mouse.move(to.x + offset[0], to.y + offset[1], {
    steps: 8,
  });
  await settle(session);
  return { from, to, state: await session.metadata() };
}
async function screenshot(session, filename) {
  await session.page.screenshot({
    path: path.join(output, filename),
    scale: "css",
  });
}
async function check(name, fixtureDoc, action, options = {}) {
  if (
    process.env.CAD_ENDPOINT_FILTER &&
    !name.toLowerCase().includes(process.env.CAD_ENDPOINT_FILTER.toLowerCase())
  )
    return;
  let session;
  const started = Date.now();
  try {
    session = await open(fixtureDoc, options);
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

const paths = [
  entity("line", "line", [
    [-42, 26],
    [-26, 26],
  ]),
  entity(
    "arc",
    "arc",
    [
      [-8, 26],
      [0, 26],
      [-8, 34],
    ],
    { ccw: true },
  ),
  entity("spline", "spline", [
    [16, 24],
    [24, 32],
    [31, 19],
    [40, 27],
  ]),
  entity("bezier", "bezier", [
    [-42, -18],
    [-35, -6],
    [-24, -30],
    [-18, -18],
  ]),
  entity(
    "conic",
    "conic",
    [
      [-4, -18],
      [4, -4],
      [14, -18],
    ],
    { weight: 0.6 },
  ),
  entity("circle", "circle", [[29, -20]], { radius: 7 }),
  entity(
    "ellipse",
    "ellipse",
    [
      [45, 0],
      [53, 0],
    ],
    { ry: 4 },
  ),
];
const endpointProbes = paths
  .filter((item) =>
    ["line", "arc", "spline", "bezier", "conic"].includes(item.kind),
  )
  .flatMap((item) => {
    const points =
      item.kind === "arc"
        ? item.points.slice(1)
        : [item.points[0], item.points.at(-1)];
    return points.map((point) => ({ kind: item.kind, point, ref: point.id }));
  });
const sourceA = entity("line", "source-a", [
  [-25, 0],
  [-10, 5],
]);
const sourceB = entity("line", "source-b", [
  [20, 17],
  [37, 22],
]);
const drawingFixture = () => fixture([sourceA, sourceB]);
const moving = entity("line", "moving", [
  [-25, -14],
  [-12, -7],
]);
const target = entity("line", "target", [
  [22, 17],
  [36, 10],
]);
const draggingFixture = () =>
  fixture(
    [moving, target],
    [{ id: "target-fixed", kind: "fixed", refs: [target.id] }],
  );
const derivedBase = entity("line", "derived-source", [
  [-20, -15],
  [-5, -10],
]);
const derived = entity(
  "line",
  "derived",
  [
    [20, 15],
    [35, 20],
  ],
  { sourceId: derivedBase.id, transform: { kind: "translate", x: 40, y: 30 } },
);

try {
  for (const dpr of [1, 2]) {
    await check(
      `Path endpoints and ten-CSS-pixel radius at DPR ${dpr}, initial and panned/zoomed`,
      documentFixture(paths),
      async (session) => {
        await startDrawing(session);
        const samples = [];
        for (const transform of ["initial", "panzoom"]) {
          if (transform === "panzoom") await panZoom(session);
          for (const probe of endpointProbes) {
            samples.push({
              transform,
              kind: probe.kind,
              ...(await endpoint(session, probe.point, probe.ref)),
            });
            const outside = await moveNear(session, probe.point, 10.6, 0);
            assert.notEqual(
              outside.state.snap?.kind,
              "endpoint",
              "new hover capture ends outside ten CSS pixels",
            );
          }
        }
        await endpoint(session, paths[0].points[0], "line_p0", 7, 1);
        await screenshot(session, `desktop-dpr${dpr}-endpoint.png`);
        return { samples };
      },
      { dpr },
    );
  }
  await check(
    "Spline interior nodes, arc/circle centers and Bezier/conic handles are not endpoints",
    documentFixture(paths),
    async (session) => {
      await disableGrid(session);
      await startDrawing(session);
      const probes = [
        { point: paths[2].points[1], kind: "point" },
        { point: paths[1].points[0], kind: "point" },
        { point: paths[5].points[0], kind: "point" },
        { point: paths[3].points[1] },
        { point: paths[3].points[2] },
        { point: paths[4].points[1] },
        { point: paths[6].points[1] },
      ];
      const samples = [];
      for (const probe of probes) {
        const { state } = await moveNear(session, probe.point, 1, 1);
        assert.notEqual(state.snap?.kind, "endpoint");
        if (probe.kind) assert.equal(state.snap?.kind, probe.kind);
        samples.push({ point: probe.point, snap: state.snap });
      }
      return { samples };
    },
  );
  await check(
    "Endpoint priority over a closer midpoint, circle center and grid node",
    fixture([
      entity("line", "short-line", [
        [-10.3, 12.4],
        [-8.5, 12.4],
      ]),
      entity("circle", "near-center", [[-9.65, 12.4]], { radius: 5 }),
      entity("line", "near-grid", [
        [20.6, 0],
        [35, -8],
      ]),
    ]),
    async (session) => {
      await startDrawing(session);
      const info = await session.metadata();
      assert(
        0.9 * info.scale < 10,
        "fixture places midpoint within endpoint radius",
      );
      const overCenter = await endpoint(
        session,
        { x: -10.3, y: 12.4 },
        "short-line_p0",
        0.65 * info.scale,
        0,
      );
      const overMidpoint = await endpoint(
        session,
        { x: -10.3, y: 12.4 },
        "short-line_p0",
        0.9 * info.scale - 0.8,
        0,
      );
      const gridX = Math.round(20.6 / info.gridStep) * info.gridStep;
      assert(Math.abs(gridX - 20.6) * info.scale < 10);
      const overGrid = await endpoint(
        session,
        { x: 20.6, y: 0 },
        "near-grid_p0",
        (gridX - 20.6) * info.scale,
        0,
      );
      return { overCenter, overMidpoint, overGrid };
    },
  );
  await check(
    "Endpoint capture works with grid OFF and master snap OFF removes its cue",
    drawingFixture(),
    async (session) => {
      await disableGrid(session);
      await startDrawing(session);
      const enabled = await endpoint(
        session,
        sourceA.points[1],
        "source-a_p1",
        7,
        1,
      );
      await option(session, "\u5438\u9644", false);
      const disabled = await moveNear(session, sourceA.points[1], 7, 1);
      assert.equal(disabled.state.snap, null);
      const ink = await cuePixels(session, disabled.position.local);
      assert.equal(ink.endpointText, false);
      assert.equal(ink.circularDraw, false);
      await option(session, "\u5438\u9644", true);
      const restored = await endpoint(
        session,
        sourceA.points[1],
        "source-a_p1",
        7,
        1,
      );
      return { enabled, disabled: disabled.state.snap, restored };
    },
  );
  await check(
    "Drawing start and end captures create real coincident refs and follow GCS source movement",
    drawingFixture(),
    async (session) => {
      assert(
        await session.page
          .getByRole("checkbox", {
            name: "\u81ea\u52a8\u7ea6\u675f",
            exact: true,
          })
          .isChecked(),
        "autoConstraint is enabled by default",
      );
      await disableGrid(session);
      const drawn = await lineBetween(
        session,
        sourceA.points[1],
        sourceB.points[0],
      );
      assert.equal(drawn.first?.kind, "endpoint");
      assert.equal(drawn.last?.kind, "endpoint");
      const added = sketch(drawn.doc).entities.find(
        (item) => ![guide.id, sourceA.id, sourceB.id].includes(item.id),
      );
      assert(added?.kind === "line");
      near(added.points[0], sourceA.points[1]);
      near(added.points[1], sourceB.points[0]);
      const coincident = sketch(drawn.doc).constraints.filter(
        (item) => item.kind === "coincident",
      );
      assert.equal(coincident.length, 2);
      for (const [newPoint, existingPoint] of [
        [added.points[0], sourceA.points[1]],
        [added.points[1], sourceB.points[0]],
      ]) {
        assert.equal(
          coincident.filter(
            (item) =>
              item.refs.length === 2 &&
              item.refs.includes(newPoint.id) &&
              item.refs.includes(existingPoint.id),
          ).length,
          1,
        );
      }
      await option(session, "\u5438\u9644", false);
      const movedTo = { x: -6, y: 9 };
      await dragStart(session, sourceA.points[1], movedTo, [0, 0]);
      await session.page.mouse.up();
      const movedDoc = await saved(session),
        attached = byId(movedDoc, added.id);
      const solvedSource = byId(movedDoc, sourceA.id).points[1];
      near(solvedSource, movedTo, 1e-4);
      near(attached.points[0], solvedSource);
      near(attached.points[1], byId(movedDoc, sourceB.id).points[0]);
      assert.equal(
        sketch(movedDoc).constraints.filter(
          (item) => item.kind === "coincident",
        ).length,
        2,
      );
      return {
        first: drawn.first,
        last: drawn.last,
        coincident,
        movedTo,
        attached,
      };
    },
  );
  await check(
    "Disabling autoConstraint aligns endpoint coordinates without creating coincidence",
    drawingFixture(),
    async (session) => {
      await disableGrid(session);
      await option(session, "\u81ea\u52a8\u7ea6\u675f", false);
      const drawn = await lineBetween(
        session,
        sourceA.points[1],
        sourceB.points[0],
      );
      const added = sketch(drawn.doc).entities.at(-1);
      near(added.points[0], sourceA.points[1]);
      near(added.points[1], sourceB.points[0]);
      assert.equal(drawn.first?.kind, "endpoint");
      assert.equal(drawn.last?.kind, "endpoint");
      assert.equal(
        sketch(drawn.doc).constraints.filter(
          (item) => item.kind === "coincident",
        ).length,
        0,
      );
      return {
        points: added.points,
        constraints: sketch(drawn.doc).constraints,
      };
    },
  );
  await check(
    "Master snap OFF draws raw coordinates and no endpoint coincidence",
    drawingFixture(),
    async (session) => {
      await option(session, "\u5438\u9644", false);
      const drawn = await lineBetween(
        session,
        sourceA.points[1],
        sourceB.points[0],
      );
      const state = await session.metadata();
      const added = sketch(drawn.doc).entities.at(-1);
      assert.equal(drawn.first, null);
      assert.equal(drawn.last, null);
      near(
        added.points[0],
        {
          x: sourceA.points[1].x + 7 / state.scale,
          y: sourceA.points[1].y - 1 / state.scale,
        },
        1 / state.scale,
      );
      near(
        added.points[1],
        {
          x: sourceB.points[0].x + 7 / state.scale,
          y: sourceB.points[0].y - 1 / state.scale,
        },
        1 / state.scale,
      );
      assert(
        Math.hypot(
          added.points[0].x - sourceA.points[1].x,
          added.points[0].y - sourceA.points[1].y,
        ) >
          4 / state.scale,
      );
      assert.equal(
        sketch(drawn.doc).constraints.filter(
          (item) => item.kind === "coincident",
        ).length,
        0,
      );
      return { points: added.points, scale: state.scale };
    },
  );
  await check(
    "Independent endpoint drag commits the exact indicated target with one undo and redo",
    draggingFixture(),
    async (session) => {
      await disableGrid(session);
      const initial = await saved(session);
      const drag = await dragStart(session, moving.points[1], target.points[0]);
      assert.equal(drag.state.snap?.kind, "endpoint");
      assert.equal(drag.state.snap.ref, target.points[0].id);
      near(drag.state.snap, drag.to.local);
      const live = drag.state.handles.find(
        (handle) => handle.pointId === moving.points[1].id,
      );
      near(live, drag.to.local, 1);
      const ink = await cuePixels(session, drag.to.local);
      assert(ink.greenRing > 8);
      await screenshot(session, "desktop-endpoint-drag.png");
      await session.page.mouse.up();
      const committed = await saved(session);
      near(byId(committed, moving.id).points[1], target.points[0]);
      await button(session.page, "\u64a4\u9500 (Ctrl+Z)").click();
      const undone = await saved(session);
      assert.deepEqual(
        undone,
        initial,
        "one undo restores the entire pre-gesture document",
      );
      assert(
        await button(session.page, "\u64a4\u9500 (Ctrl+Z)").isDisabled(),
        "drag creates exactly one undo entry",
      );
      await button(session.page, "\u91cd\u505a (Ctrl+Shift+Z)").click();
      const redone = await saved(session);
      assert.deepEqual(redone, committed);
      return {
        cue: drag.state.snap,
        live,
        ink,
        endpoint: byId(committed, moving.id).points[1],
      };
    },
  );
  await check(
    "Endpoint drag preserves twelve-pixel hysteresis and same-target render deduplication",
    draggingFixture(),
    async (session) => {
      await disableGrid(session);
      const drag = await dragStart(
        session,
        moving.points[1],
        target.points[0],
        [1, 1],
      );
      assert.equal(drag.state.snap?.kind, "endpoint");
      const before = await session.metadata(),
        samples = [];
      for (let index = 0; index < 12; index++) {
        await session.page.mouse.move(
          drag.to.x + 1 + (index % 3),
          drag.to.y + 1 + (index % 2),
        );
        await settle(session);
      }
      const after = await session.metadata();
      assert(after.stats.frames > before.stats.frames);
      assert.equal(
        after.stats.baseDraws,
        before.stats.baseDraws,
        "same captured endpoint does not rebuild static geometry",
      );
      assert.equal(after.stats.compiledPaths, before.stats.compiledPaths);
      for (const dx of [9.5, 10.5, 11.7]) {
        await session.page.mouse.move(drag.to.x + dx, drag.to.y);
        await settle(session);
        const state = await session.metadata();
        samples.push({ dx, snap: state.snap });
        assert.equal(state.snap?.kind, "endpoint");
        near(state.snap, drag.to.local);
      }
      await session.page.mouse.move(drag.to.x + 13.2, drag.to.y);
      await settle(session);
      assert.equal(
        (await session.metadata()).snap,
        null,
        "capture releases after twelve CSS pixels",
      );
      await session.page.mouse.move(drag.to.x + 7, drag.to.y + 1);
      await settle(session);
      assert.equal((await session.metadata()).snap?.kind, "endpoint");
      await session.page.mouse.up();
      near(byId(await saved(session), moving.id).points[1], target.points[0]);
      return { before: before.stats, after: after.stats, samples };
    },
  );
  await check(
    "Pointerup final endpoint target supersedes the last move without a synthetic move",
    fixture(
      [
        moving,
        entity("line", "release-a", [
          [15, 15],
          [28, 22],
        ]),
        entity("line", "release-b", [
          [30, -12],
          [42, -22],
        ]),
      ],
      [
        { id: "release-a-fixed", kind: "fixed", refs: ["release-a"] },
        { id: "release-b-fixed", kind: "fixed", refs: ["release-b"] },
      ],
    ),
    async (session) => {
      await disableGrid(session);
      const first = { x: 15, y: 15 },
        final = { x: 30, y: -12 };
      await dragStart(session, moving.points[1], first, [1, 1]);
      const to = await screen(session, final);
      await session.canvas.evaluate((element) => {
        element.__releaseEvents = [];
        for (const type of ["pointermove", "pointerup"])
          element.addEventListener(type, (event) =>
            element.__releaseEvents.push({
              type: event.type,
              x: event.clientX,
              y: event.clientY,
            }),
          );
      });
      const cdp = await session.context.newCDPSession(session.page);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: to.x + 6,
        y: to.y + 1,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await settle(session);
      const events = await session.canvas.evaluate(
        (element) => element.__releaseEvents,
      );
      await session.page.mouse.up();
      assert(events.some((event) => event.type === "pointerup"));
      assert(!events.some((event) => event.type === "pointermove"));
      const doc = await saved(session);
      near(byId(doc, moving.id).points[1], final);
      return { first, final, events, point: byId(doc, moving.id).points[1] };
    },
  );
  await check(
    "Incompatible hard constraints retain geometry without a false endpoint cue",
    fixture(
      [
        entity("line", "hard-line", [
          [0, 0],
          [10, 0],
        ]),
        entity("line", "hard-target", [
          [5, 5],
          [15, 15],
        ]),
      ],
      [
        { id: "hard-origin", kind: "fixed", refs: ["hard-line_p0"] },
        { id: "hard-length", kind: "length", refs: ["hard-line"], value: 10 },
        { id: "hard-horizontal", kind: "horizontal", refs: ["hard-line"] },
        { id: "hard-target-fixed", kind: "fixed", refs: ["hard-target"] },
      ],
    ),
    async (session) => {
      await disableGrid(session);
      const initial = await saved(session);
      const drag = await dragStart(
        session,
        { x: 10, y: 0 },
        { x: 5, y: 5 },
        [0, 0],
      );
      assert.equal(
        drag.state.snap,
        null,
        "infeasible endpoint must not advertise a committed capture",
      );
      await session.page.mouse.up();
      const doc = await saved(session);
      near(byId(doc, "hard-line").points[0], { x: 0, y: 0 });
      near(byId(doc, "hard-line").points[1], { x: 10, y: 0 });
      assert.deepEqual(sketch(doc).constraints, sketch(initial).constraints);
      return { cue: drag.state.snap, points: byId(doc, "hard-line").points };
    },
  );
  await check(
    "Deleting a source invalidates stale endpoint IDs and capture coordinates",
    drawingFixture(),
    async (session) => {
      await disableGrid(session);
      await startDrawing(session);
      const captured = await endpoint(
        session,
        sourceA.points[1],
        "source-a_p1",
        7,
        1,
      );
      await session.page
        .locator(".entity-row")
        .filter({ hasText: sourceA.id })
        .click();
      await session.page.keyboard.press("Delete");
      const deleted = await saved(session);
      assert.equal(byId(deleted, sourceA.id), undefined);
      const after = await moveNear(session, sourceA.points[1], 7, 1);
      assert.equal(after.state.snap, null);
      assert(
        !after.state.handles.some(
          (item) => item.pointId === sourceA.points[1].id,
        ),
      );
      const drawn = await lineBetween(
        session,
        sourceA.points[1],
        sourceB.points[0],
      );
      assert.equal(drawn.first, null);
      assert(
        !sketch(drawn.doc).constraints.some((item) =>
          item.refs.includes(sourceA.points[1].id),
        ),
      );
      return {
        captured,
        after: after.state.snap,
        constraints: sketch(drawn.doc).constraints,
      };
    },
  );
  await check(
    "Derived endpoint captures coordinates only, without a derived or source coincidence ref",
    fixture(
      [derivedBase, derived],
      [{ id: "derived-source-fixed", kind: "fixed", refs: [derivedBase.id] }],
    ),
    async (session) => {
      await disableGrid(session);
      await startDrawing(session);
      const captured = await endpoint(session, derived.points[0], null, 7, 1);
      await screenshot(session, "desktop-derived-endpoint.png");
      const drawn = await lineBetween(session, derived.points[0], {
        x: 30,
        y: -12,
      });
      assert.equal(drawn.first?.kind, "endpoint");
      assert.equal(drawn.first.ref, undefined);
      const added = sketch(drawn.doc).entities.at(-1);
      near(added.points[0], derived.points[0]);
      const forbidden = new Set([
        derived.id,
        ...derived.points.map((point) => point.id),
        ...derivedBase.points.map((point) => point.id),
      ]);
      assert(
        !sketch(drawn.doc).constraints.some(
          (item) =>
            item.kind === "coincident" &&
            item.refs.some((ref) => forbidden.has(ref)),
        ),
      );
      assert.equal(
        sketch(drawn.doc).entities.length,
        4,
        "creation succeeds through the native solver",
      );
      return {
        captured,
        points: added.points,
        constraints: sketch(drawn.doc).constraints,
      };
    },
  );
  await check(
    "Detached derived endpoints retain stable IDs and become valid coincidence refs",
    fixture(
      [derivedBase, derived],
      [{ id: "detached-source-fixed", kind: "fixed", refs: [derivedBase.id] }],
    ),
    async (session) => {
      await disableGrid(session);
      await session.page
        .locator(".entity-row")
        .filter({ hasText: derived.id })
        .filter({ hasNotText: derivedBase.id })
        .click();
      await button(session.page, "\u89e3\u9664\u5173\u8054").click();
      // 解除关联 now confirms through the shared command parameter panel.
      const detachPanel = session.page.getByTestId("parameter-panel");
      await detachPanel.waitFor();
      await detachPanel.locator('button[type="submit"]').click();
      await detachPanel.waitFor({ state: "detached" });
      const detached = await saved(session);
      assert.equal(byId(detached, derived.id).sourceId, undefined);
      assert.equal(
        byId(detached, derived.id).points[0].id,
        derived.points[0].id,
      );
      await startDrawing(session);
      const captured = await endpoint(
        session,
        derived.points[0],
        derived.points[0].id,
        7,
        1,
      );
      const drawn = await lineBetween(session, derived.points[0], {
        x: 30,
        y: -12,
      });
      const added = sketch(drawn.doc).entities.at(-1);
      assert.equal(
        sketch(drawn.doc).constraints.filter(
          (item) =>
            item.kind === "coincident" &&
            item.refs.includes(derived.points[0].id) &&
            item.refs.includes(added.points[0].id),
        ).length,
        1,
      );
      return { captured, constraints: sketch(drawn.doc).constraints };
    },
  );
  await check(
    "Derived geometry changed by a source drag is excluded from stationary endpoint capture",
    fixture([
      entity("line", "moving-source", [
        [-20, 0],
        [-5, 0],
      ]),
      entity(
        "line",
        "moving-derived",
        [
          [-20, 1.8],
          [-5, 1.8],
        ],
        {
          sourceId: "moving-source",
          transform: { kind: "translate", x: 0, y: 1.8 },
        },
      ),
    ]),
    async (session) => {
      await disableGrid(session);
      const state = await session.metadata();
      assert(
        1.8 * state.scale > 7,
        "derived body starts outside the source hit tolerance",
      );
      const start = await screen(session, { x: -12.5, y: 0 });
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      const samples = [];
      for (const dy of [-4, -8, -12, -16]) {
        await session.page.mouse.move(start.x, start.y + dy);
        await settle(session);
        const current = await session.metadata();
        const handle = current.handles.find(
          (item) => item.pointId === "moving-source_p0",
        );
        assert.equal(
          current.snap,
          null,
          "derived points dependent on this source are not stationary targets",
        );
        assert(
          Math.abs(handle.y - (state.origin.y + dy)) <= 1,
          "source translation follows the pointer without derived self-capture",
        );
        samples.push({ dy, handle, snap: current.snap });
      }
      await session.page.mouse.up();
      const doc = await saved(session),
        source = byId(doc, "moving-source"),
        copy = byId(doc, "moving-derived");
      near(copy.points[0], {
        x: source.points[0].x,
        y: source.points[0].y + 1.8,
      });
      return { samples, source, copy };
    },
  );
  await check(
    "Coincident-connected moving endpoints are excluded from endpoint snap references",
    fixture(
      [
        entity("line", "connected-a", [
          [-20, 10],
          [0, 10],
        ]),
        entity("line", "connected-b", [
          [0, 10],
          [20, 20],
        ]),
      ],
      [
        {
          id: "connected-coincidence",
          kind: "coincident",
          refs: ["connected-a_p1", "connected-b_p0"],
        },
      ],
    ),
    async (session) => {
      await disableGrid(session);
      const start = await screen(session, { x: 0, y: 10 }),
        samples = [];
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      for (const dx of [4, 8, 12, 16]) {
        await session.page.mouse.move(start.x + dx, start.y + 2);
        await settle(session);
        const state = await session.metadata();
        assert.equal(
          state.snap,
          null,
          "constraint-connected peer is not a stationary endpoint target",
        );
        const a = state.handles.find(
          (item) => item.pointId === "connected-a_p1",
        );
        near(a, { x: start.local.x + dx, y: start.local.y + 2 }, 1);
        samples.push({ dx, snap: state.snap, handle: a });
      }
      await session.page.mouse.up();
      const doc = await saved(session);
      near(
        byId(doc, "connected-a").points[1],
        byId(doc, "connected-b").points[0],
      );
      return { samples, constraints: sketch(doc).constraints };
    },
  );
  await check(
    "Grid capture remains an amber square rather than an endpoint cue",
    drawingFixture(),
    async (session) => {
      await startDrawing(session);
      const state = await session.metadata();
      const point = {
        x: Math.round(35 / state.gridStep) * state.gridStep,
        y: Math.round(-25 / state.gridStep) * state.gridStep,
      };
      const moved = await moveNear(session, point, 2, 1);
      assert.equal(moved.state.snap?.kind, "grid");
      const ink = await cuePixels(session, moved.position.local);
      assert(ink.amber > 8);
      assert.equal(ink.endpointText, false);
      assert.equal(ink.circularDraw, false);
      await screenshot(session, "desktop-grid-amber.png");
      return { point, snap: moved.state.snap, ink };
    },
  );
  await check(
    "Mobile DPR 2 endpoint cue is visible, correctly framed and circular",
    documentFixture([
      entity("line", "mobile-line", [
        [-25, -12],
        [20, 15],
      ]),
    ]),
    async (session) => {
      await startDrawing(session);
      const captured = await endpoint(
        session,
        { x: 20, y: 15 },
        "mobile-line_p1",
        7,
        1,
      );
      const state = await session.metadata();
      assert.equal(state.dpr, 2);
      const backing = await session.canvas.evaluate((element) => ({
        width: element.width,
        height: element.height,
      }));
      assert(Math.abs(backing.width - Math.round(state.width * 2)) <= 1);
      assert(Math.abs(backing.height - Math.round(state.height * 2)) <= 1);
      await screenshot(session, "mobile-dpr2-endpoint.png");
      return {
        captured,
        backing,
        viewport: { width: state.width, height: state.height },
      };
    },
    { dpr: 2, viewport: { width: 390, height: 844 } },
  );
  assert(results.checks.length > 0, "at least one endpoint case executed");
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
    `${results.checks.filter((item) => item.passed).length}/${results.checks.length} endpoint checks passed; artifacts: ${output}`,
  );
}
