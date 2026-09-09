export interface ComposerMention {
  readonly nodeId: string;
  readonly label: string;
  readonly kind: "agent" | "note" | "material";
}

/**
 * Everything after the last `@` on the current line.
 *
 * Deliberately allows spaces: node titles are sentences people wrote ("Revisor de código"), and a
 * token-only trigger would stop filtering at the first space and never reach them. The list closes
 * on its own once the typed text stops matching any connected node, which is what makes the loose
 * pattern safe — an `@` in a path or an address simply matches nothing.
 */
export const MENTION_TRIGGER = /@([^@\n]*)$/u;

/** Node types carrying nothing an agent could read; mentioning one would name a rectangle. */
const UNMENTIONABLE_TYPES: ReadonlySet<string> = new Set(["shape", "frame", "drawing"]);

/** Machine-facing wording, in Portuguese like every other prompt this app hands to an agent. */
const KIND_LABELS: Readonly<Record<ComposerMention["kind"], string>> = {
  agent: "agente",
  note: "nota",
  material: "material"
};

/** Structural shape of a canvas node, so this module stays free of canvas types. */
interface MentionCandidate {
  readonly id: string;
  readonly type?: string | undefined;
  readonly data: { readonly title: string };
}

interface MentionEdge {
  readonly source: string;
  readonly target: string;
}

/**
 * The nodes a given terminal is allowed to mention: its direct neighbours, either direction.
 *
 * Scoping to neighbours is the point of the feature rather than a limitation — a mention has to
 * name something the agent can actually reach through its own connections, otherwise the composed
 * prompt promises context that the runtime will refuse to assemble.
 */
export function composerMentionsFor(
  nodeId: string,
  nodes: readonly MentionCandidate[],
  edges: readonly MentionEdge[]
): readonly ComposerMention[] {
  const neighbourIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === nodeId) neighbourIds.add(edge.target);
    if (edge.target === nodeId) neighbourIds.add(edge.source);
  }
  const mentions: ComposerMention[] = [];
  const seenLabels = new Set<string>();
  for (const node of nodes) {
    if (!neighbourIds.has(node.id)) continue;
    const type = node.type ?? "task";
    if (UNMENTIONABLE_TYPES.has(type)) continue;
    const label = node.data.title.trim();
    // A duplicate label is unusable: `@Revisor` cannot say which of two "Revisor" nodes it meant.
    if (label.length === 0 || seenLabels.has(label)) continue;
    seenLabels.add(label);
    mentions.push({ nodeId: node.id, label, kind: mentionKind(type) });
  }
  return mentions;
}

/**
 * Why this terminal cannot take a composed prompt, as a translation key, or `null` when it can.
 *
 * A shell is excluded because the text would land on a prompt that reads it as a command line — the
 * failure would be a wall of "command not found", not a refused instruction.
 */
export function composerBlockedKey(
  adapterId: string | undefined,
  hasSession: boolean
): "composer.shellBlocked" | "composer.inactiveBlocked" | null {
  if (adapterId === undefined || adapterId === "shell") return "composer.shellBlocked";
  if (!hasSession) return "composer.inactiveBlocked";
  return null;
}

/**
 * Builds the text actually submitted to the terminal.
 *
 * Mentions are appended as a short, factual reference list rather than expanded inline. The renderer
 * knows a connected node's *name*, not where its bytes live — a note's file path belongs to the main
 * process — so inventing a path here would produce a prompt that reads correctly and points nowhere.
 * The closing line names the one command that does resolve them, which is what turns a mention into
 * something the agent can act on without being told the whole CLI first.
 *
 * Returns `null` when there is nothing to send, so an accidental Enter on an empty box does not
 * write a bare newline into someone's session.
 */
export function composeTerminalPrompt(
  draft: string,
  mentions: readonly ComposerMention[],
  nodeTitle: string
): string | null {
  const text = draft.trim();
  if (text.length === 0) return null;
  const referenced = mentions.filter((mention) => draft.includes(`@${mention.label}`));
  if (referenced.length === 0) return text;
  return [
    text,
    "",
    "REFERÊNCIAS MENCIONADAS (nós conectados a este terminal)",
    ...referenced.map((mention) => `- ${mention.label} (${KIND_LABELS[mention.kind]})`),
    "",
    `Leia o conteúdo dessas conexões com: compazio context "${nodeTitle.replaceAll('"', "")}"`
  ].join("\n");
}

function mentionKind(type: string): ComposerMention["kind"] {
  if (type === "terminal" || type === "agent") return "agent";
  if (type === "note" || type === "comment") return "note";
  return "material";
}
