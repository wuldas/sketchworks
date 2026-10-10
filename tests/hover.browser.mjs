import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(process.env.CAD_ARTIFACTS || "artifacts/hover");
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
const shape = (id, kind, coords, extra = {}) => ({
  id,
  name: id,
  kind,
  points: coords.map(([x, y], i) => ({ id: `${id}_p${i}`, x, y })),
  ...extra,
});
const fixture = {
  version: 1,
  name: "Hover fixture",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "hover-sketch",
      name: "Hover sketch",
      visible: true,
      constraints: [],
      entities: [
        shape("line", "line", [
          [-60, -15],
          [-30, -15],
        ]),
        shape("circle", "circle", [[-45, 20]], { radius: 8 }),
        shape(
          "construction",
          "line",
          [
            [0, -25],
            [30, -25],
          ],
          { construction: true },
        ),
      ],
    },
  ],
};
const results = [];
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: dpr,
    });
    try {
      await context.addInitScript(
        ({ key, fixture }) =>
          localStorage.setItem(key, JSON.stringify(fixture)),
        { key, fixture },
      );
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error(`DPR ${dpr}: ${e.message}`);
      });
      await page.goto(url);
      await page.bringToFront();
      const canvas = page.getByTestId("cad-canvas");
      await canvas.waitFor({ state: "visible", timeout: 120000 });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
            ?.renderer === "canvas2d",
        undefined,
        { timeout: 120000, polling: 50 },
      );
      await page.locator(".loading-overlay").waitFor({ state: "hidden" });
      await page
        .getByRole("checkbox", { name: "网格", exact: true })
        .setChecked(false);
      await page
        .getByRole("checkbox", { name: "吸附", exact: true })
        .setChecked(false);
      const settle = () =>
        page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
      await settle();
      const state = () => canvas.evaluate((c) => c.__cadViewport);
      const move = async (point, expected) => {
        const s = await state(),
          b = await canvas.boundingBox();
        await page.mouse.move(
          b.x + s.origin.x + point.x * s.scale,
          b.y + s.origin.y - point.y * s.scale,
        );
        await page.waitForFunction(
          (id) =>
            document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
              ?.hoveredEntityId === id,
          expected,
        );
        await settle();
      };
      const blank = { x: -20, y: -8 },
        probe = { x: -45, y: -15 };
      const profile = (point, family = "green") =>
        canvas.evaluate(
          (c, { point, family }) => {
            const s = c.__cadViewport,
              cx = s.origin.x + point.x * s.scale,
              cy = s.origin.y - point.y * s.scale;
            const data = c
              .getContext("2d")
              .getImageData(
                Math.floor((cx - 10) * s.dpr),
                Math.floor((cy - 6) * s.dpr),
                20 * s.dpr,
                12 * s.dpr,
              ).data;
            let count = 0,
              darkest = 765;
            for (let i = 0; i < data.length; i += 4) {
              const [r, g, b] = data.slice(i, i + 3);
              const matches =
                family === "blue"
                  ? b > r * 1.15 && b > g * 1.04
                  : family === "orange"
                    ? r > g * 1.2 && g > b * 1.4
                    : g > r * 1.3 && g > b * 1.08;
              if (matches) {
                count++;
                darkest = Math.min(darkest, r + g + b);
              }
            }
            return { count, darkest };
          },
          { point, family },
        );
      const compare = (normal, hover) => {
        assert(normal.count > 0, "normal object is visible");
        assert(
          hover.count > normal.count * 1.35,
          "hover makes the stroke thicker",
        );
        assert(
          hover.darkest < normal.darkest - 35,
          "hover darkens the same color family",
        );
      };
      await move(blank, null);
      const normal = await profile(probe),
        cached = (await state()).stats;
      const documentBefore = await page.evaluate(
        (key) => localStorage.getItem(key),
        key,
      );
      await move(probe, "line");
      const selectedHover = await profile(probe);
      compare(normal, selectedHover);
      assert.equal((await state()).stats.baseDraws, cached.baseDraws);
      assert.equal((await state()).stats.compiledPaths, cached.compiledPaths);
      assert.equal(
        await page.locator(".entity-row.selected").count(),
        0,
        "hover does not select the object",
      );
      await page.screenshot({
        path: path.join(output, `select-dpr${dpr}.png`),
      });
      await move(blank, null);
      assert.deepEqual(
        await profile(probe),
        normal,
        "leaving restores the exact cached stroke",
      );

      await page.locator('button[title="草图尺寸 (D)"]').click();
      await move(probe, "line");
      compare(normal, await profile(probe));
      const circleProbe = { x: -45 + 8 / Math.SQRT2, y: 20 + 8 / Math.SQRT2 };
      await move(circleProbe, "circle");
      await page.screenshot({ path: path.join(output, `ruler-dpr${dpr}.png`) });
      await page.keyboard.press("l");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
            ?.hoveredEntityId === null,
      );
      await page.keyboard.press("Escape");
      await move(blank, null);
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), key),
        documentBefore,
        "hover/tool switching does not modify geometry",
      );

      const constructionProbe = { x: 15, y: -25 };
      const blue = await profile(constructionProbe, "blue");
      await move(constructionProbe, "construction");
      compare(blue, await profile(constructionProbe, "blue"));
      await move(blank, null);
      await page.locator(".entity-row").filter({ hasText: /^line/ }).click();
      await move(blank, null);
      const orange = await profile(probe, "orange");
      await move(probe, "line");
      compare(orange, await profile(probe, "orange"));
      assert.equal(await page.locator(".entity-row.selected").count(), 1);
      await page.mouse.move(10, 10);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
            ?.hoveredEntityId === null,
      );
      const clickAt = async (point) => {
        const s = await state(),
          b = await canvas.boundingBox();
        await page.mouse.click(
          b.x + s.origin.x + point.x * s.scale,
          b.y + s.origin.y - point.y * s.scale,
        );
        await settle();
      };
      await move(blank, null);
      await clickAt(blank);
      assert.equal(await page.locator(".entity-row.selected").count(), 0);
      await page.locator('button[title="草图尺寸 (D)"]').click();
      await move(probe, "line");
      await clickAt(probe);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
            ?.dimensionPreview?.kind === "length",
      );
      assert.equal(await page.getByTestId("dimension-input").count(), 0);
      const placement = { x: -45, y: -4 };
      await move(placement, null);
      await clickAt(placement);
      const editor = page.getByTestId("dimension-input");
      await editor.waitFor();
      await editor.press("Escape");
      await editor.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), key),
        documentBefore,
      );
      assert.deepEqual(errors, []);
      results.push({ dpr, passed: true, normal, hover: selectedHover });
      console.log(
        `PASS hover emphasis, color preservation, cached restoration and tool switching at DPR ${dpr}`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
