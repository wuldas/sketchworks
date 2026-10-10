import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_ARTIFACTS || "artifacts/operation-preview",
);
const key = "sketchworks.document.v1";
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CAD_BROWSER_PATH ||
    (!existsSync(chromium.executablePath()) && existsSync(chrome)
      ? chrome
      : undefined),
});
await fs.mkdir(output, { recursive: true });
const entity = (id, kind, coords, extra = {}) => ({
  id,
  name: id,
  kind,
  points: coords.map(([x, y], i) => ({ id: `${id}_p${i}`, x, y })),
  ...extra,
});
const fixture = {
  version: 1,
  name: "Operation preview",
  unit: "mm",
  parameters: [{ name: "pitch", expression: "12", unit: "mm" }],
  sketches: [
    {
      id: "preview-sketch",
      name: "Preview sketch",
      visible: true,
      constraints: [],
      entities: [
        entity("source", "circle", [[-50, 0]], { radius: 4 }),
        entity("axis", "line", [
          [-20, -30],
          [-20, 30],
        ]),
        entity(
          "direction",
          "line",
          [
            [-60, -30],
            [-30, -30],
          ],
          { construction: true },
        ),
        entity("other", "point", [[-60, 20]]),
      ],
    },
  ],
};
const results = { checks: [], errors: [] };
let page;
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
try {
  await context.addInitScript(
    ({ key, fixture }) => localStorage.setItem(key, JSON.stringify(fixture)),
    { key, fixture },
  );
  page = await context.newPage();
  page.on("pageerror", (e) => results.errors.push(e.message));
  await page.goto(url);
  const canvas = page.getByTestId("cad-canvas"),
    panel = page.getByTestId("parameter-panel");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
        ?.renderer === "canvas2d",
    undefined,
    { timeout: 120000 },
  );
  await page.locator(".loading-overlay").waitFor({ state: "hidden" });
  await page
    .getByRole("checkbox", { name: "网格", exact: true })
    .setChecked(false);
  await page
    .getByRole("checkbox", { name: "吸附", exact: true })
    .setChecked(false);
  await page.locator('.save-dot[data-saved="true"]').waitFor();
  const saved = async () => {
    await page.waitForTimeout(750);
    await page.locator('.save-dot[data-saved="true"]').waitFor();
    return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
  };
  const baseline = await saved();
  const state = () => canvas.evaluate((c) => c.__cadViewport);
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const row = (id) =>
    page
      .locator(".entity-row")
      .filter({ hasText: new RegExp(`^${id}`) })
      .first();
  const param = (id) =>
    panel.locator(`.geometry-parameter[data-parameter="${id}"]`);
  const waitPreview = (count) =>
    page.waitForFunction((count) => {
      const p = document.querySelector('[data-testid="cad-canvas"]')
        ?.__cadViewport?.operationPreview;
      return count === null ? p === null : p?.entityCount === count;
    }, count);
  const open = async (menu, name) => {
    await page
      .locator(".dropdown-caption")
      .filter({ hasText: menu })
      .first()
      .click();
    await page
      .locator(".menu-item")
      .filter({ hasText: new RegExp(`^${name}$`) })
      .first()
      .click();
    await panel.waitFor();
    await settle();
  };
  const fill = async (name, value) => {
    await panel.getByRole("textbox", { name, exact: true }).fill(value);
    await settle();
  };
  const confirm = async () => {
    await panel.locator('button[type="submit"]').click();
    await panel.waitFor({ state: "detached" });
    await waitPreview(null);
  };
  const cancel = async () => {
    await panel
      .locator(".parameter-panel-actions button", { hasText: "取消" })
      .click();
    await panel.waitFor({ state: "detached" });
    await waitPreview(null);
  };
  const history = () => page.locator(".app").getAttribute("data-history");
  const cyan = (point) =>
    canvas.evaluate((c, point) => {
      const s = c.__cadViewport,
        cx = s.origin.x + point.x * s.scale,
        cy = s.origin.y - point.y * s.scale;
      if (cx < 9 || cy < 9 || cx >= s.width - 9 || cy >= s.height - 9)
        return -1;
      const data = c
        .getContext("2d")
        .getImageData(
          Math.floor((cx - 8) * s.dpr),
          Math.floor((cy - 8) * s.dpr),
          16 * s.dpr,
          16 * s.dpr,
        ).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (g > r * 1.4 && b > r * 1.4 && b >= g) count++;
      }
      return count;
    }, point);
  const clickAt = async (point) => {
    const s = await state(),
      b = await canvas.boundingBox();
    await page.mouse.click(
      b.x + s.origin.x + point.x * s.scale,
      b.y + s.origin.y - point.y * s.scale,
    );
    await settle();
  };
  const initialHistory = await history();

  await check(
    "mirror appears only after selecting its axis and changes with the axis",
    async () => {
      await row("source").click();
      await open("创建", "镜像");
      await waitPreview(null);
      await row("axis").click();
      await waitPreview(1);
      assert(
        (await cyan({ x: 10, y: -4 })) > 3,
        "the reflected circle is painted",
      );
      assert.equal((await state()).stats.sceneEntities, 4);
      assert.equal(await page.locator(".entity-row").count(), 4);
      assert.deepEqual(await saved(), baseline);
      assert.equal(await history(), initialHistory);
      await param("axis").locator(".geometry-clear").click();
      await waitPreview(null);
      await row("direction").click();
      await waitPreview(1);
      await page.locator('.view-controls button[title="适配全部"]').click();
      await settle();
      assert(
        (await cyan({ x: -50, y: -64 })) > 3,
        "fit includes the new preview bounds",
      );
      assert.equal(
        await cyan({ x: 10, y: -4 }),
        0,
        "the previous reflection was removed",
      );
      await page.screenshot({ path: path.join(output, "mirror.png") });
      await cancel();
      assert.equal(await cyan({ x: -50, y: -64 }), 0);
      assert.deepEqual(await saved(), baseline);
      assert.equal(await history(), initialHistory);
    },
  );

  await check(
    "array preview updates expressions and clears for invalid or missing parameters",
    async () => {
      await row("source").click();
      await open("创建", "矩形阵列");
      await fill("数量 1", "3");
      await fill("数量 2", "1");
      await fill("距离 1", "pitch");
      await waitPreview(2);
      assert((await cyan({ x: -38, y: -4 })) > 3);
      await fill("距离 1", "2*pitch");
      await waitPreview(2);
      assert((await cyan({ x: -26, y: -4 })) > 3);
      assert.equal(await cyan({ x: -38, y: -4 }), 0);
      await fill("距离 1", "1+");
      await waitPreview(null);
      assert.equal(
        await panel.locator('button[type="submit"]').isDisabled(),
        true,
      );
      await fill("距离 1", "pitch");
      await waitPreview(2);
      await fill("数量 1", "2.5");
      await waitPreview(null);
      assert.equal(
        await panel.locator('button[type="submit"]').isDisabled(),
        true,
      );
      await fill("数量 1", "3");
      await waitPreview(2);
      await param("objects").locator(".geometry-clear").click();
      await waitPreview(null);
      await row("source").click();
      await waitPreview(2);
      assert.deepEqual(await saved(), baseline);
      assert.equal(await history(), initialHistory);
    },
  );

  await check(
    "array direction is previewed and confirmation creates exactly the displayed instances",
    async () => {
      await param("direction").locator(".geometry-pick").click();
      await row("axis").click();
      await waitPreview(2);
      assert((await cyan({ x: -50, y: 8 })) > 3);
      await page.screenshot({ path: path.join(output, "array.png") });
      await confirm();
      const doc = await saved(),
        copies = doc.sketches[0].entities.filter(
          (e) => e.sourceId === "source",
        );
      assert.equal(copies.length, 2);
      assert.deepEqual(
        copies.map((e) => [e.points[0].x, e.points[0].y]),
        [
          [-50, 12],
          [-50, 24],
        ],
      );
      assert.equal(Number(await history()), Number(initialHistory) + 1);
      assert.equal((await state()).stats.sceneEntities, 6);
    },
  );

  const arrayDocument = await saved(),
    arrayHistory = await history();
  await check(
    "circular array responds to coordinate fields and a picked center without committing",
    async () => {
      await row("source").click();
      await open("创建", "环形阵列");
      await fill("数量", "4");
      await fill("中心 X", "-40");
      await fill("中心 Y", "0");
      await waitPreview(3);
      assert((await cyan({ x: -40, y: -14 })) > 3);
      await param("position").locator(".geometry-pick").click();
      await clickAt({ x: -45, y: 0 });
      await waitPreview(3);
      const cx = Number(
        await panel
          .getByRole("textbox", { name: "中心 X", exact: true })
          .inputValue(),
      );
      const cy = Number(
        await panel
          .getByRole("textbox", { name: "中心 Y", exact: true })
          .inputValue(),
      );
      assert((await cyan({ x: cx + cy, y: cy - 50 - cx - 4 })) > 3);
      assert.deepEqual(await saved(), arrayDocument);
      await cancel();
      assert.deepEqual(await saved(), arrayDocument);
      assert.equal(await history(), arrayHistory);
    },
  );

  await check(
    "move previews the source and dependent copies, reuses its geometry, and cancels cleanly",
    async () => {
      await row("source").click();
      await open("修改", "移动");
      await waitPreview(3);
      await fill("X 位移", "15");
      await fill("Y 位移", "5");
      await waitPreview(3);
      assert((await cyan({ x: -35, y: 1 })) > 3);
      const current = await state(),
        box = await canvas.boundingBox();
      await page.mouse.move(
        box.x + current.origin.x - 35 * current.scale,
        box.y + current.origin.y - 5 * current.scale,
      );
      await settle();
      assert.equal(
        (await state()).operationPreview.revision,
        current.operationPreview.revision,
      );
      assert.equal((await state()).stats.baseDraws, current.stats.baseDraws);
      assert.deepEqual(await saved(), arrayDocument);
      assert.equal(await history(), arrayHistory);
      await page.screenshot({ path: path.join(output, "move.png") });
      await cancel();
      assert.equal(await cyan({ x: -35, y: 1 }), 0);
      assert.deepEqual(await saved(), arrayDocument);
      assert.equal(await history(), arrayHistory);
    },
  );

  await check(
    "move confirmation saves the previewed position in one undo step",
    async () => {
      await row("source").click();
      await open("修改", "移动");
      await fill("X 位移", "15");
      await fill("Y 位移", "5");
      await waitPreview(3);
      await confirm();
      const doc = await saved(),
        s = doc.sketches[0];
      assert.deepEqual(
        [s.entities[0].points[0].x, s.entities[0].points[0].y],
        [-35, 5],
      );
      assert.deepEqual(
        s.entities
          .filter((e) => e.sourceId === "source")
          .map((e) => [e.points[0].x, e.points[0].y]),
        [
          [-35, 17],
          [-35, 29],
        ],
      );
      assert.equal(Number(await history()), Number(arrayHistory) + 1);
      await page.locator('button[title="撤销 (Ctrl+Z)"]').click();
      const undone = await saved();
      assert.deepEqual(
        undone.sketches[0].entities,
        arrayDocument.sketches[0].entities,
      );
      assert.deepEqual(results.errors, []);
    },
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await context.close();
  await browser.close();
}
