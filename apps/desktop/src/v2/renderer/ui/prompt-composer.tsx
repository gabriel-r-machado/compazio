import { useMemo, useState } from "react";

import type {
  CanvasNode,
  TerminalNode,
  TerminalSession,
  Workspace
} from "@forgedeck/compazio-v2-domain";

import { preparePrompt, type PromptContextItem } from "./prompt-composition";

export function PromptComposer({
  workspace,
  target,
  session,
  selection,
  onClose,
  onSend,
  onQuickAction
}: {
  readonly workspace: Workspace;
  readonly target: TerminalNode;
  readonly session: TerminalSession | undefined;
  readonly selection?: CanvasNode;
  readonly onClose: () => void;
  readonly onSend: (text: string) => Promise<void>;
  readonly onQuickAction: (action: "terminal" | "note" | "tree") => void;
}) {
  const [body, setBody] = useState("");
  const [items, setItems] = useState<readonly PromptContextItem[]>([]);
  const [sending, setSending] = useState(false);
  const contextOptions = useMemo(
    () => workspace.nodes.filter((node) => node.id !== target.id).map(toPromptContext),
    [target.id, workspace.nodes]
  );
  const prepared = preparePrompt(body, items);
  const add = (item: PromptContextItem): void => setItems((current) => [...current, item]);
  const submit = (): void => {
    if (session === undefined || prepared.text === "") return;
    setSending(true);
    void onSend(prepared.text)
      .then(() => {
        setBody("");
        setItems([]);
        onClose();
      })
      .finally(() => setSending(false));
  };
  return (
    <aside className="v2-prompt-composer" role="dialog" aria-label="Compositor de prompt">
      <header>
        <div>
          <small>Enviar ao terminal real</small>
          <strong>{target.title}</strong>
        </div>
        <button onClick={onClose} aria-label="Fechar compositor">
          ×
        </button>
      </header>
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="Escreva para o agente. A resposta continuará no terminal."
      />
      <div className="v2-composer-actions" aria-label="Adicionar contexto">
        {selection !== undefined && (
          <button onClick={() => add(toPromptContext(selection))}>Compartilhar seleção</button>
        )}
        {contextOptions.map((item) => (
          <button key={item.id} onClick={() => add(item)}>
            @{item.title}
          </button>
        ))}
      </div>
      {items.length > 0 && (
        <div className="v2-composer-context" aria-label="Contextos anexados">
          {items.map((item, index) => (
            <span key={`${item.id}-${index}`}>
              @{item.title}
              <button
                onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                aria-label={`Remover ${item.title}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {(prepared.duplicateIds.length > 0 || prepared.unavailableIds.length > 0) && (
        <p className="v2-composer-warning">
          {prepared.duplicateIds.length > 0 && "Itens duplicados serão enviados uma vez. "}
          {prepared.unavailableIds.length > 0 && "Itens indisponíveis foram ignorados."}
        </p>
      )}
      <footer>
        <div>
          <button onClick={() => onQuickAction("terminal")}>Novo terminal</button>
          <button onClick={() => onQuickAction("note")}>Nova nota</button>
          <button onClick={() => onQuickAction("tree")}>Nova árvore</button>
        </div>
        <span>{Math.ceil(prepared.bytes / 1024)} KB</span>
        <button
          aria-label="Enviar prompt"
          disabled={session === undefined || prepared.text === "" || sending}
          onClick={submit}
        >
          {sending ? "Enviando…" : "Enviar"}
        </button>
      </footer>
    </aside>
  );
}

function toPromptContext(node: CanvasNode): PromptContextItem {
  if (node.type === "note")
    return { id: node.id, kind: "note", title: node.title, value: node.content };
  if (node.type === "file-preview")
    return {
      id: node.id,
      kind: node.previewKind === "image" ? "image" : "file",
      title: node.title,
      value: node.filePath,
      unavailable: node.missing
    };
  if (node.type === "file-tree")
    return { id: node.id, kind: "tree", title: node.title, value: node.rootPath };
  if (node.type === "portal")
    return {
      id: node.id,
      kind: "portal",
      title: node.title,
      value: `${node.id}\nURL: ${node.url}`
    };
  return {
    id: node.id,
    kind: "terminal",
    title: node.title,
    value: node.id
  };
}
