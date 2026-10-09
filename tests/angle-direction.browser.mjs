import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173",
  output = path.resolve(
    process.env.CAD_ARTIFACTS || "artifacts/angle-direction",
  ),
  storage = "sketchworks.document.v1";
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
  checks: [],
  pageErrors: [],
  consoleErrors: [],
  browser: browser.version(),
};
await fs.mkdir(output, { recursive: true });
const entity = (id, coords, extra = {}) => ({
  id,
  kind: "line",
  name: id,
  points: coords.map(([x, y], i) => ({ id: `${id}_p${i}`, x, y })),
  ...extra,
});
const guide = entity(
  "guide",
  [
    [-50, -40],
    [50, 40],
  ],
  { construction: true },
);
const fixture = (entities = [], constraints = []) => ({
  version: 1,
  name: "Angle direction regression",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "angles",
      name: "Angles",
      visible: true,
      entities: [guide, ...entities],
      constraints: [
        { id: "guide-fixed", kind: "fixed", refs: [guide.id] },
        ...constraints,
      ],
    },
  ],
});
const byId = (doc, id) => doc.sketches[0].entities.find((e) => e.id === id);
const settle = (session) =>
  session.page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const saved = async (session) => {
  await session.page.waitForTimeout(700);
  await session.page.locator('.save-dot[data-saved="true"]').waitFor();
  return session.page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storage,
  );
};
const metadata = (session) => session.canvas.evaluate((el) => el.__cadViewport);
const near = (a, b, eps = 1e-5) =>
  assert(
    Math.hypot(a.x - b.x, a.y - b.y) <= eps,
    `${JSON.stringify(a)} != ${JSON.stringify(b)}`,
  );
async function open(doc) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    }),
    page = await context.newPage();
  await context.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 204 }),
  );
  page.on("pageerror", (e) => results.pageErrors.push(e.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      (results.failedResponses ??= []).push({
        url: response.url(),
        status: response.status(),
      });
  });
  page.on("console", (e) => {
    if (e.type() === "error") results.consoleErrors.push(e.text());
  });
  await page.addInitScript(
    ({ doc, storage }) => {
      if (!sessionStorage.getItem("angle-seeded")) {
        localStorage.setItem(storage, JSON.stringify(doc));
        sessionStorage.setItem("angle-seeded", "true");
      }
    },
    { doc, storage },
  );
  await page.goto(url);
  const session = { context, page, canvas: page.getByTestId("cad-canvas") };
  await ready(session);
  return session;
}
async function ready(session) {
  await session.page
    .locator(".loading-overlay")
    .waitFor({ state: "hidden", timeout: 120000 });
  await session.page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport?.stats
        .frames > 0,
  );
  await settle(session);
}
async function screen(session, p) {
  const state = await metadata(session),
    box = await session.canvas.boundingBox();
  return {
    x: box.x + state.origin.x + p.x * state.scale,
    y: box.y + state.origin.y - p.y * state.scale,
  };
}
async function click(session, p) {
  const target = await screen(session, p);
  await session.page.mouse.click(target.x, target.y);
  await settle(session);
}
async function chooseAngle(session, a, b, placement) {
  await session.page
    .getByRole("combobox", { name: "尺寸类型", exact: true })
    .selectOption("angle");
  await click(session, a);
  await click(session, b);
  const p = await screen(session, placement);
  await session.page.mouse.move(p.x, p.y);
  await settle(session);
  const preview = (await metadata(session)).dimensionPreview;
  assert(preview?.kind === "angle", "the selected sector has an angle preview");
  await session.page.mouse.click(p.x, p.y);
  await settle(session);
  const input = session.page.getByTestId("dimension-input");
  await input.waitFor();
  return { preview, input, value: Number(await input.inputValue()) };
}
async function commit(session, input, value) {
  await input.fill(String(value));
  await input.press("Enter");
  await input.waitFor({ state: "detached", timeout: 10000 });
  await settle(session);
  return saved(session);
}
function measured(doc, c) {
  const [a, b] = c.refs.map((id) => byId(doc, id)),
    sector = c.angleSector;
  const v = {
      x: (a.points[1].x - a.points[0].x) * (sector.reverseFirst ? -1 : 1),
      y: (a.points[1].y - a.points[0].y) * (sector.reverseFirst ? -1 : 1),
    },
    w = {
      x: (b.points[1].x - b.points[0].x) * (sector.reverseSecond ? -1 : 1),
      y: (b.points[1].y - b.points[0].y) * (sector.reverseSecond ? -1 : 1),
    },
    signed =
      (Math.atan2(v.x * w.y - v.y * w.x, v.x * w.x + v.y * w.y) * 180) /
      Math.PI;
  return ((sector.clockwise ? -signed : signed) + 360) % 360;
}
async function check(name, doc, test) {
  if (process.env.CAD_ANGLE_CASE && !name.includes(process.env.CAD_ANGLE_CASE))
    return;
  let session;
  try {
    session = await open(doc);
    const detail = await test(session);
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
    await fs.writeFile(
      path.join(output, "results.json"),
      JSON.stringify(results, null, 2),
    );
  }
}
try {
  const sectors = [
    { position: { x: 15, y: 5 }, value: 60 },
    { position: { x: -10, y: 15 }, value: 120 },
    { position: { x: -15, y: -5 }, value: 60 },
    { position: { x: 10, y: -15 }, value: 120 },
  ];
  for (const reverse of [false, true])
    for (let index = 0; index < sectors.length; index++) {
      const sample = sectors[index],
        a = entity(
          "first",
          reverse
            ? [
                [25, 0],
                [-25, 0],
              ]
            : [
                [-25, 0],
                [25, 0],
              ],
        ),
        b = entity("second", [
          [-12.5, -12.5 * Math.sqrt(3)],
          [12.5, 12.5 * Math.sqrt(3)],
        ]);
      await check(
        `crossing-sector-${index}-reverse-${reverse}`,
        fixture([a, b]),
        async (session) => {
          const picked = await chooseAngle(
            session,
            { x: -20, y: 0 },
            { x: 10, y: 10 * Math.sqrt(3) },
            sample.position,
          );
          assert(
            Math.abs(picked.value - sample.value) < 0.001,
            `prefilled ${picked.value}, expected ${sample.value}`,
          );
          assert(
            Math.abs(Number.parseFloat(picked.preview.text) - sample.value) <
              0.1,
            "preview measures the chosen sector",
          );
          const state = await metadata(session);
          assert(
            Math.sign((picked.preview.x - state.origin.x) / state.scale) ===
              Math.sign(sample.position.x),
            "preview lies in the chosen x region",
          );
          assert(
            Math.sign((state.origin.y - picked.preview.y) / state.scale) ===
              Math.sign(sample.position.y),
            "preview lies in the chosen y region",
          );
          const doc = await commit(session, picked.input, sample.value),
            c = doc.sketches[0].constraints.find((c) => c.kind === "angle");
          assert(c.angleSector, "direction metadata is persisted");
          assert(
            Math.abs(measured(doc, c) - sample.value) < 1e-4,
            "the native result matches selected rays",
          );
          await session.page.keyboard.press("Escape");
          await session.page.reload();
          await ready(session);
          const restored = await saved(session),
            restoredC = restored.sketches[0].constraints.find(
              (x) => x.id === c.id,
            );
          assert.deepEqual(restoredC.angleSector, c.angleSector);
          assert(Math.abs(measured(restored, restoredC) - sample.value) < 1e-4);
          const rendered = (await metadata(session)).dimensions.find(
            (x) => x.id === c.id,
          );
          assert(
            Number.parseFloat(rendered?.text) === sample.value,
            "chosen sector survives reload",
          );
          return { value: c.value, angleSector: c.angleSector };
        },
      );
    }

  for (const clockwise of [false, true])
    await check(
      `freehand-hexagon-120-clockwise-${clockwise}`,
      fixture(),
      async (session) => {
        const gridCapture = session.page.locator(
          '.bottom-actions button[title="网格捕获"]',
        );
        if ((await gridCapture.getAttribute("aria-pressed")) === "true")
          await gridCapture.click();
        await session.page
          .getByRole("button", { name: "直线", exact: true })
          .click();
        const vertices = [
          [20, 0],
          [10, 17],
          [-10, 16],
          [-19, 1],
          [-9, -17],
          [10, -16],
        ].map(([x, y]) => ({ x, y: clockwise ? -y : y }));
        for (const point of [...vertices, vertices[0]])
          await click(session, point);
        await session.page.keyboard.press("Escape");
        await settle(session);
        let doc = await saved(session);
        const ids = doc.sketches[0].entities
          .filter((e) => e.kind === "line" && !e.construction)
          .map((e) => e.id);
        assert.equal(
          ids.length,
          6,
          "six freehand line segments form the hexagon",
        );
        const convex = (document) => {
          const ps = ids.map((id) => byId(document, id).points[0]),
            sign = clockwise ? -1 : 1;
          for (let i = 0; i < 6; i++) {
            const a = ps[i],
              b = ps[(i + 1) % 6],
              c = ps[(i + 2) % 6];
            assert(
              sign * ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) >
                1e-4,
              `corner ${i} remains convex`,
            );
          }
        };
        convex(doc);
        for (let i = 0; i < 6; i++) {
          doc = await saved(session);
          const previous = byId(doc, ids[(i + 5) % 6]),
            next = byId(doc, ids[i]),
            center = ids
              .map((id) => byId(doc, id).points[0])
              .reduce(
                (sum, p) => ({ x: sum.x + p.x / 6, y: sum.y + p.y / 6 }),
                { x: 0, y: 0 },
              ),
            vertex = next.points[0],
            placement = {
              x: vertex.x + (center.x - vertex.x) * 0.38,
              y: vertex.y + (center.y - vertex.y) * 0.38,
            },
            midpoint = (e) => ({
              x: (e.points[0].x + e.points[1].x) / 2,
              y: (e.points[0].y + e.points[1].y) / 2,
            });
          const picked = await chooseAngle(
            session,
            midpoint(previous),
            midpoint(next),
            placement,
          );
          assert(
            picked.value > 90 && picked.value < 150,
            `corner ${i} prefill is an interior angle (${picked.value})`,
          );
          doc = await commit(session, picked.input, 120);
          convex(doc);
          for (const c of doc.sketches[0].constraints.filter(
            (c) => c.kind === "angle",
          ))
            assert(
              Math.abs(measured(doc, c) - 120) < 1e-4,
              "all constrained interior angles stay at 120",
            );
        }
        assert.equal(
          doc.sketches[0].constraints.filter((c) => c.kind === "angle").length,
          6,
        );
        await session.page.keyboard.press("Escape");
        await session.page.reload();
        await ready(session);
        const restored = await saved(session);
        convex(restored);
        const labels = (await metadata(session)).dimensions;
        assert.equal(
          labels.filter((label) => label.text === "120°").length,
          6,
          "all six labels display the 120-degree interior",
        );
        await session.page.screenshot({
          path: path.join(
            output,
            `hexagon-120-${clockwise ? "cw" : "ccw"}.png`,
          ),
        });
        return {
          angles: restored.sketches[0].constraints
            .filter((c) => c.kind === "angle")
            .map((c) => ({ value: c.value, angleSector: c.angleSector })),
        };
      },
    );
  assert(results.checks.length > 0);
  assert.deepEqual(results.pageErrors, []);
  assert.deepEqual(results.consoleErrors, []);
} finally {
  results.passed =
    results.checks.every((c) => c.passed) &&
    !results.pageErrors.length &&
    !results.consoleErrors.length;
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  if (!results.passed) process.exitCode = 1;
  console.log(
    `${results.checks.filter((c) => c.passed).length}/${results.checks.length} angle checks passed`,
  );
}
