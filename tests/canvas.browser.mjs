import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/canvas-focused",
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
  performance: [],
  consoleErrors: [],
  pageErrors: [],
  externalRequests: [],
};
const contexts = [];
let currentPage;
await fs.mkdir(output, { recursive: true });

const entity = (kind, id, coords, extra = {}) => ({
  id,
  kind,
  name: `Test ${kind}`,
  points: coords.map(([x, y], index) => ({ id: `${id}_p${index}`, x, y })),
  ...extra,
});
const document = (entities, constraints = []) => ({
  version: 1,
  name: "Canvas fixture",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "canvas-fixture",
      name: "草图 1",
      visible: true,
      entities,
      constraints,
    },
  ],
});
const assets = [
  entity("line", "line", [
    [0, 45],
    [18, 45],
  ]),
  entity("circle", "circle", [[30, 45]], { radius: 7 }),
  entity(
    "arc",
    "arc",
    [
      [55, 45],
      [62, 45],
      [55, 52],
    ],
    { ccw: true },
  ),
  entity(
    "ellipse",
    "ellipse",
    [
      [85, 45],
      [97, 49],
    ],
    { ry: 4 },
  ),
  entity("spline", "spline", [
    [0, 20],
    [5, 28],
    [14, 15],
    [20, 24],
  ]),
  entity("bezier", "bezier", [
    [30, 16],
    [36, 30],
    [45, 4],
    [51, 18],
  ]),
  entity(
    "conic",
    "conic",
    [
      [60, 18],
      [66, 30],
      [75, 18],
    ],
    { weight: 0.6 },
  ),
  entity("point", "point", [[87, 17]]),
  entity("text", "text", [[40, 0]], {
    text: "Canvas",
    fontSize: 4,
    rotation: 25,
  }),
  entity(
    "line",
    "construction",
    [
      [-10, -10],
      [100, -10],
    ],
    { construction: true },
  ),
];
const assetProbes = [
  { id: "line", point: { x: 9, y: 45 } },
  { id: "circle", point: { x: 30 + 7 / Math.SQRT2, y: 45 + 7 / Math.SQRT2 } },
  { id: "arc", point: { x: 55 + 7 / Math.SQRT2, y: 45 + 7 / Math.SQRT2 } },
  {
    id: "ellipse",
    point: { x: 85 - 16 / Math.sqrt(160), y: 45 + 48 / Math.sqrt(160) },
  },
  { id: "spline", point: { x: 5, y: 28 } },
  { id: "bezier", point: { x: 40.5, y: 17 } },
  { id: "conic", point: { x: 66.9375, y: 22.5 } },
  { id: "point", point: { x: 87, y: 17 } },
  { id: "construction", point: { x: 45, y: -10 }, radius: 9 },
];

async function check(name, action) {
  try {
    const detail = await action();
    results.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.checks.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
async function openFixture(
  fixture,
  { dpr = 1, viewport = { width: 1440, height: 900 } } = {},
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: dpr,
  });
  contexts.push(context);
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
  const page = await context.newPage();
  currentPage = page;
  page.on("console", (message) => {
    if (message.type() === "error") results.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => results.pageErrors.push(error.message));
  await page.addInitScript(
    ({ fixture, storage }) =>
      localStorage.setItem(storage, JSON.stringify(fixture)),
    { fixture, storage },
  );
  const start = Date.now();
  await page.goto(url);
  await page
    .locator(".loading-overlay")
    .waitFor({ state: "hidden", timeout: 120000 });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('[data-testid="cad-canvas"]');
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.__cadViewport?.renderer === "canvas2d" &&
        canvas.__cadViewport.stats.frames > 0
      );
    },
    undefined,
    { timeout: 120000 },
  );
  const canvas = page.getByTestId("cad-canvas");
  const viewportState = () =>
    canvas.evaluate((element) => element.__cadViewport);
  return { context, page, canvas, viewportState, loadMs: Date.now() - start };
}
async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
const fixtureDoc = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storage);
async function saved(page) {
  await page.waitForTimeout(700);
  await page.locator('.save-dot[data-saved="true"]').waitFor();
  return fixtureDoc(page);
}
async function screen(session, point) {
  const state = await session.viewportState(),
    box = await session.canvas.boundingBox();
  return {
    x: box.x + state.origin.x + point.x * state.scale,
    y: box.y + state.origin.y - point.y * state.scale,
  };
}
async function clickWorld(session, point) {
  const position = await screen(session, point);
  await session.page.mouse.click(position.x, position.y);
  await settle(session.page);
}
const selectedRows = (page) => page.locator(".entity-row.selected").count();
async function bodyPixel(session, point, radius = 3) {
  const state = await session.viewportState();
  return session.canvas.evaluate(
    (element, { point, state, radius }) => {
      const cx = state.origin.x + point.x * state.scale,
        cy = state.origin.y - point.y * state.scale;
      const x = Math.max(0, Math.floor((cx - radius) * state.dpr)),
        y = Math.max(0, Math.floor((cy - radius) * state.dpr));
      const width = Math.min(
          element.width - x,
          Math.ceil(2 * radius * state.dpr),
        ),
        height = Math.min(
          element.height - y,
          Math.ceil(2 * radius * state.dpr),
        );
      const data = element
        .getContext("2d")
        .getImageData(x, y, width, height).data;
      let coloredPixels = 0,
        first;
      for (let at = 0; at < data.length; at += 4) {
        const r = data[at],
          g = data[at + 1],
          b = data[at + 2];
        if (
          Math.min(r, g, b) < 190 &&
          Math.max(r, g, b) - Math.min(r, g, b) > 25
        ) {
          coloredPixels++;
          first ??= {
            x: (x + ((at / 4) % width) + 0.5) / state.dpr,
            y: (y + Math.floor(at / 4 / width) + 0.5) / state.dpr,
          };
        }
      }
      return { coloredPixels, first };
    },
    { point, state, radius },
  );
}
async function assertSurface(session, expectedDpr) {
  const surface = await session.canvas.evaluate((element) => {
    const state = element.__cadViewport;
    const drawing = element.getContext("2d");
    const pixels = drawing.getImageData(
      0,
      0,
      element.width,
      element.height,
    ).data;
    let coloredPixels = 0;
    for (let at = 0; at < pixels.length; at += 4)
      if (
        Math.min(pixels[at], pixels[at + 1], pixels[at + 2]) < 190 &&
        Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) -
          Math.min(pixels[at], pixels[at + 1], pixels[at + 2]) >
          25
      )
        coloredPixels++;
    return {
      isCanvas: element instanceof HTMLCanvasElement,
      renderer: state.renderer,
      backingWidth: element.width,
      backingHeight: element.height,
      width: state.width,
      height: state.height,
      dpr: state.dpr,
      sceneDom: element.parentElement.querySelectorAll(
        ":scope > svg, [data-entity-id], [data-point-id], .dimension",
      ).length,
      canvasCount: element.parentElement.querySelectorAll("canvas").length,
      coloredPixels,
      stats: state.stats,
    };
  });
  assert(surface.isCanvas);
  assert.equal(surface.renderer, "canvas2d");
  assert.equal(surface.dpr, expectedDpr);
  assert.equal(surface.canvasCount, 1);
  assert.equal(
    surface.sceneDom,
    0,
    "no hidden SVG geometry or per-entity DOM hit regions",
  );
  assert(
    Math.abs(surface.backingWidth - Math.round(surface.width * expectedDpr)) <=
      1,
  );
  assert(
    Math.abs(
      surface.backingHeight - Math.round(surface.height * expectedDpr),
    ) <= 1,
  );
  assert(surface.coloredPixels > 100, "actual nonblank CAD bitmap");
  return surface;
}
async function assertAssets(session) {
  const probes = [];
  for (const probe of assetProbes) {
    const pixels = await bodyPixel(session, probe.point, probe.radius);
    assert(
      pixels.coloredPixels > 1,
      `${probe.id} has actual colored pixels away from its control handles`,
    );
    probes.push({ id: probe.id, pixels: pixels.coloredPixels });
  }
  const text = await session.canvas.evaluate((element) => {
    const state = element.__cadViewport,
      corners = [];
    const angle = (25 * Math.PI) / 180;
    for (const x of [0, 16])
      for (const y of [-1, 4.5])
        corners.push({
          x: 40 + x * Math.cos(angle) - y * Math.sin(angle),
          y: x * Math.sin(angle) + y * Math.cos(angle),
        });
    const minX = Math.min(
        ...corners.map((point) => state.origin.x + point.x * state.scale),
      ),
      maxX = Math.max(
        ...corners.map((point) => state.origin.x + point.x * state.scale),
      );
    const minY = Math.min(
        ...corners.map((point) => state.origin.y - point.y * state.scale),
      ),
      maxY = Math.max(
        ...corners.map((point) => state.origin.y - point.y * state.scale),
      );
    const x = Math.max(0, Math.floor(minX * state.dpr)),
      y = Math.max(0, Math.floor(minY * state.dpr));
    const width = Math.min(
        element.width - x,
        Math.ceil((maxX - minX) * state.dpr),
      ),
      height = Math.min(
        element.height - y,
        Math.ceil((maxY - minY) * state.dpr),
      );
    const data = element
      .getContext("2d")
      .getImageData(x, y, width, height).data;
    let pixels = 0,
      first;
    for (let at = 0; at < data.length; at += 4)
      if (
        data[at + 1] > data[at] * 1.1 &&
        data[at + 1] > data[at + 2] * 1.05 &&
        data[at] < 190
      ) {
        pixels++;
        first ??= {
          x: (x + ((at / 4) % width) + 0.5) / state.dpr,
          y: (y + Math.floor(at / 4 / width) + 0.5) / state.dpr,
        };
      }
    return { pixels, first };
  });
  assert(text.pixels > 10, "rotated text has real upright glyph ink");
  return { probes, text };
}
async function dragPoint(session, pointId, dx, dy) {
  await settle(session.page);
  const handle = (await session.viewportState()).handles.find(
    (handle) => handle.pointId === pointId,
  );
  assert(handle, `visible Canvas control ${pointId}`);
  const box = await session.canvas.boundingBox();
  await session.page.mouse.move(box.x + handle.x, box.y + handle.y);
  await session.page.mouse.down();
  await session.page.mouse.move(box.x + handle.x + dx, box.y + handle.y + dy, {
    steps: 8,
  });
  await session.page.mouse.up();
  return saved(session.page);
}
async function editDimension(session, id, value) {
  await session.page.waitForFunction(
    (id) =>
      document
        .querySelector('[data-testid="cad-canvas"]')
        .__cadViewport.dimensions.some((dimension) => dimension.id === id),
    id,
  );
  const dimension = (await session.viewportState()).dimensions.find(
    (dimension) => dimension.id === id,
  );
  assert(
    dimension.x >= 0 &&
      dimension.x < (await session.viewportState()).width &&
      dimension.y >= 0 &&
      dimension.y < (await session.viewportState()).height,
    `dimension ${id} is visible`,
  );
  const box = await session.canvas.boundingBox();
  await session.page.mouse.dblclick(box.x + dimension.x, box.y + dimension.y);
  const input = session.page.getByTestId("dimension-input");
  await input.waitFor();
  await input.fill(String(value));
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  await session.page.keyboard.press("Escape");
  return saved(session.page);
}

async function performanceFixture(count) {
  const entities = Array.from({ length: count }, (_, index) => {
    const x = (index % 100) * 8,
      y = Math.floor(index / 100) * 8;
    return entity("line", `perf_${index}`, [
      [x, y],
      [x + 3, y + 0.5],
    ]);
  });
  const session = await openFixture(document(entities));
  await session.page
    .getByRole("checkbox", { name: "吸附", exact: true })
    .uncheck();
  await settle(session.page);
  const initial = await session.viewportState();
  assert.equal(initial.stats.sceneEntities, count);
  assert(
    initial.stats.cachedPaths >= count,
    "real paths compiled and cached for the loaded scene",
  );
  const frameTimes = [],
    box = await session.canvas.boundingBox();
  await session.page.mouse.move(
    Math.round(box.x + box.width / 2),
    Math.round(box.y + box.height / 2),
  );
  for (let step = 0; step < 11; step++) {
    const before = await session.viewportState();
    await session.page.mouse.wheel(0, -100);
    await session.page.waitForFunction(
      (scale) =>
        document.querySelector('[data-testid="cad-canvas"]').__cadViewport
          .scale !== scale,
      before.scale,
    );
    const frame = await session.viewportState();
    assert(Number.isFinite(frame.stats.renderMs) && frame.stats.renderMs >= 0);
    frameTimes.push(frame.stats.renderMs);
  }
  const zoomed = await session.viewportState();
  assert(
    zoomed.stats.visibleEntities > 0 &&
      zoomed.stats.visibleEntities < count / 4,
    "viewport culls the offscreen majority of the actual scene",
  );
  assert.equal(
    zoomed.stats.compiledPaths,
    initial.stats.compiledPaths,
    "zoom reuses unchanged paths",
  );
  const world = {
    x: (zoomed.width / 2 - zoomed.origin.x) / zoomed.scale,
    y: (zoomed.origin.y - zoomed.height / 2) / zoomed.scale,
  };
  const col = Math.max(0, Math.min(99, Math.round(world.x / 8))),
    row = Math.max(
      0,
      Math.min(Math.ceil(count / 100) - 1, Math.round(world.y / 8)),
    );
  const index = row * 100 + col;
  await clickWorld(session, { x: col * 8 + 1.5, y: row * 8 + 0.25 });
  assert(
    await session.page
      .locator(".entity-row")
      .nth(index)
      .evaluate((element) => element.classList.contains("selected")),
    "actual indexed hit selects a visible line",
  );
  const picked = await session.viewportState();
  assert(
    picked.stats.hitCandidates > 0 && picked.stats.hitCandidates < count / 10,
    "hit testing uses a limited spatial candidate set",
  );
  const cached = await session.viewportState();
  for (let index = 0; index < 12; index++)
    await session.page.mouse.move(
      box.x + box.width * 0.45 + index,
      box.y + box.height * 0.4 + (index % 3),
    );
  await settle(session.page);
  const moved = await session.viewportState();
  assert.equal(
    moved.stats.baseDraws,
    cached.stats.baseDraws,
    "cursor-only movement does not redraw the retained scene",
  );
  assert.equal(
    moved.stats.compiledPaths,
    cached.stats.compiledPaths,
    "cursor-only movement does not recompile geometry",
  );
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const detail = {
    entities: count,
    dpr: initial.dpr,
    viewport: { width: initial.width, height: initial.height },
    loadMs: session.loadMs,
    initial: initial.stats,
    zoomed: zoomed.stats,
    picked: picked.stats,
    afterCursor: moved.stats,
    frameTimesMs: frameTimes,
    medianRenderMs: sorted[Math.floor(sorted.length / 2)],
    p95RenderMs: sorted[Math.floor((sorted.length - 1) * 0.95)],
  };
  results.performance.push(detail);
  await session.page.mouse.move(5, 5);
  await session.page.screenshot({
    path: path.join(output, `scene-${count}.png`),
    scale: "css",
  });
  await session.context.close();
  return detail;
}

try {
  const desktop = await openFixture(document(assets));
  await check("Actual Canvas DPR1 renders every geometry type", async () => {
    const surface = await assertSurface(desktop, 1),
      assetPixels = await assertAssets(desktop);
    await desktop.page.screenshot({
      path: path.join(output, "desktop.png"),
      scale: "css",
    });
    return { surface, assetPixels };
  });
  await check(
    "Shape body picking, empty deselection, Ctrl multiselect, and marquee",
    async () => {
      await clickWorld(desktop, { x: 9, y: 45 });
      assert.equal(await selectedRows(desktop.page), 1);
      assert(
        await desktop.page
          .locator(".entity-row")
          .nth(0)
          .evaluate((element) => element.classList.contains("selected")),
      );
      await clickWorld(desktop, { x: 105, y: 32 });
      assert.equal(await selectedRows(desktop.page), 0);
      await clickWorld(desktop, { x: 9, y: 45 });
      await desktop.page.keyboard.down("Control");
      await clickWorld(desktop, assetProbes[1].point);
      await desktop.page.keyboard.up("Control");
      assert.equal(await selectedRows(desktop.page), 2);
      await clickWorld(desktop, { x: 105, y: 32 });
      const start = await screen(desktop, { x: -3, y: 55 }),
        end = await screen(desktop, { x: 39, y: 35 });
      await desktop.page.mouse.move(start.x, start.y);
      await desktop.page.mouse.down();
      await desktop.page.mouse.move(end.x, end.y, { steps: 8 });
      await desktop.page.mouse.up();
      await settle(desktop.page);
      assert.equal(await selectedRows(desktop.page), 2);
      return { selected: await selectedRows(desktop.page) };
    },
  );
  await check(
    "Real control drags edit line and spline geometry; rotated text is pickable",
    async () => {
      const text = (await assertAssets(desktop)).text,
        box = await desktop.canvas.boundingBox();
      await desktop.page.mouse.click(
        box.x + text.first.x,
        box.y + text.first.y,
      );
      await settle(desktop.page);
      assert(
        await desktop.page
          .locator(".entity-row")
          .nth(8)
          .evaluate((element) => element.classList.contains("selected")),
        "rotated text glyph ink is pickable",
      );
      await desktop.page
        .getByRole("checkbox", { name: "吸附", exact: true })
        .uncheck();
      await clickWorld(desktop, { x: 9, y: 45 });
      const before = await saved(desktop.page),
        scale = (await desktop.viewportState()).scale;
      const moved = await dragPoint(desktop, "line_p1", 22, -14);
      const endpoint = moved.sketches[0].entities.find(
        (entity) => entity.id === "line",
      ).points[1];
      const original = before.sketches[0].entities.find(
        (entity) => entity.id === "line",
      ).points[1];
      assert(
        Math.abs((endpoint.x - original.x) * scale - 22) <= 1 &&
          Math.abs((endpoint.y - original.y) * scale - 14) <= 1,
      );
      await clickWorld(desktop, { x: 5, y: 28 });
      assert(
        await desktop.page
          .locator(".entity-row")
          .nth(4)
          .evaluate((element) => element.classList.contains("selected")),
        "spline body is pickable",
      );
      const updated = await dragPoint(desktop, "spline_p1", 13, -11);
      const fitted = updated.sketches[0].entities.find(
        (entity) => entity.id === "spline",
      ).points[1];
      assert(
        Math.hypot(fitted.x - 5, fitted.y - 28) > 0.1,
        "spline fit control truly changed the document",
      );
      await clickWorld(desktop, { x: 105, y: 32 });
      return { endpoint, fitted, textPixels: text.pixels };
    },
  );
  await check(
    "Retained Canvas scene stays cached during cursor-only movement",
    async () => {
      await clickWorld(desktop, { x: 105, y: 32 });
      await desktop.page
        .getByRole("checkbox", { name: "吸附", exact: true })
        .check();
      await settle(desktop.page);
      const before = await desktop.viewportState();
      for (let index = 0; index < 20; index++) {
        const position = await screen(desktop, {
          x: 93 + (index % 3),
          y: 30 + (index % 2),
        });
        await desktop.page.mouse.move(position.x, position.y);
      }
      await settle(desktop.page);
      const after = await desktop.viewportState();
      assert(
        after.stats.frames > before.stats.frames,
        "cursor overlay frames were actually rendered",
      );
      assert.equal(after.stats.baseDraws, before.stats.baseDraws);
      assert.equal(after.stats.compiledPaths, before.stats.compiledPaths);
      return { before: before.stats, after: after.stats };
    },
  );
  await desktop.context.close();

  for (const spec of [
    { name: "desktop-dpr2", dpr: 2, viewport: { width: 1440, height: 900 } },
    { name: "mobile-dpr2", dpr: 2, viewport: { width: 390, height: 844 } },
  ])
    await check(
      `${spec.name} uses sharp physical backing pixels and renders every asset`,
      async () => {
        const session = await openFixture(document(assets), spec);
        const surface = await assertSurface(session, spec.dpr),
          assetPixels = await assertAssets(session);
        const layout = await session.page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          height: innerHeight,
          scrollHeight: document.documentElement.scrollHeight,
        }));
        assert(
          layout.scrollWidth <= layout.width &&
            layout.scrollHeight <= layout.height,
        );
        await session.page.screenshot({
          path: path.join(output, `${spec.name}.png`),
          scale: "css",
        });
        await session.context.close();
        return { surface, assetPixels, layout };
      },
    );

  const angleLine = entity("line", "angle_line", [
    [0, 0],
    [20, 0],
  ]);
  const radiusCircle = entity("circle", "radius_circle", [[0, 40]], {
    radius: 4,
  });
  const distanceA = entity("point", "distance_a", [[35, 5]]),
    distanceB = entity("point", "distance_b", [[55, 5]]);
  const dimensions = await openFixture(
    document(
      [angleLine, radiusCircle, distanceA, distanceB],
      [
        {
          id: "dimension_angle",
          kind: "angle",
          refs: [angleLine.id],
          value: 0,
        },
        {
          id: "dimension_radius",
          kind: "radius",
          refs: [radiusCircle.id],
          value: 4,
        },
        {
          id: "dimension_distance",
          kind: "length",
          refs: [distanceA.points[0].id, distanceB.points[0].id],
          value: 20,
        },
      ],
    ),
  );
  await check("Canvas angle label hit edits a real driving angle", async () => {
    const updated = await editDimension(dimensions, "dimension_angle", 30);
    const line = updated.sketches[0].entities.find(
      (entity) => entity.id === "angle_line",
    );
    const angle =
      (Math.atan2(
        line.points[1].y - line.points[0].y,
        line.points[1].x - line.points[0].x,
      ) *
        180) /
      Math.PI;
    assert(Math.abs(angle - 30) < 1e-5);
    return { angle };
  });
  await check(
    "Canvas radius label hit edits a real circle radius",
    async () => {
      const updated = await editDimension(dimensions, "dimension_radius", 6);
      const radius = updated.sketches[0].entities.find(
        (entity) => entity.id === "radius_circle",
      ).radius;
      assert(Math.abs(radius - 6) < 1e-5);
      return { radius };
    },
  );
  await check(
    "Canvas point-distance label hit edits the real referenced points",
    async () => {
      const updated = await editDimension(dimensions, "dimension_distance", 24);
      const points = ["distance_a", "distance_b"].map(
        (id) =>
          updated.sketches[0].entities.find((entity) => entity.id === id)
            .points[0],
      );
      const distance = Math.hypot(
        points[0].x - points[1].x,
        points[0].y - points[1].y,
      );
      assert(Math.abs(distance - 24) < 1e-5);
      await dimensions.page.screenshot({
        path: path.join(output, "dimensions.png"),
        scale: "css",
      });
      return { distance };
    },
  );
  await dimensions.context.close();
  for (const count of [1000, 5000])
    await check(
      `${count}-entity scene uses culling, limited hit candidates, and retained path cache`,
      () => performanceFixture(count),
    );
  await check(
    "No Canvas console errors, page errors, or external requests",
    async () => {
      assert.deepEqual(results.consoleErrors, []);
      assert.deepEqual(results.pageErrors, []);
      assert.deepEqual(results.externalRequests, []);
    },
  );
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.failure = error.stack;
  console.error(error);
  await currentPage
    ?.screenshot({ path: path.join(output, "failure.png"), scale: "css" })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  results.finished = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
}
