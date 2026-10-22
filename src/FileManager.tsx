import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileBox,
  FilePlus2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Home,
  ImagePlus,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  Pencil,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type Document, validateDocument } from "./model";
import {
  ROOT_ID,
  virtualFiles,
  type VfsEntry,
  type VfsFileEntry,
} from "./virtualFileSystem";
import {
  type CadProject,
  addProjectAttachment,
  attachmentData,
  createProject,
  decodeProject,
  encodeProject,
  projectFileName,
  removeProjectAttachment,
  withProjectDocument,
} from "./projectArchive";
import "./fileManager.css";

export interface FileManagerProps {
  mode: "browse" | "save";
  document: Document;
  project: CadProject;
  activeFileId?: string | null;
  initialFolderId?: string;
  onOpen: (file: VfsFileEntry) => boolean | Promise<boolean>;
  onCreateProject: (
    name: string,
    parentId: string,
  ) => Promise<VfsFileEntry | undefined>;
  onSaved: (file: VfsFileEntry, project: CadProject) => void;
  onProjectChanged?: (file: VfsFileEntry, project: CadProject) => void;
  onEntriesChanged?: () => void;
  onLockChange?: (locked: boolean) => void;
  onClose: () => void;
}

type EntryAction =
  | { kind: "project"; name: string }
  | { kind: "folder"; name: string }
  | { kind: "rename"; entry: VfsEntry; name: string }
  | {
      kind: "move" | "copy";
      entry: VfsEntry;
      parentId: string;
      name: string;
    }
  | { kind: "delete"; entry: VfsEntry }
  | { kind: "overwrite"; file: VfsFileEntry; name: string; parentId: string }
  | {
      kind: "attachment-delete";
      file: VfsFileEntry;
      attachmentId: string;
      name: string;
    };

type SortOrder = "name" | "updated" | "size";
type ProjectAttachment = CadProject["manifest"]["attachments"][number];
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function isFileEntry(entry: VfsEntry): entry is VfsFileEntry {
  return entry.kind === "file";
}

function projectName(value: string) {
  const name = value.trim().normalize("NFC");
  if (!name) throw new Error("请输入项目文件名。");
  const result = projectFileName(name);
  checkName(result);
  return result;
}

function nameKey(value: string) {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
}

function checkName(value: string) {
  if (!value.trim()) throw new Error("名称不能为空。");
  if (Array.from(value.normalize("NFC")).length > 180)
    throw new Error("名称不能超过 180 个字符。");
  if (
    /[/\\\u0000-\u001f\u007f-\u009f]/.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error("名称不能包含斜杠、控制字符或相对路径。");
}

function sizeLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function timeLabel(time: number) {
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function errorLabel(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/[\u3400-\u9fff]/.test(message)) return message;
  if (/quota|disk|space/i.test(message)) return "浏览器本地存储空间不足。";
  if (/exist|duplicate|conflict/i.test(message))
    return "当前文件夹已有同名项目，请修改名称。";
  if (/not.?found|missing/i.test(message))
    return "文件或文件夹已不存在，请刷新后重试。";
  if (/indexeddb|storage|database|transaction/i.test(message))
    return "无法访问浏览器本地文件，请重试。";
  return "操作未完成，请检查文件后重试。";
}

function imageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  const prefix = String.fromCharCode(...bytes.subarray(0, 12));
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a"))
    return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP")
    return "image/webp";
  return null;
}

async function projectBlob(project: CadProject) {
  const bytes = await encodeProject(project);
  return new Blob([Uint8Array.from(bytes)], { type: "application/x-asar" });
}

async function readProject(file: VfsFileEntry) {
  const blob = await virtualFiles.readFile(file.id);
  if (/\.json$/i.test(file.name)) {
    try {
      return await createProject(
        validateDocument(JSON.parse(await blob.text())),
      );
    } catch (error) {
      throw new Error(`旧版 JSON 文档无效：${errorLabel(error)}`);
    }
  }
  try {
    return await decodeProject(await blob.arrayBuffer());
  } catch (error) {
    throw new Error(`项目归档无法读取：${errorLabel(error)}`);
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function folderLabel(folderId: string, entries: VfsEntry[]) {
  if (folderId === ROOT_ID) return "根目录";
  const labels: string[] = [];
  const visited = new Set<string>();
  let current: string | null | undefined = folderId;
  while (current && current !== ROOT_ID && !visited.has(current)) {
    visited.add(current);
    const entry = entries.find((candidate) => candidate.id === current);
    if (!entry) break;
    labels.unshift(entry.name);
    current = entry.parentId;
  }
  return `根目录 / ${labels.join(" / ")}`;
}

function descendants(entry: VfsEntry, entries: VfsEntry[]) {
  const ids = new Set([entry.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of entries) {
      if (
        candidate.parentId &&
        ids.has(candidate.parentId) &&
        !ids.has(candidate.id)
      ) {
        ids.add(candidate.id);
        changed = true;
      }
    }
  }
  return ids;
}

function FolderMoveChooser({
  entries,
  value,
  disabled,
  onChange,
}: {
  entries: VfsEntry[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const folders = entries
    .filter((entry) => entry.kind === "folder" && entry.id !== ROOT_ID)
    .map((entry) => ({ id: entry.id, label: folderLabel(entry.id, entries) }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  return (
    <label className="fm-field fm-destination">
      <span>目标文件夹</span>
      <select
        aria-label="目标文件夹"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={ROOT_ID}>根目录</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AttachmentPreview({
  project,
  attachment,
}: {
  project: CadProject;
  attachment: ProjectAttachment;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!imageTypes.has(attachment.mimeType)) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    Promise.resolve()
      .then(() => attachmentData(project, attachment.id))
      .then((bytes) => {
        if (cancelled || !bytes || imageMime(bytes) !== attachment.mimeType)
          return;
        objectUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(bytes)], { type: attachment.mimeType }),
        );
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [project, attachment.id, attachment.mimeType]);
  return (
    <span className="fm-attachment-preview">
      {url ? <img src={url} alt={attachment.name} /> : <Paperclip size={18} />}
    </span>
  );
}

export function FileManager({
  mode,
  document: currentDocument,
  project: currentProject,
  activeFileId,
  initialFolderId = ROOT_ID,
  onOpen,
  onCreateProject,
  onSaved,
  onProjectChanged,
  onEntriesChanged,
  onLockChange,
  onClose,
}: FileManagerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef(false);
  const listRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const [folderId, setFolderId] = useState(initialFolderId);
  const [entries, setEntries] = useState<VfsEntry[]>([]);
  const [allEntries, setAllEntries] = useState<VfsEntry[]>([]);
  const [path, setPath] = useState<VfsEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortOrder>("name");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<EntryAction | null>(null);
  const [saveRequested, setSaveRequested] = useState(false);
  const [saveName, setSaveName] = useState(() =>
    projectFileName(currentDocument.name || "未命名草图"),
  );
  const [selectedProject, setSelectedProject] = useState<{
    fileId: string;
    project: CadProject;
  } | null>(null);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const selected = entries.find((entry) => entry.id === selectedId);
  const selectedFile = selected && isFileEntry(selected) ? selected : undefined;
  const attachmentProject =
    selectedProject?.fileId === selectedFile?.id
      ? selectedProject?.project
      : undefined;
  const busy = loading || pending !== null;
  const locked = busy || action !== null;
  const saveVisible = mode === "save" || saveRequested;
  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return entries
      .filter(
        (entry) => !needle || entry.name.toLocaleLowerCase().includes(needle),
      )
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        if (sort === "updated" && a.updatedAt !== b.updatedAt)
          return b.updatedAt - a.updatedAt;
        if (sort === "size" && a.size !== b.size) return b.size - a.size;
        return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      });
  }, [entries, query, sort]);

  useEffect(() => {
    onLockChange?.(locked);
    return () => onLockChange?.(false);
  }, [locked, onLockChange]);

  useEffect(() => {
    if (mode === "save") {
      setSaveName(projectFileName(currentDocument.name || "未命名草图"));
      setAction(null);
      setSaveRequested(false);
    }
  }, [mode]);

  const refresh = useCallback(async (target: string) => {
    const request = ++listRequestRef.current;
    setLoading(true);
    try {
      const [nextEntries, nextPath, nextAllEntries] = await Promise.all([
        virtualFiles.list(target),
        virtualFiles.path(target),
        virtualFiles.allEntries(),
      ]);
      if (!mountedRef.current || request !== listRequestRef.current) return;
      setEntries(nextEntries);
      setPath(nextPath);
      setAllEntries(nextAllEntries);
      setSelectedId((id) =>
        nextEntries.some((entry) => entry.id === id) ? id : null,
      );
    } finally {
      if (mountedRef.current && request === listRequestRef.current)
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const previousFocus = window.document.activeElement;
    panelRef.current?.focus();
    return () => {
      mountedRef.current = false;
      listRequestRef.current++;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSelectedProject(null);
    refresh(folderId).catch((problem) => {
      if (!cancelled && mountedRef.current)
        setError(`无法读取文件夹：${errorLabel(problem)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [folderId, refresh]);

  useEffect(() => {
    let cancelled = false;
    setSelectedProject(null);
    setAttachmentError(null);
    if (!selectedFile) {
      setAttachmentLoading(false);
      return;
    }
    const file = selectedFile;
    setAttachmentLoading(true);
    const load = Promise.resolve().then(() =>
      file.id === activeFileId
        ? withProjectDocument(currentProject, currentDocument)
        : readProject(file),
    );
    load
      .then((project) => {
        if (!cancelled) setSelectedProject({ fileId: file.id, project });
      })
      .catch((problem) => {
        if (!cancelled) setAttachmentError(errorLabel(problem));
      })
      .finally(() => {
        if (!cancelled) setAttachmentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    selectedFile?.id,
    selectedFile?.updatedAt,
    activeFileId,
    currentProject,
    currentDocument,
  ]);

  const run = async (label: string, task: () => Promise<void>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setPending(label);
    setError(null);
    setNotice("");
    try {
      await task();
    } catch (problem) {
      if (mountedRef.current) setError(`${label}失败：${errorLabel(problem)}`);
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setPending(null);
    }
  };

  const navigate = (target: string) => {
    if (locked || target === folderId) return;
    setFolderId(target);
    setSelectedId(null);
    setEntries([]);
    setQuery("");
    setNotice("");
  };

  const openEntry = (entry: VfsEntry) => {
    if (locked) return;
    if (!isFileEntry(entry)) {
      navigate(entry.id);
      return;
    }
    void run("打开项目", async () => {
      if (await onOpen(entry)) {
        setSaveRequested(false);
        onEntriesChanged?.();
        await refresh(folderId);
        setNotice(`已打开 ${entry.name}`);
      }
    });
  };

  const currentArchive = () =>
    withProjectDocument(currentProject, currentDocument);

  const saveCurrent = async (
    name: string,
    parentId: string,
    overwrite?: VfsFileEntry,
  ) => {
    const project = await currentArchive();
    const blob = await projectBlob(project);
    let file: VfsFileEntry;
    if (overwrite) {
      const latest = await virtualFiles.get(overwrite.id);
      if (
        !latest ||
        latest.kind !== "file" ||
        latest.parentId !== parentId ||
        latest.name !== name
      )
        throw new Error("待覆盖文件已变化，请重新选择保存位置。");
      file = await virtualFiles.updateFile(overwrite.id, blob);
    } else {
      file = await virtualFiles.createFile(parentId, name, blob);
    }
    onSaved(file, project);
    onEntriesChanged?.();
    setAction(null);
    setSaveRequested(false);
    setSaveName(name);
    setQuery("");
    await refresh(folderId);
    setSelectedId(file.id);
    setNotice(`已保存 ${file.name}`);
  };

  const requestSave = () => {
    if (locked) return;
    void run("保存项目", async () => {
      const name = projectName(saveName);
      setSaveName(name);
      const siblings = await virtualFiles.list(folderId);
      const existing = siblings.find(
        (entry) => nameKey(entry.name) === nameKey(name),
      );
      if (existing) {
        if (!isFileEntry(existing))
          throw new Error("当前文件夹已有同名文件夹，请修改项目文件名。");
        setAction({
          kind: "overwrite",
          file: existing,
          name: existing.name,
          parentId: folderId,
        });
        return;
      }
      await saveCurrent(name, folderId);
    });
  };

  const confirmAction = () => {
    if (!action || busy) return;
    const currentAction = action;
    const label = {
      project: "新建项目",
      folder: "新建文件夹",
      rename: "重命名",
      move: "移动",
      copy: "复制",
      delete: "删除",
      overwrite: "覆盖项目",
      "attachment-delete": "移除附件",
    }[currentAction.kind];
    void run(label, async () => {
      if (currentAction.kind === "project") {
        const name = projectName(currentAction.name);
        const file = await onCreateProject(name, folderId);
        if (!file) return;
        onEntriesChanged?.();
        setAction(null);
        setSaveRequested(false);
        setQuery("");
        await refresh(folderId);
        setSelectedId(file.id);
        setNotice(`已创建 ${file.name}`);
        return;
      }
      if (currentAction.kind === "overwrite") {
        await saveCurrent(
          currentAction.name,
          currentAction.parentId,
          currentAction.file,
        );
        return;
      }
      if (currentAction.kind === "attachment-delete") {
        const file = currentAction.file;
        const base =
          file.id === activeFileId
            ? await currentArchive()
            : await readProject(file);
        const project = await removeProjectAttachment(
          base,
          currentAction.attachmentId,
        );
        const updatedFile = await virtualFiles.updateFile(
          file.id,
          await projectBlob(project),
        );
        setSelectedProject({ fileId: file.id, project });
        onProjectChanged?.(updatedFile, project);
        onEntriesChanged?.();
        setAction(null);
        await refresh(folderId);
        setNotice(`已移除附件 ${currentAction.name}`);
        return;
      }
      let result: VfsEntry | undefined;
      if (currentAction.kind === "folder") {
        const name = currentAction.name.trim();
        checkName(name);
        result = await virtualFiles.createFolder(folderId, name);
      } else if (currentAction.kind === "rename") {
        let name = currentAction.name.trim();
        if (
          currentAction.entry.kind === "file" &&
          /\.(?:swcad|asar)$/i.test(currentAction.entry.name)
        )
          name = projectName(name);
        checkName(name);
        result = await virtualFiles.rename(currentAction.entry.id, name);
      } else if (currentAction.kind === "move") {
        result = await virtualFiles.move(
          currentAction.entry.id,
          currentAction.parentId,
        );
      } else if (currentAction.kind === "copy") {
        let name = currentAction.name.trim();
        if (
          currentAction.entry.kind === "file" &&
          /\.(?:swcad|asar)$/i.test(currentAction.entry.name)
        )
          name = projectName(name);
        checkName(name);
        result = await virtualFiles.copy(
          currentAction.entry.id,
          currentAction.parentId,
          name,
        );
      } else {
        await virtualFiles.remove(currentAction.entry.id);
        setSelectedId(null);
      }
      onEntriesChanged?.();
      setAction(null);
      await refresh(folderId);
      if (result?.parentId === folderId) setSelectedId(result.id);
      setNotice(`${label}完成`);
    });
  };

  const importFiles = (files: File[]) => {
    if (!files.length || locked) return;
    const target = folderId;
    void run("导入项目", async () => {
      let imported = 0;
      const problems: string[] = [];
      for (const file of files) {
        try {
          if (!/\.(swcad|asar|json)$/i.test(file.name))
            throw new Error("仅支持 .swcad 项目、旧版 .asar 或 .json 文档。");
          let project: CadProject;
          if (/\.json$/i.test(file.name)) {
            project = await createProject(
              validateDocument(JSON.parse(await file.text())),
            );
          } else {
            project = await decodeProject(await file.arrayBuffer());
          }
          const name = projectName(file.name);
          const siblings = await virtualFiles.list(target);
          if (siblings.some((entry) => nameKey(entry.name) === nameKey(name)))
            throw new Error(`已有同名项目「${name}」，请先重命名后再导入。`);
          const saved = await virtualFiles.createFile(
            target,
            name,
            await projectBlob(project),
          );
          imported++;
          setSelectedId(saved.id);
        } catch (problem) {
          problems.push(`${file.name}：${errorLabel(problem)}`);
        }
      }
      if (imported) onEntriesChanged?.();
      await refresh(target);
      if (imported) setNotice(`已导入 ${imported} 个项目`);
      if (problems.length) setError(problems.join("\n"));
    });
  };

  const downloadSelected = () => {
    if (!selectedFile || locked) return;
    const file = selectedFile;
    void run("下载项目", async () => {
      if (/\.json$/i.test(file.name)) {
        downloadBlob(
          await projectBlob(await readProject(file)),
          projectName(file.name),
        );
      } else {
        const blob = await virtualFiles.readFile(file.id);
        await decodeProject(await blob.arrayBuffer());
        downloadBlob(
          new Blob([blob], { type: "application/x-asar" }),
          projectName(file.name),
        );
      }
    });
  };

  const addImages = (files: File[]) => {
    if (!selectedFile || !files.length || locked) return;
    const file = selectedFile;
    void run("添加图片", async () => {
      const images: { name: string; mimeType: string; data: Uint8Array }[] = [];
      for (const image of files) {
        if (
          !/\.(png|jpe?g|webp|gif)$/i.test(image.name) ||
          (image.type && !imageTypes.has(image.type))
        )
          throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片。");
        const data = new Uint8Array(await image.arrayBuffer());
        const mimeType = imageMime(data);
        if (!mimeType || (image.type && image.type !== mimeType))
          throw new Error(`图片「${image.name}」格式无效。`);
        images.push({ name: image.name, mimeType, data });
      }
      let project =
        file.id === activeFileId
          ? await currentArchive()
          : await readProject(file);
      for (const image of images)
        project = await addProjectAttachment(project, image);
      const updatedFile = await virtualFiles.updateFile(
        file.id,
        await projectBlob(project),
      );
      setSelectedProject({ fileId: file.id, project });
      onProjectChanged?.(updatedFile, project);
      onEntriesChanged?.();
      await refresh(folderId);
      setNotice(`已添加 ${images.length} 张图片`);
    });
  };

  const downloadAttachment = (attachment: ProjectAttachment) => {
    if (!attachmentProject || locked) return;
    void run("下载附件", async () => {
      const data = await attachmentData(attachmentProject, attachment.id);
      if (!data) throw new Error("附件内容不存在。");
      downloadBlob(
        new Blob([Uint8Array.from(data)], { type: attachment.mimeType }),
        attachment.name,
      );
    });
  };

  const cancelSave = () => {
    if (busy || operationRef.current) return;
    setAction(null);
    if (mode === "save") onClose();
    else setSaveRequested(false);
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const editing =
      target.matches("input, textarea, select") || target.isContentEditable;
    if (event.key === "Escape") {
      event.preventDefault();
      if (busy || operationRef.current) return;
      if (action) setAction(null);
      else if (saveRequested && mode === "browse") setSaveRequested(false);
      else onClose();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "o", "p"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      return;
    }
    if (editing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      if (selected && !locked) setAction({ kind: "delete", entry: selected });
    } else if (event.key === "Enter" && target.classList.contains("fm-entry")) {
      event.preventDefault();
      const entry = entries.find((item) => item.id === target.dataset.entryId);
      if (entry) openEntry(entry);
    } else if (
      ["ArrowDown", "ArrowUp"].includes(event.key) &&
      target.classList.contains("fm-entry")
    ) {
      event.preventDefault();
      if (locked) return;
      const index = visibleEntries.findIndex(
        (entry) => entry.id === selectedId,
      );
      const next =
        visibleEntries[
          Math.max(
            0,
            Math.min(
              visibleEntries.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          )
        ];
      if (next) {
        setSelectedId(next.id);
        const button = Array.from(
          panelRef.current?.querySelectorAll<HTMLButtonElement>(".fm-entry") ??
            [],
        ).find((element) => element.dataset.entryId === next.id);
        button?.focus();
      }
    }
  };

  const actionTitle = action
    ? {
        project: "新建项目",
        folder: "新建文件夹",
        rename: "重命名",
        move: "移动到",
        copy: "复制到",
        delete: "确认删除",
        overwrite: "确认覆盖",
        "attachment-delete": "确认移除附件",
      }[action.kind]
    : "";
  const actionDestructive =
    action?.kind === "delete" || action?.kind === "attachment-delete";
  const actionConfirm =
    action?.kind === "overwrite"
      ? "覆盖并保存"
      : action?.kind === "delete"
        ? "确认删除"
        : action?.kind === "attachment-delete"
          ? "确认移除"
          : action?.kind === "folder" || action?.kind === "project"
            ? "创建"
            : action?.kind === "move"
              ? "确认移动"
              : action?.kind === "copy"
                ? "确认复制"
                : "确认重命名";
  const selectedAttachments = attachmentProject?.manifest.attachments ?? [];
  const crumbFolders = path.filter((entry) => entry.id !== ROOT_ID);
  const parentId = path.length > 1 ? path[path.length - 2].id : ROOT_ID;

  return (
    <div
      className="fm-panel"
      role="region"
      aria-labelledby={titleId}
      aria-busy={busy}
      data-testid="file-manager"
      data-mode={mode}
      tabIndex={-1}
      ref={panelRef}
      onKeyDownCapture={handleKey}
      onKeyUpCapture={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="fm-header">
        <div className="fm-heading">
          <FolderOpen size={17} />
          <h2 id={titleId}>项目管理</h2>
        </div>
        <span className="fm-storage-label">浏览器本地文件</span>
      </header>

      <div className="fm-pathbar">
        <button
          type="button"
          className="icon-button"
          aria-label="上一级文件夹"
          title="上一级文件夹"
          disabled={locked || folderId === ROOT_ID}
          onClick={() => navigate(parentId)}
        >
          <ArrowUp size={16} />
        </button>
        <nav className="fm-breadcrumbs" aria-label="当前文件夹路径">
          <button
            type="button"
            disabled={locked}
            onClick={() => navigate(ROOT_ID)}
            title="根目录"
          >
            <Home size={14} />
            <span>根目录</span>
          </button>
          {crumbFolders.map((folder, index) => (
            <span className="fm-crumb" key={folder.id}>
              <ChevronRight size={12} />
              <button
                type="button"
                disabled={locked}
                onClick={() => navigate(folder.id)}
                title={folder.name}
                aria-current={
                  index === crumbFolders.length - 1 ? "page" : undefined
                }
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="fm-toolbar" role="toolbar" aria-label="文件操作">
        <button
          type="button"
          className="fm-tool fm-primary-tool"
          disabled={locked}
          onClick={() => {
            setSaveRequested(false);
            setAction({ kind: "project", name: "" });
          }}
        >
          <FilePlus2 size={15} />
          <span>新建项目</span>
        </button>
        <button
          type="button"
          className="fm-tool fm-primary-tool"
          disabled={locked}
          onClick={() => {
            setSaveRequested(false);
            setAction({ kind: "folder", name: "" });
          }}
        >
          <FolderPlus size={15} />
          <span>新建文件夹</span>
        </button>
        <button
          type="button"
          className="fm-tool"
          title="打开"
          disabled={locked || !selected}
          onClick={() => selected && openEntry(selected)}
        >
          <FolderOpen size={15} />
          <span>打开</span>
        </button>
        <button
          type="button"
          className="fm-tool"
          title="重命名"
          disabled={locked || !selected}
          onClick={() =>
            selected &&
            setAction({
              kind: "rename",
              entry: selected,
              name: selected.name,
            })
          }
        >
          <Pencil size={15} />
          <span>重命名</span>
        </button>
        <button
          type="button"
          className="fm-tool"
          title="移动"
          disabled={locked || !selected}
          onClick={() =>
            selected &&
            setAction({
              kind: "move",
              entry: selected,
              parentId: folderId,
              name: selected.name,
            })
          }
        >
          <FolderInput size={15} />
          <span>移动</span>
        </button>
        <button
          type="button"
          className="fm-tool"
          title="复制"
          disabled={locked || !selected}
          onClick={() =>
            selected &&
            setAction({
              kind: "copy",
              entry: selected,
              parentId: folderId,
              name:
                selected.kind === "file" &&
                /\.(?:swcad|asar)$/i.test(selected.name)
                  ? projectFileName(
                      `${selected.name.replace(/\.(?:swcad|asar)$/i, "")} 副本`,
                    )
                  : `${selected.name} 副本`,
            })
          }
        >
          <Copy size={15} />
          <span>复制</span>
        </button>
        <button
          type="button"
          className="fm-tool fm-danger-tool"
          title="删除"
          disabled={locked || !selected}
          onClick={() =>
            selected && setAction({ kind: "delete", entry: selected })
          }
        >
          <Trash2 size={15} />
          <span>删除</span>
        </button>
        <button
          type="button"
          className="fm-tool"
          title="导入"
          disabled={locked}
          onClick={() => importRef.current?.click()}
        >
          <Upload size={15} />
          <span>导入</span>
        </button>
        <button
          type="button"
          className="fm-tool"
          title="下载项目"
          disabled={locked || !selectedFile}
          onClick={downloadSelected}
        >
          <Download size={15} />
          <span>下载项目</span>
        </button>
      </div>

      <div className="fm-filterbar">
        <label className="fm-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="搜索当前文件夹"
            placeholder="搜索当前文件夹"
            value={query}
            disabled={locked}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="fm-sort">
          <span>排序</span>
          <select
            aria-label="文件排序"
            value={sort}
            disabled={locked}
            onChange={(event) => setSort(event.target.value as SortOrder)}
          >
            <option value="name">名称</option>
            <option value="updated">最近修改</option>
            <option value="size">文件大小</option>
          </select>
        </label>
      </div>

      {(error || notice || pending) && (
        <div
          className={`fm-feedback ${error ? "fm-error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {pending && <LoaderCircle size={13} className="spin" />}
          <span>{error || (pending ? `${pending}…` : notice)}</span>
          {error && (
            <button
              type="button"
              className="icon-button"
              aria-label="关闭错误提示"
              disabled={busy}
              onClick={() => setError(null)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {action && (
        <form
          className={`fm-action-panel ${actionDestructive ? "fm-confirm-danger" : ""}`}
          aria-label={actionTitle}
          onSubmit={(event) => {
            event.preventDefault();
            confirmAction();
          }}
        >
          <strong className="fm-action-title">{actionTitle}</strong>
          {(action.kind === "project" ||
            action.kind === "folder" ||
            action.kind === "rename" ||
            action.kind === "copy") && (
            <label className="fm-field">
              <span>
                {action.kind === "project"
                  ? "项目名称"
                  : action.kind === "folder"
                    ? "文件夹名称"
                    : "名称"}
              </span>
              <input
                autoFocus
                aria-label={
                  action.kind === "project"
                    ? "项目名称"
                    : action.kind === "folder"
                      ? "文件夹名称"
                      : "名称"
                }
                value={action.name}
                maxLength={255}
                disabled={busy}
                spellCheck={false}
                onChange={(event) =>
                  setAction({ ...action, name: event.target.value })
                }
              />
            </label>
          )}
          {(action.kind === "move" || action.kind === "copy") && (
            <FolderMoveChooser
              entries={allEntries}
              value={action.parentId}
              disabled={busy}
              onChange={(value) => setAction({ ...action, parentId: value })}
            />
          )}
          {action.kind === "move" && (
            <p className="fm-action-message">
              移动「{action.entry.name}」到所选文件夹。
            </p>
          )}
          {action.kind === "delete" && (
            <p className="fm-action-message">
              {action.entry.kind === "folder"
                ? `删除文件夹「${action.entry.name}」及其中 ${descendants(action.entry, allEntries).size - 1} 个文件和文件夹？`
                : `删除项目「${action.entry.name}」？`}
              <span>此操作无法撤销。</span>
            </p>
          )}
          {action.kind === "overwrite" && (
            <p className="fm-action-message">
              「{action.name}」已存在。覆盖后将替换这个项目文件的内容。
            </p>
          )}
          {action.kind === "attachment-delete" && (
            <p className="fm-action-message">
              从项目中移除附件「{action.name}」？<span>此操作无法撤销。</span>
            </p>
          )}
          <div className="fm-action-buttons">
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              取消操作
            </button>
            <button
              type="submit"
              className={`button small ${actionDestructive ? "fm-danger-button" : "primary"}`}
              disabled={busy}
            >
              {actionDestructive ? <Trash2 size={13} /> : <Check size={13} />}
              {actionConfirm}
            </button>
          </div>
        </form>
      )}

      <div className="fm-content">
        <section className="fm-files" aria-label="当前文件夹内容">
          <div className="fm-list-header" aria-hidden="true">
            <span>名称</span>
            <span>修改时间</span>
            <span>大小</span>
          </div>
          <div
            className="fm-file-list"
            role="listbox"
            aria-label="项目文件"
            data-testid="file-manager-list"
          >
            {loading ? (
              <div className="fm-empty" role="status">
                <LoaderCircle size={18} className="spin" />
                <span>正在读取文件…</span>
              </div>
            ) : !visibleEntries.length ? (
              <div className="fm-empty" role="status">
                <FolderOpen size={24} />
                <span>{query ? "没有匹配的文件" : "当前文件夹为空"}</span>
              </div>
            ) : (
              visibleEntries.map((entry) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={entry.id === selectedId}
                  aria-label={entry.name}
                  title={entry.name}
                  className={`fm-entry ${entry.kind === "folder" ? "fm-folder-entry" : ""}`}
                  key={entry.id}
                  data-testid="file-manager-entry"
                  data-entry-id={entry.id}
                  data-entry-kind={entry.kind}
                  disabled={locked}
                  onClick={() => {
                    setSelectedId(entry.id);
                    setError(null);
                  }}
                  onDoubleClick={() => openEntry(entry)}
                >
                  <span className="fm-entry-name">
                    {entry.kind === "folder" ? (
                      <Folder size={17} />
                    ) : (
                      <FileBox size={17} />
                    )}
                    <span className="fm-entry-label">{entry.name}</span>
                    {entry.id === activeFileId && (
                      <span className="fm-active-tag">当前</span>
                    )}
                  </span>
                  <span className="fm-entry-time">
                    {timeLabel(entry.updatedAt)}
                  </span>
                  <span className="fm-entry-size">
                    {entry.kind === "folder" ? "—" : sizeLabel(entry.size)}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        {selectedFile && (
          <aside
            className="fm-attachments"
            aria-label="项目附件"
            data-testid="file-manager-attachments"
          >
            <div className="fm-attachment-heading">
              <strong>
                <Paperclip size={14} />
                项目附件
              </strong>
              <button
                type="button"
                className="button small"
                disabled={locked || !attachmentProject}
                onClick={() => imageRef.current?.click()}
              >
                <ImagePlus size={14} />
                添加图片
              </button>
            </div>
            <p className="fm-selected-name" title={selectedFile.name}>
              {selectedFile.name}
            </p>
            <div className="fm-attachment-list">
              {attachmentLoading ? (
                <p className="fm-attachment-empty" role="status">
                  正在读取附件…
                </p>
              ) : attachmentError ? (
                <p className="fm-attachment-error" role="alert">
                  {attachmentError}
                </p>
              ) : !selectedAttachments.length ? (
                <p className="fm-attachment-empty">暂无附件</p>
              ) : (
                selectedAttachments.map((attachment) => (
                  <div
                    className="fm-attachment"
                    key={attachment.id}
                    data-attachment-id={attachment.id}
                  >
                    <AttachmentPreview
                      project={attachmentProject!}
                      attachment={attachment}
                    />
                    <div className="fm-attachment-info">
                      <span title={attachment.name}>{attachment.name}</span>
                      <small>
                        {imageTypes.has(attachment.mimeType) ? (
                          <ImageIcon size={10} />
                        ) : (
                          <Paperclip size={10} />
                        )}
                        {sizeLabel(attachment.size)}
                      </small>
                    </div>
                    <div className="fm-attachment-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`下载附件 ${attachment.name}`}
                        title="下载附件"
                        disabled={locked}
                        onClick={() => downloadAttachment(attachment)}
                      >
                        <Download size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`移除附件 ${attachment.name}`}
                        title="移除附件"
                        disabled={locked}
                        onClick={() =>
                          setAction({
                            kind: "attachment-delete",
                            file: selectedFile,
                            attachmentId: attachment.id,
                            name: attachment.name,
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      <footer className="fm-footer">
        {saveVisible ? (
          <form
            className="fm-save-form"
            aria-label="保存项目文件"
            onSubmit={(event) => {
              event.preventDefault();
              requestSave();
            }}
          >
            <label className="fm-field fm-save-name">
              <span>文件名</span>
              <input
                aria-label="项目文件名"
                value={saveName}
                maxLength={255}
                disabled={locked}
                spellCheck={false}
                onChange={(event) => setSaveName(event.target.value)}
              />
            </label>
            <span
              className="fm-save-location"
              title={folderLabel(folderId, allEntries)}
            >
              保存到：{folderLabel(folderId, allEntries)}
            </span>
            <div className="fm-footer-buttons">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={cancelSave}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={locked}
              >
                <Save size={14} />
                保存
              </button>
            </div>
          </form>
        ) : (
          <>
            <span className="fm-count">
              {query
                ? `${visibleEntries.length} / ${entries.length}`
                : entries.length}{" "}
              个项目
            </span>
            <span className="fm-selection-summary" title={selected?.name}>
              {selected?.name || ""}
            </span>
          </>
        )}
      </footer>
      <input
        ref={importRef}
        type="file"
        accept=".swcad,.asar,.json,application/json"
        multiple
        hidden
        data-testid="file-manager-import"
        aria-label="导入项目文件"
        disabled={locked}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          importFiles(files);
        }}
      />
      <input
        ref={imageRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        data-testid="file-manager-image-input"
        aria-label="添加项目图片"
        disabled={locked || !attachmentProject}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          addImages(files);
        }}
      />
    </div>
  );
}
