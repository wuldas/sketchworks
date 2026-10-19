import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/spline-capture",
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
const entity = (kind, id, coordinates, extra = {}) => ({
  id,
  kind,
  name: id,
  points: coordinates.map(([x, y], index) => ({ id: `${id}_p${index}`, x, y })),
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
const fixture = (entities, constraints = []) => ({
  version: 1,
  name: "Spline capture fixture",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "spline-fixture",
      name: "Spline fixture",
      visible: true,
      entities: [guide, ...entities],
      constraints: [
        { id: "extent-fixed", kind: "fixed", refs: [guide.id] },
        ...constraints,
      ],
    },
  ],
});
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
const detail = (doc, spline) => ({
  pointCount: spline.points.length,
  pointIDs: spline.points.map((p) => p.id),
  points: spline.points,
  last2: spline.points.slice(-2),
  constraintRefs: sketch(doc)
    .constraints.filter((c) => c.kind === "coincident")
    .map((c) => ({ id: c.id, refs: c.refs })),
});

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
async function open(fixtureDoc, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ...options,
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
        const prototype = CanvasRenderingContext2D.prototype;
        const clearRect = prototype.clearRect;
        prototype.clearRect = function (...args) {
          if (this.canvas.matches?.('[data-testid="cad-canvas"]'))
            this.canvas.__splineDraws = [];
          return clearRect.apply(this, args);
        };
        for (const name of ["fillText", "strokeText", "arc"]) {
          const original = prototype[name];
          prototype[name] = function (...args) {
            if (this.canvas.matches?.('[data-testid="cad-canvas"]')) {
              const draws = (this.canvas.__splineDraws ??= []);
              if (draws.length < 4000) draws.push({ name, args });
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
    const session = {
      context,
      page,
      canvas,
      metadata: () => canvas.evaluate((element) => element.__cadViewport),
      detail: {},
    };
    await settle(session);
    assert.deepEqual(
      sketch(await saved(session)).entities.map((item) => item.id),
      sketch(fixtureDoc).entities.map((item) => item.id),
      "isolated context loaded fixture",
    );
    await page
      .getByRole("checkbox", { name: "\u7f51\u683c", exact: true })
      .setChecked(false);
    const gridCapture = page.locator('button[title="网格捕获"]');
    if ((await gridCapture.getAttribute("aria-pressed")) === "true")
      await gridCapture.click();
    await settle(session);
    return session;
  } catch (error) {
    await context.close();
    throw error;
  }
}
async function screen(session, point) {
  const state = await session.metadata(),
    box = await session.canvas.boundingBox();
  const local = {
    x: state.origin.x + point.x * state.scale,
    y: state.origin.y - point.y * state.scale,
  };
  assert(
    local.x > 10 &&
      local.y > 10 &&
      local.x < state.width - 10 &&
      local.y < state.height - 10,
    `target visible: ${JSON.stringify({ point, local, state })}`,
  );
  return { x: box.x + local.x, y: box.y + local.y, local };
}
async function moveNear(session, point, offset = [7, 1]) {
  const position = await screen(session, point);
  await session.canvas.evaluate((element) => {
    element.__splineDraws = [];
  });
  await session.page.mouse.move(position.x + offset[0], position.y + offset[1]);
  await settle(session);
  return { state: await session.metadata(), position, offset };
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
    let greenRing = 0;
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
    }
    const draws = element.__splineDraws || [];
    return {
      greenRing,
      dpr,
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
async function capture(session, point, ref, offset = [7, 1]) {
  const observed = await moveNear(session, point, offset);
  const ink = await cuePixels(session, observed.position.local);
  const result = {
    snap: observed.state.snap,
    ink,
    scale: observed.state.scale,
  };
  assert.equal(observed.state.snap?.kind, "endpoint", JSON.stringify(result));
  assert.equal(observed.state.snap.ref, ref ?? undefined);
  near(observed.state.snap, observed.position.local);
  assert(
    ink.greenRing > 8 * ink.dpr,
    "native Canvas endpoint circle has green pixels",
  );
  assert(
    ink.endpointText && ink.circularDraw,
    "native Canvas endpoint text and circle rendered",
  );
  return { ...observed, ...result };
}
async function click(session, point, offset = [0, 0]) {
  const at = await moveNear(session, point, offset);
  await session.page.mouse.click(
    at.position.x + offset[0],
    at.position.y + offset[1],
  );
  await settle(session);
  return at;
}
async function drag(session, from, to, offset = [7, 1], release = true) {
  const start = await screen(session, from),
    end = await screen(session, to);
  await session.page.mouse.move(start.x, start.y);
  await session.page.mouse.down();
  await session.page.mouse.move(end.x + offset[0], end.y + offset[1], {
    steps: 8,
  });
  await settle(session);
  const state = await session.metadata();
  const ink = await cuePixels(session, end.local);
  if (release) {
    await session.page.mouse.up();
    await settle(session);
  }
  return { snap: state.snap, ink, state };
}
async function screenshot(session, filename) {
  await session.page.screenshot({
    path: path.join(output, filename),
    scale: "css",
  });
}
async function check(name, fixtureDoc, action, options = {}) {
  if (
    process.env.CAD_SPLINE_FILTER &&
    !name.toLowerCase().includes(process.env.CAD_SPLINE_FILTER.toLowerCase())
  )
    return;
  let session;
  const started = Date.now();
  try {
    session = await open(fixtureDoc, options);
    await action(session);
    results.checks.push({
      name,
      passed: true,
      ms: Date.now() - started,
      detail: session.detail,
      metadata: await session.metadata(),
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.checks.push({
      name,
      passed: false,
      ms: Date.now() - started,
      error: error.stack,
      detail: session?.detail,
    });
    console.error(`FAIL ${name}: ${error.message}`);
    if (session) {
      results.checks.at(-1).metadata = await session
        .metadata()
        .catch(() => null);
      results.checks.at(-1).document = await saved(session).catch(() => null);
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

const sourceA = entity("line", "source-a", [
  [-25, -12],
  [-36, -26],
]);
const sourceB = entity("line", "source-b", [
  [28, -8],
  [42, -22],
]);
const drawingFixture = () => fixture([sourceA, sourceB]);

async function startSpline(session, { autoConstraint = true } = {}) {
  await session.page
    .getByRole("checkbox", { name: "\u81ea\u52a8\u7ea6\u675f", exact: true })
    .setChecked(autoConstraint);
  await button(session.page, "\u62df\u5408\u70b9\u6837\u6761")
    .or(button(session.page, "\u6837\u6761"))
    .click();
}
async function finishFresh(
  session,
  {
    finish = "doubleclick",
    autoConstraint = true,
    first = sourceA.points[0],
    firstRef = sourceA.points[0].id,
    last = sourceB.points[0],
    lastRef = sourceB.points[0].id,
    middle = { x: -5, y: 22 },
    moveSource = true,
  } = {},
) {
  await startSpline(session, { autoConstraint });
  const firstCapture = await capture(session, first, firstRef);
  await session.page.mouse.click(
    firstCapture.position.x + 7,
    firstCapture.position.y + 1,
  );
  if (middle) await click(session, middle);
  const lastCapture = await capture(session, last, lastRef);
  await screenshot(
    session,
    `${finish}-${autoConstraint ? "constraints" : "coordinates"}-preview.png`,
  );
  if (finish === "doubleclick") {
    await session.page.mouse.dblclick(
      lastCapture.position.x + 7,
      lastCapture.position.y + 1,
    );
  } else if (finish === "rightclick-hover") {
    await session.page.mouse.click(
      lastCapture.position.x + 7,
      lastCapture.position.y + 1,
      { button: "right" },
    );
  } else {
    await session.page.mouse.click(
      lastCapture.position.x + 7,
      lastCapture.position.y + 1,
    );
    await settle(session);
    let finishPosition = lastCapture.position;
    if (finish === "enter-hover") {
      const hovered = await capture(
        session,
        sourceB.points[1],
        sourceB.points[1].id,
      );
      session.detail.ignoredHover = hovered.snap;
    } else if (finish === "rightclick-free-hover") {
      const hovered = await moveNear(session, { x: 10, y: 28 }, [0, 0]);
      assert.equal(hovered.state.snap, null, "free hover is not an endpoint");
      finishPosition = hovered.position;
    }
    if (finish.startsWith("enter")) await session.page.keyboard.press("Enter");
    else
      await session.page.mouse.click(
        finishPosition.x + 7,
        finishPosition.y + 1,
        { button: "right" },
      );
  }
  await settle(session);
  const doc = await saved(session),
    spline = sketch(doc).entities.find((item) => item.kind === "spline");
  assert(spline, "real fit-point spline tool created spline");
  const firstBound = sketch(doc).constraints.some(
    (c) =>
      c.kind === "coincident" &&
      c.refs.includes(spline.points[0].id) &&
      c.refs.includes(firstRef),
  );
  const lastBound = sketch(doc).constraints.some(
    (c) =>
      c.kind === "coincident" &&
      c.refs.includes(spline.points.at(-1).id) &&
      c.refs.includes(lastRef),
  );
  session.detail = {
    ...session.detail,
    ...detail(doc, spline),
    finish,
    autoConstraint,
    firstCapture: { snap: firstCapture.snap, ink: firstCapture.ink },
    lastCapture: { snap: lastCapture.snap, ink: lastCapture.ink },
    actualFirstBound: firstBound,
    actualLastBound: lastBound,
  };
  near(spline.points[0], first);
  near(spline.points.at(-1), last);
  assert.equal(
    spline.points.length,
    middle ? 3 : 2,
    "finishing appends exactly one final fit point",
  );
  for (let index = 1; index < spline.points.length; index++)
    assert(
      Math.hypot(
        spline.points[index].x - spline.points[index - 1].x,
        spline.points[index].y - spline.points[index - 1].y,
      ) > 1e-7,
      "adjacent fit points are distinct",
    );
  if (autoConstraint && firstRef)
    assert(
      firstBound,
      "first endpoint Coincident.refs include its actual point ID",
    );
  if (autoConstraint && lastRef)
    assert(
      lastBound,
      "last endpoint Coincident.refs include ACTUAL last point ID",
    );
  if (!autoConstraint)
    assert.equal(
      session.detail.constraintRefs.length,
      0,
      "disabled auto-constraint creates no coincidence",
    );
  await button(session.page, "\u9009\u62e9").click();
  const idleHover = await moveNear(session, last, [7, 1]);
  const idleInk = await cuePixels(session, idleHover.position.local);
  assert.equal(
    idleHover.state.snap,
    null,
    "returning to select after finishing clears the endpoint capture cue",
  );
  assert(
    !idleInk.endpointText && !idleInk.circularDraw,
    "select idle after finish renders no endpoint cue ring or label",
  );
  session.detail.selectIdleCue = idleInk;
  if (moveSource && autoConstraint) {
    await drag(session, { x: 35, y: -15 }, { x: 40, y: -6 }, [0, 0]);
    const movedDoc = await saved(session),
      movedSpline = byId(movedDoc, spline.id),
      movedSource = byId(movedDoc, sourceB.id);
    session.detail.afterSourceDrag = {
      source: movedSource.points[0],
      last2: movedSpline.points.slice(-2),
    };
    assert(
      Math.hypot(
        movedSource.points[0].x - last.x,
        movedSource.points[0].y - last.y,
      ) > 2,
      "actual source line moved by grabbing its nonoverlapping body",
    );
    near(movedSource.points[0], { x: last.x + 5, y: last.y + 9 }, 1e-5);
    near(movedSpline.points.at(-1), movedSource.points[0]);
    assert.deepEqual(
      sketch(movedDoc).constraints,
      sketch(doc).constraints,
      "source movement keeps all existing constraints",
    );
  }
  return { doc, spline };
}
async function assertDragCapture(
  session,
  from,
  target,
  targetRef,
  entityId,
  pointIndex,
) {
  const before = await saved(session);
  const moved = await drag(session, from, target);
  const doc = await saved(session),
    spline = byId(doc, entityId);
  session.detail = {
    ...detail(doc, spline),
    capture: moved.snap,
    ink: moved.ink,
    expectedEndpoint: target,
    error: Math.hypot(
      spline.points[pointIndex].x - target.x,
      spline.points[pointIndex].y - target.y,
    ),
  };
  assert.equal(
    moved.snap?.kind,
    "endpoint",
    "eligible static endpoint has a capture cue",
  );
  assert.equal(moved.snap.ref, targetRef);
  assert(
    moved.ink.greenRing > 8 * moved.ink.dpr,
    "native Canvas capture circle rendered during drag",
  );
  assert(
    moved.ink.endpointText && moved.ink.circularDraw,
    "native Canvas endpoint label and circle rendered during drag",
  );
  near(spline.points[pointIndex], target);
  assert.deepEqual(
    sketch(doc).constraints,
    sketch(before).constraints,
    "endpoint drag retains all constraints",
  );
  const released = await moveNear(session, target, [7, 1]);
  const releasedInk = await cuePixels(session, released.position.local);
  assert.equal(
    released.state.snap,
    null,
    "released drag leaves no endpoint capture cue in select idle",
  );
  assert(
    !releasedInk.endpointText && !releasedInk.circularDraw,
    "select idle after released drag renders no endpoint cue ring or label",
  );
  return { before, doc };
}

try {
  await check(
    "Fresh spline double-click attaches ACTUAL last fit point",
    drawingFixture(),
    (session) => finishFresh(session),
  );

  const fixedLine = entity("line", "fixed-line", [
    [-24, -12],
    [26, -10],
  ]);
  const connected = entity("spline", "connected-spline", [
    [-24, -12],
    [-4, 18],
    [18, 14],
  ]);
  const firstAttachment = {
    id: "first-attached",
    kind: "coincident",
    refs: [connected.points[0].id, fixedLine.points[0].id],
  };
  await check(
    "Connected spline free last endpoint snaps to same fixed line other endpoint",
    fixture(
      [fixedLine, connected],
      [
        { id: "line-fixed", kind: "fixed", refs: [fixedLine.id] },
        firstAttachment,
      ],
    ),
    async (session) => {
      const { before, doc } = await assertDragCapture(
        session,
        connected.points.at(-1),
        fixedLine.points[1],
        fixedLine.points[1].id,
        connected.id,
        2,
      );
      near(byId(doc, connected.id).points[0], connected.points[0]);
      assert.deepEqual(
        byId(doc, fixedLine.id),
        byId(before, fixedLine.id),
        "fixed target remains stationary",
      );
    },
  );

  if (process.env.CAD_SPLINE_MODE !== "baseline") {
    for (const finish of [
      "rightclick",
      "enter",
      "rightclick-hover",
      "enter-hover",
      "rightclick-free-hover",
    ]) {
      await check(
        `Fresh spline ${finish} captures and binds actual last point`,
        drawingFixture(),
        (session) => finishFresh(session, { finish }),
      );
    }
    for (const finish of [
      "doubleclick",
      "rightclick",
      "enter",
      "rightclick-hover",
    ]) {
      await check(
        `Auto-constraint OFF ${finish} still captures exact spline coordinates`,
        drawingFixture(),
        (session) =>
          finishFresh(session, {
            finish,
            autoConstraint: false,
            moveSource: false,
          }),
      );
    }
    for (const finish of [
      "doubleclick",
      "rightclick",
      "enter",
      "rightclick-hover",
    ]) {
      await check(
        `Two-point short spline ${finish} has bound actual endpoints`,
        drawingFixture(),
        (session) => finishFresh(session, { finish, middle: null }),
      );
    }
    await check(
      "Fresh spline double-click DPR2 captures without duplicate fit points",
      drawingFixture(),
      (session) => finishFresh(session),
      { deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } },
    );

    await check(
      "Escape cancel returns to select and clears the endpoint capture cue",
      drawingFixture(),
      async (session) => {
        await startSpline(session);
        const firstCapture = await capture(
          session,
          sourceA.points[0],
          sourceA.points[0].id,
        );
        await click(session, sourceA.points[0], [7, 1]);
        await session.page.keyboard.press("Escape");
        await settle(session);
        const idleHover = await moveNear(session, sourceA.points[0], [7, 1]);
        const idleInk = await cuePixels(session, idleHover.position.local);
        const doc = await saved(session);
        session.detail = {
          cancelledCapture: { snap: firstCapture.snap, ink: firstCapture.ink },
          selectIdleCue: idleInk,
          entities: sketch(doc).entities.map((item) => item.kind),
        };
        assert.equal(
          idleHover.state.snap,
          null,
          "cancel returns to select and clears the capture cue",
        );
        assert(
          !idleInk.endpointText && !idleInk.circularDraw,
          "cancelled draft renders no endpoint cue ring or label",
        );
        assert(
          !sketch(doc).entities.some((item) => item.kind === "spline"),
          "cancelled spline draft creates no spline",
        );
      },
    );

    await check(
      "Same captured coordinate at first and last binds both distinct spline point IDs",
      drawingFixture(),
      async (session) => {
        const { doc, spline } = await finishFresh(session, {
          last: sourceA.points[0],
          lastRef: sourceA.points[0].id,
          moveSource: false,
        });
        assert.notEqual(spline.points[0].id, spline.points.at(-1).id);
        await button(session.page, "\u9009\u62e9").click();
        await drag(session, { x: -30.5, y: -19 }, { x: -26, y: -13 }, [0, 0]);
        const moved = await saved(session),
          movedSource = byId(moved, sourceA.id),
          movedSpline = byId(moved, spline.id);
        near(movedSource.points[0], { x: -20.5, y: -6 }, 1e-5);
        near(movedSpline.points[0], movedSource.points[0]);
        near(movedSpline.points.at(-1), movedSource.points[0]);
        session.detail.afterSourceDrag = {
          source: movedSource.points[0],
          splinePoints: movedSpline.points,
        };
        assert.deepEqual(sketch(moved).constraints, sketch(doc).constraints);
      },
    );

    await check(
      "Connected spline independent last point captures an unfixed stationary line other end",
      fixture([fixedLine, connected], [firstAttachment]),
      async (session) => {
        const { before, doc } = await assertDragCapture(
          session,
          connected.points.at(-1),
          fixedLine.points[1],
          fixedLine.points[1].id,
          connected.id,
          2,
        );
        assert.deepEqual(
          byId(doc, fixedLine.id),
          byId(before, fixedLine.id),
          "unfixed but unrelated target variables stay stationary",
        );
      },
    );

    const independent = entity("spline", "independent-spline", [
      [-15, -4],
      [0, 20],
      [15, 8],
    ]);
    for (const endpointIndex of [0, 2]) {
      const target =
        endpointIndex === 0 ? sourceA.points[0] : sourceB.points[0];
      await check(
        `Independent spline ${endpointIndex === 0 ? "first" : "last"} endpoint drag captures static line end`,
        fixture(
          [sourceA, sourceB, independent],
          [
            { id: "source-a-fixed", kind: "fixed", refs: [sourceA.id] },
            { id: "source-b-fixed", kind: "fixed", refs: [sourceB.id] },
          ],
        ),
        async (session) => {
          const { before, doc } = await assertDragCapture(
            session,
            independent.points[endpointIndex],
            target,
            target.id,
            independent.id,
            endpointIndex,
          );
          assert.deepEqual(byId(doc, sourceA.id), byId(before, sourceA.id));
          assert.deepEqual(byId(doc, sourceB.id), byId(before, sourceB.id));
        },
      );
    }

    const aliasLine = entity("line", "alias-line", [
      [-24, -12],
      [-36, -24],
    ]);
    const aliasSpline = entity("spline", "alias-spline", [
      [-24, -12],
      [-4, 18],
      [18, 14],
    ]);
    await check(
      "Moving coincident alias endpoint is excluded from self-capture",
      fixture(
        [aliasLine, aliasSpline],
        [
          {
            id: "moving-alias",
            kind: "coincident",
            refs: [aliasSpline.points[0].id, aliasLine.points[0].id],
          },
        ],
      ),
      async (session) => {
        const before = await saved(session);
        const moved = await drag(
          session,
          aliasSpline.points[0],
          aliasLine.points[0],
        );
        const doc = await saved(session),
          spline = byId(doc, aliasSpline.id),
          line = byId(doc, aliasLine.id);
        session.detail = {
          capture: moved.snap,
          splinePoint: spline.points[0],
          aliasPoint: line.points[0],
          constraintRefs: sketch(doc).constraints,
        };
        assert.equal(
          moved.snap,
          null,
          "an alias moving with the dragged endpoint cannot be a snap target",
        );
        near(spline.points[0], line.points[0]);
        assert(
          Math.hypot(spline.points[0].x + 24, spline.points[0].y + 12) > 0.5,
          "alias actually moved",
        );
        assert.deepEqual(sketch(doc).constraints, sketch(before).constraints);
      },
    );

    const groupLine = entity("line", "group-line", [
      [14, 4],
      [28, -10],
    ]);
    const groupSpline = entity("spline", "group-spline", [
      [-24, -12],
      [-4, 18],
      [18, 14],
    ]);
    await check(
      "Selected whole moving group remains excluded from endpoint capture",
      fixture([groupLine, groupSpline]),
      async (session) => {
        const before = await saved(session);
        await session.page
          .locator(".entity-row")
          .filter({ hasText: groupLine.id })
          .click();
        await session.page
          .locator(".entity-row")
          .filter({ hasText: groupSpline.id })
          .click({ modifiers: ["Control"] });
        assert.equal(
          await session.page.locator(".entity-row.selected").count(),
          2,
        );
        const from = { x: 21, y: -3 },
          delta = { x: 14, y: -14 };
        const moved = await drag(
          session,
          from,
          { x: from.x + delta.x, y: from.y + delta.y },
          [7, 1],
        );
        const doc = await saved(session),
          line = byId(doc, groupLine.id),
          spline = byId(doc, groupSpline.id);
        session.detail = {
          capture: moved.snap,
          linePoints: line.points,
          splinePoints: spline.points,
        };
        assert.equal(
          moved.snap,
          null,
          "the selected group's endpoint cannot capture its own translation anchor",
        );
        const translation = {
          x: line.points[0].x - groupLine.points[0].x,
          y: line.points[0].y - groupLine.points[0].y,
        };
        assert(
          Math.hypot(translation.x, translation.y) > 10,
          "whole group actually translated",
        );
        for (let index = 0; index < spline.points.length; index++)
          near(spline.points[index], {
            x: groupSpline.points[index].x + translation.x,
            y: groupSpline.points[index].y + translation.y,
          });
        assert.deepEqual(sketch(doc).constraints, sketch(before).constraints);
      },
    );

    const movingSource = entity("spline", "moving-source", [
      [-15, -4],
      [0, 20],
      [15, 8],
    ]);
    const movingDerived = entity(
      "spline",
      "moving-derived",
      [
        [-15, -2.2],
        [0, 21.8],
        [15, 9.8],
      ],
      {
        sourceId: movingSource.id,
        transform: { kind: "translate", x: 0, y: 1.8 },
      },
    );
    await check(
      "Derived spline endpoint moving with its source remains excluded without jitter",
      fixture([movingSource, movingDerived]),
      async (session) => {
        const before = await saved(session),
          state = await session.metadata();
        assert(
          1.8 * state.scale > 7,
          "source and derived endpoint handles are initially distinct",
        );
        const from = await screen(session, movingSource.points.at(-1));
        await session.page.mouse.move(from.x, from.y);
        await session.page.mouse.down();
        session.detail.samples = [];
        for (const dy of [-4, -8, -12, -16]) {
          await session.page.mouse.move(from.x, from.y + dy);
          await settle(session);
          const observed = await session.metadata();
          const handle = observed.handles.find(
            (item) => item.pointId === movingSource.points.at(-1).id,
          );
          session.detail.samples.push({ dy, handle, snap: observed.snap });
          assert.equal(
            observed.snap,
            null,
            "dependent derived endpoint is not a stationary target",
          );
          assert(
            Math.abs(handle.y - (from.local.y + dy)) <= 1,
            "source endpoint follows the real mouse without jitter",
          );
        }
        await session.page.mouse.up();
        const doc = await saved(session),
          source = byId(doc, movingSource.id),
          copy = byId(doc, movingDerived.id);
        near(copy.points.at(-1), {
          x: source.points.at(-1).x,
          y: source.points.at(-1).y + 1.8,
        });
        assert.deepEqual(sketch(doc).constraints, sketch(before).constraints);
        session.detail.source = source.points.at(-1);
        session.detail.derived = copy.points.at(-1);
      },
    );

    const derivedSource = entity("line", "derived-source", [
      [-30, -25],
      [-18, -22],
    ]);
    const derived = entity(
      "line",
      "derived-copy",
      [
        [10, 5],
        [22, 8],
      ],
      {
        sourceId: derivedSource.id,
        transform: { kind: "translate", x: 40, y: 30 },
      },
    );
    await check(
      "Fresh spline derived endpoint capture has exact coordinates and no forbidden relationship",
      fixture(
        [sourceA, derivedSource, derived],
        [
          {
            id: "derived-source-fixed",
            kind: "fixed",
            refs: [derivedSource.id],
          },
        ],
      ),
      async (session) => {
        const { doc, spline } = await finishFresh(session, {
          last: derived.points[0],
          lastRef: null,
          middle: { x: -5, y: 25 },
          moveSource: false,
        });
        near(spline.points.at(-1), derived.points[0]);
        const forbidden = new Set([
          derived.id,
          derivedSource.id,
          ...derived.points.map((p) => p.id),
          ...derivedSource.points.map((p) => p.id),
        ]);
        assert(
          !sketch(doc).constraints.some(
            (c) =>
              c.kind === "coincident" &&
              c.refs.some((ref) => forbidden.has(ref)),
          ),
          "derived capture must not bind to derived or source IDs",
        );
      },
    );
  }
} finally {
  await browser.close();
  results.finished = new Date().toISOString();
  results.passed =
    results.checks.length > 0 &&
    results.checks.every((item) => item.passed) &&
    !results.pageErrors.length &&
    !results.consoleErrors.length;
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        passed: results.passed,
        checks: results.checks.map(({ name, passed }) => ({ name, passed })),
        output,
      },
      null,
      2,
    ),
  );
  if (!results.passed) process.exitCode = 1;
}
