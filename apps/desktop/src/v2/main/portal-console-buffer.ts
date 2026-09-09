export type PortalConsoleLevel = "debug" | "log" | "info" | "warning" | "error";

export interface PortalConsoleEntry {
  readonly sequence: number;
  readonly level: PortalConsoleLevel;
  readonly message: string;
  readonly source: string;
  readonly line: number;
  readonly timestamp: string;
}

export interface PortalConsoleQuery {
  readonly levels?: readonly PortalConsoleLevel[];
  readonly limit?: number;
  /** Sequence returned by a previous query; only newer entries come back. */
  readonly since?: number;
  readonly sinceTimestamp?: string;
  readonly contains?: string;
}

export interface PortalConsoleQueryResult {
  readonly entries: readonly PortalConsoleEntry[];
  readonly cursor: number;
  readonly capacity: number;
  readonly stored: number;
  /** Entries evicted by the circular buffer since the Portal was created. */
  readonly dropped: number;
}

export interface PortalConsoleBufferOptions {
  readonly capacity?: number;
  readonly maxMessageChars?: number;
  readonly now?: () => Date;
}

const redactions: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  {
    // The scheme is part of the value: redacting only up to the first space would leave the token.
    pattern:
      /\b(authorization|proxy-authorization)\b\s*[:=]\s*(?:bearer|basic|digest|token)?\s*[^\s,;"']+/gi,
    replacement: "$1: [redigido]"
  },
  {
    pattern: /\b(set-cookie|cookie)\b\s*[:=]\s*(?:[^\s;,]+(?:;\s*)?)+/gi,
    replacement: "$1: [redigido]"
  },
  {
    // A quoted JSON key is the common shape in a browser console, so the closing quote is optional.
    pattern:
      /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|token|secret|password|senha|passwd|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: "$1=[redigido]"
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [redigido]" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: "[jwt-redigido]"
  },
  { pattern: /\b(sk|pk|rk)-[A-Za-z0-9]{16,}/g, replacement: "[chave-redigida]" },
  { pattern: /\b(gh[pousr]|xox[baprs])_[A-Za-z0-9]{16,}/g, replacement: "[chave-redigida]" }
];

/** Console output is observability, so it is stored redacted: a leaked header is not a diagnostic. */
export function sanitizePortalConsoleMessage(value: string, maximumChars = 2_000): string {
  let sanitized = String(value);
  for (const redaction of redactions)
    sanitized = sanitized.replace(redaction.pattern, redaction.replacement);
  return sanitized.replace(/\s+/g, " ").trim().slice(0, maximumChars);
}

export function sanitizePortalSource(value: string): string {
  if (value === "") return "desconhecida";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return String(value).replace(/\s+/g, " ").slice(0, 200);
  }
}

/** Electron 43 reports a named level; older releases and tests still send the numeric one. */
export function normalizePortalConsoleLevel(value: unknown): PortalConsoleLevel {
  if (typeof value === "string") {
    const level = value.toLowerCase();
    if (level === "warning" || level === "warn") return "warning";
    if (level === "error") return "error";
    if (level === "info") return "info";
    if (level === "debug" || level === "verbose") return "debug";
    return "log";
  }
  if (value === 3) return "error";
  if (value === 2) return "warning";
  if (value === 1) return "info";
  if (value === -1) return "debug";
  return "log";
}

/**
 * One bounded ring per Portal. It keeps the last N messages and nothing else: no file, no database,
 * no growth without limit, and it is emptied when the Portal goes away.
 */
export class PortalConsoleBuffer {
  public static readonly defaultCapacity = 500;
  public static readonly maximumCapacity = 2_000;

  private readonly entries: PortalConsoleEntry[] = [];
  private readonly capacity: number;
  private readonly maxMessageChars: number;
  private readonly now: () => Date;
  private sequence = 0;
  private droppedCount = 0;

  public constructor(options: PortalConsoleBufferOptions = {}) {
    this.capacity = Math.min(
      Math.max(options.capacity ?? PortalConsoleBuffer.defaultCapacity, 1),
      PortalConsoleBuffer.maximumCapacity
    );
    this.maxMessageChars = options.maxMessageChars ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  public record(input: {
    readonly level: unknown;
    readonly message: string;
    readonly source?: string;
    readonly line?: number;
  }): PortalConsoleEntry {
    const entry: PortalConsoleEntry = {
      sequence: ++this.sequence,
      level: normalizePortalConsoleLevel(input.level),
      message: sanitizePortalConsoleMessage(input.message, this.maxMessageChars),
      source: sanitizePortalSource(input.source ?? ""),
      line: Number.isFinite(input.line) ? Number(input.line) : 0,
      timestamp: this.now().toISOString()
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
      this.droppedCount += 1;
    }
    return entry;
  }

  public query(query: PortalConsoleQuery = {}): PortalConsoleQueryResult {
    const limit = Math.min(Math.max(Math.round(query.limit ?? 50), 1), this.capacity);
    const since = query.since ?? 0;
    const sinceTime =
      query.sinceTimestamp === undefined ? null : Date.parse(query.sinceTimestamp) || null;
    const contains = query.contains?.toLowerCase();
    const filtered = this.entries.filter((entry) => {
      if (entry.sequence <= since) return false;
      if (query.levels !== undefined && !query.levels.includes(entry.level)) return false;
      if (sinceTime !== null && Date.parse(entry.timestamp) < sinceTime) return false;
      if (contains !== undefined && !entry.message.toLowerCase().includes(contains)) return false;
      return true;
    });
    const entries = filtered.slice(-limit);
    return {
      entries,
      cursor: entries.at(-1)?.sequence ?? since,
      capacity: this.capacity,
      stored: this.entries.length,
      dropped: this.droppedCount
    };
  }

  public clear(): void {
    this.entries.length = 0;
  }

  public size(): number {
    return this.entries.length;
  }

  public dropped(): number {
    return this.droppedCount;
  }
}
