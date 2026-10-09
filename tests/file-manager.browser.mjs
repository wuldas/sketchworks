import { chromium, expect } from "@playwright/test";
import * as asar from "@electron/asar";
import { decode as decodeMessagePack } from "@msgpack/msgpack";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Run only after App has integrated FileManager and the existing dev server is stable.
const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_FILE_ARTIFACTS || "artifacts/file-manager",
);
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const executablePath =
  process.env.CAD_BROWSER_PATH ||
  (!existsSync(chromium.executablePath()) && existsSync(chrome)
    ? chrome
    : undefined);
const storage = "sketchworks.document.v1";
const seed = {
  version: 1,
  name: "文件管理测试",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "sk_files",
      name: "草图 1",
      visible: true,
      entities: [
        {
          id: "e_original",
          kind: "line",
          name: "基准线",
          points: [
            { id: "p_original_1", x: -15, y: -5 },
            { id: "p_original_2", x: 15, y: 5 },
          ],
        },
      ],
      constraints: [],
    },
  ],
};
const results = { url, checks: [], pageErrors: [], externalRequests: [] };
const browser = await chromium.launch({ headless: true, executablePath });
await fs.mkdir(output, { recursive: true });

const button = (scope, name) =>
  scope.getByRole("button", { name, exact: true });
const entry = (manager, name) =>
  manager.getByRole("option", { name, exact: true });
const idle = async (manager) => {
  await expect(manager).toHaveAttribute("aria-busy", "false", {
    timeout: 15000,
  });
};
async function openManager(page) {
  await button(page.locator(".app-header"), "文件管理器").click();
  const manager = page.getByTestId("file-manager");
  await expect(manager).toBeVisible();
  await idle(manager);
  return manager;
}
async function createFolder(manager, name) {
  await button(manager, "新建文件夹").click();
  await manager
    .getByRole("textbox", { name: "文件夹名称", exact: true })
    .fill(name);
  await button(manager, "创建").click();
  await idle(manager);
  await expect(entry(manager, name)).toBeVisible();
}
async function saveCurrent(manager, name) {
  await button(manager, "保存当前项目").click();
  await manager
    .getByRole("textbox", { name: "项目文件名", exact: true })
    .fill(name);
  await button(manager, "保存").click();
  await idle(manager);
  const filename = /\.swcad$/i.test(name) ? name : `${name}.swcad`;
  await expect(entry(manager, filename)).toBeVisible();
  return filename;
}
async function root(manager) {
  await button(
    manager.getByRole("navigation", { name: "当前文件夹路径" }),
    "根目录",
  ).click();
  await idle(manager);
}
async function chooseFiles(page, scope, label, files) {
  const chooser = page.waitForEvent("filechooser");
  await button(scope, label).click();
  await (await chooser).setFiles(files);
}
async function allEntries(page) {
  return page.evaluate(async () => {
    const { virtualFiles } = await import("/src/virtualFileSystem.ts");
    return virtualFiles.allEntries();
  });
}
async function fileByName(page, name) {
  const file = (await allEntries(page)).find(
    (candidate) => candidate.kind === "file" && candidate.name === name,
  );
  assert(file, `Expected local file ${name}`);
  return file;
}
async function projectState(page, id) {
  return page.evaluate(async (fileId) => {
    const { virtualFiles } = await import("/src/virtualFileSystem.ts");
    const { decodeProject, attachmentData } = await import(
      "/src/projectArchive.ts"
    );
    const project = decodeProject(
      await (await virtualFiles.readFile(fileId)).arrayBuffer(),
    );
    return {
      document: project.document,
      manifest: project.manifest,
      attachments: project.manifest.attachments.map((attachment) => ({
        ...attachment,
        bytes: Array.from(attachmentData(project, attachment.id) || []),
      })),
      files: Array.from(project.files, ([name, bytes]) => [
        name,
        Array.from(bytes),
      ]),
    };
  }, id);
}
async function pngFile(page, name = "参考图.png") {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 3;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#16745b";
    ctx.fillRect(0, 0, 3, 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(1, 0, 1, 1);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return { name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}
async function fixture(page, name, future = false) {
  const bytes = await page.evaluate(
    async ({ doc, name, future }) => {
      const { createProject, encodeProject } = await import(
        "/src/projectArchive.ts"
      );
      const project = createProject({ ...doc, name });
      if (future) {
        project.manifest.modules = {
          solid: { path: "models/body.bin", version: 3 },
          cam: { path: "cam/toolpath.bin" },
        };
        project.files.set(
          "models/body.bin",
          new Uint8Array([0, 255, 1, 128, 17]),
        );
        project.files.set(
          "cam/toolpath.bin",
          new Uint8Array([73, 77, 65, 71, 69, 0]),
        );
      }
      return Array.from(encodeProject(project));
    },
    { doc: seed, name, future },
  );
  return {
    name: `${name}.swcad`,
    mimeType: "application/x-asar",
    buffer: Buffer.from(bytes),
  };
}
async function downloadedJson(page, label) {
  await button(page, "文件").click();
  const event = page.waitForEvent("download");
  await button(page.locator(".file-menu"), "导出 JSON 草图").click();
  const download = await event;
  assert.match(download.suggestedFilename(), /\.json$/i);
  const file = path.join(output, `${label}.json`);
  await download.saveAs(file);
  return JSON.parse(await fs.readFile(file, "utf8"));
}

const checks = [
  {
    name: "folder navigation, search, sort and persistence",
    run: async (page) => {
      let manager = await openManager(page);
      await createFolder(manager, "工程目录");
      await createFolder(manager, "归档目录");
      await saveCurrent(manager, "z 文件");
      const ordered = await manager
        .getByTestId("file-manager-entry")
        .evaluateAll((rows) => rows.map((row) => row.dataset.entryKind));
      assert.deepEqual(ordered, ["folder", "folder", "file"]);
      await entry(manager, "工程目录").dblclick();
      await idle(manager);
      await expect(manager.getByRole("navigation")).toContainText("工程目录");
      await createFolder(manager, "子文件夹");
      await entry(manager, "子文件夹").dblclick();
      await idle(manager);
      await expect(manager.getByRole("navigation")).toContainText("子文件夹");
      await button(manager, "上一级文件夹").click();
      await idle(manager);
      await expect(entry(manager, "子文件夹")).toBeVisible();
      await root(manager);
      await manager
        .getByRole("searchbox", { name: "搜索当前文件夹" })
        .fill("z 文件");
      await expect(manager.getByTestId("file-manager-entry")).toHaveCount(1);
      await manager.getByRole("searchbox", { name: "搜索当前文件夹" }).fill("");
      await manager
        .getByRole("combobox", { name: "文件排序" })
        .selectOption("updated");
      assert.equal(
        await manager
          .getByTestId("file-manager-entry")
          .first()
          .getAttribute("data-entry-kind"),
        "folder",
      );
      await button(manager, "关闭文件管理器").click();
      await page.reload({ waitUntil: "networkidle" });
      manager = await openManager(page);
      await expect(entry(manager, "工程目录")).toBeVisible();
      await expect(entry(manager, "z 文件.swcad")).toBeVisible();
      await manager.screenshot({ path: path.join(output, "desktop.png") });
    },
  },
  {
    name: "CtrlS on unlinked document, save dialog, explicit overwrite and cancel",
    run: async (page) => {
      await page.keyboard.press("Control+s");
      let manager = page.getByTestId("file-manager");
      await expect(manager).toHaveAttribute("data-mode", "save");
      await idle(manager);
      await expect(
        manager.getByRole("textbox", { name: "项目文件名" }),
      ).toHaveValue(`${seed.name}.swcad`);
      await manager
        .getByRole("textbox", { name: "项目文件名" })
        .fill("正式项目");
      await button(manager, "保存").click();
      await expect(manager).toBeHidden();
      const file = await fileByName(page, "正式项目.swcad");
      assert.deepEqual(
        (await projectState(page, file.id)).document.sketches,
        seed.sketches,
      );
      await page
        .getByRole("textbox", { name: "文档名称", exact: true })
        .fill("编辑中的项目");
      await page.getByRole("textbox", { name: "文档名称", exact: true }).blur();
      await expect(page.locator('.save-dot[data-saved="true"]')).toBeVisible();
      await page.keyboard.press("Control+Shift+s");
      manager = page.getByTestId("file-manager");
      await idle(manager);
      await manager
        .getByRole("textbox", { name: "项目文件名" })
        .fill("正式项目.swcad");
      await button(manager, "保存").click();
      await expect(button(manager, "覆盖并保存")).toBeVisible();
      await button(manager, "取消操作").click();
      await expect(manager).toBeVisible();
      await button(manager, "保存").click();
      await expect(button(manager, "覆盖并保存")).toBeVisible();
      await button(manager, "覆盖并保存").click();
      await expect(manager).toBeHidden();
      assert.equal((await fileByName(page, "正式项目.swcad")).id, file.id);
      assert.equal(
        (await projectState(page, file.id)).document.name,
        "编辑中的项目",
      );
      await page.keyboard.press("Control+Shift+s");
      manager = page.getByTestId("file-manager");
      await idle(manager);
      await manager
        .getByRole("textbox", { name: "项目文件名" })
        .fill("不应保存.swcad");
      await button(manager, "取消").click();
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        1,
      );
    },
  },
  {
    name: "browse save activates link, CtrlS saves IDB and JSON export preserves editor",
    run: async (page) => {
      const manager = await openManager(page);
      const name = await saveCurrent(manager, "当前编辑");
      await expect(entry(manager, name)).toContainText("当前");
      await button(manager, "关闭文件管理器").click();
      const exported = await downloadedJson(page, "browse-editor");
      assert.deepEqual(exported.sketches, seed.sketches);
      assert.equal(exported.name, seed.name);
      const file = await fileByName(page, name);
      assert.deepEqual((await projectState(page, file.id)).document, seed);

      const documentName = page.getByRole("textbox", {
        name: "文档名称",
        exact: true,
      });
      await documentName.fill("CtrlS 保存后的项目");
      await documentName.blur();
      const downloads = [];
      const trackDownload = (download) =>
        downloads.push(download.suggestedFilename());
      page.on("download", trackDownload);
      await page.keyboard.press("Control+s");
      await expect(page.getByText("项目已保存", { exact: true })).toBeVisible();
      await expect(page.getByTestId("file-manager")).toBeHidden();
      assert.deepEqual(
        downloads,
        [],
        "CtrlS must save to IndexedDB without creating a download",
      );
      page.off("download", trackDownload);
      assert.equal((await fileByName(page, name)).id, file.id);
      const saved = await projectState(page, file.id);
      assert.equal(saved.document.name, "CtrlS 保存后的项目");
      assert.deepEqual(saved.document.sketches, seed.sketches);
      const explicitJson = await downloadedJson(
        page,
        "explicit-json-after-ctrls",
      );
      assert.deepEqual(explicitJson, saved.document);
      await button(page, "文件").click();
      const downloadEvent = page.waitForEvent("download");
      await button(page.locator(".file-menu"), "下载项目").click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), name);
      const downloaded = path.join(output, "linked-ctrls.swcad");
      await download.saveAs(downloaded);
      const manifest = JSON.parse(
        asar.extractFile(downloaded, "manifest.json").toString("utf8"),
      );
      const archivedDocument = decodeMessagePack(
        gunzipSync(
          asar.extractFile(
            downloaded,
            path.join(...manifest.documents.cad2d.path.split("/")),
          ),
        ),
      );
      assert.deepEqual(archivedDocument, saved.document);
    },
  },
  {
    name: "double click opens archive only after successful decode",
    run: async (page) => {
      const payload = await fixture(page, "要打开的项目");
      const manager = await openManager(page);
      await chooseFiles(page, manager, "导入", payload);
      await idle(manager);
      await expect(entry(manager, payload.name)).toBeVisible();
      const imported = await fileByName(page, payload.name);
      await page.evaluate(async (id) => {
        const { virtualFiles } = await import("/src/virtualFileSystem.ts");
        await virtualFiles.updateFile(
          id,
          new Blob(['{"invalid":true}'], { type: "application/x-asar" }),
        );
      }, imported.id);
      await entry(manager, payload.name).dblclick();
      await expect(manager).toBeVisible();
      await expect(
        manager.getByRole("alert").filter({ hasText: "打开项目失败" }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "文档名称", exact: true }),
      ).toHaveValue(seed.name);
      await button(manager, "关闭错误提示").click();
      await page.evaluate(
        async ({ id, bytes }) => {
          const { virtualFiles } = await import("/src/virtualFileSystem.ts");
          await virtualFiles.updateFile(
            id,
            new Blob([new Uint8Array(bytes)], { type: "application/x-asar" }),
          );
        },
        { id: imported.id, bytes: Array.from(payload.buffer) },
      );
      await entry(manager, payload.name).dblclick();
      await expect(manager).toBeHidden();
      await expect(
        page.getByRole("textbox", { name: "文档名称", exact: true }),
      ).toHaveValue("要打开的项目");
      assert.equal(
        (await downloadedJson(page, "opened-project")).sketches[0].entities[0]
          .id,
        "e_original",
      );
    },
  },
  {
    name: "active file rename and move retain id and refresh metadata",
    run: async (page) => {
      const manager = await openManager(page);
      await createFolder(manager, "目标目录");
      await saveCurrent(manager, "改名前");
      const original = await fileByName(page, "改名前.swcad");
      await entry(manager, "改名前.swcad").click();
      await button(manager, "重命名").click();
      await manager
        .getByRole("textbox", { name: "名称", exact: true })
        .fill("改名后");
      await button(manager, "确认重命名").click();
      await idle(manager);
      await expect(entry(manager, "改名后.swcad")).toContainText("当前");
      await button(manager, "移动").click();
      await manager
        .getByRole("combobox", { name: "目标文件夹" })
        .selectOption({ label: "根目录 / 目标目录" });
      await button(manager, "确认移动").click();
      await idle(manager);
      await expect(entry(manager, "改名后.swcad")).toHaveCount(0);
      await entry(manager, "目标目录").dblclick();
      await idle(manager);
      await expect(entry(manager, "改名后.swcad")).toContainText("当前");
      assert.equal((await fileByName(page, "改名后.swcad")).id, original.id);
      await button(manager, "关闭文件管理器").click();
      const header = await page.locator(".app-header").innerText();
      assert(
        header.includes("改名后") ||
          (await page.locator('.app-header [title*="改名后"]').count()) > 0,
        "Header should reflect active file rename",
      );
      await page.reload({ waitUntil: "networkidle" });
      const reopened = await openManager(page);
      await root(reopened);
      await entry(reopened, "目标目录").dblclick();
      await idle(reopened);
      await expect(entry(reopened, "改名后.swcad")).toBeVisible();
    },
  },
  {
    name: "copy file and nested folder preserves bytes with new ids",
    run: async (page) => {
      const manager = await openManager(page);
      await createFolder(manager, "源目录");
      await entry(manager, "源目录").dblclick();
      await idle(manager);
      await saveCurrent(manager, "源项目");
      const original = await fileByName(page, "源项目.swcad");
      await button(manager, "复制").click();
      await manager
        .getByRole("textbox", { name: "名称", exact: true })
        .fill("文件副本");
      await manager
        .getByRole("combobox", { name: "目标文件夹" })
        .selectOption("root");
      await button(manager, "确认复制").click();
      await idle(manager);
      await root(manager);
      await expect(entry(manager, "文件副本.swcad")).toBeVisible();
      const copied = await fileByName(page, "文件副本.swcad");
      assert.notEqual(copied.id, original.id);
      assert.deepEqual((await projectState(page, copied.id)).document, seed);
      await entry(manager, "源目录").click();
      await button(manager, "复制").click();
      await manager
        .getByRole("textbox", { name: "名称", exact: true })
        .fill("目录副本");
      await button(manager, "确认复制").click();
      await idle(manager);
      await entry(manager, "目录副本").dblclick();
      await idle(manager);
      await expect(entry(manager, "源项目.swcad")).toBeVisible();
      const copiedId = await entry(manager, "源项目.swcad").getAttribute(
        "data-entry-id",
      );
      assert.notEqual(copiedId, original.id);
      assert.deepEqual(
        (await projectState(page, copiedId)).document.sketches,
        seed.sketches,
      );
    },
  },
  {
    name: "local delete confirmation, subtree deletion and keyboard isolation",
    run: async (page) => {
      const manager = await openManager(page);
      await createFolder(manager, "待删除目录");
      await entry(manager, "待删除目录").dblclick();
      await idle(manager);
      await saveCurrent(manager, "待删除文件");
      await entry(manager, "待删除文件.swcad").focus();
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Delete");
      await expect(button(manager, "确认删除")).toBeVisible();
      await button(manager, "取消操作").click();
      await expect(entry(manager, "待删除文件.swcad")).toBeVisible();
      await root(manager);
      await entry(manager, "待删除目录").click();
      await button(manager, "删除").click();
      await expect(
        manager.getByRole("form", { name: "确认删除" }),
      ).toContainText("1 个文件和文件夹");
      await button(manager, "确认删除").click();
      await idle(manager);
      assert.equal((await allEntries(page)).length, 0);
      await button(manager, "关闭文件管理器").click();
      assert.deepEqual(
        (await downloadedJson(page, "deleted-active-editor")).sketches,
        seed.sketches,
      );
    },
  },
  {
    name: "ASAR and legacy imports, duplicate rejection, genuine download",
    run: async (page) => {
      const manager = await openManager(page);
      const archive = await fixture(page, "归档导入", true);
      const legacy = {
        name: "旧版导入.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ ...seed, name: "旧版导入" })),
      };
      await chooseFiles(page, manager, "导入", [archive, legacy]);
      await idle(manager);
      await expect(entry(manager, "归档导入.swcad")).toBeVisible();
      await expect(entry(manager, "旧版导入.swcad")).toBeVisible();
      await chooseFiles(page, manager, "导入", archive);
      await expect(manager.getByRole("alert")).toContainText("已有同名项目");
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        2,
      );
      await button(manager, "关闭错误提示").click();
      await chooseFiles(page, manager, "导入", {
        name: "无效.swcad",
        mimeType: "application/x-asar",
        buffer: Buffer.from('{"fake":true}'),
      });
      await expect(manager.getByRole("alert")).toBeVisible();
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        2,
      );
      await button(manager, "关闭错误提示").click();
      await entry(manager, "归档导入.swcad").click();
      const event = page.waitForEvent("download");
      await button(manager, "下载项目").click();
      const download = await event;
      assert.equal(download.suggestedFilename(), "归档导入.swcad");
      const downloaded = path.join(output, "import-download.swcad");
      await download.saveAs(downloaded);
      const names = asar
        .listPackage(downloaded)
        .map((name) => name.replaceAll("\\", "/"));
      assert(names.includes("/manifest.json"));
      assert(names.includes("/documents/sketch.jsonb.gz"));
      assert(names.includes("/models/body.bin"));
      const manifest = JSON.parse(
        asar.extractFile(downloaded, "manifest.json").toString("utf8"),
      );
      assert.equal(manifest.documents.cad2d.codec, "msgpack");
      assert.equal(manifest.documents.cad2d.compression, "gzip");
      assert.deepEqual(manifest.modules.solid, {
        path: "models/body.bin",
        version: 3,
      });
      const doc = decodeMessagePack(
        gunzipSync(
          asar.extractFile(
            downloaded,
            path.join(...manifest.documents.cad2d.path.split("/")),
          ),
        ),
      );
      assert.equal(doc.name, "归档导入");
      assert.deepEqual(doc.sketches, seed.sketches);
      await entry(manager, "旧版导入.swcad").dblclick();
      await expect(manager).toBeHidden();
      await expect(
        page.getByRole("textbox", { name: "文档名称", exact: true }),
      ).toHaveValue("旧版导入");
    },
  },
  {
    name: "active image attachments use current geometry and persist exact bytes",
    run: async (page) => {
      let manager = await openManager(page);
      await saveCurrent(manager, "图片项目");
      const file = await fileByName(page, "图片项目.swcad");
      const oldBytes = await page.evaluate(async (id) => {
        const { virtualFiles } = await import("/src/virtualFileSystem.ts");
        return Array.from(
          new Uint8Array(await (await virtualFiles.readFile(id)).arrayBuffer()),
        );
      }, file.id);
      await button(manager, "关闭文件管理器").click();
      await button(page, "直线").first().click();
      const canvas = page.getByTestId("cad-canvas");
      const box = await canvas.boundingBox();
      assert(box);
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await page.mouse.click(
        box.x + box.width * 0.55,
        box.y + box.height * 0.45,
      );
      await page.keyboard.press("Escape");
      await expect(page.locator('.save-dot[data-saved="true"]')).toBeVisible();
      const edited = await downloadedJson(page, "edited-before-attachment");
      assert(
        edited.sketches[0].entities.length > seed.sketches[0].entities.length,
        "Create a real CAD line before testing attachment preservation",
      );
      manager = await openManager(page);
      await entry(manager, "图片项目.swcad").click();
      await expect(button(manager, "添加图片")).toBeEnabled();
      // Put a valid older archive on disk: active attachment changes must still use editor props.
      await page.evaluate(
        async ({ id, bytes }) => {
          const { virtualFiles } = await import("/src/virtualFileSystem.ts");
          await virtualFiles.updateFile(
            id,
            new Blob([new Uint8Array(bytes)], { type: "application/x-asar" }),
          );
        },
        { id: file.id, bytes: oldBytes },
      );
      const image = await pngFile(page);
      await chooseFiles(page, manager, "添加图片", image);
      await idle(manager);
      await expect(
        manager.getByRole("img", { name: image.name }),
      ).toBeVisible();
      const state = await projectState(page, file.id);
      assert.deepEqual(state.document.sketches, edited.sketches);
      assert.deepEqual(state.attachments[0].bytes, Array.from(image.buffer));
      await button(manager, "关闭文件管理器").click();
      await page.reload({ waitUntil: "networkidle" });
      manager = await openManager(page);
      await entry(manager, "图片项目.swcad").click();
      await expect(
        manager.getByRole("img", { name: image.name }),
      ).toBeVisible();
      assert.deepEqual(
        (await projectState(page, file.id)).document.sketches,
        edited.sketches,
      );
      await button(manager, `移除附件 ${image.name}`).click();
      await expect(button(manager, "确认移除")).toBeVisible();
      await button(manager, "取消操作").click();
      assert.equal((await projectState(page, file.id)).attachments.length, 1);
      await button(manager, `移除附件 ${image.name}`).click();
      await button(manager, "确认移除").click();
      await idle(manager);
      assert.equal((await projectState(page, file.id)).attachments.length, 0);
    },
  },
  {
    name: "390px layout, inactive attachments preserve future files, unsafe images rejected",
    viewport: { width: 390, height: 844 },
    run: async (page) => {
      const manager = await openManager(page);
      const longName = "很长的工程目录名称用于检查文件管理器的移动布局";
      await createFolder(manager, longName);
      const archive = await fixture(
        page,
        "很长的项目文件名称用于验证省略号与稳定列表高度",
        true,
      );
      await chooseFiles(page, manager, "导入", archive);
      await idle(manager);
      await entry(manager, archive.name).click();
      await expect(button(manager, "添加图片")).toBeEnabled();
      const image = await pngFile(
        page,
        "很长的参考图片名称不会挤出移动窗口.png",
      );
      await chooseFiles(page, manager, "添加图片", image);
      await idle(manager);
      await expect(
        manager.getByRole("img", { name: image.name }),
      ).toBeVisible();
      const imported = await fileByName(page, archive.name);
      const state = await projectState(page, imported.id);
      assert.deepEqual(state.manifest.modules.solid, {
        path: "models/body.bin",
        version: 3,
      });
      assert.deepEqual(
        state.files.find(([name]) => name === "models/body.bin")[1],
        [0, 255, 1, 128, 17],
      );
      assert.deepEqual(state.attachments[0].bytes, Array.from(image.buffer));
      await chooseFiles(page, manager, "添加图片", {
        name: "危险.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
      });
      await expect(manager.getByRole("alert")).toContainText("仅支持 PNG");
      assert.equal(
        (await projectState(page, imported.id)).attachments.length,
        1,
      );
      await button(manager, "关闭错误提示").click();
      const dimensions = await manager.evaluate((element) => ({
        right: element.getBoundingClientRect().right,
        left: element.getBoundingClientRect().left,
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        dialogWidth: element.clientWidth,
        dialogScrollWidth: element.scrollWidth,
        rowHeights: Array.from(
          element.querySelectorAll(".fm-entry"),
          (row) => row.getBoundingClientRect().height,
        ),
        rowsInside: Array.from(
          element.querySelectorAll(".fm-entry"),
          (row) =>
            row.getBoundingClientRect().right <=
            element.getBoundingClientRect().right,
        ),
      }));
      assert(dimensions.left >= 0 && dimensions.right <= dimensions.width);
      assert(dimensions.documentWidth <= dimensions.width);
      assert(dimensions.dialogScrollWidth <= dimensions.dialogWidth);
      assert(dimensions.rowsInside.every(Boolean));
      assert(dimensions.rowHeights.every((height) => height === 40));
      await manager.screenshot({ path: path.join(output, "mobile-390.png") });
      await button(manager, "关闭文件管理器").click();
      const exported = await downloadedJson(page, "inactive-attachment-editor");
      assert.deepEqual(
        exported,
        seed,
        "Adding an image to an inactive file must not replace the editor document",
      );
    },
  },
];

try {
  for (const check of checks) {
    const context = await browser.newContext({
      viewport: check.viewport || { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    await context.addInitScript(
      ({ storage, seed }) => {
        if (!localStorage.getItem(storage))
          localStorage.setItem(storage, JSON.stringify(seed));
      },
      { storage, seed },
    );
    await context.route("**/*", async (route) => {
      const request = route.request().url();
      if (
        /^https?:/.test(request) &&
        new URL(request).origin !== new URL(url).origin
      ) {
        results.externalRequests.push(request);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      results.pageErrors.push(error.message);
    });
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await expect(
        button(page.locator(".app-header"), "文件管理器"),
      ).toBeEnabled();
      await check.run(page);
      assert.deepEqual(errors, []);
      results.checks.push({ name: check.name, passed: true });
      console.log(`PASS ${check.name}`);
    } catch (error) {
      results.checks.push({
        name: check.name,
        passed: false,
        error: error.stack || String(error),
      });
      await page
        .screenshot({
          path: path.join(output, `failure-${results.checks.length}.png`),
          fullPage: true,
        })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(results.externalRequests, []);
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
