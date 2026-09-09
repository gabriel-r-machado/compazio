import { ORCHESTRATOR_LABEL } from "./role-labels";

export type PromptContextKind =
  "terminal" | "note" | "file" | "image" | "tree" | "portal" | "orchestrator" | "team";

export interface PromptContextItem {
  readonly id: string;
  readonly kind: PromptContextKind;
  readonly title: string;
  readonly value: string;
  readonly unavailable?: boolean;
}

export interface PreparedPrompt {
  readonly text: string;
  readonly bytes: number;
  readonly duplicateIds: readonly string[];
  readonly unavailableIds: readonly string[];
}

/** Prepares contextual text for a real terminal without persisting terminal output or secrets. */
export function preparePrompt(body: string, items: readonly PromptContextItem[]): PreparedPrompt {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const unavailableIds: string[] = [];
  const context: string[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      duplicateIds.push(item.id);
      continue;
    }
    seen.add(item.id);
    if (item.unavailable) {
      unavailableIds.push(item.id);
      continue;
    }
    context.push(renderItem(item));
  }
  const text = [body.trim(), ...context]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 64 * 1024);
  return { text, bytes: new TextEncoder().encode(text).byteLength, duplicateIds, unavailableIds };
}

function renderItem(item: PromptContextItem): string {
  if (item.kind === "note")
    return `@Nota ${item.title}\n${item.value.slice(0, 20_000)}\nUse as ferramentas context_list/note_update para reler ou atualizar esta nota conectada.`;
  if (item.kind === "image")
    return `@Imagem ${item.title}\nCaminho: ${item.value}\nAbra e analise visualmente esta imagem; não deduza seu conteúdo apenas pelo nome.`;
  if (item.kind === "file")
    return `@Arquivo ${item.title}\nCaminho: ${item.value}\nLeia este arquivo antes de responder.`;
  if (item.kind === "tree") return `@Árvore ${item.title}\nRaiz: ${item.value}`;
  if (item.kind === "portal")
    return `@Portal ${item.title}\n${item.value}\nUse as ferramentas portal_* do Compazio para navegar e extrair informações.`;
  if (item.kind === "orchestrator") return `@${ORCHESTRATOR_LABEL} ${item.title}`;
  if (item.kind === "team") return `@Equipe ${item.title}\n${item.value}`;
  return `@Terminal ${item.title}`;
}
