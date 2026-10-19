import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(process.env.CAD_ARTIFACTS || "artifacts/drag-snap");
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
  started: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  pageErrors: [],
};
await fs.mkdir(output, { recursive: true });
const entity = (kind, id, points, extra = {}) => ({
  kind,
  id,
  name: id,
  points: points.map(([x, y], i) => ({ id: `${id}_p${i}`, x, y })),
  ...extra,
});
const guide = entity(
  "line",
  "guide",
  [
    [-50, -40],
    [50, 40],
  ],
  { construction: true },
);
function document(entities, constraints = []) {
  return {
    version: 1,
    name: "Drag snap regression",
    unit: "mm",
    parameters: [],
    sketches: [
      {
        id: "drag-fixture",
        name: "草图 1",
        visible: true,
        entities: [guide, ...entities],
        constraints: [
          { id: "guide-fixed", kind: "fixed", refs: [guide.id] },
          ...constraints,
        ],
      },
    ],
  };
}
async function open(fixture, { dpr = 1 } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: dpr,
  });
  await context.route("**/*", (route) => {
    const target = route.request().url();
    return /^https?:/.test(target) &&
      new URL(target).origin !== new URL(url).origin
      ? route.abort()
      : route.continue();
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") results.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => results.pageErrors.push(error.message));
  await page.addInitScript(
    ({ fixture, storage }) =>
      localStorage.setItem(storage, JSON.stringify(fixture)),
    { fixture, storage },
  );
  await page.goto(url);
  await page
    .locator(".loading-overlay")
    .waitFor({ state: "hidden", timeout: 120000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport?.stats
        .frames > 0,
  );
  const canvas = page.getByTestId("cad-canvas"),
    metadata = () => canvas.evaluate((el) => el.__cadViewport);
  return { context, page, canvas, metadata };
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
async function disableGrid(session) {
  await session.page
    .getByRole("checkbox", { name: "网格", exact: true })
    .uncheck();
  const capture = session.page.getByRole("button", {
    name: "网格捕获",
    exact: true,
  });
  if ((await capture.getAttribute("aria-pressed")) === "true")
    await capture.click();
  await settle(session);
}
async function screen(session, point) {
  const info = await session.metadata(),
    box = await session.canvas.boundingBox();
  return {
    x: box.x + info.origin.x + point.x * info.scale,
    y: box.y + info.origin.y - point.y * info.scale,
  };
}
async function saved(session) {
  await session.page.waitForTimeout(750);
  await session.page.waitForFunction(
    () => document.querySelector(".save-dot")?.dataset.saved === "true",
  );
  return session.page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storage,
  );
}
const pointOf = (doc, id) =>
  doc.sketches[0].entities.find((entity) => entity.id === id).points[0];
const close = (point, target) => {
  assert(
    Math.hypot(point.x - target.x, point.y - target.y) < 1e-6,
    `expected (${target.x},${target.y}), actual (${point.x},${point.y})`,
  );
};
async function check(name, fixture, action, options = {}) {
  let session;
  try {
    session = await open(fixture, options);
    const detail = await action(session);
    results.checks.push({ name, passed: true, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.checks.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    if (session)
      await session.page
        .screenshot({
          path: path.join(output, `${results.checks.length}-failure.png`),
        })
        .catch(() => {});
  } finally {
    if (session) await session.context.close();
  }
}
try {
  await check(
    "Off-center circle body drag snaps its geometry anchor",
    document(
      [entity("circle", "circle", [[13.2, 9.7]], { radius: 4 })],
      [{ id: "radius", kind: "radius", refs: ["circle"], value: 4 }],
    ),
    async (session) => {
      const info = await session.metadata(),
        step = info.gridStep,
        target = { x: step * 6, y: step * 4 };
      const start = await screen(session, { x: 17.2, y: 9.7 }),
        finish = await screen(session, { x: target.x + 4, y: target.y });
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 2, finish.y + 1, { steps: 6 });
      await settle(session);
      const captured = await session.metadata();
      await session.page.mouse.up();
      const final = pointOf(await saved(session), "circle");
      results.circleBaseline = {
        target,
        marker: captured.snap,
        final,
        scale: info.scale,
      };
      close(final, target);
      return results.circleBaseline;
    },
  );
  await check(
    "Pointerup final coordinates supersede the last move",
    document([entity("point", "point", [[-13.2, -8.7]])]),
    async (session) => {
      const info = await session.metadata(),
        step = info.gridStep,
        intermediate = { x: step * 3, y: step * 3 },
        target = { x: step * 6, y: step * 5 };
      const start = await screen(session, { x: -13.2, y: -8.7 }),
        middle = await screen(session, intermediate),
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(middle.x, middle.y, { steps: 6 });
      await settle(session);
      await session.canvas.evaluate((el) => {
        el.__releaseEvents = [];
        for (const type of ["pointermove", "pointerup"])
          el.addEventListener(type, (event) =>
            el.__releaseEvents.push({
              type: event.type,
              x: event.clientX,
              y: event.clientY,
            }),
          );
      });
      const cdp = await session.context.newCDPSession(session.page);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: finish.x,
        y: finish.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      const events = await session.canvas.evaluate((el) => el.__releaseEvents);
      await session.page.mouse.up();
      const final = pointOf(await saved(session), "point");
      results.releaseBaseline = { intermediate, target, final, events };
      assert(events.some((event) => event.type === "pointerup"));
      assert(
        !events.some((event) => event.type === "pointermove"),
        "CDP release must not inject a trailing pointermove",
      );
      close(final, target);
      return results.releaseBaseline;
    },
  );
  await check(
    "Free point commits an exact captured grid position and one undo",
    document([entity("point", "point", [[-13.2, -8.7]])]),
    async (session) => {
      const info = await session.metadata(),
        target = { x: info.gridStep * 4, y: info.gridStep * 4 },
        start = await screen(session, { x: -13.2, y: -8.7 }),
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await settle(session);
      assert.equal(
        (await session.metadata()).snap,
        null,
        "a click without movement does not capture",
      );
      await session.page.mouse.move(finish.x + 2, finish.y + 1, { steps: 8 });
      await settle(session);
      const captured = await session.metadata(),
        live = captured.handles.find((handle) => handle.pointId === "point_p0");
      assert(
        captured.snap?.kind === "grid",
        "captured point must have a grid cue",
      );
      assert(
        Math.hypot(live.x - captured.snap.x, live.y - captured.snap.y) <= 1,
        "rendered anchor must be at the capture cue",
      );
      await session.page.mouse.up();
      await settle(session);
      assert.equal(
        (await session.metadata()).snap,
        null,
        "release clears the capture cue",
      );
      close(pointOf(await saved(session), "point"), target);
      await session.page
        .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
        .click();
      close(pointOf(await saved(session), "point"), { x: -13.2, y: -8.7 });
      await session.page
        .getByRole("button", { name: "重做 (Ctrl+Shift+Z)", exact: true })
        .click();
      close(pointOf(await saved(session), "point"), target);
      return { target, live, cue: captured.snap };
    },
  );
  await check(
    "Repeated movement inside a captured grid cell does not rebuild geometry",
    document([entity("point", "point", [[-13.2, -8.7]])]),
    async (session) => {
      const info = await session.metadata(),
        target = { x: info.gridStep * 4, y: info.gridStep * 4 },
        start = await screen(session, { x: -13.2, y: -8.7 }),
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 1, finish.y + 1, { steps: 8 });
      await settle(session);
      const before = await session.metadata();
      assert(before.snap?.kind === "grid");
      for (let i = 0; i < 14; i++) {
        await session.page.mouse.move(
          finish.x + 1 + (i % 3),
          finish.y + 1 + (i % 2),
        );
        await settle(session);
      }
      const after = await session.metadata();
      await session.page.mouse.up();
      close(pointOf(await saved(session), "point"), target);
      assert(
        after.stats.frames > before.stats.frames,
        "capture overlay actually received frames",
      );
      assert.equal(
        after.stats.baseDraws,
        before.stats.baseDraws,
        "same capture must not re-solve/rebuild the static scene",
      );
      assert.equal(after.stats.compiledPaths, before.stats.compiledPaths);
      return { before: before.stats, after: after.stats, target };
    },
  );
  await check(
    "Captured grid target stays stable across the eight-pixel boundary",
    document([entity("point", "point", [[-13.2, -8.7]])]),
    async (session) => {
      const info = await session.metadata(),
        target = { x: info.gridStep * 4, y: info.gridStep * 4 },
        start = await screen(session, { x: -13.2, y: -8.7 }),
        finish = await screen(session, target),
        samples = [];
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 1, finish.y, { steps: 8 });
      await settle(session);
      for (const dx of [7, 8.7, 7.4, 9]) {
        await session.page.mouse.move(finish.x + dx, finish.y);
        await settle(session);
        const state = await session.metadata();
        samples.push({ dx, snap: state.snap });
        assert(
          state.snap?.kind === "grid",
          "latched grid capture should not flicker at acquisition threshold",
        );
        assert(
          Math.hypot(
            state.snap.x - info.origin.x - target.x * info.scale,
            state.snap.y - info.origin.y + target.y * info.scale,
          ) < 1e-6,
        );
      }
      await session.page.mouse.up();
      close(pointOf(await saved(session), "point"), target);
      return { target, samples };
    },
  );
  const constrained = () =>
    document(
      [
        entity("line", "line", [
          [0, 0],
          [10, 0],
        ]),
      ],
      [
        { id: "origin-fixed", kind: "fixed", refs: ["line_p0"] },
        { id: "length", kind: "length", refs: ["line"], value: 10 },
      ],
    );
  await check(
    "Feasible constrained endpoint drops exactly on the captured grid",
    constrained(),
    async (session) => {
      const start = await screen(session, { x: 10, y: 0 }),
        target = { x: 0, y: 10 },
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 1, finish.y + 1, { steps: 10 });
      await settle(session);
      const captured = await session.metadata();
      assert(captured.snap?.kind === "grid");
      await session.page.mouse.up();
      const line = (await saved(session)).sketches[0].entities.find(
        (item) => item.id === "line",
      );
      close(line.points[1], target);
      close(line.points[0], { x: 0, y: 0 });
      assert(
        Math.abs(Math.hypot(line.points[1].x, line.points[1].y) - 10) < 1e-6,
      );
      return { target, points: line.points, cue: captured.snap };
    },
  );
  await check(
    "Incompatible grid capture does not advertise an unachievable point",
    constrained(),
    async (session) => {
      const start = await screen(session, { x: 10, y: 0 }),
        target = { x: 5, y: 5 },
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x, finish.y, { steps: 10 });
      await settle(session);
      const captured = await session.metadata();
      await session.page.mouse.up();
      const line = (await saved(session)).sketches[0].entities.find(
        (item) => item.id === "line",
      );
      assert.equal(
        captured.snap,
        null,
        "a rejected constrained grid point must not keep the captured cue",
      );
      close(line.points[0], { x: 0, y: 0 });
      assert(
        Math.abs(Math.hypot(line.points[1].x, line.points[1].y) - 10) < 1e-6,
      );
      assert(Math.hypot(line.points[1].x - 5, line.points[1].y - 5) > 1);
      return { requested: target, points: line.points, cue: captured.snap };
    },
  );
  const rectangle = [
    entity("line", "bottom", [
      [0.3, 0.3],
      [20.3, 0.3],
    ]),
    entity("line", "right", [
      [20.3, 0.3],
      [20.3, 20.3],
    ]),
    entity("line", "top", [
      [20.3, 20.3],
      [0.3, 20.3],
    ]),
    entity("line", "left", [
      [0.3, 20.3],
      [0.3, 0.3],
    ]),
  ];
  const rectangleConstraints = rectangle.flatMap((line, i) => [
    {
      id: `axis${i}`,
      kind: i % 2 ? "vertical" : "horizontal",
      refs: [line.id],
    },
    {
      id: `seam${i}`,
      kind: "coincident",
      refs: [`${line.id}_p1`, `${rectangle[(i + 1) % 4].id}_p0`],
    },
  ]);
  rectangleConstraints.push(
    { id: "width", kind: "length", refs: ["bottom"], value: 20 },
    { id: "height", kind: "length", refs: ["right"], value: 20 },
  );
  await check(
    "Constraint-connected moving peer points do not make dragging stall",
    document(rectangle, rectangleConstraints),
    async (session) => {
      await disableGrid(session);
      const start = await screen(session, { x: 20.3, y: 20.3 }),
        initial = await session.metadata(),
        samples = [];
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      for (const dx of [4, 8, 12, 16, 20, 24]) {
        await session.page.mouse.move(start.x + dx, start.y);
        await settle(session);
        const state = await session.metadata(),
          handle = state.handles.find((item) => item.pointId === "top_p0");
        samples.push({
          dx,
          actualDx: handle.x - (initial.origin.x + 20.3 * initial.scale),
          snap: state.snap,
        });
        assert(
          Math.abs(samples.at(-1).actualDx - dx) <= 1,
          "constrained peer must not magnetize to its own previous pose",
        );
        assert.equal(
          state.snap,
          null,
          "moving constraint-connected geometry is not a stationary snap target",
        );
      }
      await session.page.mouse.up();
      const final = await saved(session);
      assert.equal(
        final.sketches[0].constraints.length,
        rectangleConstraints.length + 1,
      );
      return { samples };
    },
  );
  await check(
    "Selected moving companions are excluded from body snap references",
    document(
      [
        entity("circle", "a", [[10.2, 20.4]], { radius: 2 }),
        entity("circle", "b", [[15.2, 20.4]], { radius: 2 }),
      ],
      [
        { id: "radius-a", kind: "radius", refs: ["a"], value: 2 },
        { id: "radius-b", kind: "radius", refs: ["b"], value: 2 },
      ],
    ),
    async (session) => {
      await disableGrid(session);
      await session.page.locator(".entity-row").nth(1).click();
      await session.page
        .locator(".entity-row")
        .nth(2)
        .click({ modifiers: ["Control"] });
      await settle(session);
      const start = await screen(session, { x: 8.2, y: 20.4 }),
        finish = await screen(session, { x: 13.2, y: 20.4 });
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x, finish.y);
      await settle(session);
      const captured = await session.metadata();
      await session.page.mouse.up();
      const final = await saved(session),
        a = pointOf(final, "a"),
        b = pointOf(final, "b");
      assert.equal(
        captured.snap,
        null,
        "a selected moving companion must not be offered as a snap reference",
      );
      assert(Math.abs(a.x - 15.2) * captured.scale <= 1);
      assert(Math.abs(b.x - a.x - 5) < 1e-6);
      return { a, b, snap: captured.snap };
    },
  );
  await check(
    "Free circle center handle drops at its indicated grid node",
    document(
      [entity("circle", "circle", [[13.2, 9.7]], { radius: 4 })],
      [{ id: "radius", kind: "radius", refs: ["circle"], value: 4 }],
    ),
    async (session) => {
      const info = await session.metadata(),
        target = { x: info.gridStep * 6, y: info.gridStep * 4 },
        start = await screen(session, { x: 13.2, y: 9.7 }),
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 2, finish.y + 2, { steps: 8 });
      await settle(session);
      const captured = await session.metadata();
      assert(captured.snap?.kind === "grid");
      await session.page.mouse.up();
      const final = await saved(session),
        circle = final.sketches[0].entities.find(
          (item) => item.id === "circle",
        );
      close(circle.points[0], target);
      assert(Math.abs(circle.radius - 4) < 1e-6);
      return { target, circle, cue: captured.snap };
    },
  );
  await check(
    "Length-constrained otherwise movable line endpoint drops exactly",
    document(
      [
        entity("line", "line", [
          [10.2, 10.2],
          [20.2, 10.2],
        ]),
      ],
      [{ id: "length", kind: "length", refs: ["line"], value: 10 }],
    ),
    async (session) => {
      const info = await session.metadata(),
        target = { x: info.gridStep * 6, y: info.gridStep * 5 },
        start = await screen(session, { x: 20.2, y: 10.2 }),
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 2, finish.y + 1, { steps: 9 });
      await settle(session);
      await session.page.mouse.up();
      const line = (await saved(session)).sketches[0].entities.find(
        (item) => item.id === "line",
      );
      close(line.points[1], target);
      assert(
        Math.abs(
          Math.hypot(
            line.points[1].x - line.points[0].x,
            line.points[1].y - line.points[0].y,
          ) - 10,
        ) < 1e-5,
      );
      return { target, points: line.points };
    },
  );
  await check(
    "Entire line body clicked off p0 snaps its intended first-point anchor",
    document(
      [
        entity("line", "line", [
          [1.2, 2.6],
          [11.2, 6.6],
        ]),
      ],
      [
        {
          id: "length",
          kind: "length",
          refs: ["line"],
          value: Math.hypot(10, 4),
        },
      ],
    ),
    async (session) => {
      const info = await session.metadata(),
        target = { x: info.gridStep * 6, y: info.gridStep * 4 },
        grab = { x: 7.7, y: 5.2 },
        start = await screen(session, grab),
        finish = await screen(session, {
          x: target.x + 6.5,
          y: target.y + 2.6,
        });
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 2, finish.y + 1, { steps: 9 });
      await settle(session);
      const captured = await session.metadata();
      assert(captured.snap?.kind === "grid");
      await session.page.mouse.up();
      const line = (await saved(session)).sketches[0].entities.find(
        (item) => item.id === "line",
      );
      close(line.points[0], target);
      assert(Math.abs(line.points[1].x - line.points[0].x - 10) < 1e-5);
      assert(Math.abs(line.points[1].y - line.points[0].y - 4) < 1e-5);
      return { grab, target, points: line.points, cue: captured.snap };
    },
  );
  await check(
    "Multi-selected bodies snap primary anchor and preserve relative offsets",
    document(
      [
        entity("circle", "a", [[10.2, 20.4]], { radius: 2 }),
        entity("circle", "b", [[15.2, 20.4]], { radius: 2 }),
      ],
      [
        { id: "radius-a", kind: "radius", refs: ["a"], value: 2 },
        { id: "radius-b", kind: "radius", refs: ["b"], value: 2 },
      ],
    ),
    async (session) => {
      await session.page.locator(".entity-row").nth(1).click();
      await session.page
        .locator(".entity-row")
        .nth(2)
        .click({ modifiers: ["Control"] });
      await settle(session);
      const info = await session.metadata(),
        target = { x: info.gridStep * 6, y: info.gridStep * 5 },
        start = await screen(session, { x: 8.2, y: 20.4 }),
        finish = await screen(session, { x: target.x - 2, y: target.y });
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 1, finish.y + 1, { steps: 9 });
      await settle(session);
      const captured = await session.metadata();
      assert(captured.snap?.kind === "grid");
      await session.page.mouse.up();
      const final = await saved(session),
        a = pointOf(final, "a"),
        b = pointOf(final, "b");
      close(a, target);
      assert(Math.abs(b.x - a.x - 5) < 1e-5 && Math.abs(b.y - a.y) < 1e-5);
      return { target, a, b, cue: captured.snap };
    },
  );
  await check(
    "Escape cancels a captured drag without adding history",
    document([entity("point", "point", [[-13.2, -8.7]])]),
    async (session) => {
      const before = await saved(session),
        info = await session.metadata(),
        target = { x: info.gridStep * 4, y: info.gridStep * 4 },
        start = await screen(session, { x: -13.2, y: -8.7 }),
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 1, finish.y + 1, { steps: 8 });
      await settle(session);
      assert((await session.metadata()).snap?.kind === "grid");
      await session.page.keyboard.press("Escape");
      await session.page.mouse.up();
      assert.deepEqual(await saved(session), before);
      assert(
        await session.page
          .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
          .isDisabled(),
      );
      return { cancelledTarget: target, restored: pointOf(before, "point") };
    },
  );
  await check(
    "Fixed geometry rejects an incompatible capture and stays unchanged",
    document(
      [entity("circle", "fixed", [[13.2, 9.7]], { radius: 4 })],
      [{ id: "fixed-circle", kind: "fixed", refs: ["fixed"] }],
    ),
    async (session) => {
      const before = await saved(session),
        info = await session.metadata(),
        target = { x: info.gridStep * 6, y: info.gridStep * 4 },
        start = await screen(session, { x: 13.2, y: 9.7 }),
        finish = await screen(session, target);
      await session.page.mouse.move(start.x, start.y);
      await session.page.mouse.down();
      await session.page.mouse.move(finish.x + 1, finish.y + 1, { steps: 8 });
      await settle(session);
      const captured = await session.metadata();
      await session.page.mouse.up();
      assert.deepEqual(await saved(session), before);
      assert.equal(captured.snap, null);
      assert(
        await session.page
          .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
          .isDisabled(),
      );
      return {
        requested: target,
        cue: captured.snap,
        unchanged: pointOf(before, "fixed"),
      };
    },
  );
  for (const mode of ["point", "circle-body"]) {
    const isCircle = mode === "circle-body",
      fixture = document(
        [
          entity(
            isCircle ? "circle" : "point",
            "dragged",
            [[13.2, 9.7]],
            isCircle ? { radius: 4 } : {},
          ),
        ],
        isCircle
          ? [{ id: "radius", kind: "radius", refs: ["dragged"], value: 4 }]
          : [],
      );
    await check(
      `DPR2 ${mode} snaps exactly after wheel zoom and view pan`,
      fixture,
      async (session) => {
        let box = await session.canvas.boundingBox();
        await session.page.mouse.move(
          box.x + box.width * 0.45,
          box.y + box.height * 0.48,
        );
        await session.page.mouse.down({ button: "middle" });
        await session.page.mouse.move(
          box.x + box.width * 0.45 + 37,
          box.y + box.height * 0.48 - 23,
          { steps: 5 },
        );
        await session.page.mouse.up({ button: "middle" });
        await settle(session);
        const before = await session.metadata();
        await session.page.mouse.move(
          box.x + box.width * 0.3,
          box.y + box.height * 0.4,
        );
        await session.page.mouse.wheel(0, -100);
        await session.page.waitForFunction(
          (scale) =>
            document.querySelector('[data-testid="cad-canvas"]').__cadViewport
              .scale !== scale,
          before.scale,
        );
        await settle(session);
        const info = await session.metadata();
        assert.equal(info.dpr, 2);
        assert(
          await session.canvas.evaluate(
            (canvas, info) =>
              canvas.width === Math.round(info.width * 2) &&
              canvas.height === Math.round(info.height * 2),
            info,
          ),
        );
        const target = { x: info.gridStep * 6, y: info.gridStep * 4 },
          start = await screen(session, {
            x: 13.2 + (isCircle ? 4 : 0),
            y: 9.7,
          }),
          finish = await screen(session, {
            x: target.x + (isCircle ? 4 : 0),
            y: target.y,
          });
        await session.page.mouse.move(start.x, start.y);
        await session.page.mouse.down();
        await session.page.mouse.move(finish.x + 2, finish.y + 1, { steps: 8 });
        await settle(session);
        const captured = await session.metadata();
        assert(captured.snap?.kind === "grid");
        await session.page.mouse.up();
        close(pointOf(await saved(session), "dragged"), target);
        await session.page.mouse.move(5, 5);
        await session.page.screenshot({
          path: path.join(output, `dpr2-${mode}.png`),
          scale: "css",
        });
        return { dpr: info.dpr, target, cue: captured.snap, scale: info.scale };
      },
      { dpr: 2 },
    );
  }
} finally {
  results.finished = new Date().toISOString();
  results.passed =
    results.checks.every((check) => check.passed) &&
    results.consoleErrors.length === 0 &&
    results.pageErrors.length === 0;
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  if (!results.passed) process.exitCode = 1;
}
