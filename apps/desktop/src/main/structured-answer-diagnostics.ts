/**
 * Safe diagnostics for a structured agent answer that failed validation.
 *
 * When a real model returns something the official schema refuses, the only way to learn WHY is to look at
 * the answer — and the answer is untrusted text that may carry a prompt, a token or an absolute path. So
 * nothing here ever reports a value: it reports SHAPE (types, key names, lengths of collections), the
 * schema's own field paths, and how the answer was wrapped. That is enough to see a mismatch and not enough
 * to leak anything.
 *
 * It is pure and side-effect free: it never mutates the answer and never changes a validation result.
 */

/** A value's shape. Primitives collapse to their type name; containers report size and member shapes. */
export type ShapeSummary =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "unknown"
  | "[REDACTED]"
  | "[MAX_DEPTH]"
  | {
      readonly type: "array";
      readonly length: number;
      readonly itemShapes: readonly ShapeSummary[];
    }
  | {
      readonly type: "object";
      readonly keys: Readonly<Record<string, ShapeSummary>>;
      /** Keys beyond the per-object cap, counted but not described. */
      readonly omittedKeys?: number;
    };

/** How the answer arrived, without any of its content. */
export interface AnswerEnvelope {
  readonly characters: number;
  /** The whole answer is one JSON document, with nothing around it. */
  readonly pureJson: boolean;
  readonly markdownFence: boolean;
  readonly textBeforeJson: boolean;
  readonly textAfterJson: boolean;
  readonly jsonParsed: boolean;
  readonly rootKeys: readonly string[];
}

export interface SchemaIssueSummary {
  readonly index: number;
  readonly code: string;
  /** Schema field path (e.g. `nodes.0.adapter`), never a filesystem path. `<root>` when empty. */
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
}

/** Property names whose contents must never be described, only their type. */
const SENSITIVE_KEY_PATTERN =
  /(prompt|token|key|secret|password|passphrase|cookie|authorization|credential|bearer|session|signature|private|apikey)/i;

const MAX_DEPTH = 4;
const MAX_KEYS = 30;
const MAX_ITEM_SHAPES = 3;
const MAX_MESSAGE_CHARS = 200;

/**
 * Describes a value's shape. Strings, numbers and booleans collapse to their type name, so no value can
 * escape. A sensitive key is renamed and its value reduced to `[REDACTED]`.
 */
export function describeShape(value: unknown, depth = 0): ShapeSummary {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      // Only the first few member shapes: enough to spot a wrong element type, bounded regardless of size.
      itemShapes: value.slice(0, MAX_ITEM_SHAPES).map((item) => describeShape(item, depth + 1))
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const keys: Record<string, ShapeSummary> = {};
    for (const [key, member] of entries.slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        // The name itself is replaced, and the contents are never described at all.
        keys[uniqueKey(keys, "[REDACTED_KEY]")] = "[REDACTED]";
        continue;
      }
      keys[uniqueKey(keys, key)] = describeShape(member, depth + 1);
    }
    const omitted = entries.length - Math.min(entries.length, MAX_KEYS);
    return omitted > 0 ? { type: "object", keys, omittedKeys: omitted } : { type: "object", keys };
  }
  return "unknown";
}

/**
 * Reports how the answer was wrapped and which root keys it carried. Parsing here is a read-only probe: the
 * caller's own parse result is unaffected.
 */
export function describeAnswerEnvelope(raw: string): AnswerEnvelope {
  const trimmed = raw.trim();
  const markdownFence = /```/u.test(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const hasBraces = start !== -1 && end > start;
  const candidate = hasBraces ? trimmed.slice(start, end + 1) : "";
  let parsed: unknown = undefined;
  let jsonParsed = false;
  if (hasBraces) {
    try {
      parsed = JSON.parse(candidate);
      jsonParsed = true;
    } catch {
      jsonParsed = false;
    }
  }
  const rootKeys =
    jsonParsed && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>)
          .slice(0, MAX_KEYS)
          .map((key) => (SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED_KEY]" : key))
      : [];
  return {
    characters: raw.length,
    pureJson: hasBraces && start === 0 && end === trimmed.length - 1 && jsonParsed,
    markdownFence,
    textBeforeJson: hasBraces && start > 0,
    textAfterJson: hasBraces && end < trimmed.length - 1,
    jsonParsed,
    rootKeys
  };
}

/**
 * Summarizes validation issues using the schema's own vocabulary: code, field path, and a sanitized
 * message. Expected/received are reported only as TYPE names, never as values.
 */
export function describeSchemaIssues(
  issues: readonly {
    readonly code?: unknown;
    readonly path?: readonly unknown[];
    readonly message?: unknown;
  }[]
): readonly SchemaIssueSummary[] {
  return issues.map((issue, index) => {
    const path = (issue.path ?? []).map((segment) => String(segment)).join(".");
    const expected = readTypeField(issue, "expected");
    const received = readTypeField(issue, "received");
    return {
      index: index + 1,
      code: typeof issue.code === "string" && issue.code.length > 0 ? issue.code : "unknown",
      path: path.length === 0 ? "<root>" : path,
      message: sanitizeMessage(typeof issue.message === "string" ? issue.message : ""),
      ...(expected === null ? {} : { expected }),
      ...(received === null ? {} : { received })
    };
  });
}

/** Renders the issues and the shape as plain lines, ready to print. */
export function formatAnswerDiagnostics(input: {
  readonly envelope: AnswerEnvelope;
  readonly issues: readonly SchemaIssueSummary[];
  readonly shape: ShapeSummary | null;
  readonly schemaValidated: boolean;
}): readonly string[] {
  const lines: string[] = [
    "Answer envelope:",
    `- characters: ${input.envelope.characters}`,
    `- pure JSON: ${String(input.envelope.pureJson)}`,
    `- markdown fence: ${String(input.envelope.markdownFence)}`,
    `- text before JSON: ${String(input.envelope.textBeforeJson)}`,
    `- text after JSON: ${String(input.envelope.textAfterJson)}`,
    `- JSON parsed: ${String(input.envelope.jsonParsed)}`,
    `- schema validated: ${String(input.schemaValidated)}`,
    `- root keys: ${input.envelope.rootKeys.join(", ") || "(none)"}`
  ];
  for (const issue of input.issues) {
    lines.push(
      `Schema issue ${issue.index}:`,
      `- code: ${issue.code}`,
      `- path: ${issue.path}`,
      `- message: ${issue.message}`
    );
    if (issue.expected !== undefined) lines.push(`- expected type: ${issue.expected}`);
    if (issue.received !== undefined) lines.push(`- received type: ${issue.received}`);
  }
  if (input.shape !== null) {
    lines.push("Answer shape (types only, no values):", JSON.stringify(input.shape, null, 2));
  }
  return lines;
}

function uniqueKey(keys: Readonly<Record<string, unknown>>, candidate: string): string {
  if (!(candidate in keys)) return candidate;
  let suffix = 2;
  while (`${candidate}_${String(suffix)}` in keys) suffix += 1;
  return `${candidate}_${String(suffix)}`;
}

/** Reads a type-name field, refusing anything that is not a short type token. */
function readTypeField(issue: object, field: string): string | null {
  if (!(field in issue)) return null;
  const value = (issue as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  return value;
}

/**
 * Bounds a schema message and strips anything path-shaped. Schema messages carry type names, but a custom
 * refinement could embed something else, so absolute paths are replaced rather than trusted.
 */
function sanitizeMessage(message: string): string {
  const withoutWindowsPaths = message.replace(/[A-Za-z]:\\[^\s"']*/gu, "[path]");
  const withoutPosixPaths = withoutWindowsPaths.replace(/(?:\/[\w.-]+){2,}/gu, "[path]");
  const collapsed = withoutPosixPaths.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_MESSAGE_CHARS
    ? `${collapsed.slice(0, MAX_MESSAGE_CHARS)}…`
    : collapsed;
}
