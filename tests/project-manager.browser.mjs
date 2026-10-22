import { chromium, expect } from "@playwright/test";
import * as asar from "@electron/asar";
import { decode as decodeMessagePack } from "@msgpack/msgpack";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Real docked project management, archive persistence, and transition boundaries.
const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_PROJECT_ARTIFACTS || "artifacts/project-manager",
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
  name: "项目管理测试",
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: "sk_projects",
      name: "草图 1",
      visible: true,
      entities: [
        {
          id: "e_seed_line",
          kind: "line",
          name: "基准线",
          points: [
            { id: "p_seed_1", x: -15, y: -5 },
            { id: "p_seed_2", x: 15, y: 5 },
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
const projectToggle = (page) =>
  page
    .locator(".app-header")
    .getByRole("button", { name: "项目管理", exact: true });
const entry = (manager, name) =>
  manager.getByRole("option", { name, exact: true });
const documentName = (page) => page.locator(".app-header .document-name");
const savedDot = (page) => page.locator('.save-dot[data-saved="true"]');
const managerPane = (page) => page.getByTestId("file-manager");
const idle = async (manager) => {
  await expect(manager).toHaveAttribute("aria-busy", "false", {
    timeout: 15000,
  });
};
async function waitReady(page) {
  await page
    .locator(".loading-overlay")
    .waitFor({ state: "hidden", timeout: 30000 });
  await expect(projectToggle(page)).toBeEnabled();
}
async function openManager(page) {
  const toggle = projectToggle(page);
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
  const manager = managerPane(page);
  await expect(manager).toBeVisible();
  await idle(manager);
  return manager;
}
async function closeManager(page) {
  const toggle = projectToggle(page);
  if ((await toggle.getAttribute("aria-pressed")) === "true")
    await toggle.click();
  await expect(page.getByTestId("file-manager")).toBeHidden();
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
async function createProject(manager, name) {
  await button(manager, "新建项目").click();
  await manager
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill(name);
  await button(manager, "创建").click();
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
async function drawLine(page, fractions = [0.3, 0.3, 0.55, 0.45]) {
  await button(page, "直线").first().click();
  // The drawing sidebar replaces the properties panel while the tool collects
  // points, so the canvas box is measured on the live creation layout.
  await page.getByTestId("creation-panel").waitFor();
  const canvas = page.getByTestId("cad-canvas");
  const box = await canvas.boundingBox();
  assert(box, "CAD canvas must have a bounding box for real line drawing");
  const before = await page.locator(".entity-row").count();
  await page.mouse.click(
    box.x + box.width * fractions[0],
    box.y + box.height * fractions[1],
  );
  await page.mouse.click(
    box.x + box.width * fractions[2],
    box.y + box.height * fractions[3],
  );
  await expect(page.locator(".entity-row")).toHaveCount(before + 1);
  await page.keyboard.press("Escape");
}
async function canvasHitAtCenter(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="cad-canvas"]');
    const box = canvas.getBoundingClientRect();
    return (
      document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      ) === canvas
    );
  });
}
// Passive DOM observation: records whether the canvas stays hit-testable and an
// accessible status is announced while a project switch is in flight. No mocks.
async function watchProjectSwitch(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="cad-canvas"]');
    const box = canvas.getBoundingClientRect();
    const state = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      samples: [],
    };
    window.__switchWatch = state;
    const sample = () => {
      if (state.samples.length >= 500) return;
      const status = !!document.querySelector(
        '.project-transition-overlay[role="status"]',
      );
      const hit = document.elementFromPoint(state.x, state.y);
      state.samples.push({
        status,
        canvasHit: hit === canvas,
      });
    };
    state.observer = new MutationObserver(sample);
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}
async function readProjectSwitch(page, label) {
  const samples = await page.evaluate(() => {
    window.__switchWatch.observer.disconnect();
    return window.__switchWatch.samples;
  });
  const covered = samples.filter(
    (sample) => !sample.canvasHit && sample.status,
  );
  assert(
    covered.length > 0,
    `${label}: during the project switch the canvas must be inert and a role=status hint must be visible`,
  );
  assert(
    await canvasHitAtCenter(page),
    `${label}: canvas must be operable again after the switch completes`,
  );
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
    name: "sidebar placement, non-modal canvas, shortcuts and save mode",
    run: async (page) => {
      await expect(managerPane(page)).toBeVisible();
      const manager = await openManager(page);
      const projectBar = page.locator(".project-tabs");
      const tabBar = page.locator(".workspace-tabbar");
      await expect(
        projectBar.getByRole("tab", { name: "草图", exact: true }),
      ).toHaveCount(0);
      await expect(
        tabBar.getByRole("button", { name: "草图", exact: true }),
      ).toBeVisible();
      const projectBarBox = await projectBar.boundingBox();
      const tabBarBox = await tabBar.boundingBox();
      assert(projectBarBox && tabBarBox);
      assert(
        Math.abs(tabBarBox.y - (projectBarBox.y + projectBarBox.height)) < 1,
        "The tool tab row must sit directly under the project tabs",
      );
      const fileButton = button(tabBar, "文件");
      const saveButton = button(tabBar, "保存当前项目");
      await expect(saveButton).toBeVisible();
      const fileBox = await fileButton.boundingBox();
      const saveBox = await saveButton.boundingBox();
      assert(fileBox && saveBox);
      assert(
        saveBox.x >= fileBox.x + fileBox.width - 1,
        "The project save icon must sit to the right of the file menu",
      );
      await expect(
        manager.getByRole("button", { name: "保存当前项目", exact: true }),
      ).toHaveCount(0);
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      const paneBox = await page.locator(".project-panel").boundingBox();
      const browserBox = await page.locator(".browser-panel").boundingBox();
      const canvasBox = await page.getByTestId("cad-canvas").boundingBox();
      const tabsBox = await page.locator(".project-tabs").boundingBox();
      const statusBox = await page.locator(".status-bar").boundingBox();
      assert(paneBox && browserBox && canvasBox && tabsBox && statusBox);
      assert(
        Math.abs(paneBox.y - tabsBox.y) < 1,
        "Project sidebar must start level with the toolbar",
      );
      assert(
        Math.abs(paneBox.y + paneBox.height - statusBox.y) < 1,
        "Project sidebar must run down to the status bar",
      );
      assert(
        paneBox.x <= 1 && paneBox.x + paneBox.width <= browserBox.x + 1,
        "Project management must be the leftmost sidebar",
      );
      assert(
        Math.abs(browserBox.x - (paneBox.x + paneBox.width)) < 1,
        "The sketch browser must sit next to the project sidebar",
      );
      assert.equal(
        paneBox.width,
        browserBox.width,
        "Both left sidebars share the same fixed width",
      );
      await expect(page.locator(".sketch-browser")).toBeVisible();
      assert(
        await canvasHitAtCenter(page),
        "Opened panel must not cover the canvas",
      );

      // No focus trap: Tab from inside the panel must reach elements outside it.
      await manager.getByRole("searchbox", { name: "搜索当前文件夹" }).focus();
      let escaped = false;
      for (let i = 0; i < 30 && !escaped; i++) {
        await page.keyboard.press("Tab");
        escaped = await page.evaluate(
          () =>
            !document.activeElement?.closest('[data-testid="file-manager"]'),
        );
      }
      assert(escaped, "Tab focus must leave the panel (no modal focus trap)");

      // Canvas stays operable while the panel is open: draw a real line.
      await drawLine(page);
      await expect(savedDot(page)).toBeVisible();
      const edited = await downloadedJson(page, "panel-open-draw");
      assert.equal(edited.sketches[0].entities.length, 2);
      const line = edited.sketches[0].entities.find(
        (entity) => entity.id !== "e_seed_line",
      );
      assert.equal(line.kind, "line");
      assert(
        line.points[1].x > line.points[0].x &&
          line.points[1].y < line.points[0].y,
      );

      // Ctrl+S without an active project opens save mode, downloads nothing.
      const downloads = [];
      const trackDownload = (download) => downloads.push(download);
      page.on("download", trackDownload);
      await page.keyboard.press("Control+s");
      await expect(manager).toHaveAttribute("data-mode", "save");
      await expect(
        manager.getByRole("textbox", { name: "项目文件名", exact: true }),
      ).toHaveValue(`${seed.name}.swcad`);
      await button(manager, "取消").click();
      await expect(manager).toBeHidden();
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        0,
        "Cancelled save mode must not create a project file",
      );

      // Closing the project sidebar keeps the sketch browser and its width.
      await openManager(page);
      const projectWidth = (await page.locator(".project-panel").boundingBox())
        .width;
      await closeManager(page);
      await expect(page.locator(".project-panel")).toHaveCount(0);
      await expect(page.locator(".sketch-browser")).toBeVisible();
      await expect(projectToggle(page)).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      assert.equal(
        (await page.locator(".browser-panel").boundingBox()).width,
        projectWidth,
        "Sidebar width must not change between the two left panels",
      );
      await openManager(page);
      await expect(projectToggle(page)).toHaveAttribute("aria-pressed", "true");

      // File menu entry 项目管理 still opens the panel.
      await button(page, "文件").click();
      const fileMenu = page.locator(".file-menu");
      await fileMenu.getByRole("button", { name: /^项目管理/ }).click();
      await expect(manager).toBeVisible();

      // The header project toggle closes back to the sketch browser.
      await closeManager(page);

      // Ctrl+O reopens project management.
      await page.keyboard.press("Control+o");
      await expect(managerPane(page)).toBeVisible();
      await idle(managerPane(page));
      await managerPane(page).screenshot({
        path: path.join(output, "desktop-panel.png"),
      });
      assert.deepEqual(
        downloads,
        [],
        "Panel interactions and Ctrl+S must not create downloads",
      );
      page.off("download", trackDownload);
    },
  },
  {
    name: "nested folder create, real empty ASAR project, reload restore, save and open stay in panel",
    run: async (page) => {
      let manager = await openManager(page);
      await createFolder(manager, "工程目录");
      await entry(manager, "工程目录").dblclick();
      await idle(manager);
      await createFolder(manager, "子文件夹");
      await entry(manager, "子文件夹").dblclick();
      await idle(manager);
      await expect(
        manager.getByRole("navigation", { name: "当前文件夹路径" }),
      ).toContainText("子文件夹");

      const filename = await createProject(manager, "嵌套项目");
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await expect(entry(manager, filename)).toContainText("当前");
      const created = await fileByName(page, filename);
      assert.equal(
        await entry(manager, filename).getAttribute("data-entry-id"),
        created.id,
        "Active entry must reference the real stored project file id",
      );
      await expect(documentName(page)).toHaveText("嵌套项目");

      // Genuine ASAR payload: fully validated by in-page decodeProject.
      const state = await projectState(page, created.id);
      assert.equal(state.document.name, "嵌套项目");
      assert.deepEqual(state.document.sketches[0].entities, []);
      assert.equal(state.manifest.documents.cad2d.codec, "msgpack");
      assert.equal(state.manifest.documents.cad2d.compression, "gzip");
      assert.deepEqual(state.manifest.attachments, []);

      // Download the real bytes and verify the ASAR structure independently.
      await entry(manager, filename).click();
      const event = page.waitForEvent("download");
      await button(manager, "下载项目").click();
      const download = await event;
      assert.equal(download.suggestedFilename(), filename);
      const downloaded = path.join(output, "created-project.swcad");
      await download.saveAs(downloaded);
      const manifest = JSON.parse(
        asar.extractFile(downloaded, "manifest.json").toString("utf8"),
      );
      assert.equal(manifest.documents.cad2d.codec, "msgpack");
      assert.equal(manifest.documents.cad2d.compression, "gzip");
      const doc = decodeMessagePack(
        gunzipSync(
          asar.extractFile(
            downloaded,
            path.join(...manifest.documents.cad2d.path.split("/")),
          ),
        ),
      );
      assert.equal(doc.name, "嵌套项目");
      assert.deepEqual(doc.sketches[0].entities, []);

      await expect(savedDot(page)).toBeVisible();
      await page.reload({ waitUntil: "networkidle" });
      await waitReady(page);
      manager = await openManager(page);
      await expect(
        manager.getByRole("navigation", { name: "当前文件夹路径" }),
      ).toContainText("子文件夹");
      await expect(documentName(page)).toHaveText("嵌套项目");
      await root(manager);
      await expect(entry(manager, "工程目录")).toBeVisible();
      await entry(manager, "工程目录").dblclick();
      await idle(manager);
      await expect(entry(manager, "子文件夹")).toBeVisible();
      await entry(manager, "子文件夹").dblclick();
      await idle(manager);
      await expect(entry(manager, filename)).toContainText("当前");
      assert.equal(
        await entry(manager, filename).getAttribute("data-entry-id"),
        created.id,
        "Reload must restore the same active project file",
      );

      // Save mode from an active project: overwrite in place, panel stays open.
      await page.keyboard.press("Control+Shift+s");
      await expect(manager).toHaveAttribute("data-mode", "save");
      await expect(
        manager.getByRole("textbox", { name: "项目文件名", exact: true }),
      ).toHaveValue(filename);
      await button(manager, "保存").click();
      await expect(button(manager, "覆盖并保存")).toBeVisible();
      await button(manager, "覆盖并保存").click();
      await idle(manager);
      await expect(manager).toBeVisible();
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await expect(entry(manager, filename)).toContainText("当前");
      await expect(savedDot(page)).toBeVisible();
      assert.equal(
        (await fileByName(page, filename)).id,
        created.id,
        "Overwrite save must keep the project file id",
      );

      // Open flow also stays inside the panel and moves the 当前 tag.
      await createProject(manager, "快速打开");
      await expect(entry(manager, "快速打开.swcad")).toContainText("当前");
      await expect(entry(manager, filename)).not.toContainText("当前");
      const nestedTab = page.getByRole("tab", {
        name: "嵌套项目",
        exact: true,
      });
      const quickTab = page.getByRole("tab", {
        name: "快速打开",
        exact: true,
      });
      await expect(nestedTab).toHaveAttribute("aria-selected", "false");
      await expect(quickTab).toHaveAttribute("aria-selected", "true");
      await nestedTab.click();
      await idle(manager);
      await expect(manager).toBeVisible();
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await expect(entry(manager, filename)).toContainText("当前");
      await expect(documentName(page)).toHaveText("嵌套项目");
      await expect(nestedTab).toHaveAttribute("aria-selected", "true");
      await expect(quickTab).toHaveAttribute("aria-selected", "false");
      await page
        .getByRole("button", { name: "关闭 快速打开", exact: true })
        .click();
      await expect(quickTab).toHaveCount(0);
      await expect(nestedTab).toHaveAttribute("aria-selected", "true");
      await page
        .getByRole("button", { name: "关闭 嵌套项目", exact: true })
        .click();
      await expect(page.getByRole("tab")).toHaveCount(1);
      await expect(documentName(page)).toHaveText("未命名草图");
      assert.equal((await fileByName(page, filename)).id, created.id);
    },
  },
  {
    name: "switching to a new project persists pending edits and keeps the app inert with status",
    run: async (page) => {
      const manager = await openManager(page);
      await createProject(manager, "编辑项目");
      const original = await fileByName(page, "编辑项目.swcad");
      await closeManager(page);

      await drawLine(page);

      await watchProjectSwitch(page);
      await openManager(page);
      await createProject(manager, "下个项目");
      await readProjectSwitch(page, "create project");

      await expect(manager).toHaveAttribute("data-mode", "browse");
      await expect(entry(manager, "下个项目.swcad")).toContainText("当前");
      await expect(entry(manager, "编辑项目.swcad")).toBeVisible();
      await expect(entry(manager, "编辑项目.swcad")).not.toContainText("当前");
      await expect(documentName(page)).toHaveText("下个项目");
      const fresh = await projectState(
        page,
        (await fileByName(page, "下个项目.swcad")).id,
      );
      assert.deepEqual(fresh.document.sketches[0].entities, []);

      // The drawn line must have been flushed to the old file before the
      // switch, not lost with the editor reset.
      const persisted = await projectState(page, original.id);
      assert.equal(persisted.document.name, "编辑项目");
      const entities = persisted.document.sketches[0].entities;
      assert.equal(
        entities.length,
        1,
        "Exactly the drawn line must be archived into the previous project",
      );
      assert.equal(entities[0].kind, "line");
    },
  },
  {
    name: "duplicate and illegal project names keep the current project and files intact",
    run: async (page) => {
      const manager = await openManager(page);
      await createFolder(manager, "冲突目录");
      await entry(manager, "冲突目录").dblclick();
      await idle(manager);
      await createProject(manager, "冲突项目");
      const kept = await fileByName(page, "冲突项目.swcad");
      const before = await projectState(page, kept.id);

      // Same-name creation fails without touching the existing project.
      await button(manager, "新建项目").click();
      await manager
        .getByRole("textbox", { name: "项目名称", exact: true })
        .fill("冲突项目");
      await button(manager, "创建").click();
      await expect(
        manager.getByRole("alert").filter({ hasText: "同名" }),
      ).toBeVisible();
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        1,
        "Duplicate creation must not add a file",
      );
      assert.equal((await fileByName(page, "冲突项目.swcad")).id, kept.id);
      assert.deepEqual(
        (await projectState(page, kept.id)).document.sketches,
        before.document.sketches,
        "Duplicate creation must not overwrite the existing project",
      );
      await expect(documentName(page)).toHaveText("冲突项目");
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await button(manager, "关闭错误提示").click();
      await expect(
        manager.getByRole("textbox", { name: "项目名称", exact: true }),
      ).toHaveValue("冲突项目");

      // Path-like names are rejected as well.
      await manager
        .getByRole("textbox", { name: "项目名称", exact: true })
        .fill("坏/名称");
      await button(manager, "创建").click();
      await expect(
        manager.getByRole("alert").filter({ hasText: "斜杠" }),
      ).toBeVisible();
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        1,
      );
      assert.equal((await fileByName(page, "冲突项目.swcad")).id, kept.id);
      await expect(documentName(page)).toHaveText("冲突项目");
      await button(manager, "关闭错误提示").click();
      await button(manager, "取消操作").click();

      // Save mode rejects illegal names and keeps the current project attached.
      await page.keyboard.press("Control+Shift+s");
      await expect(manager).toHaveAttribute("data-mode", "save");
      await manager
        .getByRole("textbox", { name: "项目文件名", exact: true })
        .fill("坏/名称");
      await button(manager, "保存").click();
      await expect(
        manager.getByRole("alert").filter({ hasText: "斜杠" }),
      ).toBeVisible();
      await button(manager, "关闭错误提示").click();
      await button(manager, "取消").click();
      await expect(manager).toBeHidden();
      await expect(documentName(page)).toHaveText("冲突项目");
      assert.equal((await fileByName(page, "冲突项目.swcad")).id, kept.id);
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        1,
      );

      // The form recovers: a valid name still creates and switches.
      await openManager(page);
      await createProject(manager, "成功项目");
      await expect(entry(manager, "成功项目.swcad")).toContainText("当前");
      await expect(documentName(page)).toHaveText("成功项目");
      assert.equal(
        (await allEntries(page)).filter((item) => item.kind === "file").length,
        2,
      );
    },
  },
  {
    name: "quick new adds independent untitled project tabs",
    run: async (page) => {
      const manager = await openManager(page);
      const tabs = page.locator(".project-tab");
      const add = page.getByRole("button", {
        name: "新建未命名项目",
        exact: true,
      });
      await expect(add).toBeVisible();
      const initialCount = await tabs.count();
      const lastBox = await tabs.last().boundingBox();
      const addBox = await add.boundingBox();
      assert(lastBox && addBox);
      assert(
        addBox.x >= lastBox.x + lastBox.width - 1,
        "The quick-new icon must sit to the right of the project tabs",
      );
      await add.click();
      await expect(tabs).toHaveCount(initialCount + 1);
      await expect(documentName(page)).toHaveText("未命名草图");
      const firstNew = page.getByRole("tab", {
        name: "未命名草图",
        exact: true,
      });
      await expect(firstNew).toHaveAttribute("aria-selected", "true");
      await drawLine(page);
      await expect(page.locator(".status-right")).toContainText("1 对象");
      await add.click();
      await expect(tabs).toHaveCount(initialCount + 2);
      await expect(documentName(page)).toHaveText("未命名草图 2");
      await expect(page.locator(".status-right")).toContainText("0 对象");
      await firstNew.click();
      await expect(documentName(page)).toHaveText("未命名草图");
      await expect(page.locator(".status-right")).toContainText("1 对象");
      await expect(manager).toBeVisible();
    },
  },
  {
    name: "390px layout: collapsed toggle, reachable actions, no overflow, resized dual-panel overlap",
    viewport: { width: 390, height: 844 },
    run: async (page) => {
      await waitReady(page);
      await expect(page.locator(".browser-panel")).toBeHidden();
      await button(page, "切换左侧栏").click();
      await expect(page.locator(".browser-panel")).toBeVisible();
      await expect(page.locator(".sketch-browser")).toBeVisible();

      const manager = await openManager(page);
      await expect(page.getByRole("region", { name: "项目管理" })).toHaveCount(
        1,
      );
      const projectWidth = (await page.locator(".project-panel").boundingBox())
        .width;
      assert.equal(
        projectWidth,
        (await page.locator(".browser-panel").boundingBox()).width,
        "Both left sidebars share the same narrow width",
      );
      await closeManager(page);
      await expect(page.locator(".project-panel")).toHaveCount(0);
      await expect(page.locator(".sketch-browser")).toBeVisible();
      await openManager(page);
      // Every key action must be reachable: run the full create flow by clicking.
      await createFolder(manager, "移动目录");
      await entry(manager, "移动目录").dblclick();
      await idle(manager);
      await createProject(manager, "移动项目");
      await expect(entry(manager, "移动项目.swcad")).toContainText("当前");
      await expect(projectToggle(page)).toHaveAttribute("aria-pressed", "true");

      const dimensions = await manager.evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        paneWidth: element.clientWidth,
        paneScrollWidth: element.scrollWidth,
        rowsInside: Array.from(
          element.querySelectorAll(".fm-entry"),
          (row) =>
            row.getBoundingClientRect().right <=
            element.getBoundingClientRect().right,
        ),
      }));
      assert(
        dimensions.left >= 0 && dimensions.right <= dimensions.width + 1,
        "Panel must stay inside the narrow viewport",
      );
      assert(dimensions.documentWidth <= dimensions.width + 1);
      assert(
        dimensions.paneScrollWidth <= dimensions.paneWidth + 1,
        "Panel content must not overflow horizontally",
      );
      assert(dimensions.rowsInside.every(Boolean));
      await manager.screenshot({ path: path.join(output, "mobile-390.png") });

      // Desktop load resized down to 390 keeps both sidebars expanded
      // (leftOpen/rightOpen were initialized on mount); the properties panel
      // must never cover the project panel's create actions.
      const resized = await page.context().newPage();
      resized.setDefaultTimeout(15000);
      const resizedErrors = [];
      resized.on("pageerror", (error) => {
        resizedErrors.push(error.message);
        results.pageErrors.push(error.message);
      });
      try {
        await resized.setViewportSize({ width: 1440, height: 900 });
        await resized.goto(url, { waitUntil: "networkidle" });
        await waitReady(resized);
        await resized.setViewportSize({ width: 390, height: 844 });
        const overlapManager = await openManager(resized);
        // Successful clicks prove neither sidebar covers these controls.
        await createFolder(overlapManager, "窄屏重叠目录");
        await entry(overlapManager, "窄屏重叠目录").dblclick();
        await idle(overlapManager);
        await createProject(overlapManager, "窄屏重叠项目");
        await expect(entry(overlapManager, "窄屏重叠项目.swcad")).toContainText(
          "当前",
        );
        await overlapManager.screenshot({
          path: path.join(output, "mobile-390-resized.png"),
        });
        assert.deepEqual(resizedErrors, []);
      } finally {
        await resized.close();
      }
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
      await waitReady(page);
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
