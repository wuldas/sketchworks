/** Native Canvas double-click selection regressions; uses the running CAD_URL. */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/contour-selection",
);
const storage = "sketchworks.document.v1";
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const executablePath =
  process.env.CAD_BROWSER_PATH ||
  (!existsSync(chromium.executablePath()) && existsSync(chrome)
    ? chrome
    : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const results = {
  url,
  browser: browser.version(),
  started: new Date().toISOString(),
  checks: [],
  pageErrors: [],
  consoleErrors: [],
};
await fs.mkdir(output, { recursive: true });

const entity = (kind, id, coords, extra = {}) => ({
  kind,
  id,
  name: id,
  points: coords.map(([x, y], index) => ({ id: `${id}_p${index}`, x, y })),
  ...extra,
});
const line = (id, a, b) => entity("line", id, [a, b]);
// A distant horizontal guide gives every fixture a stable, broad fit. No path
// endpoint lies on this guide, including the branch and crossing fixtures.
const guide = line("extent-guide", [-55, -35], [55, -35]);
guide.construction = true;
const fixture = (name, entities, constraints = []) => ({
  version: 1,
  name,
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "contour-fixture",
      name: "Contour fixture",
      visible: true,
      entities: [guide, ...entities],
      constraints: [
        { id: "extent-fixed", kind: "fixed", refs: [guide.id] },
        ...constraints,
      ],
    },
  ],
});
const ring = (prefix, coords) =>
  coords.map((a, index) =>
    line(`${prefix}${index}`, a, coords[(index + 1) % coords.length]),
  );
const rectangle = () =>
  ring("rect", [
    [-25, -10],
    [-5, -10],
    [-5, 10],
    [-25, 10],
  ]);
const detached = () => [
  line("detached", [22, 15], [42, 15]),
  entity("circle", "unrelated", [[35, 0]], { radius: 4 }),
];
const rowNames = (session) =>
  session.page
    .locator(".entity-row.selected")
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector("span").textContent),
    );
const settle = (session) =>
  session.page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const metadata = (session) => session.canvas.evaluate((el) => el.__cadViewport);

async function snapshot(session) {
  await session.page.locator('.save-dot[data-saved="true"]').waitFor();
  return session.page.evaluate(
    (key) => ({
      document: localStorage.getItem(key),
      history: document.querySelector(".app").getAttribute("data-history"),
      undoDisabled: document.querySelector('button[title="撤销 (Ctrl+Z)"]')
        .disabled,
      redoDisabled: document.querySelector(
        'button[title="重做 (Ctrl+Shift+Z)"]',
      ).disabled,
    }),
    storage,
  );
}
async function unchanged(session, label) {
  const after = await snapshot(session);
  assert.deepEqual(
    after,
    session.baseline,
    `${label}: document and history stay unchanged`,
  );
  return after;
}
async function expectSelection(session, expected, label) {
  await settle(session);
  const actual = await rowNames(session),
    ordered = session.initial.sketches[0].entities
      .filter((item) => expected.includes(item.id))
      .map((item) => item.name);
  assert.deepEqual(actual, ordered, label);
  assert.equal(
    actual.includes(guide.id),
    false,
    `${label}: extent guide stays separate`,
  );
  const state = await unchanged(session, label);
  session.observations.push({
    label,
    selectedRows: actual,
    history: state.history,
  });
}
async function open(doc) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await context.route("**/favicon.ico", (route) =>
      route.fulfill({ status: 204 }),
    );
    page.on("pageerror", (error) =>
      results.pageErrors.push({ case: doc.name, error: error.message }),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        results.consoleErrors.push({ case: doc.name, error: message.text() });
    });
    await context.addInitScript(
      ({ doc, storage }) => {
        if (!sessionStorage.getItem("contour-seeded")) {
          localStorage.setItem(storage, JSON.stringify(doc));
          sessionStorage.setItem("contour-seeded", "true");
        }
      },
      { doc, storage },
    );
    await page.goto(url);
    await page
      .locator(".loading-overlay")
      .waitFor({ state: "hidden", timeout: 120000 });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
          ?.stats.frames > 0,
    );
    const session = {
      context,
      page,
      canvas: page.getByTestId("cad-canvas"),
      observations: [],
    };
    await settle(session);
    session.baseline = await snapshot(session);
    session.initial = JSON.parse(session.baseline.document);
    assert.equal(session.initial.name, doc.name, "isolated fixture loaded");
    assert.deepEqual(
      session.initial.sketches[0].entities.map((item) => item.id),
      doc.sketches[0].entities.map((item) => item.id),
      "fixture entities survived initial solve",
    );
    assert.equal(session.baseline.history, "0");
    assert.equal(session.baseline.undoDisabled, true);
    assert.equal(session.baseline.redoDisabled, true);
    await page.locator('button.ribbon-tool[title="选择"]').click();
    await settle(session);
    return session;
  } catch (error) {
    await context.close();
    throw error;
  }
}
async function screen(session, point) {
  const state = await metadata(session),
    box = await session.canvas.boundingBox();
  return {
    x: box.x + state.origin.x + point.x * state.scale,
    y: box.y + state.origin.y - point.y * state.scale,
  };
}
async function nativeClick(session, target, { double = true, modifier } = {}) {
  assert(
    await session.page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y) ===
        document.querySelector('[data-testid="cad-canvas"]'),
      target,
    ),
    "the native click hits the actual canvas surface",
  );
  if (modifier) await session.page.keyboard.down(modifier);
  try {
    if (double) await session.page.mouse.dblclick(target.x, target.y);
    else await session.page.mouse.click(target.x, target.y);
  } finally {
    if (modifier) await session.page.keyboard.up(modifier);
  }
  await settle(session);
}
async function worldClick(session, point, options) {
  return nativeClick(session, await screen(session, point), options);
}
async function doubleLine(session, id, fraction = 0.5, modifier) {
  const target = session.initial.sketches[0].entities.find(
    (item) => item.id === id,
  );
  assert.equal(target.kind, "line");
  const [a, b] = target.points;
  return worldClick(
    session,
    {
      x: a.x + (b.x - a.x) * fraction,
      y: a.y + (b.y - a.y) * fraction,
    },
    { modifier },
  );
}
async function check(name, doc, test) {
  if (
    process.env.CAD_CONTOUR_CASE &&
    !name.includes(process.env.CAD_CONTOUR_CASE)
  )
    return;
  let session;
  try {
    session = await open(doc);
    const detail = await test(session);
    const after = await unchanged(session, name);
    results.checks.push({
      name,
      passed: true,
      detail,
      observations: session.observations,
      history: after.history,
      savedDocumentUnchanged: after.document === session.baseline.document,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.checks.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    if (session)
      await session.page
        .screenshot({
          path: path.join(output, `${results.checks.length}-failure.png`),
          fullPage: true,
        })
        .catch(() => {});
  } finally {
    if (session) await session.context.close();
    await fs.writeFile(
      path.join(output, "results.json"),
      JSON.stringify(results, null, 2),
    );
  }
}

try {
  const rect = rectangle();
  await check(
    "fixed rectangle replaces selection and excludes separate shapes",
    fixture(
      "Fixed rectangle contour",
      [...rect, ...detached()],
      rect.map((item) => ({
        id: `fixed-${item.id}`,
        kind: "fixed",
        refs: [item.id],
      })),
    ),
    async (session) => {
      await doubleLine(session, "detached");
      await expectSelection(session, ["detached"], "isolated line selection");
      await doubleLine(session, "rect0");
      await expectSelection(
        session,
        rect.map((item) => item.id),
        "fixed rectangle entire contour",
      );
      await session.page.screenshot({
        path: path.join(output, "desktop-connected-rectangle.png"),
        fullPage: true,
      });
      await doubleLine(session, "rect2");
      await expectSelection(
        session,
        rect.map((item) => item.id),
        "reverse side reaches same rectangle",
      );
      return {
        screenshot: "desktop-connected-rectangle.png",
        fixedEntitiesSelectable: true,
      };
    },
  );

  const pentagon = ring("poly", [
    [-22, -12],
    [-2, -12],
    [8, 4],
    [-12, 18],
    [-28, 4],
  ]);
  await check(
    "pentagon covers the ring but stops spreading at a corner branch",
    fixture("Pentagon contour", [
      ...pentagon,
      line("corner-branch", [-22, -12], [-40, -22]),
      ...detached(),
    ]),
    async (session) => {
      await doubleLine(session, "poly0");
      await expectSelection(
        session,
        pentagon.map((item) => item.id),
        "pentagon ring without branch or detached shapes",
      );
      await doubleLine(session, "corner-branch");
      await expectSelection(
        session,
        ["corner-branch"],
        "branch stops upon entering the ring junction",
      );
      await doubleLine(session, "poly2", 0.5, "Control");
      await expectSelection(
        session,
        [...pentagon.map((item) => item.id), "corner-branch"],
        "Ctrl includes pentagon corner branch",
      );
    },
  );

  const chain = [
    line("tail", [-30, 0], [-20, 0]),
    line("entry", [-10, 0], [-20, 0]),
    line("stem", [-10, 0], [0, 0]),
    line("up", [0, 0], [0, 15]),
    line("right", [15, 0], [0, 0]),
    entity("circle", "unrelated", [[35, 20]], { radius: 4 }),
  ];
  await check(
    "three way branch stops normally while Ctrl expands and Shift adds",
    fixture("Three way contour", chain),
    async (session) => {
      await doubleLine(session, "entry");
      await expectSelection(
        session,
        ["tail", "entry", "stem"],
        "interior chain edge stops at three way junction",
      );
      await worldClick(session, { x: 39, y: 20 }, { double: false });
      await expectSelection(
        session,
        ["unrelated"],
        "unrelated initial selection",
      );
      await doubleLine(session, "stem", 0.5, "Control");
      await expectSelection(
        session,
        chain.map((item) => item.id),
        "Ctrl expands through branch and preserves unrelated selection",
      );
      // A single click on a member of an existing group preserves that group
      // for dragging. Clear on empty canvas before preparing the Shift baseline.
      await worldClick(session, { x: -40, y: 20 }, { double: false });
      await expectSelection(
        session,
        [],
        "empty canvas clears the Ctrl network",
      );
      await worldClick(session, { x: 39, y: 20 }, { double: false });
      await expectSelection(session, ["unrelated"], "unrelated Shift baseline");
      await doubleLine(session, "stem", 0.5, "Shift");
      await expectSelection(
        session,
        ["tail", "entry", "stem", "unrelated"],
        "Shift adds the stopped contour without traversing branch",
      );
      await doubleLine(session, "up");
      await expectSelection(
        session,
        ["up"],
        "entry directly into branch stops",
      );
    },
  );

  const fourWay = [
    line("down", [0, -15], [0, 0]),
    line("up", [0, 0], [0, 15]),
    line("left", [-15, 0], [0, 0]),
    line("right", [15, 0], [0, 0]),
  ];
  await check(
    "four way endpoint junction stops every entry and Ctrl visits all arms",
    fixture("Four way contour", fourWay),
    async (session) => {
      for (const item of fourWay) {
        await doubleLine(session, item.id);
        await expectSelection(
          session,
          [item.id],
          `${item.id} stops at four way junction`,
        );
      }
      await doubleLine(session, "left", 0.5, "Control");
      await expectSelection(
        session,
        fourWay.map((item) => item.id),
        "Ctrl follows all four endpoint branches",
      );
    },
  );

  const tee = [
    line("left-tail", [-32, 0], [-20, 0]),
    line("trunk", [-20, 0], [20, 0]),
    line("right-tail", [32, 0], [20, 0]),
    line("tee-branch", [0, 0], [0, 15]),
  ];
  await check(
    "interior T junction uses the clicked subedge and never traverses the other side",
    fixture("Interior tee contour", tee),
    async (session) => {
      await doubleLine(session, "trunk", 0.25);
      await expectSelection(
        session,
        ["left-tail", "trunk"],
        "left logical subedge stops at T while whole trunk is selected",
      );
      await doubleLine(session, "trunk", 0.75);
      await expectSelection(
        session,
        ["trunk", "right-tail"],
        "right logical subedge excludes beyond the T",
      );
      await doubleLine(session, "tee-branch");
      await expectSelection(
        session,
        ["tee-branch"],
        "T branch stops at line interior",
      );
      await doubleLine(session, "trunk", 0.25, "Control");
      await expectSelection(
        session,
        tee.map((item) => item.id),
        "Ctrl follows the entire T network",
      );
    },
  );

  const crossing = [
    line("horizontal", [-20, 0], [20, 0]),
    line("vertical", [0, -20], [0, 20]),
    line("diagonal", [-15, -15], [15, 15]),
  ];
  await check(
    "accidental interior X crossings remain disconnected under Ctrl",
    fixture("Crossing contour", crossing),
    async (session) => {
      await doubleLine(session, "horizontal", 0.25, "Control");
      await expectSelection(
        session,
        ["horizontal"],
        "Ctrl does not create topology at interior crossings",
      );
      await doubleLine(session, "vertical", 0.25);
      await expectSelection(
        session,
        ["vertical"],
        "vertical crossing line remains independent",
      );
      await worldClick(session, { x: 0, y: 0 });
      await expectSelection(
        session,
        ["diagonal"],
        "native click at crossing selects only the topmost path",
      );
    },
  );

  await check(
    "saved diameter double click edits the value and active editor blocks contour selection",
    fixture(
      "Diameter editor contour",
      [
        ...rectangle(),
        entity("circle", "diameter-circle", [[30, 0]], { radius: 5 }),
      ],
      [
        {
          id: "saved-diameter",
          kind: "diameter",
          refs: ["diameter-circle"],
          value: 10,
          labelPosition: { x: 40, y: 15 },
        },
      ],
    ),
    async (session) => {
      const label = (await metadata(session)).dimensions.find(
        (item) => item.id === "saved-diameter",
      );
      assert(label, "saved diameter has a canvas label");
      assert.equal(label.text, "Ø10");
      const box = await session.canvas.boundingBox();
      await nativeClick(session, { x: box.x + label.x, y: box.y + label.y });
      const input = session.page.getByTestId("dimension-input");
      await input.waitFor();
      assert.equal(await input.inputValue(), "10");
      await expectSelection(
        session,
        [],
        "numeric diameter double click opens editor without geometry selection",
      );
      await doubleLine(session, "rect0");
      assert.equal(
        await input.count(),
        1,
        "active value editor stays open after double click on geometry",
      );
      await expectSelection(
        session,
        [],
        "active editor does not expand rectangle contour",
      );
      await input.press("Escape");
      await input.waitFor({ state: "detached" });
      await unchanged(session, "cancel diameter editing");
    },
  );

  await check(
    "dimension and parameter picking never expand the contour",
    fixture("Picking guards contour", rectangle()),
    async (session) => {
      await session.canvas.focus();
      await session.page.keyboard.press("d");
      assert.equal(
        await session.page
          .locator('button[title="草图尺寸 (D)"]')
          .getAttribute("aria-pressed"),
        "true",
      );
      await doubleLine(session, "rect0");
      await expectSelection(
        session,
        [],
        "D mode picks references instead of selecting the rectangle",
      );
      await session.page.keyboard.press("Escape");
      await session.page.locator('button.ribbon-tool[title="移动"]').click();
      const panel = session.page.getByTestId("parameter-panel");
      await panel.waitFor();
      await doubleLine(session, "rect0");
      const picks = await rowNames(session);
      assert(
        picks.length <= 1,
        "geometry parameter double click may toggle its one pick but cannot select a contour",
      );
      await unchanged(session, "geometry parameter picks");
      session.observations.push({
        label: "geometry parameter double click",
        selectedRows: picks,
      });
      await panel.getByRole("button", { name: "取消", exact: true }).click();
      await panel.waitFor({ state: "detached" });
      await session.page.locator('button.ribbon-tool[title="修剪"]').click();
      await panel.waitFor();
      await worldClick(session, { x: -15, y: -10 }, { double: false });
      await expectSelection(
        session,
        ["rect0"],
        "trim receives only the single picked object",
      );
      await panel
        .getByRole("button", { name: "选择修剪位置", exact: true })
        .click();
      await doubleLine(session, "rect2");
      await expectSelection(
        session,
        ["rect0"],
        "position picking does not change geometry selection to its contour",
      );
      assert.match(
        await panel
          .locator('[data-parameter="position"] .geometry-pick')
          .innerText(),
        /\(/,
      );
      await panel.getByRole("button", { name: "取消", exact: true }).click();
      await expectSelection(
        session,
        [],
        "cancel picking restores original selection",
      );
    },
  );

  assert.equal(results.pageErrors.length, 0, "no browser runtime errors");
  assert.equal(results.consoleErrors.length, 0, "no browser console errors");
  assert(results.checks.length > 0, "at least one requested case ran");
  assert(
    results.checks.every((item) => item.passed),
    "all contour selection browser checks passed",
  );
} finally {
  results.finished = new Date().toISOString();
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
