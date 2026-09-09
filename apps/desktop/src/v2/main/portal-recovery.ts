export type PortalFailureKind =
  "render-process-gone" | "unresponsive" | "did-fail-load" | "destroyed";

export interface PortalRecoveryState {
  readonly attempts: number;
  readonly exhausted: boolean;
  readonly lastFailure: PortalFailureKind | null;
  readonly lastAttemptAt: string | null;
}

export interface PortalRecoveryEvaluation {
  readonly allowed: boolean;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: "allowed" | "attempts-exhausted" | "cooling-down";
  readonly retryInMs?: number;
}

export interface PortalRecoveryPolicyOptions {
  readonly maxAttempts?: number;
  readonly cooldownMs?: number;
  /** Attempts older than the window are forgiven: a crash today is not a crash from an hour ago. */
  readonly windowMs?: number;
  readonly now?: () => number;
}

interface Entry {
  /** Timestamps of automatic recovery attempts still inside the window. */
  attempts: number[];
  lastAttemptAt: number | null;
  lastFailure: PortalFailureKind | null;
}

/**
 * Automatic recovery has to stop. A page that crashes on load would otherwise be recreated forever,
 * burning CPU and hiding the failure; after the budget runs out the Portal stays visibly failed and
 * waits for a person to press "Recriar Runtime".
 *
 * The budget is counted over a time window and a successful load does not refund it: a page that
 * crashes right after every recovery is exactly the loop this exists to stop. Only time passing or
 * an explicit human retry clears it.
 */
export class PortalRecoveryPolicy {
  public static readonly defaultMaxAttempts = 3;

  private readonly entries = new Map<string, Entry>();
  private readonly maxAttempts: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  public constructor(options: PortalRecoveryPolicyOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? PortalRecoveryPolicy.defaultMaxAttempts);
    this.cooldownMs = options.cooldownMs ?? 1_000;
    this.windowMs = options.windowMs ?? 120_000;
    this.now = options.now ?? (() => Date.now());
  }

  public evaluate(key: string): PortalRecoveryEvaluation {
    const entry = this.entry(key);
    if (entry.attempts.length >= this.maxAttempts)
      return {
        allowed: false,
        attempt: entry.attempts.length,
        maxAttempts: this.maxAttempts,
        reason: "attempts-exhausted"
      };
    const elapsed =
      entry.lastAttemptAt === null ? Number.POSITIVE_INFINITY : this.now() - entry.lastAttemptAt;
    if (elapsed < this.cooldownMs)
      return {
        allowed: false,
        attempt: entry.attempts.length,
        maxAttempts: this.maxAttempts,
        reason: "cooling-down",
        retryInMs: Math.max(0, this.cooldownMs - elapsed)
      };
    return {
      allowed: true,
      attempt: entry.attempts.length + 1,
      maxAttempts: this.maxAttempts,
      reason: "allowed"
    };
  }

  public recordFailure(key: string, kind: PortalFailureKind): PortalRecoveryState {
    const entry = this.entry(key);
    entry.lastFailure = kind;
    return this.state(key);
  }

  public recordAttempt(key: string): PortalRecoveryState {
    const entry = this.entry(key);
    const now = this.now();
    entry.attempts.push(now);
    entry.lastAttemptAt = now;
    return this.state(key);
  }

  /** A Portal that loads again is healthy for display, but its recent attempts still count. */
  public recordSuccess(key: string): PortalRecoveryState {
    const entry = this.entry(key);
    entry.lastFailure = null;
    entry.lastAttemptAt = null;
    return this.state(key);
  }

  /** Manual recreation is the human override: it clears the budget the automatic path exhausted. */
  public reset(key: string): PortalRecoveryState {
    this.entries.set(key, { attempts: [], lastAttemptAt: null, lastFailure: null });
    return this.state(key);
  }

  public forget(key: string): void {
    this.entries.delete(key);
  }

  public state(key: string): PortalRecoveryState {
    const entry = this.entry(key);
    return {
      attempts: entry.attempts.length,
      exhausted: entry.attempts.length >= this.maxAttempts,
      lastFailure: entry.lastFailure,
      lastAttemptAt:
        entry.lastAttemptAt === null ? null : new Date(entry.lastAttemptAt).toISOString()
    };
  }

  private entry(key: string): Entry {
    const existing = this.entries.get(key);
    if (existing === undefined) {
      const created: Entry = { attempts: [], lastAttemptAt: null, lastFailure: null };
      this.entries.set(key, created);
      return created;
    }
    const horizon = this.now() - this.windowMs;
    existing.attempts = existing.attempts.filter((attempt) => attempt > horizon);
    return existing;
  }
}

export interface PortalFailureDescription {
  readonly kind: PortalFailureKind;
  readonly title: string;
  readonly reason: string;
  readonly hint: string;
}

/** The canvas shows why a Portal failed in plain language; the diagnostic keeps the technical detail. */
export function describePortalFailure(
  kind: PortalFailureKind,
  details: { readonly description?: string; readonly errorCode?: number } = {}
): PortalFailureDescription {
  if (kind === "render-process-gone")
    return {
      kind,
      title: "Portal falhou",
      reason: "O processo de renderização da página terminou inesperadamente.",
      hint: "Recarregue o Portal ou recrie o runtime."
    };
  if (kind === "unresponsive")
    return {
      kind,
      title: "Portal falhou",
      reason: "A página parou de responder.",
      hint: "Recarregue o Portal; se persistir, recrie o runtime."
    };
  if (kind === "did-fail-load")
    return {
      kind,
      title: "Portal falhou",
      reason:
        details.description === undefined || details.description === ""
          ? "A página não pôde ser carregada."
          : `A página não pôde ser carregada (${details.description}).`,
      hint: "Verifique o endereço e recarregue o Portal."
    };
  return {
    kind,
    title: "Portal falhou",
    reason: "O runtime do Portal foi destruído fora do fluxo normal.",
    hint: "Recrie o runtime para continuar."
  };
}
