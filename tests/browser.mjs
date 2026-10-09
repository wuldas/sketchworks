import { chromium } from "@playwright/test";
import DxfParser from "dxf-parser";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { inflateSync } from "node:zlib";

const URL = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(process.env.CAD_ARTIFACTS || "artifacts");
const storage = "sketchworks.document.v1";
const results = {
  url: URL,
  started: new Date().toISOString(),
  viewports: {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
  },
  checks: [],
  wasm: [],
  consoleErrors: [],
  pageErrors: [],
  externalRequests: [],
};
await fs.mkdir(output, { recursive: true });
const localChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const executablePath =
  process.env.CAD_BROWSER_PATH ||
  (!existsSync(chromium.executablePath()) && existsSync(localChrome)
    ? localChrome
    : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
results.browser = browser.version();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
await context.route("**/*", (route) => {
  const url = route.request().url();
  if (
    /^https?:/.test(url) &&
    new globalThis.URL(url).origin !== new globalThis.URL(URL).origin
  ) {
    results.externalRequests.push(url);
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") results.consoleErrors.push(message.text());
});
page.on("pageerror", (error) => results.pageErrors.push(error.message));
page.on("response", (response) => {
  if (/\.wasm(?:\?|$)/.test(response.url()))
    results.wasm.push({ url: response.url(), status: response.status() });
});
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
const button = (name) =>
  page
    .getByRole("button", { name, exact: true })
    .or(page.locator(`button:not(.entity-row)[title=${JSON.stringify(name)}]`));
const doc = async () =>
  JSON.parse(await page.evaluate((key) => localStorage.getItem(key), storage));
const saved = async () => {
  await page.waitForTimeout(700);
  await page.locator('.save-dot[data-saved="true"]').waitFor();
  return doc();
};
const canvas = page.getByTestId("cad-canvas");
const compactCanvasOverlays = async () => {
  const controls = await page.locator(".view-controls").boundingBox();
  const badge = await page.locator(".view-badge").boundingBox();
  assert(
    controls && controls.width <= 140 && controls.height <= 45,
    "zoom controls must not obscure the canvas",
  );
  assert(
    badge && badge.width >= 90 && badge.height <= 35,
    "view badge must stay on one compact row",
  );
};
const clickAt = async (x, y) => {
  const b = await canvas.boundingBox();
  await page.mouse.click(b.x + b.width * x, b.y + b.height * y);
};
const selectEntity = (index) => page.locator(".entity-row").nth(index).click();
const dimensionEditor = () => page.getByTestId("dimension-input");
const lengthLabelPosition = (state, line, world) => {
  const [a, b] = line.points;
  const size = Math.hypot(b.x - a.x, b.y - a.y);
  const normal = { x: -(b.y - a.y) / size, y: (b.x - a.x) / size };
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const offset =
    (world.x - midpoint.x) * normal.x + (world.y - midpoint.y) * normal.y;
  assert(
    Math.abs(offset) * state.scale >= 12,
    "placement has a readable perpendicular offset",
  );
  return {
    x: state.origin.x + (midpoint.x + normal.x * offset) * state.scale,
    y: state.origin.y - (midpoint.y + normal.y * offset) * state.scale,
  };
};
const placeDimension = async () => {
  assert.equal(
    await dimensionEditor().count(),
    0,
    "line placement has no editor yet",
  );
  const state = await viewport();
  assert(
    state.dimensionPreview,
    "selected line has a visible dimension preview",
  );
  assert.equal(
    state.dimensionPreview.fixed,
    false,
    "label is not fixed before blank click",
  );
  const box = await canvas.boundingBox();
  const target = {
    x: Math.round(box.x + box.width * 0.52),
    y: Math.round(box.y + box.height * 0.15),
  };
  await page.mouse.click(target.x, target.y);
  await dimensionEditor().waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="cad-canvas"]')?.__cadViewport
        ?.dimensionPreview?.fixed === true,
  );
  const placed = (await viewport()).dimensionPreview;
  assert(placed?.fixed, "blank click fixes the preview and opens the editor");
  const local = { x: target.x - box.x, y: target.y - box.y };
  const world = {
    x: (local.x - state.origin.x) / state.scale,
    y: (state.origin.y - local.y) / state.scale,
  };
  const line = geometry(await doc()).entities.find(
    (item) => item.id === placed.refs[0],
  );
  const projected = lengthLabelPosition(state, line, world);
  assert(
    Math.abs(placed.x - projected.x) <= 0.5,
    "preview x is the projected label coordinate",
  );
  assert(
    Math.abs(placed.y - projected.y) <= 0.5,
    "preview y is the projected label coordinate",
  );
  return world;
};
const editDimension = async (value) => {
  const input = dimensionEditor();
  await input.waitFor();
  await input.fill(String(value));
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  // Leave the dimension tool so later steps select and drag again.
  await page.keyboard.press("Escape");
};
const geometry = (d) => d.sketches[0];
const length = (e) =>
  Math.hypot(e.points[1].x - e.points[0].x, e.points[1].y - e.points[0].y);
const viewport = async () =>
  canvas.evaluate((element) => element.__cadViewport);
const canvasReady = async () => {
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="cad-canvas"]');
    return (
      element instanceof HTMLCanvasElement &&
      element.__cadViewport?.renderer === "canvas2d"
    );
  });
};
const doubleClickDimension = async (text) => {
  await page.waitForFunction(
    (text) =>
      document
        .querySelector('[data-testid="cad-canvas"]')
        ?.__cadViewport?.dimensions.some(
          (dimension) => dimension.text === text,
        ),
    String(text),
  );
  const dimension = (await viewport()).dimensions.find(
    (dimension) => dimension.text === String(text),
  );
  assert(dimension, `visible Canvas dimension ${text}`);
  const box = await canvas.boundingBox();
  await page.mouse.dblclick(box.x + dimension.x, box.y + dimension.y);
};
const dragHandle = async (pointId, dx, dy) => {
  const state = await viewport();
  const handle = state.handles.findLast((handle) => handle.pointId === pointId);
  const point = (await doc()).sketches
    .flatMap((sketch) => sketch.entities)
    .flatMap((entity) => entity.points)
    .find((point) => point.id === pointId);
  assert(handle || point, "existing Canvas point handle");
  const position = handle ?? {
    x: state.origin.x + point.x * state.scale,
    y: state.origin.y - point.y * state.scale,
  };
  assert(
    position.x >= 0 &&
      position.x <= state.width &&
      position.y >= 0 &&
      position.y <= state.height,
    "point handle lies in the visible Canvas",
  );
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + position.x, box.y + position.y);
  await page.mouse.down();
  await page.mouse.move(box.x + position.x + dx, box.y + position.y + dy, {
    steps: 12,
  });
  await page.mouse.up();
};
const download = async (action, filename) => {
  const pending = page.waitForEvent("download");
  await action();
  const item = await pending;
  const target = path.join(output, filename);
  await item.saveAs(target);
  assert.equal(await item.failure(), null);
  return fs.readFile(target, "utf8");
};
// Decode the actual Chromium PNG, including PNG scanline filters, to inspect rendered pixels.
async function pixels(filename) {
  const png = await fs.readFile(filename);
  let at = 8,
    width,
    height,
    channels;
  const chunks = [];
  while (at < png.length) {
    const size = png.readUInt32BE(at),
      kind = png.toString("ascii", at + 4, at + 8),
      data = png.subarray(at + 8, at + 8 + size);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert(channels);
    }
    if (kind === "IDAT") chunks.push(data);
    at += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    stride = width * channels;
  let previous = Buffer.alloc(stride),
    offset = 0,
    colored = 0;
  const colors = new Set();
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++],
      row = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0,
        b = previous[x],
        c = x >= channels ? previous[x - channels] : 0;
      row[x] =
        (row[x] +
          (filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : filter === 4
                  ? paeth(a, b, c)
                  : 0)) &
        255;
    }
    for (let x = 0; x < stride; x += channels) {
      const [r, g, b] = row.subarray(x, x + 3);
      colors.add(`${r},${g},${b}`);
      if (g > r * 1.15 && g > b * 1.05 && r < 170) colored++;
    }
    previous = row;
  }
  assert(colors.size > 30, "canvas has varied rendered pixels");
  assert(colored > 100, "canvas contains CAD geometry pixels");
  return { width, height, uniqueColors: colors.size, geometryPixels: colored };
}
async function advancedChecks() {
  await check(
    "Duplicate dimension rejected without document mutation",
    async () => {
      await selectEntity(5);
      const before = await saved();
      await button("草图尺寸 (D)").click();
      await placeDimension();
      const input = dimensionEditor();
      await input.waitFor();
      await input.fill("99");
      await input.press("Enter");
      assert(
        await input.isVisible(),
        "invalid dimension keeps the inline editor open",
      );
      assert(
        await page.locator(".toast.error").isVisible(),
        "duplicate dimension reports error",
      );
      assert.deepEqual(await saved(), before);
      await input.press("Escape");
      await input.waitFor({ state: "detached" });
    },
  );
  await check(
    "Inch display exports DXF and SVG in internal millimeters",
    async () => {
      const before = geometry(await saved());
      await page
        .getByRole("combobox", { name: "单位", exact: true })
        .selectOption("in");
      const current = await saved();
      assert.equal(current.unit, "in");
      assert.deepEqual(geometry(current), before);
      const dxf = await download(async () => {
        await page.locator(".export-button").click();
        await page
          .locator(".dialog")
          .getByRole("button", { name: "导出", exact: true })
          .click();
      }, "inches-display.dxf");
      const parsed = new DxfParser().parseSync(dxf);
      assert.equal(parsed.header.$INSUNITS, 4);
      const exportedLine = parsed.entities
        .filter((e) => e.type === "LINE")
        .at(-1);
      assert(
        Math.abs(
          Math.hypot(
            exportedLine.vertices[1].x - exportedLine.vertices[0].x,
            exportedLine.vertices[1].y - exportedLine.vertices[0].y,
          ) - 34,
        ) < 1e-5,
      );
      const svg = await download(async () => {
        await page.locator(".export-button").click();
        await page
          .getByRole("combobox", { name: "文件格式", exact: true })
          .selectOption("SVG");
        await page
          .locator(".dialog")
          .getByRole("button", { name: "导出", exact: true })
          .click();
      }, "inches-display.svg");
      const xml = await page.evaluate((text) => {
        const document = new DOMParser().parseFromString(text, "image/svg+xml");
        return {
          errors: document.querySelectorAll("parsererror").length,
          width: document.documentElement.getAttribute("width"),
          height: document.documentElement.getAttribute("height"),
          radius: Number(document.querySelector("circle").getAttribute("r")),
        };
      }, svg);
      assert.equal(xml.errors, 0);
      assert(xml.width.endsWith("mm"));
      assert(xml.height.endsWith("mm"));
      assert(Math.abs(xml.radius - before.entities[4].radius) < 1e-5);
      return {
        dxfUnits: parsed.header.$INSUNITS,
        exportedLineLength: 34,
        svgWidth: xml.width,
        svgHeight: xml.height,
      };
    },
  );
}
async function parameterChecks() {
  await check(
    "Parameter-driven dimensions and associated array spacing",
    async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await page.locator(".loading-overlay").waitFor({ state: "hidden" });
      const parameters = async (width, pitch) => {
        await button("修改").click();
        await button("更改参数").click();
        await page
          .getByRole("textbox", {
            name: "名称, 表达式, 单位（每行一项）",
            exact: true,
          })
          .fill(`width, ${width}, mm\npitch, ${pitch}, mm`);
        await button("确定").click();
        await page.locator(".dialog").waitFor({ state: "hidden" });
        return geometry(await saved());
      };
      await parameters(22, 7);
      await doubleClickDimension("16");
      await editDimension("width");
      let sk = geometry(await saved());
      assert(Math.abs(length(sk.entities[5]) - 22) < 1e-5);
      assert(
        sk.constraints.some(
          (c) => c.kind === "length" && c.expression === "width",
        ),
      );
      await selectEntity(4);
      await button("创建").click();
      await button("矩形阵列").click();
      const arrayPanel = page.getByTestId("parameter-panel");
      await arrayPanel.waitFor();
      assert.equal(
        (await arrayPanel.locator(".geometry-pick span").first().innerText()).trim(),
        "已选择 1 个",
        "the preselected object fills the 对象 parameter",
      );
      await arrayPanel
        .getByRole("textbox", { name: "数量 1", exact: true })
        .fill("3");
      await arrayPanel
        .getByRole("textbox", { name: "数量 2", exact: true })
        .fill("1");
      await arrayPanel
        .getByRole("textbox", { name: "距离 1", exact: true })
        .fill("pitch");
      await arrayPanel
        .getByRole("textbox", { name: "距离 2", exact: true })
        .fill("0");
      await arrayPanel.locator('button[type="submit"]').click();
      await arrayPanel.waitFor({ state: "detached" });
      sk = geometry(await saved());
      assert.equal(sk.entities.length, 8);
      const sourceId = sk.entities[4].id;
      const spacing = (sk, pitch) => {
        const source = sk.entities.find((e) => e.id === sourceId),
          copies = sk.entities.filter((e) => e.sourceId === sourceId);
        assert.equal(copies.length, 2);
        assert(copies.every((e) => e.transform.xExpression?.includes("pitch")));
        assert(
          !sk.constraints.some((c) =>
            c.refs.some((ref) =>
              copies.some(
                (e) => e.id === ref || e.points.some((p) => p.id === ref),
              ),
            ),
          ),
        );
        const offsets = copies
          .map((e) => e.points[0].x - source.points[0].x)
          .sort((a, b) => a - b);
        assert(Math.abs(offsets[0] - pitch) < 1e-5);
        assert(Math.abs(offsets[1] - 2 * pitch) < 1e-5);
      };
      spacing(sk, 7);
      sk = await parameters(28, 9);
      spacing(sk, 9);
      assert(Math.abs(length(sk.entities[5]) - 28) < 1e-5);
      await page.locator(".entity-row").nth(6).dblclick();
      await page
        .getByRole("textbox", { name: "X 位移", exact: true })
        .fill("3*pitch");
      await button("确定").click();
      await page.locator(".dialog").waitFor({ state: "hidden" });
      sk = geometry(await saved());
      assert(
        Math.abs(sk.entities[6].points[0].x - sk.entities[4].points[0].x - 27) <
          1e-5,
      );
      sk = await parameters(34, 13);
      assert(Math.abs(length(sk.entities[5]) - 34) < 1e-5);
      assert(
        Math.abs(sk.entities[6].points[0].x - sk.entities[4].points[0].x - 39) <
          1e-5,
      );
      assert(
        Math.abs(sk.entities[7].points[0].x - sk.entities[4].points[0].x - 26) <
          1e-5,
      );
      return { length: 34, editedCopyOffset: 39, arrayCopyOffset: 26 };
    },
  );
}
try {
  await check("WASM network success and solver ready", async () => {
    await page.goto(URL);
    await page
      .locator(".loading-overlay")
      .waitFor({ state: "hidden", timeout: 30000 });
    await canvasReady();
    const surface = await canvas.evaluate((element) => ({
      isCanvas: element instanceof HTMLCanvasElement,
      renderer: element.__cadViewport.renderer,
      width: element.width,
      height: element.height,
      cssWidth: element.__cadViewport.width,
      cssHeight: element.__cadViewport.height,
      dpr: element.__cadViewport.dpr,
      sceneDomNodes: element.parentElement.querySelectorAll(
        ":scope > svg, [data-entity-id], [data-point-id], .dimension",
      ).length,
    }));
    assert.equal(surface.isCanvas, true);
    assert.equal(surface.renderer, "canvas2d");
    assert.equal(surface.sceneDomNodes, 0);
    assert(
      Math.abs(surface.width - Math.round(surface.cssWidth * surface.dpr)) <= 1,
    );
    assert(
      Math.abs(surface.height - Math.round(surface.cssHeight * surface.dpr)) <=
        1,
    );
    await button("新建草图").waitFor();
    assert(
      results.wasm.some((r) => r.status === 200),
      "WASM response status 200",
    );
    assert(
      !(await page
        .locator(".solver-status")
        .getAttribute("class")
        .then((c) => c.includes("loading"))),
    );
    return results.wasm;
  });
  await check("New document and rectangle/circle/line creation", async () => {
    await button("文件").click();
    await button("新建文档").click();
    await page
      .locator(".dialog")
      .getByRole("textbox", { name: "文档名称", exact: true })
      .fill("Browser E2E");
    await button("新建").click();
    assert.equal(geometry(await saved()).entities.length, 0);
    await page.getByRole("checkbox", { name: "吸附", exact: true }).uncheck();
    await button("两点矩形").click();
    await clickAt(0.2, 0.3);
    await clickAt(0.48, 0.65);
    await page.keyboard.press("Escape");
    assert.equal(geometry(await saved()).entities.length, 4);
    await button("圆心圆").click();
    await clickAt(0.72, 0.45);
    await clickAt(0.81, 0.45);
    await page.keyboard.press("Escape");
    assert.equal(geometry(await saved()).entities.length, 5);
    await button("直线").click();
    await clickAt(0.56, 0.78);
    await clickAt(0.85, 0.78);
    await page.keyboard.press("Escape");
    const sk = geometry(await saved());
    assert.equal(sk.entities.length, 6);
    assert.equal(sk.entities.filter((e) => e.kind === "circle").length, 1);
    return { entities: 6, rectangleConstraints: sk.constraints.length };
  });
  await check("Browser selection and length dimension", async () => {
    await selectEntity(5);
    assert(
      await page
        .locator(".entity-row")
        .nth(5)
        .evaluate((e) => e.classList.contains("selected")),
    );
    const before = await saved();
    const baseDimensions = (await viewport()).dimensions;
    await button("草图尺寸 (D)").click();
    assert.equal(
      await dimensionEditor().count(),
      0,
      "selected line enters placement without input",
    );
    const preview = (await viewport()).dimensionPreview;
    assert.equal(preview?.kind, "length", "selection previews a line length");
    assert.deepEqual(preview.refs, [geometry(before).entities[5].id]);
    assert.deepEqual(
      (await viewport()).dimensions,
      baseDimensions,
      "preview is not a saved dimension",
    );
    assert.deepEqual(
      await saved(),
      before,
      "selection preview leaves the document unchanged",
    );
    const placement = await placeDimension();
    await editDimension(12);
    const sk = geometry(await saved());
    assert(Math.abs(length(sk.entities[5]) - 12) < 1e-5);
    const constraint = sk.constraints.find(
      (c) => c.kind === "length" && c.value === 12,
    );
    assert(constraint, "length dimension committed");
    assert(
      Math.abs(constraint.labelPosition.x - placement.x) < 1e-7,
      "world label x persisted",
    );
    assert(
      Math.abs(constraint.labelPosition.y - placement.y) < 1e-7,
      "world label y persisted",
    );
    assert.equal(
      (await viewport()).dimensionPreview,
      null,
      "commit clears the preview",
    );
  });
  await check("Double-click dimension edits geometry", async () => {
    const before = geometry(await saved()).constraints.find(
      (c) => c.kind === "length",
    );
    await doubleClickDimension("12");
    await dimensionEditor().waitFor();
    assert.equal(
      (await viewport()).dimensionPreview,
      null,
      "saved label editing is immediate, not placement",
    );
    await editDimension(16);
    const sk = geometry(await saved());
    assert(Math.abs(length(sk.entities[5]) - 16) < 1e-5);
    assert.deepEqual(
      sk.constraints.find((c) => c.id === before.id).labelOffset,
      before.labelOffset,
      "editing the value retains geometry-relative placement",
    );
  });
  await check(
    "Point drag preserves length constraint and undo/redo",
    async () => {
      const before = geometry(await saved()).entities[5];
      await dragHandle(before.points[1].id, 50, -45);
      const after = geometry(await saved()).entities[5];
      assert(Math.abs(length(after) - 16) < 1e-5);
      assert(
        Math.hypot(
          after.points[1].x - before.points[1].x,
          after.points[1].y - before.points[1].y,
        ) > 0.05,
        "drag changes point",
      );
      await button("撤销 (Ctrl+Z)").click();
      const undone = geometry(await saved()).entities[5];
      assert(Math.abs(undone.points[1].x - before.points[1].x) < 1e-5);
      await button("重做 (Ctrl+Shift+Z)").click();
      const redone = geometry(await saved()).entities[5];
      assert(Math.abs(redone.points[1].x - after.points[1].x) < 1e-5);
    },
  );
  await check("Fixed circle does not move on drag", async () => {
    await selectEntity(4);
    await button("固定").first().click();
    const fixPanel = page.getByTestId("parameter-panel");
    await fixPanel.waitFor();
    assert.notEqual(
      (await fixPanel.locator(".geometry-pick span").first().innerText()).trim(),
      "选择",
      "the fixed constraint preselects the object",
    );
    assert.equal(
      await fixPanel.locator('button[type="submit"]').isDisabled(),
      false,
      "the fixed constraint is ready to commit",
    );
    await fixPanel.locator('button[type="submit"]').click();
    await fixPanel.waitFor({ state: "detached" });
    const before = geometry(await saved()).entities[4];
    await dragHandle(before.points[0].id, 50, 40);
    const after = geometry(await saved()).entities[4];
    assert(Math.abs(before.points[0].x - after.points[0].x) < 1e-7);
    assert(Math.abs(before.points[0].y - after.points[0].y) < 1e-7);
    assert.equal(after.radius, before.radius);
  });
  await check("JSON save download and localStorage reload", async () => {
    const text = await download(async () => {
      await button("文件").click();
      await button("保存草图 Ctrl S").click();
    }, "document.sketch.json");
    const downloaded = JSON.parse(text);
    const previous = await saved();
    assert.deepEqual(downloaded, previous);
    await page.reload();
    await page.locator(".loading-overlay").waitFor({ state: "hidden" });
    await canvasReady();
    assert.deepEqual(await saved(), previous);
    const constraint = geometry(previous).constraints.find(
      (item) => item.kind === "length",
    );
    assert(
      constraint?.labelPosition,
      "saved length includes a world label position",
    );
    const state = await viewport();
    const label = state.dimensions.find((item) => item.id === constraint.id);
    assert(label, "persisted label rendered after reload");
    const line = geometry(previous).entities.find(
      (item) => item.id === constraint.refs[0],
    );
    const projected = lengthLabelPosition(
      state,
      line,
      constraint.labelPosition,
    );
    assert(Math.abs(label.x - projected.x) < 1e-7);
    assert(Math.abs(label.y - projected.y) < 1e-7);
    assert.equal(
      state.dimensionPreview,
      null,
      "reloading shows only saved dimensions",
    );
    await page
      .locator("input[type=file]")
      .setInputFiles(path.join(output, "document.sketch.json"));
    assert.equal(geometry(await saved()).entities.length, 6);
  });
  await check("DXF export parsed by dxf-parser", async () => {
    const text = await download(async () => {
      await page.locator(".export-button").click();
      await page
        .locator(".dialog")
        .getByRole("button", { name: "导出", exact: true })
        .click();
    }, "drawing.dxf");
    const parsed = new DxfParser().parseSync(text);
    assert.equal(parsed.entities.length, 6);
    assert.equal(parsed.entities.filter((e) => e.type === "CIRCLE").length, 1);
    return { entities: parsed.entities.map((e) => e.type) };
  });
  await check("SVG export parsed with native XML DOM", async () => {
    const text = await download(async () => {
      await page.locator(".export-button").click();
      await page
        .getByRole("combobox", { name: "文件格式", exact: true })
        .selectOption("SVG");
      await page
        .locator(".dialog")
        .getByRole("button", { name: "导出", exact: true })
        .click();
    }, "drawing.svg");
    const parsed = await page.evaluate((text) => {
      const xml = new DOMParser().parseFromString(text, "image/svg+xml");
      return {
        errors: xml.querySelectorAll("parsererror").length,
        tag: xml.documentElement.localName,
        shapes: xml.querySelectorAll("path,line,circle,polyline").length,
      };
    }, text);
    assert.equal(parsed.errors, 0);
    assert.equal(parsed.tag, "svg");
    assert(parsed.shapes >= 6);
    return parsed;
  });
  await check("Desktop screenshot and canvas pixel check", async () => {
    await page.keyboard.press("Escape");
    await button("适配全部").first().click();
    await page.mouse.move(10, 10);
    await page.screenshot({ path: path.join(output, "desktop.png") });
    await canvas.screenshot({ path: path.join(output, "desktop-canvas.png") });
    await compactCanvasOverlays();
    return pixels(path.join(output, "desktop-canvas.png"));
  });
  await check("Mobile panels controls and no page overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".loading-overlay").waitFor({ state: "hidden" });
    await button("切换浏览器").click();
    assert(await page.locator(".browser-panel").isVisible());
    await selectEntity(4);
    await button("切换浏览器").click();
    await button("切换属性面板").click();
    assert(
      await page
        .getByRole("checkbox", { name: "网格", exact: true })
        .isVisible(),
    );
    await page.getByRole("checkbox", { name: "网格", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "网格", exact: true }).check();
    await button("切换属性面板").click();
    await button("放大").click();
    await button("缩小").click();
    await button("适配全部").first().click();
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    assert(layout.scrollWidth <= layout.width, "no horizontal page overflow");
    assert(layout.scrollHeight <= layout.height, "no vertical page overflow");
    await page.keyboard.press("Escape");
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, "mobile.png") });
    await canvas.screenshot({ path: path.join(output, "mobile-canvas.png") });
    await compactCanvasOverlays();
    return {
      ...layout,
      pixels: await pixels(path.join(output, "mobile-canvas.png")),
    };
  });
  await parameterChecks();
  await advancedChecks();
  await check("Default demo desktop and mobile screenshots", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate((key) => localStorage.removeItem(key), storage);
    await page.reload();
    await page.locator(".loading-overlay").waitFor({ state: "hidden" });
    const initial = geometry(await saved());
    assert.equal(initial.entities.length, 11);
    await compactCanvasOverlays();
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, "demo-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator(".loading-overlay").waitFor({ state: "hidden" });
    await compactCanvasOverlays();
    await page.mouse.move(5, 5);
    await page.screenshot({ path: path.join(output, "demo-mobile.png") });
  });
  await check("No console/page errors or external network", async () => {
    assert.deepEqual(results.consoleErrors, []);
    assert.deepEqual(results.pageErrors, []);
    assert.deepEqual(results.externalRequests, []);
  });
} catch (error) {
  results.failure = error.stack;
  console.error(error);
  await page
    .screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  results.finished = new Date().toISOString();
  results.passed = !results.failure;
  await fs.writeFile(
    path.join(output, "browser-results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
