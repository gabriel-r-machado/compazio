import {
  ORCHESTRATOR_COMPOSITION_CLOSE,
  ORCHESTRATOR_COMPOSITION_OPEN,
  ORCHESTRATOR_RESULT_CLOSE,
  ORCHESTRATOR_RESULT_OPEN,
  orchestratorCompositionActionSchema,
  taskResultSchema
} from "@forgedeck/schemas";
import type { OrchestratorCompositionAction, TaskResult } from "@forgedeck/schemas";

/**
 * Stateful parsers for the orchestrator wire protocols. A CLI session plans in natural language and
 * emits one machine-readable payload per envelope, wrapped between sentinels:
 *  - composition actions between `⟦compasso:draft⟧ … ⟦/compasso⟧` (build a draft);
 *  - a worker's structured result between `⟦compasso:result⟧ … ⟦/compasso⟧` (report completion).
 *
 * The desktop treats terminal output as untrusted data: only a full, well-formed, schema-valid envelope
 * becomes a value; chatter and malformed payloads are dropped, never applied. Output arrives in
 * arbitrary chunks, so each parser keeps a remainder buffer. Parsing lives in the domain layer (not the
 * renderer) because the main process — not the LLM and not the UI — owns what counts as a command.
 */

export interface EnvelopeParser<T> {
  /** Feeds a raw output chunk and returns any complete, schema-valid payloads it contained. */
  push(chunk: string): readonly T[];
}

export type CompositionActionParser = EnvelopeParser<OrchestratorCompositionAction>;
export type TaskResultParser = EnvelopeParser<TaskResult>;

/**
 * A deliberately plain, ASCII-only command prefix for real interactive CLIs.
 *
 * The older Unicode envelope remains accepted for backwards compatibility, but terminal agents are
 * instructed to use this line protocol. It survives shells, terminal fonts and copy/paste much more
 * reliably than decorative delimiters, and it makes the command boundary obvious in a live terminal.
 */
export const COMPASSO_DRAFT_LINE_PREFIX = "COMPASSO_DRAFT:";

export function createCompositionActionParser(): CompositionActionParser {
  const legacyEnvelope = createEnvelopeParser(
    ORCHESTRATOR_COMPOSITION_OPEN,
    ORCHESTRATOR_COMPOSITION_CLOSE,
    (json) => {
      const parsed = orchestratorCompositionActionSchema.safeParse(json);
      return parsed.success ? parsed.data : null;
    }
  );
  const lineProtocol = createLineCommandParser(COMPASSO_DRAFT_LINE_PREFIX, (json) => {
    const parsed = orchestratorCompositionActionSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  });
  return {
    push(chunk: string): readonly OrchestratorCompositionAction[] {
      // A real agent must choose one protocol. Keeping legacy parsing here makes interrupted and
      // already-open sessions harmless across an app upgrade, without treating ordinary chatter as a
      // workflow command.
      return [...legacyEnvelope.push(chunk), ...lineProtocol.push(chunk)];
    }
  };
}

export function createTaskResultParser(): TaskResultParser {
  return createEnvelopeParser(ORCHESTRATOR_RESULT_OPEN, ORCHESTRATOR_RESULT_CLOSE, (json) => {
    const parsed = taskResultSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  });
}

// A generous bound on buffered text between an open and close sentinel. If an envelope never closes
// (garbled output), the stale buffer is dropped instead of growing without bound.
const MAX_PENDING_BUFFER = 64 * 1024;

function createEnvelopeParser<T>(
  open: string,
  close: string,
  parse: (json: unknown) => T | null
): EnvelopeParser<T> {
  let buffer = "";
  return {
    push(chunk: string): readonly T[] {
      buffer += stripAnsi(chunk);
      if (buffer.length > MAX_PENDING_BUFFER) {
        const lastOpen = buffer.lastIndexOf(open);
        buffer = lastOpen === -1 ? "" : buffer.slice(lastOpen);
      }
      const values: T[] = [];
      for (;;) {
        const openAt = buffer.indexOf(open);
        if (openAt === -1) {
          buffer = retainPartialSentinel(buffer, open);
          break;
        }
        const contentStart = openAt + open.length;
        const closeAt = buffer.indexOf(close, contentStart);
        if (closeAt === -1) {
          // Wait for the rest of this envelope, discarding anything before the opening sentinel.
          buffer = buffer.slice(openAt);
          break;
        }
        const payload = buffer.slice(contentStart, closeAt);
        buffer = buffer.slice(closeAt + close.length);
        const value = parsePayload(payload, parse);
        if (value !== null) {
          values.push(value);
        }
      }
      return values;
    }
  };
}

/**
 * Parses one strict JSON command per terminal line, for example
 * `COMPASSO_DRAFT: { ... }`. The prefix may appear in ordinary explanatory text, but only a complete
 * schema-valid JSON object after it is admitted. This is important because interactive terminals echo
 * the prompt we send to an agent; an instructional prefix by itself can never mutate the draft.
 */
function createLineCommandParser<T>(
  prefix: string,
  parse: (json: unknown) => T | null
): EnvelopeParser<T> {
  let buffer = "";
  return {
    push(chunk: string): readonly T[] {
      buffer += stripAnsi(chunk);
      if (buffer.length > MAX_PENDING_BUFFER) {
        const lastNewline = Math.max(buffer.lastIndexOf("\n"), buffer.lastIndexOf("\r"));
        buffer = lastNewline === -1 ? buffer.slice(-prefix.length) : buffer.slice(lastNewline + 1);
      }

      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop() ?? "";
      const values: T[] = [];
      for (const line of lines) {
        const prefixAt = line.indexOf(prefix);
        if (prefixAt === -1) continue;
        const value = parsePayload(line.slice(prefixAt + prefix.length), parse);
        if (value !== null) values.push(value);
      }
      return values;
    }
  };
}

function parsePayload<T>(payload: string, parse: (json: unknown) => T | null): T | null {
  const trimmed = payload.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return parse(json);
}

/**
 * Retains a partially received opening sentinel at the tail so the next chunk can complete it, instead
 * of dropping a sentinel that was split mid-token across two output chunks.
 */
function retainPartialSentinel(text: string, open: string): string {
  const maxPrefix = Math.min(text.length, open.length - 1);
  for (let length = maxPrefix; length > 0; length -= 1) {
    if (open.startsWith(text.slice(text.length - length))) {
      return text.slice(text.length - length);
    }
  }
  return "";
}

/** Removes ANSI/OSC escape sequences and backspaces so sentinels survive terminal styling. */
function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const next = value.charCodeAt(index + 1);
      if (next === 91) {
        index += 2;
        while (index < value.length) {
          const finalByte = value.charCodeAt(index);
          if (finalByte >= 64 && finalByte <= 126) break;
          index += 1;
        }
      } else if (next === 93) {
        index += 2;
        while (index < value.length) {
          if (value.charCodeAt(index) === 7) break;
          if (value.charCodeAt(index) === 27 && value.charCodeAt(index + 1) === 92) {
            index += 1;
            break;
          }
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (code === 8) {
      output = output.slice(0, -1);
    } else if (code === 9 || code === 10 || code === 13 || code >= 32) {
      output += value[index];
    }
  }
  return output;
}
