const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

const sensitiveKeyPattern =
  /(?:authorization|cookie|credential|password|passphrase|secret|session|token|api[-_]?key)/i;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const knownTokenPattern = /\b(?:ghp|github_pat|sk)[_-][A-Za-z0-9_-]{8,}\b/g;
const markedSecretPattern = /\bFORGEDECK_(?:TEST_)?SECRET_[A-Za-z0-9_-]+\b/g;
const sensitiveAssignmentPattern =
  /(\b[A-Za-z0-9_]*(?:authorization|credential|password|passphrase|secret|session|token|api[-_]?key)[A-Za-z0-9_]*\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi;
/* eslint-disable no-control-regex -- terminal escape syntax intentionally matches control bytes. */
const terminalEscapePattern = new RegExp(
  "\\u001B(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|\\u001B\\\\))",
  "g"
);
/* eslint-enable no-control-regex */

export function redactText(value: string): string {
  return redactPrintableText(stripTerminalControls(value));
}

export function redactTerminalText(value: string): string {
  return redactPrintableText(value);
}

function redactPrintableText(value: string): string {
  return value
    .replace(bearerPattern, `Bearer ${REDACTED}`)
    .replace(knownTokenPattern, REDACTED)
    .replace(markedSecretPattern, REDACTED)
    .replace(sensitiveAssignmentPattern, `$1${REDACTED}`);
}

function stripTerminalControls(value: string): string {
  return [...value.replace(terminalEscapePattern, "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join("");
}

export function redactValue(value: unknown): unknown {
  return redactValueInternal(value, new WeakSet<object>());
}

function redactValueInternal(value: unknown, visited: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (visited.has(value)) {
    return CIRCULAR;
  }
  visited.add(value);

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack === undefined ? undefined : redactText(value.stack)
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValueInternal(entry, visited));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = sensitiveKeyPattern.test(key) ? REDACTED : redactValueInternal(entry, visited);
  }
  return redacted;
}
