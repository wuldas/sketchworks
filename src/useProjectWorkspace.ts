import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { type Document } from "./model";
import {
  createProject,
  decodeProject,
  encodeProject,
  withProjectDocument,
  type CadProject,
} from "./projectArchive";
import {
  virtualFiles,
  type VfsEntry,
  type VfsFileEntry,
} from "./virtualFileSystem";
const isFile = (entry: VfsEntry | undefined): entry is VfsFileEntry =>
  entry?.kind === "file";

const DOCUMENT_KEY = "sketchworks.document.v1";
const TIME_KEY = "sketchworks.workspace.updated.v1";
const sameDocument = (a: Document, b: Document) =>
  a.sketches[0]?.id === b.sketches[0]?.id;
const blobFor = (project: CadProject) =>
  new Blob([new Uint8Array(encodeProject(project))], {
    type: "application/octet-stream",
  });
export { blobFor as projectBlob };

export function useProjectWorkspace({
  document: doc,
  documentRef,
  editorReady,
  notify,
  onRestore,
}: {
  document: Document;
  documentRef: RefObject<Document>;
  editorReady: boolean;
  notify: (message: string, error?: boolean) => void;
  onRestore: (project: CadProject) => boolean;
}) {
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeFile, setActiveFile] = useState<VfsFileEntry | null>(null);
  const [, setProjectVersion] = useState(0);
  const projectRef = useRef<CadProject | null>(null);
  if (!projectRef.current) projectRef.current = createProject(doc);
  const activeRef = useRef<VfsFileEntry | null>(null);
  const generation = useRef(0);
  const available = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const started = useRef(false);
  const initialized = useRef(false);
  const mounted = useRef(true);
  const restoring = useRef(onRestore);
  restoring.current = onRestore;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setFile = useCallback((file: VfsFileEntry | null) => {
    activeRef.current = file;
    if (mounted.current) setActiveFile(file);
  }, []);

  useEffect(() => {
    if (!editorReady || started.current) return;
    started.current = true;
    const original = documentRef.current;
    const epoch = generation.current;
    void (async () => {
      try {
        const snapshot = await virtualFiles.readWorkspace();
        if (!mounted.current || epoch !== generation.current) return;
        if (snapshot) {
          const project = decodeProject(await snapshot.contents.arrayBuffer());
          if (!mounted.current || epoch !== generation.current) return;
          const current = documentRef.current;
          const changed = current !== original;
          let legacyTime = 0;
          try {
            legacyTime = Number(localStorage.getItem(TIME_KEY) || 0);
          } catch {
            /* IndexedDB can still restore the project. */
          }
          const keepCurrent = changed || legacyTime > snapshot.updatedAt;
          if (keepCurrent && !sameDocument(current, project.document)) {
            projectRef.current = createProject(current);
          } else if (keepCurrent || restoring.current(project)) {
            projectRef.current = withProjectDocument(
              project,
              documentRef.current,
            );
            if (snapshot.fileId) {
              const file = await virtualFiles.get(snapshot.fileId);
              if (
                mounted.current &&
                epoch === generation.current &&
                isFile(file)
              )
                setFile(file);
            }
          }
          if (mounted.current) setProjectVersion((value) => value + 1);
        }
      } catch (error) {
        available.current = false;
        if (mounted.current)
          notify(`项目恢复失败：${(error as Error).message}`, true);
      } finally {
        if (mounted.current) {
          initialized.current = true;
          setReady(true);
        }
      }
    })();
  }, [editorReady, documentRef, notify, setFile]);

  const persist = useCallback(
    (snapshot: Document = documentRef.current) => {
      if (!initialized.current)
        return Promise.reject(new Error("项目存储正在恢复，请稍后保存"));
      const epoch = generation.current;
      const task = queue.current
        .catch(() => {})
        .then(async () => {
          if (epoch !== generation.current || !mounted.current) return;
          let legacySaved = false;
          const time = Date.now();
          try {
            localStorage.setItem(DOCUMENT_KEY, JSON.stringify(snapshot));
            localStorage.setItem(TIME_KEY, String(time));
            legacySaved = true;
          } catch {
            /* File and workspace storage are independent from localStorage quota. */
          }
          try {
            if (available.current) {
              const base = sameDocument(projectRef.current!.document, snapshot)
                ? projectRef.current!
                : createProject(snapshot);
              const project = withProjectDocument(base, snapshot);
              const contents = blobFor(project);
              const file = activeRef.current;
              if (file) {
                try {
                  const updated = await virtualFiles.updateFile(
                    file.id,
                    contents,
                  );
                  if (
                    epoch === generation.current &&
                    activeRef.current?.id === file.id
                  )
                    setFile(updated);
                } catch (error) {
                  const exists = await virtualFiles.get(file.id);
                  if (
                    !exists &&
                    epoch === generation.current &&
                    activeRef.current?.id === file.id
                  ) {
                    setFile(null);
                  } else throw error;
                }
              }
              if (epoch !== generation.current) return;
              await virtualFiles.writeWorkspace({
                contents,
                fileId: activeRef.current?.id ?? null,
                updatedAt: time,
              });
            } else if (!legacySaved) {
              throw new Error("浏览器无法保存当前项目");
            }
            if (
              mounted.current &&
              epoch === generation.current &&
              documentRef.current === snapshot
            )
              setSaved(true);
          } catch (error) {
            if (mounted.current && epoch === generation.current) {
              setSaved(false);
              notify(`项目保存失败：${(error as Error).message}`, true);
            }
            throw error;
          }
        });
      queue.current = task.catch(() => {});
      return task;
    },
    [documentRef, notify, setFile],
  );

  useEffect(() => {
    setSaved(false);
    if (!ready || !editorReady) return;
    const timer = setTimeout(() => {
      void persist(doc).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [doc, ready, editorReady, activeFile?.id, persist]);

  const attach = useCallback(
    (file: VfsFileEntry, project: CadProject) => {
      generation.current += 1;
      available.current = true;
      projectRef.current = withProjectDocument(project, documentRef.current);
      setFile(file);
      setSaved(false);
      setProjectVersion((value) => value + 1);
      void persist().catch(() => {});
    },
    [documentRef, persist, setFile],
  );

  const detach = useCallback(
    (next: Document, project?: CadProject) => {
      generation.current += 1;
      projectRef.current = project
        ? withProjectDocument(project, next)
        : createProject(next);
      setFile(null);
      setSaved(false);
      setProjectVersion((value) => value + 1);
    },
    [setFile],
  );

  const updateProject = useCallback(
    (file: VfsFileEntry, project: CadProject) => {
      if (activeRef.current?.id !== file.id) return;
      generation.current += 1;
      projectRef.current = withProjectDocument(project, documentRef.current);
      setFile(file);
      setProjectVersion((value) => value + 1);
      void persist().catch(() => {});
    },
    [documentRef, persist, setFile],
  );

  const refresh = useCallback(async () => {
    const file = activeRef.current;
    if (!file) return;
    const epoch = generation.current;
    const current = await virtualFiles.get(file.id);
    if (epoch !== generation.current || activeRef.current?.id !== file.id)
      return;
    if (isFile(current)) setFile(current);
    else {
      generation.current += 1;
      setFile(null);
      setSaved(false);
      void persist().catch(() => {});
    }
  }, [persist, setFile]);

  return {
    ready,
    saved,
    activeFile,
    project: projectRef.current!,
    persist,
    attach,
    detach,
    updateProject,
    refresh,
    flush: () => queue.current,
    currentProject: () =>
      withProjectDocument(projectRef.current!, documentRef.current),
  };
}
