import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
  type IDBPTransaction,
} from "idb";

export const ROOT_ID = "root";
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

export interface VfsEntry {
  id: string;
  parentId: string | null;
  kind: "folder" | "file";
  name: string;
  createdAt: number;
  updatedAt: number;
  size: number;
  mimeType?: string;
}

export interface VfsFileEntry extends VfsEntry {
  kind: "file";
}

export interface VfsFolderEntry extends VfsEntry {
  kind: "folder";
}

export interface VfsWorkspace {
  contents: Blob;
  fileId: string | null;
  updatedAt: number;
}

export type VirtualFileErrorCode =
  | "INVALID_NAME"
  | "NAME_EXISTS"
  | "NOT_FOUND"
  | "NOT_FOLDER"
  | "NOT_FILE"
  | "ROOT_PROTECTED"
  | "CYCLE"
  | "INVALID_CONTENTS"
  | "INVALID_WORKSPACE"
  | "FILE_TOO_LARGE"
  | "CORRUPT_DATA"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_BLOCKED"
  | "STORAGE_CHANGED"
  | "STORAGE_QUOTA"
  | "STORAGE_ERROR"
  | "CLOSED";

export class VirtualFileError extends Error {
  readonly code: VirtualFileErrorCode;

  constructor(code: VirtualFileErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VirtualFileError";
    this.code = code;
  }
}

interface VfsSchema extends DBSchema {
  entries: {
    key: string;
    value: VfsEntry;
    indexes: { parentId: string };
  };
  contents: {
    key: string;
    value: { id: string; blob: Blob };
  };
  workspace: {
    key: string;
    value: VfsWorkspace;
  };
}

type StoreName = "entries" | "contents" | "workspace";
type Transaction<Mode extends IDBTransactionMode> = IDBPTransaction<
  VfsSchema,
  StoreName[],
  Mode
>;
type EntryStore = IDBPObjectStore<
  VfsSchema,
  StoreName[],
  "entries",
  "readonly" | "readwrite"
>;

const forbiddenNameCharacters = /[\\/\u0000-\u001f\u007f-\u009f]/u;
const nameOrder = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

function rootEntry(): VfsFolderEntry {
  return {
    id: ROOT_ID,
    parentId: null,
    kind: "folder",
    name: "我的文件",
    createdAt: 0,
    updatedAt: 0,
    size: 0,
  };
}

function normalizeName(name: string): string {
  if (typeof name !== "string")
    throw new VirtualFileError("INVALID_NAME", "请输入有效的文件或文件夹名称");
  const normalized = name.trim().normalize("NFC");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    forbiddenNameCharacters.test(name) ||
    Array.from(normalized).length > 180
  )
    throw new VirtualFileError(
      "INVALID_NAME",
      "名称不能为空、不能为 . 或 ..，不能包含斜杠或控制字符，且最多为 180 个字符",
    );
  return normalized;
}

function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase().normalize("NFC");
}

function sortEntries(entries: VfsEntry[]): VfsEntry[] {
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return (
      nameOrder.compare(a.name, b.name) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  });
}

function corrupt(message = "本地文件数据损坏，无法完成操作"): VirtualFileError {
  return new VirtualFileError("CORRUPT_DATA", message);
}

/** Validate persisted records without repairing or overwriting malformed data. */
function metadata(value: unknown): VfsEntry {
  if (!value || typeof value !== "object") throw corrupt();
  const entry = value as VfsEntry;
  if (
    typeof entry.id !== "string" ||
    !entry.id ||
    entry.id === ROOT_ID ||
    typeof entry.parentId !== "string" ||
    !entry.parentId ||
    (entry.kind !== "folder" && entry.kind !== "file") ||
    typeof entry.name !== "string" ||
    !Number.isSafeInteger(entry.createdAt) ||
    entry.createdAt < 0 ||
    !Number.isSafeInteger(entry.updatedAt) ||
    entry.updatedAt < entry.createdAt ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.size > MAX_FILE_SIZE ||
    (entry.kind === "folder" && entry.size !== 0) ||
    (entry.mimeType !== undefined && typeof entry.mimeType !== "string")
  )
    throw corrupt();
  try {
    if (normalizeName(entry.name) !== entry.name) throw corrupt();
  } catch {
    throw corrupt("本地文件名称数据损坏，无法完成操作");
  }
  // Return only metadata, even if an external writer added other record fields.
  return {
    id: entry.id,
    parentId: entry.parentId,
    kind: entry.kind,
    name: entry.name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    size: entry.size,
    ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
  };
}

function validateSiblingNames(entries: VfsEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    const key = nameKey(entry.name);
    if (names.has(key)) throw corrupt("本地文件包含重复名称，无法完成操作");
    names.add(key);
  }
}

function validateTree(entries: VfsEntry[]): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const checked = new Set([ROOT_ID]);
  const siblingNames = new Map<string, Set<string>>();
  for (const entry of entries) {
    const parentId = entry.parentId!;
    const names = siblingNames.get(parentId) ?? new Set<string>();
    const key = nameKey(entry.name);
    if (names.has(key)) throw corrupt("本地文件包含重复名称，无法完成操作");
    names.add(key);
    siblingNames.set(parentId, names);
    const visited = new Set<string>();
    let current = entry;
    while (!checked.has(current.id)) {
      if (visited.has(current.id)) throw corrupt("本地文件夹层级包含循环");
      visited.add(current.id);
      if (current.parentId === ROOT_ID) break;
      const parent = byId.get(current.parentId!);
      if (!parent || parent.kind !== "folder")
        throw corrupt("本地文件的父文件夹不存在或无效");
      current = parent;
    }
    for (const id of visited) checked.add(id);
  }
}

function storageError(error: unknown): VirtualFileError {
  if (error instanceof VirtualFileError) return error;
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  if (name === "QuotaExceededError")
    return new VirtualFileError(
      "STORAGE_QUOTA",
      "本地存储空间不足，文件未保存，请释放空间后重试",
      error,
    );
  if (name === "SecurityError" || name === "NotSupportedError")
    return new VirtualFileError(
      "STORAGE_UNAVAILABLE",
      "浏览器不允许使用本地文件存储，请检查浏览器设置",
      error,
    );
  if (name === "VersionError")
    return new VirtualFileError(
      "STORAGE_CHANGED",
      "本地文件存储版本已更新，请刷新页面后重试",
      error,
    );
  return new VirtualFileError(
    "STORAGE_ERROR",
    "本地文件存储操作失败，未保存的更改已取消，请重试",
    error,
  );
}

function blobSnapshot(contents: Blob): Blob {
  if (typeof Blob === "undefined" || !(contents instanceof Blob))
    throw new VirtualFileError("INVALID_CONTENTS", "文件内容必须是有效的 Blob");
  if (contents.size > MAX_FILE_SIZE)
    throw new VirtualFileError("FILE_TOO_LARGE", "文件大小不能超过 100 MB");
  // Blob is immutable; slice takes a separate Blob without asynchronous reads
  // that would let an IndexedDB transaction become inactive.
  return contents.slice(0, contents.size, contents.type);
}

function storedBlob(value: unknown, entry: VfsFileEntry): Blob {
  if (!value || typeof value !== "object")
    throw corrupt("本地文件内容缺失，无法完成操作");
  const record = value as { id: string; blob: Blob };
  if (
    record.id !== entry.id ||
    typeof Blob === "undefined" ||
    !(record.blob instanceof Blob) ||
    record.blob.size !== entry.size ||
    record.blob.type !== (entry.mimeType ?? "")
  )
    throw corrupt("本地文件内容损坏，无法完成操作");
  return record.blob;
}

function workspaceSnapshot(value: unknown, persisted = false): VfsWorkspace {
  try {
    if (!value || typeof value !== "object")
      throw new VirtualFileError("INVALID_WORKSPACE", "工作区快照格式无效");
    const snapshot = value as VfsWorkspace;
    if (
      (snapshot.fileId !== null &&
        (typeof snapshot.fileId !== "string" ||
          !snapshot.fileId ||
          snapshot.fileId === ROOT_ID)) ||
      !Number.isSafeInteger(snapshot.updatedAt) ||
      snapshot.updatedAt < 0
    )
      throw new VirtualFileError("INVALID_WORKSPACE", "工作区快照信息无效");
    return {
      contents: blobSnapshot(snapshot.contents),
      fileId: snapshot.fileId,
      updatedAt: snapshot.updatedAt,
    };
  } catch (error) {
    if (persisted) throw corrupt("本地工作区快照损坏，现有数据已保留");
    throw error;
  }
}

function updatedAt(entry: VfsEntry): number {
  return Math.max(Date.now(), entry.updatedAt + 1);
}

/** Persistent generic Blob storage; archive formats belong to their codecs. */
export class VirtualFileStore {
  private connection?: Promise<IDBPDatabase<VfsSchema>>;
  private database?: IDBPDatabase<VfsSchema>;
  private connectionError?: VirtualFileError;
  private cancelOpen?: (error: VirtualFileError) => void;
  private closed = false;

  constructor(private readonly databaseName = "sketchworks.vfs.v1") {}

  private async open(): Promise<IDBPDatabase<VfsSchema>> {
    if (this.closed) throw new VirtualFileError("CLOSED", "本地文件存储已关闭");
    if (this.connectionError) throw this.connectionError;
    if (!this.connection) {
      const opening = this.openDatabase();
      this.connection = opening;
      void opening.catch(() => {
        if (this.connection === opening) this.connection = undefined;
      });
    }
    return this.connection;
  }

  private openDatabase(): Promise<IDBPDatabase<VfsSchema>> {
    if (typeof indexedDB === "undefined")
      return Promise.reject(
        new VirtualFileError(
          "STORAGE_UNAVAILABLE",
          "当前浏览器不支持 IndexedDB，本地文件无法持久保存",
        ),
      );
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        rejectOpen(
          new VirtualFileError(
            "STORAGE_BLOCKED",
            "本地文件存储打开超时，请关闭其他相关页面后重试",
          ),
        );
      }, 5000);
      const rejectOpen = (error: VirtualFileError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelOpen = undefined;
        reject(error);
      };
      this.cancelOpen = rejectOpen;
      try {
        openDB<VfsSchema>(this.databaseName, 1, {
          upgrade(db) {
            db.createObjectStore("entries", { keyPath: "id" }).createIndex(
              "parentId",
              "parentId",
            );
            db.createObjectStore("contents", { keyPath: "id" });
            db.createObjectStore("workspace");
          },
          blocked() {
            rejectOpen(
              new VirtualFileError(
                "STORAGE_BLOCKED",
                "本地文件存储被其他页面占用，请关闭其他相关页面后重试",
              ),
            );
          },
          blocking: (_currentVersion, _blockedVersion, event) => {
            (event.target as IDBDatabase).close();
            this.database = undefined;
            this.connectionError = new VirtualFileError(
              "STORAGE_CHANGED",
              "其他页面已更新本地文件存储，请刷新页面后重试",
            );
          },
          terminated: () => {
            this.database = undefined;
            this.connectionError = new VirtualFileError(
              "STORAGE_ERROR",
              "本地文件存储连接已中断，请刷新页面后重试",
            );
          },
        })
          .then(async (db) => {
            if (settled || this.closed || this.connectionError) {
              db.close();
              rejectOpen(
                this.connectionError ??
                  new VirtualFileError("CLOSED", "本地文件存储已关闭"),
              );
              return;
            }
            try {
              await this.validateSchema(db);
              if (settled || this.closed || this.connectionError) {
                db.close();
                rejectOpen(
                  this.connectionError ??
                    new VirtualFileError("CLOSED", "本地文件存储已关闭"),
                );
                return;
              }
              this.database = db;
              settled = true;
              clearTimeout(timer);
              this.cancelOpen = undefined;
              resolve(db);
            } catch (error) {
              db.close();
              rejectOpen(storageError(error));
            }
          })
          .catch((error: unknown) => rejectOpen(storageError(error)));
      } catch (error) {
        rejectOpen(storageError(error));
      }
    });
  }

  private async validateSchema(db: IDBPDatabase<VfsSchema>): Promise<void> {
    if (
      !db.objectStoreNames.contains("entries") ||
      !db.objectStoreNames.contains("contents") ||
      !db.objectStoreNames.contains("workspace")
    )
      throw corrupt("本地文件存储结构无效，现有数据已保留");
    const tx = db.transaction(["entries", "contents", "workspace"], "readonly");
    const done = tx.done;
    void done.catch(() => undefined);
    const entries = tx.objectStore("entries");
    const contents = tx.objectStore("contents");
    const valid =
      entries.keyPath === "id" &&
      contents.keyPath === "id" &&
      tx.objectStore("workspace").keyPath === null &&
      !tx.objectStore("workspace").autoIncrement &&
      entries.indexNames.contains("parentId") &&
      entries.index("parentId").keyPath === "parentId" &&
      !entries.index("parentId").unique &&
      !entries.index("parentId").multiEntry;
    await done;
    if (!valid) throw corrupt("本地文件存储结构无效，现有数据已保留");
  }

  private async transaction<T, Mode extends "readonly" | "readwrite">(
    mode: Mode,
    stores: StoreName[],
    action: (tx: Transaction<Mode>) => Promise<T>,
  ): Promise<T> {
    try {
      const db = await this.open();
      // close() or versionchange may run while the connection promise settles.
      if (this.closed)
        throw new VirtualFileError("CLOSED", "本地文件存储已关闭");
      if (this.connectionError) throw this.connectionError;
      const tx = db.transaction(stores, mode);
      const done = tx.done;
      void done.catch(() => undefined);
      try {
        const result = await action(tx);
        await done;
        return result;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // An IDB request error may already have aborted the transaction.
        }
        await done.catch(() => undefined);
        throw error;
      }
    } catch (error) {
      throw storageError(error);
    }
  }

  private read<T>(
    action: (tx: Transaction<"readonly">) => Promise<T>,
    withContents = false,
  ): Promise<T> {
    return this.transaction(
      "readonly",
      withContents ? ["entries", "contents"] : ["entries"],
      action,
    );
  }

  private write<T>(
    action: (tx: Transaction<"readwrite">) => Promise<T>,
  ): Promise<T> {
    return this.transaction(
      "readwrite",
      ["entries", "contents", "workspace"],
      action,
    );
  }

  private async find(
    entries: EntryStore,
    id: string,
  ): Promise<VfsEntry | undefined> {
    if (id === ROOT_ID) return rootEntry();
    const value = await entries.get(id);
    if (value === undefined) return undefined;
    const entry = metadata(value);
    if (entry.id !== id) throw corrupt();
    return entry;
  }

  private async folderPath(
    entries: EntryStore,
    folderId: string,
  ): Promise<VfsEntry[]> {
    const chain: VfsEntry[] = [];
    const visited = new Set<string>();
    let id = folderId;
    while (id !== ROOT_ID) {
      if (visited.has(id)) throw corrupt("本地文件夹层级包含循环");
      visited.add(id);
      const entry = await this.find(entries, id);
      if (!entry) {
        if (id === folderId)
          throw new VirtualFileError("NOT_FOUND", "文件夹不存在或已被删除");
        throw corrupt("本地文件的父文件夹不存在");
      }
      if (entry.kind !== "folder") {
        if (id === folderId)
          throw new VirtualFileError("NOT_FOLDER", "目标位置不是文件夹");
        throw corrupt("本地文件的父文件夹无效");
      }
      chain.push(entry);
      id = entry.parentId!;
    }
    return [rootEntry(), ...chain.reverse()];
  }

  private async requireEntry(
    entries: EntryStore,
    id: string,
  ): Promise<VfsEntry> {
    const entry = await this.find(entries, id);
    if (!entry)
      throw new VirtualFileError("NOT_FOUND", "文件或文件夹不存在或已被删除");
    if (entry.id !== ROOT_ID) await this.folderPath(entries, entry.parentId!);
    return entry;
  }

  private async children(
    entries: EntryStore,
    parentId: string,
  ): Promise<VfsEntry[]> {
    const children = (await entries.index("parentId").getAll(parentId)).map(
      metadata,
    );
    if (children.some((entry) => entry.parentId !== parentId)) throw corrupt();
    validateSiblingNames(children);
    return sortEntries(children);
  }

  private async availableName(
    entries: EntryStore,
    parentId: string,
    name: string,
    ownId?: string,
  ): Promise<void> {
    if (
      (await this.children(entries, parentId)).some(
        (entry) => entry.id !== ownId && nameKey(entry.name) === nameKey(name),
      )
    )
      throw new VirtualFileError(
        "NAME_EXISTS",
        "该文件夹中已存在同名文件或文件夹，请使用其他名称",
      );
  }

  private protectRoot(id: string): void {
    if (id === ROOT_ID)
      throw new VirtualFileError(
        "ROOT_PROTECTED",
        "不能修改、复制或删除根文件夹",
      );
  }

  private async subtree(
    entries: EntryStore,
    entry: VfsEntry,
  ): Promise<VfsEntry[]> {
    const result = [entry];
    const visited = new Set([entry.id]);
    for (let i = 0; i < result.length; i++) {
      if (result[i].kind !== "folder") continue;
      for (const child of await this.children(entries, result[i].id)) {
        if (visited.has(child.id)) throw corrupt("本地文件夹层级包含循环");
        visited.add(child.id);
        result.push(child);
      }
    }
    return result;
  }

  async list(parentId = ROOT_ID): Promise<VfsEntry[]> {
    return this.read(async (tx) => {
      const entries = tx.objectStore("entries");
      await this.folderPath(entries, parentId);
      return this.children(entries, parentId);
    });
  }

  async get(id: string): Promise<VfsEntry | undefined> {
    return this.read(async (tx) => {
      const entries = tx.objectStore("entries");
      const entry = await this.find(entries, id);
      if (entry && entry.id !== ROOT_ID)
        await this.folderPath(entries, entry.parentId!);
      return entry;
    });
  }

  async path(folderId: string): Promise<VfsEntry[]> {
    return this.read((tx) =>
      this.folderPath(tx.objectStore("entries"), folderId),
    );
  }

  async allEntries(): Promise<VfsEntry[]> {
    return this.read(async (tx) => {
      const entries = (await tx.objectStore("entries").getAll()).map(metadata);
      validateTree(entries);
      return sortEntries(entries);
    });
  }

  async createFolder(parentId: string, name: string): Promise<VfsFolderEntry> {
    return this.write(async (tx) => {
      const entries = tx.objectStore("entries");
      await this.folderPath(entries, parentId);
      const normalized = normalizeName(name);
      await this.availableName(entries, parentId, normalized);
      const now = Date.now();
      const entry: VfsFolderEntry = {
        id: `vfs_${crypto.randomUUID()}`,
        parentId,
        kind: "folder",
        name: normalized,
        createdAt: now,
        updatedAt: now,
        size: 0,
      };
      await entries.add(entry);
      return entry;
    });
  }

  async createFile(
    parentId: string,
    name: string,
    contents: Blob,
  ): Promise<VfsFileEntry> {
    return this.write(async (tx) => {
      const entries = tx.objectStore("entries");
      await this.folderPath(entries, parentId);
      const normalized = normalizeName(name);
      const blob = blobSnapshot(contents);
      await this.availableName(entries, parentId, normalized);
      const now = Date.now();
      const entry: VfsFileEntry = {
        id: `vfs_${crypto.randomUUID()}`,
        parentId,
        kind: "file",
        name: normalized,
        createdAt: now,
        updatedAt: now,
        size: blob.size,
        ...(blob.type ? { mimeType: blob.type } : {}),
      };
      await entries.add(entry);
      await tx.objectStore("contents").add({ id: entry.id, blob });
      return entry;
    });
  }

  async updateFile(id: string, contents: Blob): Promise<VfsFileEntry> {
    return this.write(async (tx) => {
      const entries = tx.objectStore("entries");
      const previous = await this.requireEntry(entries, id);
      if (previous.kind !== "file")
        throw new VirtualFileError("NOT_FILE", "所选项目不是文件");
      const contentStore = tx.objectStore("contents");
      storedBlob(await contentStore.get(id), previous as VfsFileEntry);
      const blob = blobSnapshot(contents);
      const { mimeType: _mimeType, ...base } = previous;
      const entry: VfsFileEntry = {
        ...base,
        kind: "file",
        size: blob.size,
        updatedAt: updatedAt(previous),
        ...(blob.type ? { mimeType: blob.type } : {}),
      };
      await entries.put(entry);
      await contentStore.put({ id, blob });
      return entry;
    });
  }

  async readFile(id: string): Promise<Blob> {
    return this.read(async (tx) => {
      const entry = await this.requireEntry(tx.objectStore("entries"), id);
      if (entry.kind !== "file")
        throw new VirtualFileError("NOT_FILE", "所选项目不是文件");
      const blob = storedBlob(
        await tx.objectStore("contents").get(id),
        entry as VfsFileEntry,
      );
      return blob.slice(0, blob.size, blob.type);
    }, true);
  }

  async rename(id: string, name: string): Promise<VfsEntry> {
    return this.write(async (tx) => {
      this.protectRoot(id);
      const entries = tx.objectStore("entries");
      const previous = await this.requireEntry(entries, id);
      const normalized = normalizeName(name);
      await this.availableName(entries, previous.parentId!, normalized, id);
      const entry = {
        ...previous,
        name: normalized,
        updatedAt: updatedAt(previous),
      };
      await entries.put(entry);
      return entry;
    });
  }

  async move(id: string, parentId: string): Promise<VfsEntry> {
    return this.write(async (tx) => {
      this.protectRoot(id);
      const entries = tx.objectStore("entries");
      const previous = await this.requireEntry(entries, id);
      const destination = await this.folderPath(entries, parentId);
      if (destination.some((entry) => entry.id === id))
        throw new VirtualFileError(
          "CYCLE",
          "不能将文件夹移动到自身或其子文件夹中",
        );
      await this.availableName(entries, parentId, previous.name, id);
      const entry = { ...previous, parentId, updatedAt: updatedAt(previous) };
      await entries.put(entry);
      return entry;
    });
  }

  /** Omitting a name preserves the original; name conflicts are reported. */
  async copy(id: string, parentId?: string, name?: string): Promise<VfsEntry> {
    return this.write(async (tx) => {
      this.protectRoot(id);
      const entries = tx.objectStore("entries");
      const source = await this.requireEntry(entries, id);
      const destinationId = parentId ?? source.parentId!;
      const destination = await this.folderPath(entries, destinationId);
      if (destination.some((entry) => entry.id === id))
        throw new VirtualFileError(
          "CYCLE",
          "不能将文件夹复制到自身或其子文件夹中",
        );
      const copyName = normalizeName(name ?? source.name);
      await this.availableName(entries, destinationId, copyName);
      const originals = await this.subtree(entries, source);
      const newIds = new Map<string, string>();
      const contentStore = tx.objectStore("contents");
      let copiedRoot: VfsEntry | undefined;
      for (const original of originals) {
        const newId = `vfs_${crypto.randomUUID()}`;
        newIds.set(original.id, newId);
        const now = updatedAt(original);
        const entry: VfsEntry = {
          ...original,
          id: newId,
          parentId:
            original.id === id
              ? destinationId
              : newIds.get(original.parentId!)!,
          name: original.id === id ? copyName : original.name,
          createdAt: now,
          updatedAt: now,
        };
        await entries.add(entry);
        if (original.kind === "file") {
          const blob = storedBlob(
            await contentStore.get(original.id),
            original as VfsFileEntry,
          );
          await contentStore.add({
            id: newId,
            blob: blob.slice(0, blob.size, blob.type),
          });
        }
        copiedRoot ??= entry;
      }
      return copiedRoot!;
    });
  }

  async remove(id: string): Promise<void> {
    return this.write(async (tx) => {
      this.protectRoot(id);
      const entries = tx.objectStore("entries");
      const source = await this.requireEntry(entries, id);
      for (const entry of await this.subtree(entries, source)) {
        await entries.delete(entry.id);
        await tx.objectStore("contents").delete(entry.id);
      }
    });
  }

  async writeWorkspace(snapshot: VfsWorkspace): Promise<void> {
    return this.write(async (tx) => {
      const next = workspaceSnapshot(snapshot);
      const workspace = tx.objectStore("workspace");
      const previousValue = await workspace.get("current");
      const previous =
        previousValue === undefined
          ? undefined
          : workspaceSnapshot(previousValue, true);
      await workspace.put(
        {
          ...next,
          updatedAt: Math.max(next.updatedAt, (previous?.updatedAt ?? -1) + 1),
        },
        "current",
      );
    });
  }

  async readWorkspace(): Promise<VfsWorkspace | undefined> {
    return this.transaction("readonly", ["workspace"], async (tx) => {
      const value = await tx.objectStore("workspace").get("current");
      return value === undefined ? undefined : workspaceSnapshot(value, true);
    });
  }

  /** Closes only this instance; reopening uses a new VirtualFileStore. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelOpen?.(new VirtualFileError("CLOSED", "本地文件存储已关闭"));
    this.database?.close();
    this.database = undefined;
    await this.connection?.then(
      (db) => db.close(),
      () => undefined,
    );
  }
}

export const virtualFiles = new VirtualFileStore();
