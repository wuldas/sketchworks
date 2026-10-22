import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

// Main runs this against its existing stable dev server; this script starts no server.
const url = process.env.CAD_URL || "http://127.0.0.1:5173";
const output = path.resolve(
  process.env.CAD_WORKSPACE_ARTIFACTS || "artifacts/workspace-recovery",
);
const requestedCases = (process.env.CAD_WORKSPACE_CASE || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const executablePath =
  process.env.CAD_BROWSER_PATH ||
  (!existsSync(chromium.executablePath()) && existsSync(chrome)
    ? chrome
    : undefined);
const documentKey = "sketchworks.document.v1";
const timeKey = "sketchworks.workspace.updated.v1";
const seedDocument = (name, key = "a") => ({
  version: 1,
  name,
  unit: "mm",
  parameters: [],
  sketches: [
    {
      id: `sk_recovery_${key}`,
      name: "草图 1",
      visible: true,
      entities: [
        {
          id: `e_recovery_${key}`,
          kind: "line",
          name: "恢复基准线",
          points: [
            { id: `p_recovery_${key}_1`, x: key === "b" ? 30 : -15, y: -5 },
            { id: `p_recovery_${key}_2`, x: key === "b" ? 40 : 15, y: 5 },
          ],
        },
      ],
      constraints: [],
    },
  ],
});
const seed = seedDocument("工作区初始文档", "initial");
const results = { url, checks: [], pageErrors: [], externalRequests: [] };
const button = (scope, name) =>
  scope.getByRole("button", { name, exact: true });
const documentName = (page) => page.locator(".app-header .document-name");
async function setUnit(page, unit) {
  await page.getByRole("combobox", { name: "单位" }).selectOption(unit);
}
const fileRow = (manager, name) =>
  manager.getByRole("option", { name, exact: true });
const idle = (manager) =>
  expect(manager).toHaveAttribute("aria-busy", "false", { timeout: 20000 });

const projectToggle = (page) =>
  page
    .locator(".app-header")
    .getByRole("button", { name: "项目管理", exact: true });
const activeTag = (manager, name) =>
  fileRow(manager, name).getByText("当前", { exact: true });
async function openManager(page) {
  const toggle = projectToggle(page);
  const manager = page.getByTestId("file-manager");
  if ((await toggle.getAttribute("aria-pressed")) === "true") {
    await idle(manager);
    await toggle.click();
    await expect(manager).toBeHidden();
  }
  await toggle.click();
  await expect(manager).toBeVisible();
  // Contract: the docked pane is a named region, not a modal dialog.
  await expect(page.getByRole("region", { name: "项目管理" })).toBeVisible();
  await expect(manager).toHaveAttribute("data-mode", "browse");
  await idle(manager);
  return manager;
}
async function closeManagerPanel(page, manager) {
  const toggle = projectToggle(page);
  if ((await toggle.getAttribute("aria-pressed")) === "true")
    await toggle.click();
  await expect(manager).toBeHidden();
  await expect(page.locator(".browser-panel .sketch-browser")).toBeVisible();
  await expect(projectToggle(page)).toHaveAttribute("aria-pressed", "false");
}
async function fileMenu(page, label) {
  if (!(await page.locator(".file-menu").isVisible()))
    await button(page, "文件").click();
  await button(page.locator(".file-menu"), label).click();
}
async function openNamed(page, file, expectedName) {
  const manager = await openManager(page);
  await fileRow(manager, file.name).dblclick();
  // The docked sidebar stays mounted; the switch is complete only once the
  // editor, the linked file and the persisted workspace point at the project.
  await expect(manager).toBeVisible();
  await expect(manager).toHaveAttribute("data-mode", "browse");
  await expect(documentName(page)).toHaveText(expectedName);
  await expect(page.locator(".app-header .save-label")).toHaveAttribute(
    "title",
    file.name,
  );
  await expect(activeTag(manager, file.name)).toBeVisible();
}
async function newDocumentDialog(page, name) {
  await fileMenu(page, "新建文档");
  const dialog = page.locator("form.dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "文档名称", exact: true })
    .fill(name);
  return dialog;
}
async function nativeImport(page, payload) {
  const chooser = page.waitForEvent("filechooser");
  await fileMenu(page, "打开草图");
  await (await chooser).setFiles(payload);
}
async function makeFixture(
  page,
  doc,
  { extension = ".swcad", resources = false } = {},
) {
  const fixture = await page.evaluate(
    async ({ doc, resources }) => {
      const { createProject, addProjectAttachment, encodeProject } =
        await import("/src/projectArchive.ts");
      let project = createProject(doc);
      if (resources) {
        const canvas = document.createElement("canvas");
        canvas.width = 3;
        canvas.height = 2;
        const context = canvas.getContext("2d");
        context.fillStyle = "#16745b";
        context.fillRect(0, 0, 3, 2);
        context.fillStyle = "#ffffff";
        context.fillRect(1, 0, 1, 1);
        const binary = atob(canvas.toDataURL("image/png").split(",")[1]);
        const png = Uint8Array.from(binary, (character) =>
          character.charCodeAt(0),
        );
        project = addProjectAttachment(project, {
          name: "恢复参考图.png",
          mimeType: "image/png",
          data: png,
        });
        project.manifest.modules = {
          solid: {
            path: "models/opaque-body.bin",
            version: 3,
            settings: { tolerance: 0.01 },
          },
          cam: {
            path: "cam/opaque-toolpath.bin",
            version: 2,
            strategy: "future",
          },
        };
        project.manifest.futureWorkspace = { schema: 17, retained: true };
        project.files.set(
          "models/opaque-body.bin",
          new Uint8Array([0, 255, 7, 128, 17, 0, 49]),
        );
        project.files.set(
          "cam/opaque-toolpath.bin",
          new Uint8Array([67, 65, 77, 0, 254, 10, 13, 1]),
        );
        project.files.set(
          "future/unknown-module.bin",
          new Uint8Array([91, 0, 93, 255]),
        );
      }
      const bytes = Array.from(encodeProject(project));
      return {
        bytes,
        expected: {
          document: project.document,
          manifest: project.manifest,
          resources: Array.from(project.files, ([name, data]) => [
            name,
            Array.from(data),
          ]),
        },
      };
    },
    { doc, resources },
  );
  return {
    ...fixture,
    payload: {
      name: `${doc.name}${extension}`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.bytes),
    },
  };
}
async function createNamed(page, doc, options) {
  const fixture = await makeFixture(page, doc, options);
  const file = await page.evaluate(
    async ({ name, bytes }) => {
      const { ROOT_ID, virtualFiles } = await import(
        "/src/virtualFileSystem.ts"
      );
      return virtualFiles.createFile(
        ROOT_ID,
        name,
        new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
      );
    },
    { name: fixture.payload.name, bytes: fixture.bytes },
  );
  return { file, fixture };
}
async function inspectProject(page, request) {
  return page.evaluate(async (request) => {
    const { virtualFiles } = await import("/src/virtualFileSystem.ts");
    const { decodeProject, attachmentData } = await import(
      "/src/projectArchive.ts"
    );
    let bytes;
    let fileId = request.fileId ?? null;
    let updatedAt = null;
    if (request.bytes) bytes = new Uint8Array(request.bytes);
    else if (request.workspace || request.bootDisk) {
      const snapshot = request.bootDisk
        ? await window.__workspaceBootGate.readDisk()
        : await virtualFiles.readWorkspace();
      if (!snapshot) return null;
      bytes = new Uint8Array(await snapshot.contents.arrayBuffer());
      fileId = snapshot.fileId;
      updatedAt = snapshot.updatedAt;
    } else
      bytes = new Uint8Array(
        await (await virtualFiles.readFile(fileId)).arrayBuffer(),
      );
    const project = decodeProject(bytes);
    return {
      fileId,
      updatedAt,
      bytes: Array.from(bytes),
      document: project.document,
      manifest: project.manifest,
      files: Array.from(project.files, ([name, data]) => [
        name,
        Array.from(data),
      ]),
      attachments: project.manifest.attachments.map((attachment) => ({
        ...attachment,
        bytes: Array.from(attachmentData(project, attachment.id) || []),
      })),
    };
  }, request);
}
async function waitForWorkspace(page, name, fileId) {
  await expect
    .poll(
      async () => {
        const snapshot = await inspectProject(page, { workspace: true });
        return snapshot
          ? { name: snapshot.document.name, fileId: snapshot.fileId }
          : null;
      },
      { timeout: 20000 },
    )
    .toEqual({ name, fileId });
  return inspectProject(page, { workspace: true });
}
async function baseline(page, { resources = false } = {}) {
  const a = await createNamed(page, seedDocument("项目 A", "a"), { resources });
  await openNamed(page, a.file, a.fixture.expected.document.name);
  await waitForWorkspace(page, "项目 A", a.file.id);
  await expect(page.locator('.save-dot[data-saved="true"]')).toBeVisible();
  return a;
}
async function allEntries(page) {
  return page.evaluate(async () =>
    (await import("/src/virtualFileSystem.ts")).virtualFiles.allEntries(),
  );
}
function assertResources(actual, fixture, { document = true } = {}) {
  assert(actual, "Expected a readable full project snapshot");
  if (document) assert.deepEqual(actual.document, fixture.expected.document);
  assert.deepEqual(actual.manifest.modules, fixture.expected.manifest.modules);
  assert.deepEqual(actual.manifest.futureWorkspace, {
    schema: 17,
    retained: true,
  });
  for (const [name, bytes] of fixture.expected.resources)
    assert.deepEqual(
      actual.files.find(([path]) => path === name)?.[1],
      bytes,
      `Preserve exact bytes of ${name}`,
    );
  const image = fixture.expected.manifest.attachments[0];
  assert.equal(actual.attachments.length, 1);
  assert.equal(actual.attachments[0].id, image.id);
  assert.equal(actual.attachments[0].mimeType, "image/png");
  assert.deepEqual(
    actual.attachments[0].bytes,
    fixture.expected.resources.find(([name]) => name === image.path)[1],
  );
}
async function downloadProject(page, label) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    fileMenu(page, "下载项目"),
  ]);
  assert.match(download.suggestedFilename(), /\.swcad$/i);
  const file = path.join(output, `${label}.swcad`);
  await download.saveAs(file);
  const bytes = await fs.readFile(file);
  assert.equal(
    bytes.readUInt32LE(0),
    4,
    "Downloaded project must have an ASAR pickle header",
  );
  return inspectProject(page, { bytes: Array.from(bytes) });
}
async function exportedDocument(page, label) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    fileMenu(page, "导出 JSON 草图"),
  ]);
  const file = path.join(output, `${label}.json`);
  await download.saveAs(file);
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function forceSave(page) {
  await page.keyboard.press("Control+s");
  await expect(page.getByText("项目已保存", { exact: true })).toBeVisible();
}
async function addLineWithHistory(page) {
  const before = await page.locator(".app").getAttribute("data-history");
  await button(page, "直线").first().click();
  // The drawing sidebar replaces the properties panel while the tool collects
  // points, so the canvas box is measured on the live creation layout.
  await page.getByTestId("creation-panel").waitFor();
  const bounds = await page.getByTestId("cad-canvas").boundingBox();
  assert(bounds);
  await page.mouse.click(
    bounds.x + bounds.width * 0.22,
    bounds.y + bounds.height * 0.18,
  );
  await page.mouse.click(
    bounds.x + bounds.width * 0.58,
    bounds.y + bounds.height * 0.34,
  );
  await expect(page.locator(".app")).not.toHaveAttribute(
    "data-history",
    before,
  );
  await page.keyboard.press("Escape");
  await expect(button(page, "撤销 (Ctrl+Z)")).toBeEnabled();
  await forceSave(page);
}
async function armClock(page) {
  await page.evaluate(() => {
    window.__workspaceClock = { editAt: null, switchAt: null, action: null };
    if (window.__workspaceClockInstalled) return;
    window.__workspaceClockInstalled = true;
    document.addEventListener(
      "change",
      (event) => {
        if (
          event.target instanceof HTMLSelectElement &&
          event.target.getAttribute("aria-label") === "单位"
        )
          window.__workspaceClock = {
            editAt: performance.now(),
            switchAt: null,
            action: null,
          };
      },
      true,
    );
    const record = (action) => {
      const clock = window.__workspaceClock;
      if (clock.editAt !== null && clock.switchAt === null) {
        clock.switchAt = performance.now();
        clock.action = action;
      }
    };
    document.addEventListener(
      "dblclick",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-testid="file-manager-entry"]')
        )
          record("file-manager-open");
      },
      true,
    );
    document.addEventListener(
      "submit",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.matches("form.dialog")
        )
          record("new-document-confirm");
      },
      true,
    );
    document.addEventListener(
      "change",
      (event) => {
        if (
          event.target instanceof HTMLInputElement &&
          event.target.type === "file" &&
          !event.target.closest('[data-testid="file-manager"]')
        )
          record("native-project-import");
      },
      true,
    );
  });
}
async function immediateTiming(page) {
  const timing = await page.evaluate(() => {
    const clock = window.__workspaceClock;
    return {
      ...clock,
      editToActionMs:
        clock.switchAt === null || clock.editAt === null
          ? null
          : clock.switchAt - clock.editAt,
    };
  });
  assert.notEqual(
    timing.editToActionMs,
    null,
    "Observe actual native edit and switch events",
  );
  assert(
    timing.editToActionMs < 600,
    `Immediate case must switch before 600ms autosave; observed ${timing.editToActionMs.toFixed(1)}ms`,
  );
  return timing;
}
async function installFailure(page, method, fileId) {
  await page.evaluate(
    async ({ method, fileId }) => {
      const { virtualFiles } = await import("/src/virtualFileSystem.ts");
      const original = virtualFiles[method];
      const patch = {
        method,
        calls: 0,
        events: [],
        message: `测试注入：${method === "updateFile" ? "更新项目文件" : "写入完整工作区"}失败`,
      };
      patch.restore = () => {
        virtualFiles[method] = original;
      };
      virtualFiles[method] = async function (...args) {
        if (method !== "updateFile" || args[0] === fileId) {
          patch.calls++;
          patch.events.push({
            method,
            at: performance.now(),
            fileId: method === "updateFile" ? args[0] : args[0]?.fileId,
          });
          throw new Error(patch.message);
        }
        return original.apply(virtualFiles, args);
      };
      window.__workspacePatch = patch;
    },
    { method, fileId },
  );
}
async function patchCalls(page) {
  return page.evaluate(() => window.__workspacePatch.calls);
}
async function waitForFailure(page, before) {
  await expect.poll(() => patchCalls(page)).toBeGreaterThan(before);
  await expect(page.locator(".toast.error")).toContainText("测试注入：");
}
async function restorePatch(page) {
  await page
    .evaluate(() => window.__workspacePatch?.restore?.())
    .catch(() => {});
}
async function assertEditorKept(page, file, name, history, unit) {
  await expect(documentName(page)).toHaveText(name);
  await expect(page.locator(".app-header .save-label")).toHaveAttribute(
    "title",
    file.name,
  );
  assert.equal(await documentName(page).getAttribute("title"), file.name);
  if (unit)
    await expect(page.getByRole("combobox", { name: "单位" })).toHaveValue(
      unit,
    );
  assert.equal(
    await page.locator(".app").getAttribute("data-history"),
    history,
  );
}

const cases = [
  {
    id: "same-reopen",
    name: "immediate same-file reopen preserves pending edit, geometry and file id",
    run: async (page) => {
      const a = await baseline(page);
      await armClock(page);
      await setUnit(page, "in");
      const manager = await openManager(page);
      await fileRow(manager, a.file.name).dblclick();
      const timing = await immediateTiming(page);
      await expect(manager).toBeVisible();
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await expect(documentName(page)).toHaveText(
        a.fixture.expected.document.name,
      );
      await expect(page.locator(".app-header .save-label")).toHaveAttribute(
        "title",
        a.file.name,
      );
      const archive = await inspectProject(page, { fileId: a.file.id });
      assert.equal(archive.document.unit, "in");
      assert.deepEqual(
        archive.document.sketches,
        a.fixture.expected.document.sketches,
      );
      assert.equal(
        (
          await waitForWorkspace(
            page,
            a.fixture.expected.document.name,
            a.file.id,
          )
        ).fileId,
        a.file.id,
      );
      assert.equal(
        (await allEntries(page)).filter((entry) => entry.kind === "file")
          .length,
        1,
      );
      return timing;
    },
  },
  {
    id: "switch-b",
    name: "immediate switch to B writes the latest edited A before changing link",
    run: async (page) => {
      const b = await createNamed(page, seedDocument("项目 B", "b"));
      const a = await baseline(page);
      await armClock(page);
      await setUnit(page, "in");
      const manager = await openManager(page);
      await fileRow(manager, b.file.name).dblclick();
      const timing = await immediateTiming(page);
      await expect(manager).toBeVisible();
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await expect(documentName(page)).toHaveText("项目 B");
      await expect(page.locator(".app-header .save-label")).toHaveAttribute(
        "title",
        b.file.name,
      );
      const prior = await inspectProject(page, { fileId: a.file.id });
      assert.equal(prior.document.unit, "in");
      assert.deepEqual(
        prior.document.sketches,
        a.fixture.expected.document.sketches,
      );
      assert.deepEqual(
        (await inspectProject(page, { fileId: b.file.id })).document,
        b.fixture.expected.document,
      );
      await waitForWorkspace(page, "项目 B", b.file.id);
      return timing;
    },
  },
  {
    id: "new-import",
    name: "immediate NewDoc and native SWCAD import preserve previous named documents",
    run: async (page) => {
      const c = await createNamed(page, seedDocument("项目 C", "c"));
      const a = await baseline(page);
      const incoming = await makeFixture(
        page,
        seedDocument("原生 SWCAD 项目", "native"),
        { resources: true },
      );
      await armClock(page);
      await setUnit(page, "in");
      const dialog = await newDocumentDialog(page, "真正的新文档");
      await button(dialog, "新建").click();
      const newTiming = await immediateTiming(page);
      await expect(dialog).toBeHidden();
      await expect(documentName(page)).toHaveText("真正的新文档");
      assert.equal(
        await page.locator(".app-header .save-label").getAttribute("title"),
        null,
      );
      const previousA = await inspectProject(page, { fileId: a.file.id });
      assert.equal(previousA.document.unit, "in");
      assert.deepEqual(
        previousA.document.sketches,
        a.fixture.expected.document.sketches,
      );
      await openNamed(page, c.file, "项目 C");
      await waitForWorkspace(page, "项目 C", c.file.id);
      await armClock(page);
      await setUnit(page, "in");
      await nativeImport(page, incoming.payload);
      const importTiming = await immediateTiming(page);
      await expect(documentName(page)).toHaveText(
        incoming.expected.document.name,
      );
      assert.equal(
        await page.locator(".app-header .save-label").getAttribute("title"),
        null,
      );
      const previousC = await inspectProject(page, { fileId: c.file.id });
      assert.equal(previousC.document.unit, "in");
      assert.deepEqual(
        previousC.document.sketches,
        c.fixture.expected.document.sketches,
      );
      assertResources(
        await waitForWorkspace(page, incoming.expected.document.name, null),
        incoming,
      );
      return { newTiming, importTiming };
    },
  },
  {
    id: "in-flight",
    name: "in-flight update blocks reopen: docked panel waits under app inert, then adopts only the committed archive",
    run: async (page) => {
      const a = await baseline(page);
      await page.evaluate(async (fileId) => {
        const { virtualFiles } = await import("/src/virtualFileSystem.ts");
        const { decodeProject } = await import("/src/projectArchive.ts");
        const originalUpdate = virtualFiles.updateFile;
        const originalRead = virtualFiles.readFile;
        let release;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        const gate = {
          entered: false,
          used: false,
          released: false,
          events: [],
          reads: [],
          release: () => {
            gate.released = true;
            release();
          },
        };
        virtualFiles.updateFile = async function (id, contents) {
          const archived =
            id === fileId
              ? decodeProject(await contents.arrayBuffer()).document
              : null;
          const unit = archived?.unit ?? null;
          if (id === fileId && !gate.used) {
            gate.used = true;
            gate.entered = true;
            gate.events.push({
              kind: "blocked-update",
              unit,
              at: performance.now(),
            });
            await wait;
          }
          const result = await originalUpdate.call(virtualFiles, id, contents);
          if (id === fileId)
            gate.events.push({
              kind: "committed-update",
              unit,
              at: performance.now(),
            });
          return result;
        };
        virtualFiles.readFile = async function (id) {
          const blob = await originalRead.call(virtualFiles, id);
          if (id === fileId) {
            const unit = decodeProject(await blob.arrayBuffer()).document.unit;
            gate.reads.push(unit);
            gate.events.push({
              kind: "archive-read",
              unit,
              at: performance.now(),
            });
          }
          return blob;
        };
        gate.restore = () => {
          gate.release();
          virtualFiles.updateFile = originalUpdate;
          virtualFiles.readFile = originalRead;
        };
        window.__workspaceWriteGate = gate;
      }, a.file.id);
      try {
        const editedUnit = "in";
        await setUnit(page, editedUnit);
        await page.keyboard.press("Control+s");
        await page.waitForFunction(() => window.__workspaceWriteGate.entered);
        const manager = await openManager(page);
        await fileRow(manager, a.file.name).dblclick();
        await expect(manager).toHaveAttribute("aria-busy", "true");
        await page.waitForFunction(() =>
          window.__workspaceWriteGate.events.some(
            (event) => event.kind === "blocked-update",
          ),
        );
        // The async switch locks the whole app behind an accessible status.
        const app = page.locator(".app");
        const transition = page.locator(".project-transition-overlay");
        await expect(app).toHaveAttribute("inert", "");
        await expect(transition).toBeVisible();
        await expect(transition).toHaveAttribute("role", "status");
        const historyBeforeShortcut = await app.getAttribute("data-history");
        await page.keyboard.press("Control+z");
        await expect(page.getByRole("combobox", { name: "单位" })).toHaveValue(
          editedUnit,
        );
        assert.equal(
          await app.getAttribute("data-history"),
          historyBeforeShortcut,
        );
        const blocked = await page.evaluate(() => ({
          released: window.__workspaceWriteGate.released,
          reads: window.__workspaceWriteGate.reads,
          events: window.__workspaceWriteGate.events,
        }));
        assert.equal(blocked.released, false);
        assert(
          !blocked.reads.length,
          "No stale archive may be decoded while the previous write is still pending",
        );
        assert(
          !blocked.events.some((event) => event.kind === "committed-update"),
        );
        await expect(documentName(page)).toHaveText(
          a.fixture.expected.document.name,
        );
        await expect(page.locator(".app-header .save-label")).toHaveAttribute(
          "title",
          a.file.name,
        );
        await manager.screenshot({
          path: path.join(output, "in-flight-blocked.png"),
        });
        await page.evaluate(() => window.__workspaceWriteGate.release());
        await expect(app).not.toHaveAttribute("inert");
        await expect(transition).toBeHidden();
        await expect(manager).toBeVisible();
        await expect(manager).toHaveAttribute("data-mode", "browse");
        await expect(documentName(page)).toHaveText(
          a.fixture.expected.document.name,
        );
        const ordering = await page.evaluate(
          () => window.__workspaceWriteGate.events,
        );
        const written = ordering.findIndex(
          (event) =>
            event.kind === "committed-update" && event.unit === editedUnit,
        );
        const freshRead = ordering.findIndex(
          (event) => event.kind === "archive-read" && event.unit === editedUnit,
        );
        assert(
          written >= 0 && freshRead > written,
          "Open must re-read current archive after the pending write commits",
        );
        const project = await inspectProject(page, { fileId: a.file.id });
        assert.equal(project.document.unit, editedUnit);
        assert.deepEqual(
          project.document.sketches,
          a.fixture.expected.document.sketches,
        );
        await waitForWorkspace(
          page,
          a.fixture.expected.document.name,
          a.file.id,
        );
        return { ordering };
      } finally {
        await page
          .evaluate(() => window.__workspaceWriteGate?.restore?.())
          .catch(() => {});
      }
    },
  },
  {
    id: "update-failure",
    name: "failed file update blocks open, NewDoc and native import without clearing geometry or Undo",
    run: async (page) => {
      const b = await createNamed(page, seedDocument("失败测试目标 B", "b"));
      const a = await baseline(page);
      const incoming = await makeFixture(
        page,
        seedDocument("失败测试原生导入", "failure_import"),
      );
      await addLineWithHistory(page);
      const geometry = (await inspectProject(page, { fileId: a.file.id }))
        .document.sketches;
      assert(geometry[0].entities.length > 1);
      await installFailure(page, "updateFile", a.file.id);
      let detail;
      try {
        const editedUnit = "in";
        await setUnit(page, editedUnit);
        const history = await page.locator(".app").getAttribute("data-history");
        const manager = await openManager(page);
        const beforeOpen = await patchCalls(page);
        await fileRow(manager, b.file.name).dblclick();
        await waitForFailure(page, beforeOpen);
        await idle(manager);
        await expect(manager).toBeVisible();
        await assertEditorKept(
          page,
          a.file,
          a.fixture.expected.document.name,
          history,
          editedUnit,
        );
        await closeManagerPanel(page, manager);
        const dialog = await newDocumentDialog(page, "不应新建");
        const beforeNew = await patchCalls(page);
        await button(dialog, "新建").click();
        await waitForFailure(page, beforeNew);
        await expect(dialog).toHaveAttribute("aria-busy", "false");
        await expect(dialog).toBeVisible();
        await assertEditorKept(
          page,
          a.file,
          a.fixture.expected.document.name,
          history,
          editedUnit,
        );
        await button(dialog, "取消").click();
        const beforeImport = await patchCalls(page);
        await nativeImport(page, incoming.payload);
        await waitForFailure(page, beforeImport);
        await assertEditorKept(
          page,
          a.file,
          a.fixture.expected.document.name,
          history,
          editedUnit,
        );
        await expect(button(page, "撤销 (Ctrl+Z)")).toBeEnabled();
        assert.deepEqual(
          (await exportedDocument(page, "update-failure-kept-editor")).sketches,
          geometry,
        );
        assert.equal(
          (await inspectProject(page, { workspace: true })).fileId,
          a.file.id,
        );
        await page.screenshot({
          path: path.join(output, "update-failure-kept-editor.png"),
        });
        detail = { failureCalls: await patchCalls(page), history };
      } finally {
        await restorePatch(page);
      }
      await forceSave(page);
      await page.keyboard.press("Control+z");
      await page.keyboard.press("Control+z");
      assert.deepEqual(
        (await exportedDocument(page, "update-failure-undo")).sketches,
        a.fixture.expected.document.sketches,
        "Original Undo history must remain usable after failed switches",
      );
      return detail;
    },
  },
  {
    id: "workspace-failure",
    name: "failed full-workspace write and invalid native files never replace the active document",
    run: async (page) => {
      const b = await createNamed(page, seedDocument("工作区失败目标 B", "b"));
      const a = await baseline(page);
      const incoming = await makeFixture(
        page,
        seedDocument("工作区失败原生导入", "write_failure"),
      );
      await installFailure(page, "writeWorkspace", a.file.id);
      let history;
      try {
        const editedUnit = "in";
        await setUnit(page, editedUnit);
        history = await page.locator(".app").getAttribute("data-history");
        const dialog = await newDocumentDialog(page, "不能替换当前文档");
        const beforeNew = await patchCalls(page);
        await button(dialog, "新建").click();
        await waitForFailure(page, beforeNew);
        await expect(dialog).toHaveAttribute("aria-busy", "false");
        await expect(dialog).toBeVisible();
        await assertEditorKept(
          page,
          a.file,
          a.fixture.expected.document.name,
          history,
          editedUnit,
        );
        await button(dialog, "取消").click();
        const manager = await openManager(page);
        const beforeOpen = await patchCalls(page);
        await fileRow(manager, b.file.name).dblclick();
        await waitForFailure(page, beforeOpen);
        await idle(manager);
        await expect(manager).toBeVisible();
        await assertEditorKept(
          page,
          a.file,
          a.fixture.expected.document.name,
          history,
          editedUnit,
        );
        await closeManagerPanel(page, manager);
        const beforeImport = await patchCalls(page);
        await nativeImport(page, incoming.payload);
        await waitForFailure(page, beforeImport);
        await assertEditorKept(
          page,
          a.file,
          a.fixture.expected.document.name,
          history,
          editedUnit,
        );
        assert.deepEqual(
          (await exportedDocument(page, "workspace-failure-kept-editor"))
            .sketches,
          a.fixture.expected.document.sketches,
        );
      } finally {
        await restorePatch(page);
      }
      await forceSave(page);
      const retained = await exportedDocument(page, "before-invalid-import");
      for (const payload of [
        {
          name: "损坏的项目.swcad",
          mimeType: "application/octet-stream",
          buffer: Buffer.from('{"fakeArchive":true}'),
        },
        {
          name: "无效的旧版文档.json",
          mimeType: "application/json",
          buffer: Buffer.from('{"version":1,"name":"bad","sketches":[]}'),
        },
      ]) {
        await nativeImport(page, payload);
        await expect(page.locator(".toast.error")).toBeVisible();
        await assertEditorKept(
          page,
          a.file,
          retained.name,
          history,
          retained.unit,
        );
        assert.deepEqual(
          await exportedDocument(
            page,
            `invalid-${path.extname(payload.name).slice(1)}`,
          ),
          retained,
        );
      }
      assert.equal(
        (await allEntries(page)).filter((entry) => entry.kind === "file")
          .length,
        2,
      );
      return { history, invalidInputs: 2 };
    },
  },
  {
    id: "create-save-failure",
    name: "failed persist of the previous project blocks 新建项目 without creating or switching, then creation recovers",
    run: async (page) => {
      const a = await baseline(page);
      const manager = await openManager(page);
      // The docked sidebar never blocks the canvas: parallel editing keeps working.
      assert.equal(await page.locator(".app").getAttribute("inert"), null);
      await addLineWithHistory(page);
      await expect(manager).toBeVisible();
      await expect(manager).toHaveAttribute("data-mode", "browse");
      const parallelGeometry = (
        await inspectProject(page, { fileId: a.file.id })
      ).document.sketches;
      assert.equal(parallelGeometry[0].entities.length, 2);
      const editedUnit = "in";
      await setUnit(page, editedUnit);
      const history = await page.locator(".app").getAttribute("data-history");
      await installFailure(page, "updateFile", a.file.id);
      try {
        const form = manager.getByRole("form", {
          name: "新建项目",
          exact: true,
        });
        await button(manager, "新建项目").click();
        await expect(form).toBeVisible();
        await form
          .getByRole("textbox", { name: "项目名称", exact: true })
          .fill("并行新建项目");
        const beforeCreate = await patchCalls(page);
        await button(form, "创建").click();
        await waitForFailure(page, beforeCreate);
        await idle(manager);
        // The consumer error boundary: the inline form reports the failure,
        // stays open, and neither creates a file nor switches projects.
        await expect(form).toBeVisible();
        await expect(manager).toBeVisible();
        await assertEditorKept(
          page,
          a.file,
          a.fixture.expected.document.name,
          history,
          editedUnit,
        );
        assert.deepEqual(
          (await allEntries(page))
            .filter((entry) => entry.kind === "file")
            .map((entry) => entry.name),
          [a.file.name],
          "No new project file may be created when the previous project cannot persist",
        );
        assert.equal(
          (await inspectProject(page, { workspace: true })).fileId,
          a.file.id,
        );
        await button(form, "取消操作").click();
        await expect(form).toBeHidden();
      } finally {
        await restorePatch(page);
      }
      await button(manager, "新建项目").click();
      const form = manager.getByRole("form", {
        name: "新建项目",
        exact: true,
      });
      await expect(form).toBeVisible();
      await form
        .getByRole("textbox", { name: "项目名称", exact: true })
        .fill("并行新建项目");
      await button(form, "创建").click();
      // Recovery keeps the sidebar open, returns to browse mode and marks the
      // new entry active with the document named after the project.
      await expect(manager).toBeVisible();
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await idle(manager);
      await expect(documentName(page)).toHaveText("并行新建项目");
      await expect(page.locator(".app-header .save-label")).toHaveAttribute(
        "title",
        "并行新建项目.swcad",
      );
      const files = (await allEntries(page)).filter(
        (entry) => entry.kind === "file",
      );
      assert.equal(files.length, 2);
      const created = files.find((file) => file.name === "并行新建项目.swcad");
      assert(created, "New empty project must exist in the current folder");
      const empty = await inspectProject(page, { fileId: created.id });
      assert.equal(empty.document.name, "并行新建项目");
      assert.deepEqual(empty.document.sketches[0].entities, []);
      await waitForWorkspace(page, "并行新建项目", created.id);
      await expect(activeTag(manager, created.name)).toBeVisible();
      await expect(activeTag(manager, a.file.name)).toHaveCount(0);
      // The interrupted previous project kept its parallel edits.
      const prior = await inspectProject(page, { fileId: a.file.id });
      assert.equal(prior.document.unit, editedUnit);
      assert.deepEqual(prior.document.sketches, parallelGeometry);
      return { priorId: a.file.id, createdId: created.id };
    },
  },
  {
    id: "full-resources",
    name: "unlinked native SWCAD and legacy ASAR recover all resources without named save",
    run: async (page) => {
      const restored = [];
      let latest;
      for (const extension of [".swcad", ".asar"]) {
        const fixture = await makeFixture(
          page,
          seedDocument(
            `未命名保存前恢复 ${extension}`,
            `resources_${extension.slice(1)}`,
          ),
          { extension, resources: true },
        );
        await nativeImport(page, fixture.payload);
        await expect(documentName(page)).toHaveText(
          fixture.expected.document.name,
        );
        assert.equal(
          await page.locator(".app-header .save-label").getAttribute("title"),
          null,
        );
        assertResources(
          await waitForWorkspace(page, fixture.expected.document.name, null),
          fixture,
        );
        assert.equal(
          (await allEntries(page)).length,
          0,
          "Native import and autosaved hidden workspace must not silently create a named project",
        );
        await page.reload({ waitUntil: "networkidle" });
        await expect(documentName(page)).toHaveText(
          fixture.expected.document.name,
        );
        assert.equal(
          await page.locator(".app-header .save-label").getAttribute("title"),
          null,
        );
        assertResources(
          await inspectProject(page, { workspace: true }),
          fixture,
        );
        assertResources(
          await downloadProject(
            page,
            `recovered-unlinked-${extension.slice(1)}`,
          ),
          fixture,
        );
        restored.push({
          extension,
          resourceNames: fixture.expected.resources.map(([name]) => name),
        });
        latest = fixture;
      }
      await page.keyboard.press("Control+Shift+s");
      const manager = page.getByTestId("file-manager");
      await expect(manager).toBeVisible();
      await idle(manager);
      await manager
        .getByRole("textbox", { name: "项目文件名", exact: true })
        .fill("恢复后的完整项目");
      await button(manager, "保存").click();
      // Named save keeps the sidebar open and returns to browse mode.
      await expect(manager).toBeVisible();
      await expect(manager).toHaveAttribute("data-mode", "browse");
      await idle(manager);
      const files = await allEntries(page);
      assert.equal(files.length, 1);
      assert.equal(files[0].name, "恢复后的完整项目.swcad");
      assertResources(
        await inspectProject(page, { fileId: files[0].id }),
        latest,
      );
      await waitForWorkspace(page, latest.expected.document.name, files[0].id);
      assertResources(
        await downloadProject(page, "recovered-named-full-project"),
        latest,
      );
      const browser = await openManager(page);
      await expect(activeTag(browser, files[0].name)).toBeVisible();
      await fileRow(browser, files[0].name).click();
      await expect(
        browser.getByRole("img", { name: "恢复参考图.png" }),
      ).toBeVisible();
      await browser.screenshot({
        path: path.join(output, "recovered-full-resources.png"),
      });
      return { restored, savedId: files[0].id };
    },
  },
  {
    id: "startup-guard",
    name: "cleared localStorage restores full IndexedDB project and rapid NewDoc cannot overwrite startup recovery",
    run: async (page) => {
      const a = await baseline(page, { resources: true });
      const before = await inspectProject(page, { workspace: true });
      assertResources(before, a.fixture);
      const entryPattern = /\/src\/main\.tsx(?:\?.*)?$/;
      // Inject only a controlled singleton method gate before the original entry mounts React.
      // App, Hook, codec and storage source files remain unchanged; all UI actions below are native.
      const prefix = `
const __recoveryVfs = (await import('/src/virtualFileSystem.ts')).virtualFiles;
const __recoveryRead = __recoveryVfs.readWorkspace;
const __recoveryWrite = __recoveryVfs.writeWorkspace;
let __recoveryRelease;
const __recoveryWait = new Promise(resolve => { __recoveryRelease = resolve; });
const __recoveryGate = { entered: false, writes: 0, released: false,
  readDisk: () => __recoveryRead.call(__recoveryVfs),
  release: () => { __recoveryGate.released = true; __recoveryRelease(); },
  restore: () => { __recoveryGate.release(); __recoveryVfs.readWorkspace = __recoveryRead; __recoveryVfs.writeWorkspace = __recoveryWrite; }
};
__recoveryVfs.readWorkspace = async (...args) => {
  const snapshot = await __recoveryRead.apply(__recoveryVfs, args);
  __recoveryGate.entered = true;
  await __recoveryWait;
  return snapshot;
};
__recoveryVfs.writeWorkspace = async (...args) => {
  __recoveryGate.writes++;
  return __recoveryWrite.apply(__recoveryVfs, args);
};
window.__workspaceBootGate = __recoveryGate;
`;
      await page.route(entryPattern, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: prefix + (await response.text()),
        });
      });
      try {
        await page.evaluate(
          ({ documentKey, timeKey }) => {
            localStorage.removeItem(documentKey);
            localStorage.removeItem(timeKey);
          },
          { documentKey, timeKey },
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__workspaceBootGate?.entered);
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), documentKey),
          null,
          "Reload must begin without a re-seeded legacy document",
        );
        const startupName = await documentName(page).innerText();
        const history = await page.locator(".app").getAttribute("data-history");
        const dialog = await newDocumentDialog(
          page,
          "不应覆盖正在恢复的完整项目",
        );
        await button(dialog, "新建").click();
        await expect(page.locator(".toast.error")).toContainText("正在恢复");
        await expect(dialog).toHaveAttribute("aria-busy", "false");
        await expect(dialog).toBeVisible();
        await expect(documentName(page)).toHaveText(startupName);
        assert.equal(
          await page.locator(".app").getAttribute("data-history"),
          history,
        );
        assert.equal(
          await page.evaluate(() => window.__workspaceBootGate.writes),
          0,
        );
        const disk = await inspectProject(page, { bootDisk: true });
        assert.deepEqual(
          disk.bytes,
          before.bytes,
          "No startup action may replace the full persisted snapshot before restore completes",
        );
        assert.equal(disk.fileId, a.file.id);
        assertResources(disk, a.fixture);
        await button(dialog, "取消").click();
        await page.evaluate(() => window.__workspaceBootGate.release());
        await expect(documentName(page)).toHaveText(
          a.fixture.expected.document.name,
        );
        await expect(page.locator(".app-header .save-label")).toHaveAttribute(
          "title",
          a.file.name,
        );
        assertResources(
          await inspectProject(page, { workspace: true }),
          a.fixture,
        );
        assertResources(
          await downloadProject(page, "startup-restored-full-project"),
          a.fixture,
        );
        assert.equal((await allEntries(page))[0].id, a.file.id);
        return { restoredId: a.file.id, startupName, guardedWrites: 0 };
      } finally {
        await page
          .evaluate(() => window.__workspaceBootGate?.restore?.())
          .catch(() => {});
        await page.unroute(entryPattern);
      }
    },
  },
];

const selectedCases = cases.filter(
  (entry, index) =>
    !requestedCases.length ||
    requestedCases.some(
      (filter) =>
        filter === String(index + 1) ||
        entry.id.toLowerCase().includes(filter) ||
        entry.name.toLowerCase().includes(filter),
    ),
);
assert(
  selectedCases.length,
  `CAD_WORKSPACE_CASE matched no cases: ${requestedCases.join(", ")}`,
);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
try {
  for (const check of selectedCases) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    await context.addInitScript(
      ({ documentKey, seed, origin }) => {
        if (
          location.origin !== origin ||
          sessionStorage.getItem("__workspaceRecoverySeeded")
        )
          return;
        if (!localStorage.getItem(documentKey))
          localStorage.setItem(documentKey, JSON.stringify(seed));
        sessionStorage.setItem("__workspaceRecoverySeeded", "1");
      },
      { documentKey, seed, origin: new URL(url).origin },
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
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      results.pageErrors.push({ case: check.id, error: error.message });
    });
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      // The project toolbar action only enables once workspace storage is ready.
      await expect(
        button(page.locator(".app-header"), "项目管理"),
      ).toBeEnabled();
      await expect(button(page, "直线").first()).toBeEnabled();
      const detail = await check.run(page);
      assert.deepEqual(errors, []);
      results.checks.push({
        id: check.id,
        name: check.name,
        passed: true,
        detail,
      });
      console.log(`PASS ${check.id} ${JSON.stringify(detail || {})}`);
    } catch (error) {
      results.checks.push({
        id: check.id,
        name: check.name,
        passed: false,
        error: error.stack || String(error),
      });
      await page
        .screenshot({
          path: path.join(output, `failure-${check.id}.png`),
          fullPage: true,
        })
        .catch(() => {});
      throw error;
    } finally {
      await restorePatch(page);
      await page
        .evaluate(() => window.__workspaceWriteGate?.restore?.())
        .catch(() => {});
      await page
        .evaluate(() => window.__workspaceBootGate?.restore?.())
        .catch(() => {});
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
