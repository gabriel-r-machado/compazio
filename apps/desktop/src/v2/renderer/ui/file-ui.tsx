import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type {
  AgentFileContext,
  FileEntry,
  FilePreview,
  FileReadResult,
  FileTreeNode,
  GitChangedFile,
  GitRepositorySnapshot,
  Workspace
} from "@forgedeck/compazio-v2-domain";

interface SharedProps {
  readonly workspace: Workspace;
  readonly onWorkspace: (workspace: Workspace) => Promise<void>;
  readonly onError: (message: string) => void;
}

export function FileTreeCard({
  node,
  workspace,
  onWorkspace,
  onError
}: SharedProps & { readonly node: FileTreeNode }) {
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [opened, setOpened] = useState<FileReadResult | null>(null);
  const [draft, setDraft] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [git, setGit] = useState<GitRepositorySnapshot | null>(null);
  const [diff, setDiff] = useState("");
  const [selectedHunk, setSelectedHunk] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = node.searchQuery?.trim()
        ? await window.compazioV2.files.search({
            workspaceId: workspace.id,
            query: node.searchQuery,
            path: node.currentPath
          })
        : await window.compazioV2.files.list({ workspaceId: workspace.id, path: node.currentPath });
      setEntries(next);
      if (node.viewMode === "diff") {
        setGit(await window.compazioV2.git.status({ workspaceId: workspace.id }));
      }
    } catch (error) {
      // Diff is optional: a regular folder without .git stays a usable file canvas.
      if (node.viewMode === "diff" && isRepositoryUnavailable(error)) {
        setGit(null);
        setDiff("");
        return;
      }
      onError(messageFor(error));
    } finally {
      setLoading(false);
    }
  }, [node.currentPath, node.searchQuery, node.viewMode, onError, workspace.id]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void refresh());
    return () => window.cancelAnimationFrame(frame);
  }, [refresh]);

  useEffect(() => {
    void window.compazioV2.files
      .watch({ workspaceId: workspace.id, treeNodeId: node.id, path: node.currentPath })
      .catch((error: unknown) => onError(messageFor(error)));
    const unsubscribe = window.compazioV2.files.onEvent((event) => {
      if (event.treeNodeId !== node.id) return;
      setExternalChange(true);
      void refresh();
    });
    return () => {
      unsubscribe();
      void window.compazioV2.files.unwatch({ workspaceId: workspace.id, treeNodeId: node.id });
    };
  }, [node.currentPath, node.id, onError, refresh, workspace.id]);

  const updateTree = useCallback(
    async (patch: Parameters<typeof window.compazioV2.nodes.updateFileTree>[0]): Promise<void> => {
      await onWorkspace(await window.compazioV2.nodes.updateFileTree(patch));
    },
    [onWorkspace]
  );

  const navigate = (path: string): void => {
    const history = [...node.history.slice(0, node.historyIndex + 1), path];
    void updateTree({
      workspaceId: workspace.id,
      nodeId: node.id,
      currentPath: path,
      history,
      historyIndex: history.length - 1,
      selectedPath: undefined
    }).catch((error: unknown) => onError(messageFor(error)));
  };

  const open = (entry: FileEntry): void => {
    if (entry.kind === "directory") {
      navigate(entry.path);
      return;
    }
    void (async () => {
      try {
        const result = await window.compazioV2.files.read({
          workspaceId: workspace.id,
          path: entry.path
        });
        setOpened(result);
        setDraft(result.content);
        setExternalChange(false);
        await updateTree({
          workspaceId: workspace.id,
          nodeId: node.id,
          selectedPath: entry.path,
          editor: { ...node.editor, openedPath: entry.path }
        });
      } catch (error) {
        onError(messageFor(error));
      }
    })();
  };

  const pin = (entry: FileEntry): void => {
    if (entry.kind !== "file") return;
    void window.compazioV2.nodes
      .addFilePreview({
        workspaceId: workspace.id,
        filePath: entry.path,
        previewKind: entry.previewKind ?? "unsupported"
      })
      .then(onWorkspace)
      .catch((error: unknown) => onError(messageFor(error)));
  };

  const send = (context: AgentFileContext): void => {
    const terminals = connectedTerminals(workspace, node.id);
    if (terminals.length === 0) {
      onError("Conecte esta árvore a um terminal com a capacidade de compartilhar contexto.");
      return;
    }
    // Electron deliberately does not expose window.prompt. The file card already has an explicit
    // canvas connection, so its first connected terminal is a deterministic safe destination.
    // The person can connect only the intended recipient when there is more than one.
    const selected = terminals[0];
    if (selected === undefined) return;
    void window.compazioV2.files
      .sendContext({
        workspaceId: workspace.id,
        sourceNodeId: node.id,
        targetTerminalId: selected.id,
        context
      })
      .catch((error: unknown) => onError(messageFor(error)));
  };

  const save = (): void => {
    if (opened === null) return;
    void window.compazioV2.files
      .write({
        workspaceId: workspace.id,
        path: opened.path,
        content: draft,
        expectedRevision: opened.revision
      })
      .then((next) => {
        setOpened(next);
        setDraft(next.content);
        setExternalChange(false);
        void refresh();
      })
      .catch((error: unknown) => {
        setExternalChange(true);
        onError(messageFor(error));
      });
  };

  const loadDiff = (file: GitChangedFile): void => {
    void window.compazioV2.git
      .diff({ workspaceId: workspace.id, path: file.path })
      .then(async ({ diff: next }) => {
        setDiff(next);
        setSelectedHunk(null);
        await updateTree({
          workspaceId: workspace.id,
          nodeId: node.id,
          diff: { ...node.diff, selectedFile: file.path, selectedHunkId: undefined }
        });
      })
      .catch((error: unknown) => onError(messageFor(error)));
  };

  const selectHunk = (hunk: string, index: number): void => {
    const id = `${node.diff.selectedFile ?? "diff"}:${index}`;
    setSelectedHunk(id);
    void updateTree({
      workspaceId: workspace.id,
      nodeId: node.id,
      diff: { ...node.diff, selectedHunkId: id }
    }).catch((error: unknown) => onError(messageFor(error)));
    if (node.diff.selectedFile === undefined) return;
    send({
      kind: "diff",
      workspaceId: workspace.id,
      path: node.diff.selectedFile,
      relativePath: node.diff.selectedFile,
      diff: hunk,
      metadata: { selectedHunk: id }
    });
  };

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.ctrlKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  };

  const visibleEntries = useMemo(() => entries.filter((entry) => !entry.hidden), [entries]);
  return (
    <div className="v2-file-tree-body">
      <div className="v2-file-tree-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button
          onClick={() =>
            node.historyIndex > 0 && navigate(node.history[node.historyIndex - 1] ?? ".")
          }
          disabled={node.historyIndex <= 0}
          aria-label="Voltar"
        >
          ←
        </button>
        <button
          onClick={() => navigate(parentPath(node.currentPath))}
          disabled={node.currentPath === "."}
          aria-label="Subir pasta"
        >
          ↑
        </button>
        <span title={node.currentPath} aria-label="Pasta atual">
          {node.currentPath === "." ? "Arquivos do projeto" : node.currentPath}
        </span>
        <button onClick={() => void refresh()} aria-label="Atualizar arquivos">
          ↻
        </button>
      </div>
      <div
        className="v2-file-tree-controls v2-file-tree-modes"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {(["list", "grid", "diff"] as const).map((mode) => (
          <button
            key={mode}
            className={node.viewMode === mode ? "active" : ""}
            aria-pressed={node.viewMode === mode}
            onClick={() =>
              void updateTree({ workspaceId: workspace.id, nodeId: node.id, viewMode: mode }).catch(
                (error: unknown) => onError(messageFor(error))
              )
            }
          >
            {mode === "list" ? "Lista" : mode === "grid" ? "Grade" : "Diff"}
          </button>
        ))}
        <input
          aria-label="Buscar arquivos"
          placeholder="Buscar"
          defaultValue={node.searchQuery ?? ""}
          onChange={(event) =>
            void updateTree({
              workspaceId: workspace.id,
              nodeId: node.id,
              searchQuery: event.target.value || undefined
            }).catch((error: unknown) => onError(messageFor(error)))
          }
        />
      </div>
      {externalChange && (
        <div className="v2-file-notice" role="status">
          Alteração externa detectada. <button onClick={() => void refresh()}>Atualizar</button>
        </div>
      )}
      {node.viewMode === "diff" ? (
        <DiffReview
          workspace={workspace}
          git={git}
          diff={diff}
          selectedHunk={selectedHunk}
          onRefresh={() => void refresh()}
          onSelect={loadDiff}
          onSelectHunk={selectHunk}
          onError={onError}
        />
      ) : opened !== null ? (
        <LightEditor
          file={opened}
          draft={draft}
          find={find}
          replace={replace}
          externalChange={externalChange}
          onDraft={setDraft}
          onFind={setFind}
          onReplace={setReplace}
          onReplaceAll={() => find !== "" && setDraft((value) => value.split(find).join(replace))}
          onSave={save}
          onReload={() =>
            open({
              path: opened.path,
              name: opened.path.split("/").at(-1) ?? opened.path,
              kind: "file",
              size: opened.revision.size,
              modifiedAt: opened.revision.modifiedAt,
              hidden: false,
              previewKind: "text"
            })
          }
          onSendSelection={(selection) =>
            send({
              kind: "selection",
              workspaceId: workspace.id,
              path: opened.path,
              relativePath: opened.path,
              revision: opened.revision,
              contentPreview: selection,
              startLine: 1,
              endLine: Math.max(1, selection.split("\n").length)
            })
          }
          onKeyDown={onEditorKeyDown}
        />
      ) : loading ? (
        <p className="v2-file-empty">Carregando arquivos…</p>
      ) : node.viewMode === "grid" ? (
        <div className="v2-file-grid">
          {visibleEntries.map((entry) => (
            <FileEntryCard
              key={entry.path}
              entry={entry}
              onOpen={open}
              onPin={pin}
              onSend={(candidate) => send(sendFileEntry(workspace.id, candidate))}
              sourceNodeId={node.id}
            />
          ))}
        </div>
      ) : (
        <div className="v2-file-list" role="tree" aria-label="Arquivos do workspace">
          {visibleEntries.length === 0 ? (
            <div className="v2-file-empty">
              <strong>Esta pasta está vazia</strong>
              <span>Abra outra pasta ou arraste arquivos para o canvas.</span>
            </div>
          ) : (
            visibleEntries.map((entry) => (
              <FileEntryCard
                key={entry.path}
                entry={entry}
                onOpen={open}
                onPin={pin}
                onSend={(candidate) => send(sendFileEntry(workspace.id, candidate))}
                sourceNodeId={node.id}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FileEntryCard({
  entry,
  onOpen,
  onPin,
  onSend,
  sourceNodeId
}: {
  readonly entry: FileEntry;
  readonly onOpen: (entry: FileEntry) => void;
  readonly onPin: (entry: FileEntry) => void;
  readonly onSend: (entry: FileEntry) => unknown;
  readonly sourceNodeId: string;
}) {
  return (
    <article
      className="v2-file-entry"
      role="treeitem"
      draggable={entry.kind === "file"}
      aria-label={`${entry.kind === "directory" ? "Pasta" : "Arquivo"} ${entry.name}`}
      onDragStart={(event) => {
        event.dataTransfer.setData(
          "application/x-compazio-file",
          JSON.stringify({
            sourceNodeId,
            path: entry.path,
            kind: entry.previewKind ?? "unsupported"
          })
        );
        event.dataTransfer.effectAllowed = "copy";
      }}
      onDoubleClick={() => onOpen(entry)}
    >
      <button onClick={() => onOpen(entry)}>
        {entry.kind === "directory" ? "▸" : iconFor(entry)} {entry.name}
      </button>
      {entry.kind === "file" && (
        <div>
          <button onClick={() => onPin(entry)}>Fixar</button>
          <button onClick={() => void onSend(entry)}>Enviar</button>
        </div>
      )}
      <small>{entry.kind === "file" ? formatSize(entry.size) : "Pasta"}</small>
    </article>
  );
}

function LightEditor({
  file,
  draft,
  find,
  replace,
  externalChange,
  onDraft,
  onFind,
  onReplace,
  onReplaceAll,
  onSave,
  onReload,
  onSendSelection,
  onKeyDown
}: {
  readonly file: FileReadResult;
  readonly draft: string;
  readonly find: string;
  readonly replace: string;
  readonly externalChange: boolean;
  readonly onDraft: (value: string) => void;
  readonly onFind: (value: string) => void;
  readonly onReplace: (value: string) => void;
  readonly onReplaceAll: () => void;
  readonly onSave: () => void;
  readonly onReload: () => void;
  readonly onSendSelection: (selection: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <div className="v2-light-editor" onPointerDown={(event) => event.stopPropagation()}>
      <header>
        <strong>{file.path}</strong>
        <button onClick={onSave}>Salvar</button>
        <button onClick={onReload} disabled={!externalChange}>
          Recarregar
        </button>
      </header>
      <div className="v2-editor-find">
        <input
          value={find}
          onChange={(event) => onFind(event.target.value)}
          placeholder="Localizar"
        />
        <input
          value={replace}
          onChange={(event) => onReplace(event.target.value)}
          placeholder="Substituir"
        />
        <button onClick={onReplaceAll} disabled={!find}>
          Substituir tudo
        </button>
      </div>
      <div className="v2-editor-main">
        <pre aria-hidden="true">{lineNumbers(draft)}</pre>
        <textarea
          aria-label={`Editor ${file.path}`}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onMouseUp={(event) => {
            const text = event.currentTarget.value.slice(
              event.currentTarget.selectionStart,
              event.currentTarget.selectionEnd
            );
            if (text) onSendSelection(text);
          }}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function DiffReview({
  workspace,
  git,
  diff,
  selectedHunk,
  onRefresh,
  onSelect,
  onSelectHunk,
  onError
}: {
  readonly workspace: Workspace;
  readonly git: GitRepositorySnapshot | null;
  readonly diff: string;
  readonly selectedHunk: string | null;
  readonly onRefresh: () => void;
  readonly onSelect: (file: GitChangedFile) => void;
  readonly onSelectHunk: (hunk: string, index: number) => void;
  readonly onError: (message: string) => void;
}) {
  const hunks = splitHunks(diff);
  return (
    <div className="v2-diff" onPointerDown={(event) => event.stopPropagation()}>
      <header>
        <span>
          {git === null
            ? "Git não disponível"
            : `${git.branch ?? "HEAD"} · ${git.files.length} alterações`}
        </span>
        <button onClick={onRefresh}>Atualizar</button>
      </header>
      <div className="v2-diff-files">
        {git?.files.map((file) => (
          <article key={file.path}>
            <button onClick={() => onSelect(file)}>
              {gitStatusSymbol(file.status)} {file.path}
            </button>
            <button
              onClick={() =>
                void window.compazioV2.git[file.staged ? "unstage" : "stage"]({
                  workspaceId: workspace.id,
                  paths: [file.path]
                })
                  .then(onRefresh)
                  .catch((error: unknown) => onError(messageFor(error)))
              }
            >
              {file.staged ? "Unstage" : "Stage"}
            </button>
          </article>
        ))}
      </div>
      {hunks.map((hunk, index) => (
        <button
          key={`${index}-${hunk.slice(0, 20)}`}
          className={selectedHunk?.endsWith(`:${index}`) ? "v2-diff-hunk selected" : "v2-diff-hunk"}
          onClick={() => onSelectHunk(hunk, index)}
        >
          <pre>{hunk}</pre>
          <span>Selecionar e enviar hunk</span>
        </button>
      ))}
    </div>
  );
}

export function FilePreviewCard({
  node,
  workspace,
  onWorkspace,
  onError
}: SharedProps & {
  readonly node: Extract<Workspace["nodes"][number], { readonly type: "file-preview" }>;
}) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const refresh = useCallback(() => {
    void window.compazioV2.files
      .preview({ workspaceId: workspace.id, path: node.filePath })
      .then((next) => {
        setPreview(next);
        if (next.missing !== node.missing)
          void window.compazioV2.nodes
            .updateFilePreview({
              workspaceId: workspace.id,
              nodeId: node.id,
              missing: next.missing
            })
            .then(onWorkspace)
            .catch((error: unknown) => onError(messageFor(error)));
      })
      .catch((error: unknown) => onError(messageFor(error)));
  }, [node.filePath, node.id, node.missing, onError, onWorkspace, workspace.id]);
  useEffect(refresh, [refresh]);
  useEffect(
    () =>
      window.compazioV2.files.onEvent((event) => {
        if (event.workspaceId === workspace.id && event.path === node.filePath) refresh();
      }),
    [node.filePath, refresh, workspace.id]
  );
  if (preview?.missing || node.missing)
    return (
      <div className="v2-preview-missing">
        <strong>Arquivo não encontrado</strong>
        <span>{node.filePath}</span>
        <button onClick={refresh}>Localizar novamente</button>
      </div>
    );
  return (
    <div className="v2-preview" onPointerDown={(event) => event.stopPropagation()}>
      {preview?.kind === "image" && preview.dataUrl ? (
        <img src={preview.dataUrl} alt={`Preview de ${node.title}`} />
      ) : preview?.kind === "text" ? (
        <pre>{preview.textPreview}</pre>
      ) : (
        <div>
          <strong>{node.previewKind === "pdf" ? "PDF" : "Preview indisponível"}</strong>
          <span>{node.filePath}</span>
          <small>O conteúdo não é executado no Compazio.</small>
        </div>
      )}
      <footer>
        <button onClick={refresh}>Atualizar</button>
        <button onClick={() => navigator.clipboard.writeText(node.filePath).catch(() => undefined)}>
          Copiar caminho
        </button>
      </footer>
    </div>
  );
}

function connectedTerminals(workspace: Workspace, sourceNodeId: string) {
  return workspace.nodes.filter(
    (node) =>
      node.type === "terminal" &&
      workspace.edges.some(
        (edge) =>
          ((edge.sourceNodeId === sourceNodeId && edge.targetNodeId === node.id) ||
            (edge.targetNodeId === sourceNodeId && edge.sourceNodeId === node.id)) &&
          edge.capabilities.includes("share-context")
      )
  );
}
function sendFileEntry(workspaceId: string, entry: FileEntry): AgentFileContext {
  return {
    kind:
      entry.kind === "directory"
        ? "directory"
        : entry.previewKind === "image"
          ? "image"
          : entry.previewKind === "pdf"
            ? "pdf"
            : "file",
    workspaceId,
    path: entry.path,
    relativePath: entry.path,
    metadata: { size: String(entry.size) }
  };
}
function parentPath(path: string): string {
  const pieces = path.split("/");
  pieces.pop();
  return pieces.filter(Boolean).join("/") || ".";
}
function splitHunks(diff: string): readonly string[] {
  return diff.split(/(?=^@@ )/m).filter((part) => part.includes("@@ "));
}
function lineNumbers(value: string): string {
  return value
    .split("\n")
    .map((_, index) => String(index + 1))
    .join("\n");
}
function iconFor(entry: FileEntry): string {
  return entry.previewKind === "image" ? "▧" : entry.previewKind === "pdf" ? "PDF" : "·";
}
function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
function gitStatusSymbol(status: GitChangedFile["status"]): string {
  return {
    modified: "M",
    added: "A",
    deleted: "D",
    renamed: "R",
    copied: "C",
    untracked: "?",
    ignored: "I",
    conflicted: "!"
  }[status];
}
function isRepositoryUnavailable(error: unknown): boolean {
  const record = error as { readonly code?: unknown; readonly message?: unknown } | null;
  return (
    record?.code === "GIT_REPOSITORY_NOT_FOUND" ||
    (typeof record?.message === "string" && /reposit[oó]rio git/i.test(record.message))
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "A operação não pôde ser concluída.";
}
