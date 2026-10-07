/**
 * Regenerate the README screenshots from the running dev server.
 *
 * Usage: pnpm dev (in another terminal) then `node scripts/readme-screenshots.mjs`.
 * Environment: CAD_URL, CAD_SHOTS, CAD_BROWSER_PATH.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(process.env.CAD_SHOTS || "docs/screenshots");
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
const summary = [];

async function open(viewport, dpr = 2) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(".loading-overlay").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
        ?.renderer === "canvas2d",
  );
  await page.waitForTimeout(400);
  return { context, page };
}
const canvas = (page) => page.getByTestId("cad-canvas");
const metadata = (page) => canvas(page).evaluate((el) => el.__cadViewport);
const toScreen = async (page, world) => {
  const state = await metadata(page),
    box = await canvas(page).boundingBox();
  return {
    x: Math.round(box.x + state.origin.x + world.x * state.scale),
    y: Math.round(box.y + state.origin.y - world.y * state.scale),
  };
};
const hover = async (page, world) => {
  const p = await toScreen(page, world);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(220);
  return p;
};
const click = async (page, world) => {
  const p = await hover(page, world);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(260);
  return p;
};
const shot = async (page, name, clip) => {
  await page.screenshot({
    path: path.join(output, name),
    scale: "css",
    ...(clip ? { clip } : {}),
  });
  const { size } = await fs.stat(path.join(output, name));
  summary.push({ name, bytes: size });
  console.log(`saved ${name} (${Math.round(size / 1024)} kB)`);
};
const tangentPoints = (center, radius, from) => {
  const dx = from.x - center.x,
    dy = from.y - center.y,
    d = Math.hypot(dx, dy);
  if (!(d > radius)) return [];
  const ux = dx / d,
    uy = dy / d,
    cos = radius / d,
    sin = Math.sqrt(d * d - radius * radius) / d;
  return [1, -1].map((s) => ({
    x: center.x + radius * (cos * ux - s * sin * uy),
    y: center.y + radius * (cos * uy + s * sin * ux),
  }));
};

try {
  /* ------------------------------------------------- desktop overview */
  const desktop = await open({ width: 1440, height: 900 });
  try {
    const { page } = desktop;
    await page.mouse.move(20, 20);
    await page.waitForTimeout(200);
    await shot(page, "desktop-overview.png");

    /* ---------------------------------------- dimension hover preview */
    await page.keyboard.press("d");
    await page.waitForTimeout(200);
    await click(page, { x: -30, y: 36 }); // top profile edge -> length
    const hovered = await hover(page, { x: -30, y: -36 }); // parallel edge
    const preview = (await metadata(page)).dimensionPreview;
    await shot(page, "dimension-preview.png");
    summary.push({
      step: "dimension-preview",
      snap: preview?.kind,
      text: preview?.text,
    });

    /* ------------------------------------------ placed label + editor */
    await page.mouse.click(hovered.x, hovered.y); // confirm the pair
    await page.waitForTimeout(220);
    await click(page, { x: 30, y: 7 }); // blank spot fixes the label
    await page.locator('[data-testid="dimension-input"]').waitFor();
    const fixed = (await metadata(page)).dimensionPreview;
    await shot(page, "dimension-editor.png");
    summary.push({
      step: "dimension-editor",
      fixed: fixed?.fixed,
      text: fixed?.text,
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    /* -------------------------------------------- tangent capture cue */
    await page.keyboard.press("l");
    await page.waitForTimeout(200);
    const from = { x: -20, y: -20 };
    await click(page, from);
    const candidates = tangentPoints({ x: 42, y: 20 }, 5, from);
    let cue = null;
    for (const candidate of candidates) {
      await hover(page, candidate);
      const state = await metadata(page);
      if (state.snap?.kind === "tangent") {
        cue = state.snap;
        break;
      }
    }
    await shot(page, "capture-tangent.png");
    summary.push({
      step: "capture-tangent",
      cue: cue ? cue.kind : null,
      candidates,
    });
    await page.keyboard.press("Escape");
  } finally {
    await desktop.context.close();
  }

  /* --------------------------------------------- mobile overview */
  const mobile = await open({ width: 390, height: 844 });
  try {
    await mobile.page.mouse.move(20, 300);
    await mobile.page.waitForTimeout(200);
    await shot(mobile.page, "mobile-overview.png");
  } finally {
    await mobile.context.close();
  }

  const total = summary.reduce((sum, item) => sum + (item.bytes || 0), 0);
  console.log(
    `\n${summary.length} images, ${Math.round(total / 1024)} kB total in ${output}`,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
