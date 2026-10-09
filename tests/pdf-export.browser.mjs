import { chromium } from "@playwright/test";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_PDF_ARTIFACTS || "artifacts/pdf-export",
);
const localChrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const executablePath =
  process.env.CAD_BROWSER_PATH ||
  (!existsSync(chromium.executablePath()) && existsSync(localChrome)
    ? localChrome
    : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const externalRequests = [],
  pageErrors = [];
try {
  await fs.mkdir(output, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.route("**/*", async (route) => {
    const request = route.request().url();
    if (
      /^https?:/.test(request) &&
      new URL(request).origin !== new URL(url).origin
    ) {
      externalRequests.push(request);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  // Independent module validation uses the existing server and does not depend on PDF UI integration.
  const result = await page.evaluate(async () => {
    const { exportPdf } = await import("/src/pdfExport.ts");
    const { emptyDocument, entity } = await import("/src/model.ts");
    const captures = [];
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const value = original.apply(this, args);
      if (args[0] === "image/png")
        captures.push({ png: value, width: this.width, height: this.height });
      return value;
    };
    let bytes;
    try {
      const doc = emptyDocument();
      doc.name = "工程图 — 中文导出";
      const sketch = doc.sketches[0];
      const circle = entity("circle", [{ x: 25, y: 0 }], { radius: 5 });
      sketch.entities.push(
        entity("line", [
          { x: -30, y: 0 },
          { x: 40, y: 0 },
        ]),
        circle,
        entity("text", [{ x: -30, y: 20 }], {
          text: "Latin 中文工程图 Ø10 / 90°\nSecond line",
          fontSize: 4,
          rotation: 15,
        }),
      );
      sketch.constraints.push({
        id: "diameter",
        kind: "diameter",
        refs: [circle.id],
        value: 10,
        labelPosition: { x: 38, y: 10 },
      });
      bytes = Array.from(await exportPdf(doc));
    } finally {
      HTMLCanvasElement.prototype.toDataURL = original;
    }
    // Check actual fallback pixels. Different Chinese glyphs must not all be one missing-glyph box.
    const masks = [],
      inkCounts = [];
    for (const capture of captures) {
      const image = new Image();
      image.src = capture.png;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = capture.width;
      canvas.height = capture.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const count = Array.from(pixels).filter(
        (_, i) => i % 4 === 3 && pixels[i] > 0,
      ).length;
      inkCounts.push(count);
      for (let glyph = 0; glyph < 5; glyph++) {
        let hash = 2166136261;
        for (let y = 0; y < canvas.height; y++)
          for (
            let x = 3 + glyph * 96;
            x < 3 + (glyph + 1) * 96 && x < canvas.width;
            x++
          ) {
            hash ^= pixels[(y * canvas.width + x) * 4 + 3];
            hash = Math.imul(hash, 16777619);
          }
        masks.push(hash >>> 0);
      }
    }
    const preview = document.createElement("div");
    preview.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:white;padding:40px;font:20px sans-serif;color:#1f262e";
    preview.innerHTML =
      "<p>PDF Chinese glyph fallback embedded at the saved text baseline</p>";
    for (const capture of captures) {
      const img = new Image();
      img.src = capture.png;
      img.style.cssText =
        "display:block;max-width:100%;border:1px solid #cbd5e1";
      preview.appendChild(img);
    }
    document.body.appendChild(preview);
    return { bytes, captures, inkCounts, distinctGlyphs: new Set(masks).size };
  });
  const bytes = Uint8Array.from(result.bytes);
  assert.match(Buffer.from(bytes.slice(0, 8)).toString("ascii"), /^%PDF-1\./);
  const pdf = await PDFDocument.load(bytes),
    pdfPage = pdf.getPages()[0];
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getTitle(), "工程图 — 中文导出");
  const contents = pdfPage.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray()
      : contents
        ? [contents]
        : [];
  const source = streams
    .map((ref) =>
      Buffer.from(
        decodePDFRawStream(pdf.context.lookup(ref, PDFRawStream)).decode(),
      ).toString("latin1"),
    )
    .join("\n");
  const encoded = Array.from(source.matchAll(/<([\da-f]+)> Tj/gi)).map(
    (match) => Buffer.from(match[1], "hex").toString("latin1"),
  );
  assert(encoded.includes("Latin "));
  assert(encoded.includes(" Ø10 / 90°"));
  assert(encoded.includes("Second line"));
  assert(encoded.includes("Ø10"));
  assert.match(source, /\bc\b/);
  assert.match(source, /\bl\b/);
  assert.match(source, /\/Image-\d+ Do/);
  const images = pdf.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
    );
  // One Chinese run plus its alpha mask; all geometry and remaining text stay vector.
  assert.equal(result.captures.length, 1);
  assert.equal(images.length, 2);
  assert(
    result.inkCounts[0] > 1500,
    "CJK glyph image must contain visible ink",
  );
  assert.equal(
    result.distinctGlyphs,
    5,
    "Chinese glyphs must be distinct rather than missing-glyph boxes",
  );
  assert.deepEqual(
    externalRequests,
    [],
    "PDF fonts and fallback must make no external requests",
  );
  assert.deepEqual(pageErrors, []);
  await fs.writeFile(path.join(output, "cjk-vector.pdf"), bytes);
  for (const [i, capture] of result.captures.entries())
    await fs.writeFile(
      path.join(output, `cjk-run-${i + 1}.png`),
      Buffer.from(capture.png.split(",")[1], "base64"),
    );
  await page.screenshot({ path: path.join(output, "cjk-fallback.png") });
  const fixture = await page.evaluate(async () => {
    const { emptyDocument, entity } = await import("/src/model.ts");
    const doc = emptyDocument();
    doc.name = "PDF UI 工程图";
    const current = doc.sketches[0];
    const circle = entity("circle", [{ x: 25, y: 0 }], { radius: 5 });
    current.entities.push(
      entity("line", [
        { x: -30, y: 0 },
        { x: 40, y: 0 },
      ]),
      circle,
      entity("text", [{ x: -30, y: 20 }], {
        text: "CURRENT 中文工程图 Ø10",
        fontSize: 4,
      }),
      entity(
        "line",
        [
          { x: -40, y: -15 },
          { x: 40, y: -15 },
        ],
        { construction: true },
      ),
      entity("text", [{ x: -40, y: -20 }], {
        text: "CONSTRUCTION",
        fontSize: 3,
        construction: true,
      }),
    );
    current.constraints.push({
      id: "ui-diameter",
      kind: "diameter",
      refs: [circle.id],
      value: 10,
      labelPosition: { x: 38, y: 10 },
    });
    doc.sketches.push(
      {
        id: "second-visible",
        name: "Second visible",
        visible: true,
        constraints: [],
        entities: [
          entity("line", [
            { x: -50, y: -35 },
            { x: 50, y: -35 },
          ]),
          entity("text", [{ x: -50, y: -40 }], {
            text: "VISIBLE_SECOND",
            fontSize: 3,
          }),
        ],
      },
      {
        id: "hidden-pdf",
        name: "Hidden",
        visible: false,
        constraints: [],
        entities: [
          entity("line", [
            { x: -100, y: -60 },
            { x: 100, y: -60 },
          ]),
          entity("text", [{ x: -100, y: -65 }], {
            text: "DO_NOT_EXPORT",
            fontSize: 3,
          }),
        ],
      },
    );
    localStorage.setItem("sketchworks.document.v1", JSON.stringify(doc));
    return doc;
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".loading-overlay").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".entity-row").count(),
    fixture.sketches[0].entities.length,
  );
  const downloadUI = async (format, scope, construction, filename) => {
    await page.locator(".export-button").click();
    await page
      .getByRole("combobox", { name: "文件格式", exact: true })
      .selectOption(format);
    await page
      .getByRole("combobox", { name: "导出范围", exact: true })
      .selectOption(scope);
    await page
      .getByRole("combobox", { name: "构造几何", exact: true })
      .selectOption(construction);
    await page
      .getByRole("textbox", { name: "文件名", exact: true })
      .fill(filename);
    const pending = page.waitForEvent("download");
    await page
      .locator(".dialog")
      .getByRole("button", { name: "导出", exact: true })
      .click();
    const item = await pending;
    const extension = format.toLowerCase();
    assert.equal(item.suggestedFilename(), `${filename}.${extension}`);
    const target = path.join(output, `${filename}.${extension}`);
    await item.saveAs(target);
    assert.equal(await item.failure(), null);
    await page.locator(".dialog").waitFor({ state: "hidden" });
    return fs.readFile(target);
  };
  const inspectPDF = async (contents) => {
    assert.match(contents.subarray(0, 8).toString("ascii"), /^%PDF-1\./);
    const loaded = await PDFDocument.load(contents);
    assert.equal(loaded.getPageCount(), 1);
    const page = loaded.getPages()[0],
      body = page.node.Contents();
    const streams = body instanceof PDFArray ? body.asArray() : [body];
    const source = streams
      .map((ref) =>
        Buffer.from(
          decodePDFRawStream(loaded.context.lookup(ref, PDFRawStream)).decode(),
        ).toString("latin1"),
      )
      .join("\n");
    const texts = Array.from(source.matchAll(/<([\da-f]+)> Tj/gi)).map((m) =>
      Buffer.from(m[1], "hex").toString("latin1"),
    );
    const images = loaded.context
      .enumerateIndirectObjects()
      .filter(
        ([, object]) =>
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
      );
    assert.match(source, /\bc\b/);
    assert.match(source, /\bl\b/);
    assert(texts.includes("Ø10"));
    assert(texts.includes("CURRENT "));
    assert(!texts.includes("DO_NOT_EXPORT"));
    assert.equal(images.length, 2);
    return { source, texts, pageSize: page.getSize(), bytes: contents.length };
  };
  const uiCurrent = await inspectPDF(
    await downloadUI("PDF", "当前草图", "不包含", "ui-current"),
  );
  assert(!uiCurrent.texts.includes("VISIBLE_SECOND"));
  assert(!uiCurrent.texts.includes("CONSTRUCTION"));
  assert(!uiCurrent.source.includes("[2 1] 0 d"));
  const uiVisible = await inspectPDF(
    await downloadUI("PDF", "所有可见草图", "不包含", "ui-visible"),
  );
  assert(uiVisible.texts.includes("VISIBLE_SECOND"));
  assert(!uiVisible.texts.includes("CONSTRUCTION"));
  const uiConstruction = await inspectPDF(
    await downloadUI("PDF", "所有可见草图", "包含", "ui-construction"),
  );
  assert(uiConstruction.texts.includes("VISIBLE_SECOND"));
  assert(uiConstruction.texts.includes("CONSTRUCTION"));
  assert(uiConstruction.source.includes("[2 1] 0 d"));
  const dxfSource = (
    await downloadUI("DXF", "当前草图", "不包含", "ui-smoke")
  ).toString("utf8");
  const { default: DxfParser } = await import("dxf-parser");
  const dxf = new DxfParser().parseSync(dxfSource);
  assert.deepEqual(
    dxf.entities.map((e) => e.type),
    ["LINE", "CIRCLE", "TEXT"],
  );
  assert.equal(dxf.entities.find((e) => e.type === "CIRCLE").radius, 5);
  const svgSource = (
    await downloadUI("SVG", "当前草图", "不包含", "ui-smoke")
  ).toString("utf8");
  const svg = await page.evaluate((text) => {
    const xml = new DOMParser().parseFromString(text, "image/svg+xml");
    return {
      errors: xml.querySelectorAll("parsererror").length,
      circleCount: xml.querySelectorAll("circle").length,
      text: xml.querySelector("text")?.textContent,
    };
  }, svgSource);
  assert.equal(svg.errors, 0);
  assert.equal(svg.circleCount, 1);
  assert(svg.text.includes("中文工程图"));
  await page.screenshot({ path: path.join(output, "ui-export.png") });
  const viewer = { screenshotSaved: false };
  const viewerPage = await context.newPage();
  try {
    const relative = path
      .relative(process.cwd(), path.join(output, "ui-current.pdf"))
      .split(path.sep)
      .join("/");
    const response = await viewerPage.goto(`${url}/${relative}`, {
      waitUntil: "load",
      timeout: 10000,
    });
    viewer.contentType = response?.headers()["content-type"];
    await viewerPage.waitForTimeout(1500);
    viewer.embed = await viewerPage
      .locator('embed[type="application/pdf"]')
      .count();
    await viewerPage.screenshot({
      path: path.join(output, "native-viewer.png"),
    });
    viewer.screenshotSaved = true;
  } catch (error) {
    viewer.error = error.message;
  } finally {
    await viewerPage.close();
  }
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
  const report = {
    passed: true,
    pageCount: 1,
    pageSize: pdfPage.getSize(),
    title: pdf.getTitle(),
    vectorText: encoded,
    rasterRuns: result.captures.length,
    imageObjects: images.length,
    inkPixels: result.inkCounts,
    distinctChineseGlyphs: result.distinctGlyphs,
    ui: {
      current: { text: uiCurrent.texts, bytes: uiCurrent.bytes },
      visible: { text: uiVisible.texts, bytes: uiVisible.bytes },
      construction: { text: uiConstruction.texts, bytes: uiConstruction.bytes },
      dxfEntityTypes: dxf.entities.map((e) => e.type),
      svg,
    },
    nativeViewer: viewer,
    externalRequests,
    pageErrors,
  };
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
