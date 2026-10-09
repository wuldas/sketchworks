// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB, openDB, type IDBPDatabase } from "idb";
import {
  MAX_FILE_SIZE,
  ROOT_ID,
  VirtualFileError,
  VirtualFileStore,
} from "./virtualFileSystem";

let databaseName: string;
let store: VirtualFileStore;
let stores: VirtualFileStore[];

function anotherStore(): VirtualFileStore {
  const next = new VirtualFileStore(databaseName);
  stores.push(next);
  return next;
}

async function inspect<T>(
  action: (db: IDBPDatabase) => Promise<T>,
): Promise<T> {
  const db = await openDB(databaseName);
  try {
    return await action(db);
  } finally {
    db.close();
  }
}

function binary(contents = [0, 4, 0, 0, 0, 255, 128, 13, 10, 0]): Blob {
  return new Blob([new Uint8Array(contents)], { type: "application/x-asar" });
}

async function bytes(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

beforeEach(() => {
  databaseName = `test.sketchworks.vfs.${crypto.randomUUID()}`;
  stores = [];
  store = anotherStore();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(stores.map((instance) => instance.close()));
  // Only unique databases created by this test are ever deleted.
  await deleteDB(databaseName);
});

describe("persistent virtual filesystem", () => {
  it("has a synthetic root and separate indexed metadata, contents, and workspace stores", async () => {
    expect(await store.get(ROOT_ID)).toEqual({
      id: ROOT_ID,
      parentId: null,
      kind: "folder",
      name: "我的文件",
      createdAt: 0,
      updatedAt: 0,
      size: 0,
    });
    expect(await store.path(ROOT_ID)).toEqual([await store.get(ROOT_ID)]);
    expect(await store.list()).toEqual([]);
    expect(await store.allEntries()).toEqual([]);
    const folder = await store.createFolder(ROOT_ID, "项目");
    await inspect(async (db) => {
      expect(Array.from(db.objectStoreNames)).toEqual([
        "contents",
        "entries",
        "workspace",
      ]);
      expect(await db.get("entries", ROOT_ID)).toBeUndefined();
      expect(await db.get("entries", folder.id)).toEqual(folder);
      expect(await db.getAllFromIndex("entries", "parentId", ROOT_ID)).toEqual([
        folder,
      ]);
      expect(await db.count("contents")).toBe(0);
    });
  });

  it("persists generic binary Blobs, metadata, folders, and breadcrumbs across new instances", async () => {
    const project = await store.createFolder(ROOT_ID, "项目");
    const nested = await store.createFolder(project.id, "素材");
    const payload = binary();
    const file = await store.createFile(nested.id, "drawing.asar", payload);
    const arbitrary = await store.createFile(
      project.id,
      "arbitrary.data",
      new Blob([new Uint8Array([255, 0, 128])]),
    );
    expect(file).toMatchObject({
      parentId: nested.id,
      kind: "file",
      size: payload.size,
      mimeType: payload.type,
    });
    await store.close();
    const reopened = anotherStore();
    expect(await reopened.get(file.id)).toEqual(file);
    expect(await reopened.list(nested.id)).toEqual([file]);
    expect((await reopened.path(nested.id)).map((entry) => entry.id)).toEqual([
      ROOT_ID,
      project.id,
      nested.id,
    ]);
    const restored = await reopened.readFile(file.id);
    expect(restored).not.toBe(payload);
    expect(restored.type).toBe(payload.type);
    expect(await bytes(restored)).toEqual(await bytes(payload));
    expect(await bytes(await reopened.readFile(arbitrary.id))).toEqual([
      255, 0, 128,
    ]);
  });

  it("sorts folders before files and sorts names consistently", async () => {
    await store.createFile(ROOT_ID, "z.asar", binary());
    await store.createFolder(ROOT_ID, "Folder 10");
    await store.createFile(ROOT_ID, "a.asar", binary());
    await store.createFolder(ROOT_ID, "Folder 2");
    const names = ["Folder 2", "Folder 10", "a.asar", "z.asar"];
    expect((await store.list()).map((entry) => entry.name)).toEqual(names);
    expect((await store.list()).map((entry) => entry.name)).toEqual(names);
  });

  it("lists and gets metadata without fetching any Blob payload", async () => {
    const folder = await store.createFolder(ROOT_ID, "Folder");
    const file = await store.createFile(folder.id, "file.asar", binary());
    const originalGet = IDBObjectStore.prototype.get;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange,
    ) {
      if (this.name === "contents" || this.name === "workspace")
        throw new Error("metadata must not read payload stores");
      return originalGet.call(this, key);
    });
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
      this: IDBObjectStore,
      query?: IDBValidKey | IDBKeyRange | null,
      count?: number,
    ) {
      if (this.name === "contents" || this.name === "workspace")
        throw new Error("metadata must not read payload stores");
      return originalGetAll.call(this, query, count);
    });
    expect(await store.list(folder.id)).toEqual([file]);
    expect(await store.get(file.id)).toEqual(file);
    expect(await store.allEntries()).toHaveLength(2);
    expect((await store.path(folder.id)).map((entry) => entry.id)).toEqual([
      ROOT_ID,
      folder.id,
    ]);
    const listed = await store.list(folder.id);
    listed[0].name = "mutated";
    expect((await store.get(file.id))?.name).toBe("file.asar");
  });

  it("updates only existing files and keeps update timestamps monotonic when the clock moves back", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const folder = await store.createFolder(ROOT_ID, "Folder");
    const original = await store.createFile(ROOT_ID, "original.asar", binary());
    vi.mocked(Date.now).mockReturnValue(900);
    const updated = await store.updateFile(original.id, new Blob(["new"]));
    expect(updated.id).toBe(original.id);
    expect(updated.createdAt).toBe(1000);
    expect(updated.updatedAt).toBe(1001);
    expect(updated.size).toBe(3);
    expect(updated.mimeType).toBeUndefined();
    expect(await (await store.readFile(original.id)).text()).toBe("new");
    const renamed = await store.rename(original.id, "renamed.asar");
    expect(renamed.updatedAt).toBe(1002);
    const moved = await store.move(original.id, folder.id);
    expect(moved.updatedAt).toBe(1003);
    expect(moved.createdAt).toBe(1000);
    expect(moved.parentId).toBe(folder.id);
    expect(await store.list()).toEqual([folder]);
    expect(await store.list(folder.id)).toEqual([moved]);
  });

  it("normalizes trimmed NFC names and enforces case-insensitive uniqueness across files and folders", async () => {
    const file = await store.createFile(
      ROOT_ID,
      "  Cafe\u0301.asar  ",
      binary(),
    );
    expect(file.name).toBe("Café.asar");
    await expect(
      store.createFolder(ROOT_ID, "CAFÉ.ASAR"),
    ).rejects.toMatchObject({
      code: "NAME_EXISTS",
    });
    await expect(
      store.createFile(ROOT_ID, "cafe\u0301.asar", binary()),
    ).rejects.toMatchObject({ code: "NAME_EXISTS" });
    const renamed = await store.rename(file.id, "CAFÉ.ASAR");
    expect(renamed.name).toBe("CAFÉ.ASAR");
    expect((await store.rename(file.id, "  CAFÉ.ASAR  ")).id).toBe(file.id);
    const folder = await store.createFolder(ROOT_ID, "Destination");
    await store.createFile(folder.id, "café.asar", binary());
    await expect(store.move(file.id, folder.id)).rejects.toMatchObject({
      code: "NAME_EXISTS",
    });
    await expect(store.copy(file.id, folder.id)).rejects.toMatchObject({
      code: "NAME_EXISTS",
    });
    await expect(store.rename(folder.id, "café.asar")).rejects.toMatchObject({
      code: "NAME_EXISTS",
    });
    expect((await store.get(file.id))?.parentId).toBe(ROOT_ID);
  });

  it.each([
    "",
    "   ",
    ".",
    " .. ",
    "a/b",
    "a\\b",
    "a\u0000b",
    "a\nb",
    "\tname",
    "a\u007fb",
    "a\u0085b",
    "x".repeat(181),
  ])("rejects invalid name %j without writing anything", async (name) => {
    await expect(store.createFolder(ROOT_ID, name)).rejects.toMatchObject({
      code: "INVALID_NAME",
    });
    await expect(
      store.createFile(ROOT_ID, name, binary()),
    ).rejects.toMatchObject({
      code: "INVALID_NAME",
    });
    expect(await store.allEntries()).toEqual([]);
    expect(await inspect((db) => db.count("contents"))).toBe(0);
  });

  it("accepts the 180-character name boundary without changing extensions", async () => {
    const name = `${"界".repeat(175)}.asar`;
    expect((await store.createFile(ROOT_ID, name, binary())).name).toBe(name);
    const folder = await store.createFolder(ROOT_ID, "😀".repeat(180));
    expect(Array.from(folder.name)).toHaveLength(180);
  });

  it("serializes concurrent name creation across separate connections", async () => {
    const other = anotherStore();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        index % 2
          ? other.createFolder(ROOT_ID, "CONCURRENT.asar")
          : store.createFile(ROOT_ID, "concurrent.asar", binary([index])),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "NAME_EXISTS" });
    }
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    await inspect(async (db) => {
      expect(await db.count("entries")).toBe(1);
      expect(await db.count("contents")).toBe(
        entries[0].kind === "file" ? 1 : 0,
      );
    });
  });

  it("rejects missing parents, file destinations, stale ids, and protected root operations", async () => {
    const folder = await store.createFolder(ROOT_ID, "Folder");
    const file = await store.createFile(ROOT_ID, "file.asar", binary());
    for (const parentId of ["missing", file.id]) {
      const code = parentId === file.id ? "NOT_FOLDER" : "NOT_FOUND";
      for (const action of [
        () => store.list(parentId),
        () => store.path(parentId),
        () => store.createFolder(parentId, "child"),
        () => store.createFile(parentId, "child.asar", binary()),
        () => store.move(folder.id, parentId),
        () => store.copy(folder.id, parentId, "copy"),
      ])
        await expect(action()).rejects.toMatchObject({ code });
    }
    for (const action of [
      () => store.readFile("missing"),
      () => store.updateFile("missing", binary()),
      () => store.rename("missing", "new"),
      () => store.move("missing", folder.id),
      () => store.copy("missing", folder.id),
      () => store.remove("missing"),
    ])
      await expect(action()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await store.get("missing")).toBeUndefined();
    for (const action of [
      () => store.rename(ROOT_ID, "new"),
      () => store.move(ROOT_ID, folder.id),
      () => store.copy(ROOT_ID, folder.id),
      () => store.remove(ROOT_ID),
    ])
      await expect(action()).rejects.toMatchObject({ code: "ROOT_PROTECTED" });
    await expect(store.readFile(folder.id)).rejects.toMatchObject({
      code: "NOT_FILE",
    });
    await expect(store.updateFile(folder.id, binary())).rejects.toMatchObject({
      code: "NOT_FILE",
    });
    expect(await store.allEntries()).toHaveLength(2);
  });

  it("prevents moving or copying folders into themselves or any descendant", async () => {
    const top = await store.createFolder(ROOT_ID, "Top");
    const child = await store.createFolder(top.id, "Child");
    const deep = await store.createFolder(child.id, "Deep");
    for (const destination of [top.id, child.id, deep.id]) {
      await expect(store.move(top.id, destination)).rejects.toMatchObject({
        code: "CYCLE",
      });
      await expect(
        store.copy(top.id, destination, "Copy"),
      ).rejects.toMatchObject({
        code: "CYCLE",
      });
    }
    expect((await store.path(deep.id)).map((entry) => entry.id)).toEqual([
      ROOT_ID,
      top.id,
      child.id,
      deep.id,
    ]);
    expect((await store.move(child.id, top.id)).id).toBe(child.id);
    expect(await store.allEntries()).toHaveLength(3);
  });

  it("copies file bytes independently and supports explicit names with the default parent", async () => {
    const destination = await store.createFolder(ROOT_ID, "Destination");
    const file = await store.createFile(ROOT_ID, "file.asar", binary());
    await expect(store.copy(file.id)).rejects.toMatchObject({
      code: "NAME_EXISTS",
    });
    const copy = await store.copy(file.id, destination.id);
    const named = await store.copy(file.id, undefined, "other.asar");
    expect(copy.id).not.toBe(file.id);
    expect(copy.name).toBe(file.name);
    expect(named.parentId).toBe(ROOT_ID);
    expect(named.name).toBe("other.asar");
    await store.updateFile(file.id, binary([99]));
    await store.remove(file.id);
    expect(await bytes(await store.readFile(copy.id))).toEqual(
      await bytes(binary()),
    );
    expect(await bytes(await store.readFile(named.id))).toEqual(
      await bytes(binary()),
    );
  });

  it("recursively copies folders and resources under new ids without mutating the source", async () => {
    const source = await store.createFolder(ROOT_ID, "Project");
    const resources = await store.createFolder(source.id, "resources");
    const images = await store.createFolder(resources.id, "images");
    const image = await store.createFile(
      images.id,
      "image.bin",
      new Blob([new Uint8Array([0, 255, 0, 128])], { type: "image/png" }),
    );
    const projectFile = await store.createFile(
      source.id,
      "model.asar",
      binary(),
    );
    const destination = await store.createFolder(ROOT_ID, "Copies");
    const copy = await store.copy(source.id, destination.id, "Project copy");
    const copyChildren = await store.list(copy.id);
    const copiedResources = copyChildren.find(
      (entry) => entry.kind === "folder",
    )!;
    const copiedProject = copyChildren.find((entry) => entry.kind === "file")!;
    const copiedImages = (await store.list(copiedResources.id))[0];
    const copiedImage = (await store.list(copiedImages.id))[0];
    expect(copy.id).not.toBe(source.id);
    expect(copiedResources.id).not.toBe(resources.id);
    expect(copiedImages.id).not.toBe(images.id);
    expect(copiedImage.id).not.toBe(image.id);
    expect(copiedProject.id).not.toBe(projectFile.id);
    expect(await bytes(await store.readFile(copiedImage.id))).toEqual([
      0, 255, 0, 128,
    ]);
    expect((await store.readFile(copiedImage.id)).type).toBe("image/png");
    expect(await bytes(await store.readFile(copiedProject.id))).toEqual(
      await bytes(binary()),
    );
    expect(await store.get(source.id)).toEqual(source);
    await store.remove(source.id);
    expect(await store.list(copy.id)).toHaveLength(2);
    expect(await bytes(await store.readFile(copiedImage.id))).toEqual([
      0, 255, 0, 128,
    ]);
  });

  it("recursively deletes metadata and payloads, preserves siblings, and never resurrects deleted files", async () => {
    const top = await store.createFolder(ROOT_ID, "Top");
    const child = await store.createFolder(top.id, "Child");
    const file = await store.createFile(child.id, "child.asar", binary());
    const direct = await store.createFile(top.id, "direct.asar", binary());
    const kept = await store.createFile(ROOT_ID, "kept.asar", binary([42]));
    await store.remove(top.id);
    expect(await store.allEntries()).toEqual([kept]);
    for (const id of [top.id, child.id, file.id, direct.id])
      expect(await store.get(id)).toBeUndefined();
    await expect(store.updateFile(file.id, binary([1]))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      store.createFile(child.id, "stale.asar", binary()),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await inspect(async (db) => {
      expect(await db.count("entries")).toBe(1);
      expect(await db.count("contents")).toBe(1);
      expect(await db.get("contents", file.id)).toBeUndefined();
    });
    expect(await bytes(await store.readFile(kept.id))).toEqual([42]);
  });

  it("serializes deletion and a concurrent stale update without recreating metadata or contents", async () => {
    const file = await store.createFile(ROOT_ID, "file.asar", binary());
    const other = anotherStore();
    await other.list();
    const removed = store.remove(file.id);
    const update = other.updateFile(file.id, binary([7]));
    const results = await Promise.allSettled([removed, update]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_FOUND" },
    });
    expect(await store.allEntries()).toEqual([]);
    expect(await inspect((db) => db.count("contents"))).toBe(0);
  });
});

describe("transaction failure and storage integrity", () => {
  it("rejects a late transaction abort even after the final payload request succeeds", async () => {
    await store.list();
    const originalAdd = IDBObjectStore.prototype.add;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request = originalAdd.call(this, value, key);
        if (this.name === "contents")
          request.addEventListener("success", () => this.transaction.abort(), {
            once: true,
          });
        return request;
      });
    await expect(
      store.createFile(ROOT_ID, "aborted.asar", binary()),
    ).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    spy.mockRestore();
    expect(await store.allEntries()).toEqual([]);
    expect(await inspect((db) => db.count("contents"))).toBe(0);
  });

  it("rolls metadata creation back if the contents write fails with a quota error", async () => {
    await store.list();
    const originalAdd = IDBObjectStore.prototype.add;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (this.name === "contents")
          throw new DOMException("simulated quota", "QuotaExceededError");
        return originalAdd.call(this, value, key);
      });
    await expect(
      store.createFile(ROOT_ID, "file.asar", binary()),
    ).rejects.toMatchObject({
      code: "STORAGE_QUOTA",
      message: expect.stringContaining("空间不足"),
    });
    spy.mockRestore();
    expect(await store.allEntries()).toEqual([]);
    expect(await inspect((db) => db.count("contents"))).toBe(0);
    expect(
      await store.createFile(ROOT_ID, "file.asar", binary()),
    ).toMatchObject({
      kind: "file",
    });
  });

  it("preserves previous metadata and bytes when updating contents aborts the transaction", async () => {
    const file = await store.createFile(ROOT_ID, "file.asar", binary());
    const originalPut = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (this.name === "contents")
          throw new DOMException("simulated quota", "QuotaExceededError");
        return originalPut.call(this, value, key);
      });
    await expect(
      store.updateFile(file.id, binary([8, 9])),
    ).rejects.toMatchObject({
      code: "STORAGE_QUOTA",
    });
    spy.mockRestore();
    expect(await store.get(file.id)).toEqual(file);
    expect(await bytes(await store.readFile(file.id))).toEqual(
      await bytes(binary()),
    );
  });

  it("rolls recursive deletion back if any contents delete fails", async () => {
    const folder = await store.createFolder(ROOT_ID, "Folder");
    const first = await store.createFile(folder.id, "a.asar", binary([1]));
    const second = await store.createFile(folder.id, "b.asar", binary([2]));
    const originalDelete = IDBObjectStore.prototype.delete;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "delete")
      .mockImplementation(function (
        this: IDBObjectStore,
        key: IDBValidKey | IDBKeyRange,
      ) {
        if (this.name === "contents" && key === second.id)
          throw new DOMException("simulated abort", "AbortError");
        return originalDelete.call(this, key);
      });
    await expect(store.remove(folder.id)).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    spy.mockRestore();
    expect(await store.get(folder.id)).toEqual(folder);
    expect(await store.list(folder.id)).toEqual([first, second]);
    expect(await bytes(await store.readFile(first.id))).toEqual([1]);
    expect(await bytes(await store.readFile(second.id))).toEqual([2]);
  });

  it("rolls a partial recursive copy back if a later resource is missing", async () => {
    const folder = await store.createFolder(ROOT_ID, "Folder");
    const first = await store.createFile(folder.id, "a.asar", binary([1]));
    const broken = await store.createFile(folder.id, "z.asar", binary([2]));
    await inspect((db) => db.delete("contents", broken.id));
    const originalEntries = await store.allEntries();
    await expect(store.copy(folder.id, ROOT_ID, "Copy")).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    expect(await store.allEntries()).toEqual(originalEntries);
    await inspect(async (db) => {
      expect(await db.count("contents")).toBe(1);
      expect(await db.get("contents", broken.id)).toBeUndefined();
    });
    expect(await bytes(await store.readFile(first.id))).toEqual([1]);
    await expect(
      store.updateFile(broken.id, binary([3])),
    ).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    expect(
      await inspect((db) => db.get("contents", broken.id)),
    ).toBeUndefined();
  });

  it("rejects files over 100 MiB and preserves existing files and workspace snapshots", async () => {
    const file = await store.createFile(ROOT_ID, "file.asar", binary());
    await store.writeWorkspace({
      contents: binary([5]),
      fileId: file.id,
      updatedAt: 10,
    });
    const tooLarge = new Blob([new Uint8Array(MAX_FILE_SIZE + 1)]);
    await expect(
      store.createFile(ROOT_ID, "large.asar", tooLarge),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await expect(store.updateFile(file.id, tooLarge)).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await expect(
      store.writeWorkspace({ contents: tooLarge, fileId: null, updatedAt: 11 }),
    ).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    expect(await store.get(file.id)).toEqual(file);
    expect(await bytes(await store.readFile(file.id))).toEqual(
      await bytes(binary()),
    );
    const workspace = (await store.readWorkspace())!;
    expect(workspace.fileId).toBe(file.id);
    expect(workspace.updatedAt).toBe(10);
    expect(await bytes(workspace.contents)).toEqual([5]);
    expect(await store.allEntries()).toEqual([file]);
  });

  it("rejects non-Blob contents without inserting or replacing data", async () => {
    const file = await store.createFile(ROOT_ID, "file.asar", binary());
    await expect(
      store.createFile(ROOT_ID, "bad.asar", {} as Blob),
    ).rejects.toMatchObject({
      code: "INVALID_CONTENTS",
    });
    await expect(
      store.updateFile(file.id, "text" as unknown as Blob),
    ).rejects.toMatchObject({
      code: "INVALID_CONTENTS",
    });
    expect(await store.get(file.id)).toEqual(file);
    expect(await bytes(await store.readFile(file.id))).toEqual(
      await bytes(binary()),
    );
  });

  it("rejects malformed schemas without clearing existing data", async () => {
    const legacy = await openDB(databaseName, 1, {
      upgrade(db) {
        db.createObjectStore("entries", { keyPath: "wrongId" });
        db.createObjectStore("contents", { keyPath: "id" });
        db.createObjectStore("workspace");
      },
    });
    try {
      await legacy.add("entries", { wrongId: "legacy", marker: "preserve me" });
      await expect(store.list()).rejects.toMatchObject({
        code: "CORRUPT_DATA",
      });
      expect(await legacy.get("entries", "legacy")).toEqual({
        wrongId: "legacy",
        marker: "preserve me",
      });
    } finally {
      legacy.close();
    }
  });

  it("rejects malformed records, missing parents, and damaged contents without repairs", async () => {
    const folder = await store.createFolder(ROOT_ID, "Folder");
    const file = await store.createFile(folder.id, "file.asar", binary());
    await inspect((db) => db.put("entries", { ...file, size: -1 }));
    await expect(store.list(folder.id)).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    await expect(store.get(file.id)).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    await expect(store.rename(file.id, "new.asar")).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    expect((await inspect((db) => db.get("entries", file.id))).size).toBe(-1);
    await inspect((db) => db.put("entries", { ...file, parentId: "missing" }));
    await expect(store.allEntries()).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    await inspect((db) => db.put("entries", file));
    await inspect((db) => db.put("contents", { id: file.id, blob: "broken" }));
    await expect(store.readFile(file.id)).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    await expect(store.updateFile(file.id, binary())).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    expect(await inspect((db) => db.get("contents", file.id))).toEqual({
      id: file.id,
      blob: "broken",
    });
  });

  it("rejects malformed persisted cycles rather than hanging", async () => {
    const top = await store.createFolder(ROOT_ID, "Top");
    const child = await store.createFolder(top.id, "Child");
    await inspect((db) => db.put("entries", { ...top, parentId: child.id }));
    await expect(store.path(child.id)).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    await expect(store.allEntries()).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    expect((await inspect((db) => db.get("entries", top.id))).parentId).toBe(
      child.id,
    );
  });

  it("reports unavailable IndexedDB instead of falling back to temporary memory", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(store.list()).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      message: expect.stringContaining("IndexedDB"),
    });
    await expect(store.createFolder(ROOT_ID, "lost")).rejects.toBeInstanceOf(
      VirtualFileError,
    );
    vi.unstubAllGlobals();
  });

  it("closes on versionchange so another connection can upgrade without being blocked", async () => {
    const file = await store.createFile(ROOT_ID, "file.asar", binary());
    const upgraded = await openDB(databaseName, 2);
    try {
      expect(await upgraded.get("entries", file.id)).toEqual(file);
      await expect(store.list()).rejects.toMatchObject({
        code: "STORAGE_CHANGED",
      });
      await expect(anotherStore().list()).rejects.toMatchObject({
        code: "STORAGE_CHANGED",
      });
    } finally {
      upgraded.close();
    }
  });

  it("rejects queued opens after timeout, closes late connections, and permits retry", async () => {
    await store.list();
    await store.close();
    const held = await openDB(databaseName);
    let notifyBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve;
    });
    const deletion = deleteDB(databaseName, { blocked: notifyBlocked });
    await blocked;
    const pendingStore = anotherStore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = pendingStore.list();
      const rejected = expect(pending).rejects.toMatchObject({
        code: "STORAGE_BLOCKED",
      });
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
    } finally {
      vi.useRealTimers();
      held.close();
      await deletion;
    }
    expect(await pendingStore.list()).toEqual([]);
  });

  it("can close during a blocked open without awaiting the blocking connection", async () => {
    await store.list();
    await store.close();
    const held = await openDB(databaseName);
    let notifyBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve;
    });
    const deletion = deleteDB(databaseName, { blocked: notifyBlocked });
    await blocked;
    const pendingStore = anotherStore();
    try {
      const pending = pendingStore.list();
      const rejected = expect(pending).rejects.toMatchObject({
        code: "CLOSED",
      });
      await pendingStore.close();
      await rejected;
    } finally {
      held.close();
      await deletion;
      const drained = await openDB(databaseName);
      drained.close();
    }
  });

  it("makes close terminal for one instance while allowing a new instance to reopen", async () => {
    await store.createFolder(ROOT_ID, "Folder");
    await store.close();
    await store.close();
    await expect(store.list()).rejects.toMatchObject({ code: "CLOSED" });
    expect(await anotherStore().list()).toHaveLength(1);
  });
});

describe("hidden persistent workspace snapshots", () => {
  it("surfaces quota failures without replacing the previous workspace Blob", async () => {
    await store.writeWorkspace({
      contents: binary([6]),
      fileId: null,
      updatedAt: 10,
    });
    const originalPut = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (this.name === "workspace")
          throw new DOMException("simulated quota", "QuotaExceededError");
        return originalPut.call(this, value, key);
      });
    await expect(
      store.writeWorkspace({
        contents: binary([9]),
        fileId: null,
        updatedAt: 11,
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_QUOTA",
    });
    spy.mockRestore();
    const restored = (await store.readWorkspace())!;
    expect(restored.updatedAt).toBe(10);
    expect(await bytes(restored.contents)).toEqual([6]);
    expect(await store.allEntries()).toEqual([]);
  });

  it("restores complete raw Blob bytes and the associated file id across reopen without tree entries", async () => {
    expect(await store.readWorkspace()).toBeUndefined();
    const file = await store.createFile(ROOT_ID, "project.asar", binary([1]));
    const snapshot = binary([4, 0, 0, 0, 255, 0, 128, 10]);
    await store.writeWorkspace({
      contents: snapshot,
      fileId: file.id,
      updatedAt: 100,
    });
    await store.close();
    const reopened = anotherStore();
    const restored = (await reopened.readWorkspace())!;
    expect(restored.fileId).toBe(file.id);
    expect(restored.updatedAt).toBe(100);
    expect(restored.contents.type).toBe(snapshot.type);
    expect(await bytes(restored.contents)).toEqual(await bytes(snapshot));
    expect(await reopened.list()).toEqual([file]);
    expect(await reopened.allEntries()).toEqual([file]);
    await inspect(async (db) => {
      expect(await db.count("entries")).toBe(1);
      expect(await db.count("contents")).toBe(1);
      expect(await db.count("workspace")).toBe(1);
      expect((await db.get("workspace", "current")).fileId).toBe(file.id);
    });
  });

  it("supports unsaved nullable associations and monotonically updated snapshots", async () => {
    await store.writeWorkspace({
      contents: binary([1]),
      fileId: null,
      updatedAt: 100,
    });
    await store.writeWorkspace({
      contents: binary([2]),
      fileId: null,
      updatedAt: 90,
    });
    const restored = (await store.readWorkspace())!;
    expect(restored.fileId).toBeNull();
    expect(restored.updatedAt).toBe(101);
    expect(await bytes(restored.contents)).toEqual([2]);
    expect(await store.allEntries()).toEqual([]);
  });

  it("preserves a stale association after deletion without recreating a file", async () => {
    const file = await store.createFile(ROOT_ID, "project.asar", binary([1]));
    await store.writeWorkspace({
      contents: binary([9]),
      fileId: file.id,
      updatedAt: 1,
    });
    await store.remove(file.id);
    expect((await store.readWorkspace())?.fileId).toBe(file.id);
    await store.writeWorkspace({
      contents: binary([8]),
      fileId: file.id,
      updatedAt: 2,
    });
    expect(await store.get(file.id)).toBeUndefined();
    expect(await store.allEntries()).toEqual([]);
    await expect(store.updateFile(file.id, binary([3]))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects invalid snapshot metadata while preserving the previous snapshot", async () => {
    await store.writeWorkspace({
      contents: binary([7]),
      fileId: null,
      updatedAt: 10,
    });
    for (const changes of [
      { fileId: ROOT_ID },
      { fileId: "" },
      { fileId: undefined },
      { updatedAt: -1 },
      { updatedAt: NaN },
    ])
      await expect(
        store.writeWorkspace({
          contents: binary([8]),
          fileId: null,
          updatedAt: 11,
          ...changes,
        } as Parameters<VirtualFileStore["writeWorkspace"]>[0]),
      ).rejects.toMatchObject({ code: "INVALID_WORKSPACE" });
    const restored = (await store.readWorkspace())!;
    expect(restored.updatedAt).toBe(10);
    expect(await bytes(restored.contents)).toEqual([7]);
  });

  it("does not overwrite malformed persisted workspace snapshots", async () => {
    await store.list();
    await inspect((db) =>
      db.put(
        "workspace",
        { contents: "broken", fileId: null, updatedAt: 10 },
        "current",
      ),
    );
    await expect(store.readWorkspace()).rejects.toMatchObject({
      code: "CORRUPT_DATA",
    });
    await expect(
      store.writeWorkspace({
        contents: binary([8]),
        fileId: null,
        updatedAt: 11,
      }),
    ).rejects.toMatchObject({ code: "CORRUPT_DATA" });
    expect(
      (await inspect((db) => db.get("workspace", "current"))).contents,
    ).toBe("broken");
  });
});
