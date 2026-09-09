export type PortalErrorCode =
  | "PORTAL_TIMEOUT"
  | "PORTAL_OPERATION_CANCELLED"
  | "PORTAL_NOT_CONNECTED"
  | "PORTAL_DESTROYED"
  | "PORTAL_CRASHED"
  | "PORTAL_NOT_FOUND"
  | "PORTAL_INVALID_URL"
  | "PORTAL_PROTOCOL_BLOCKED"
  | "PORTAL_LOADING_FAILED"
  | "PORTAL_ELEMENT_NOT_FOUND"
  | "PORTAL_ELEMENT_NOT_EDITABLE"
  | "PORTAL_INVALID_KEY"
  | "PORTAL_DOM_LIMIT_EXCEEDED"
  | "PORTAL_EVALUATE_DENIED"
  | "PORTAL_DOWNLOAD_DENIED"
  | "PORTAL_RECOVERY_FAILED"
  | "PORTAL_OPERATION_FAILED";

/** Cancellation always names its cause: an agent reads the reason, the UI reports it, tests assert it. */
export type PortalCancelReason =
  | "user-cancelled"
  | "connection-revoked"
  | "terminal-deleted"
  | "portal-deleted"
  | "portal-crashed"
  | "workspace-switched"
  | "workspace-closed"
  | "application-closing"
  | "runtime-recreated";

const cancelCodes: Record<PortalCancelReason, PortalErrorCode> = {
  "user-cancelled": "PORTAL_OPERATION_CANCELLED",
  "connection-revoked": "PORTAL_NOT_CONNECTED",
  "terminal-deleted": "PORTAL_OPERATION_CANCELLED",
  "portal-deleted": "PORTAL_DESTROYED",
  "portal-crashed": "PORTAL_CRASHED",
  "workspace-switched": "PORTAL_OPERATION_CANCELLED",
  "workspace-closed": "PORTAL_OPERATION_CANCELLED",
  "application-closing": "PORTAL_OPERATION_CANCELLED",
  "runtime-recreated": "PORTAL_DESTROYED"
};

const cancelMessages: Record<PortalCancelReason, string> = {
  "user-cancelled": "A operação do Portal foi cancelada.",
  "connection-revoked": "A conexão portal-control foi removida durante a operação.",
  "terminal-deleted": "O terminal que pediu a operação foi excluído.",
  "portal-deleted": "O Portal foi excluído durante a operação.",
  "portal-crashed": "O processo do Portal falhou durante a operação.",
  "workspace-switched": "O workspace foi trocado durante a operação.",
  "workspace-closed": "O workspace foi fechado durante a operação.",
  "application-closing": "O aplicativo foi encerrado durante a operação.",
  "runtime-recreated": "O runtime do Portal foi recriado durante a operação."
};

export class PortalError extends Error {
  public constructor(
    public readonly code: PortalErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "PortalError";
  }

  /** Errors cross the bridge as data; an agent never receives a stack or an Electron object. */
  public toResult(): {
    readonly ok: false;
    readonly code: PortalErrorCode;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  } {
    return { ok: false, code: this.code, message: this.message, details: this.details };
  }
}

export interface PortalOperationDescriptor {
  readonly workspaceId: string;
  readonly portalId: string;
  readonly action: string;
  /** Absent for operations started by the canvas itself instead of by a connected terminal. */
  readonly terminalNodeId?: string;
  readonly timeoutMs?: number;
  readonly correlationId?: string;
}

export interface PortalOperationContext {
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  /** Milliseconds left before the operation is aborted; work can pass it to a page-level budget. */
  remainingMs(): number;
}

export interface PortalOperationSnapshot {
  readonly correlationId: string;
  readonly workspaceId: string;
  readonly portalId: string;
  readonly terminalNodeId?: string;
  readonly action: string;
  readonly startedAt: string;
  readonly timeoutMs: number;
}

export interface PortalOperationRegistryOptions {
  readonly defaultTimeoutMs?: number;
  readonly maximumTimeoutMs?: number;
  readonly minimumTimeoutMs?: number;
  readonly createId?: () => string;
  readonly now?: () => number;
  readonly onEvent?: (type: string, metadata: Readonly<Record<string, unknown>>) => void;
}

interface RunningOperation {
  readonly snapshot: PortalOperationSnapshot;
  readonly controller: AbortController;
  readonly fail: (error: PortalError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/**
 * Every Portal operation lives here from start to finish. A promise that nobody can cancel is a leak
 * with a nicer name: the registry owns the timer, the abort signal and the cleanup, so closing a
 * workspace or cutting a connection ends work already in flight instead of only refusing the next.
 */
export class PortalOperationRegistry {
  public static readonly defaultTimeoutMs = 15_000;
  public static readonly maximumTimeoutMs = 120_000;
  public static readonly minimumTimeoutMs = 250;

  private readonly running = new Map<string, RunningOperation>();
  private readonly defaultTimeoutMs: number;
  private readonly maximumTimeoutMs: number;
  private readonly minimumTimeoutMs: number;
  private readonly createId: () => string;
  private readonly now: () => number;
  private sequence = 0;

  public constructor(private readonly options: PortalOperationRegistryOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? PortalOperationRegistry.defaultTimeoutMs;
    this.maximumTimeoutMs = options.maximumTimeoutMs ?? PortalOperationRegistry.maximumTimeoutMs;
    this.minimumTimeoutMs = options.minimumTimeoutMs ?? PortalOperationRegistry.minimumTimeoutMs;
    this.createId = options.createId ?? (() => `op-${++this.sequence}`);
    this.now = options.now ?? (() => Date.now());
  }

  public resolveTimeout(requested?: number): number {
    if (requested === undefined || !Number.isFinite(requested)) return this.defaultTimeoutMs;
    return Math.min(Math.max(Math.round(requested), this.minimumTimeoutMs), this.maximumTimeoutMs);
  }

  public async run<T>(
    descriptor: PortalOperationDescriptor,
    work: (context: PortalOperationContext) => Promise<T>
  ): Promise<T> {
    const correlationId = descriptor.correlationId ?? this.createId();
    const timeoutMs = this.resolveTimeout(descriptor.timeoutMs);
    const controller = new AbortController();
    const startedAt = this.now();
    const snapshot: PortalOperationSnapshot = {
      correlationId,
      workspaceId: descriptor.workspaceId,
      portalId: descriptor.portalId,
      ...(descriptor.terminalNodeId === undefined
        ? {}
        : { terminalNodeId: descriptor.terminalNodeId }),
      action: descriptor.action,
      startedAt: new Date(startedAt).toISOString(),
      timeoutMs
    };
    let settle: (error: PortalError) => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      settle = (error: PortalError) => reject(error);
    });
    const operation: RunningOperation = {
      snapshot,
      controller,
      fail: (error) => settle(error),
      timer: null,
      settled: false
    };
    operation.timer = setTimeout(() => {
      this.abort(
        correlationId,
        new PortalError("PORTAL_TIMEOUT", `A operação excedeu ${timeoutMs} ms.`, {
          correlationId,
          action: descriptor.action,
          timeoutMs
        }),
        "portal.operation.timeout"
      );
    }, timeoutMs);
    this.running.set(correlationId, operation);
    this.options.onEvent?.("portal.operation.started", {
      ...snapshot,
      pending: this.running.size
    });
    const context: PortalOperationContext = {
      correlationId,
      signal: controller.signal,
      deadlineAt: startedAt + timeoutMs,
      remainingMs: () => Math.max(0, startedAt + timeoutMs - this.now())
    };
    try {
      const value = await Promise.race([work(context), interrupted]);
      this.options.onEvent?.("portal.operation.completed", {
        correlationId,
        action: descriptor.action,
        portalId: descriptor.portalId,
        workspaceId: descriptor.workspaceId,
        durationMs: this.now() - startedAt
      });
      return value;
    } catch (error) {
      const failure =
        error instanceof PortalError
          ? error
          : new PortalError(
              "PORTAL_OPERATION_FAILED",
              error instanceof Error ? error.message : "A operação do Portal falhou.",
              { correlationId, action: descriptor.action }
            );
      this.options.onEvent?.("portal.operation.failed", {
        correlationId,
        action: descriptor.action,
        portalId: descriptor.portalId,
        workspaceId: descriptor.workspaceId,
        code: failure.code
      });
      throw failure;
    } finally {
      this.release(correlationId);
    }
  }

  /** Explicit cancellation. Repeating it is a no-op instead of a second rejection. */
  public cancel(correlationId: string, reason: PortalCancelReason = "user-cancelled"): boolean {
    const operation = this.running.get(correlationId);
    if (operation === undefined || operation.settled) return false;
    this.abort(
      correlationId,
      new PortalError(cancelCodes[reason], cancelMessages[reason], { correlationId, reason }),
      "portal.operation.cancelled"
    );
    return true;
  }

  public cancelPortal(workspaceId: string, portalId: string, reason: PortalCancelReason): number {
    return this.cancelMatching(
      (item) => item.workspaceId === workspaceId && item.portalId === portalId,
      reason
    );
  }

  public cancelWorkspace(workspaceId: string, reason: PortalCancelReason): number {
    return this.cancelMatching((item) => item.workspaceId === workspaceId, reason);
  }

  public cancelTerminal(
    workspaceId: string,
    terminalNodeId: string,
    reason: PortalCancelReason
  ): number {
    return this.cancelMatching(
      (item) => item.workspaceId === workspaceId && item.terminalNodeId === terminalNodeId,
      reason
    );
  }

  public cancelGrant(
    workspaceId: string,
    terminalNodeId: string,
    portalId: string,
    reason: PortalCancelReason
  ): number {
    return this.cancelMatching(
      (item) =>
        item.workspaceId === workspaceId &&
        item.portalId === portalId &&
        item.terminalNodeId === terminalNodeId,
      reason
    );
  }

  public cancelAll(reason: PortalCancelReason): number {
    return this.cancelMatching(() => true, reason);
  }

  public pending(): readonly PortalOperationSnapshot[] {
    return [...this.running.values()].filter((item) => !item.settled).map((item) => item.snapshot);
  }

  public pendingCount(): number {
    return this.pending().length;
  }

  private cancelMatching(
    predicate: (snapshot: PortalOperationSnapshot) => boolean,
    reason: PortalCancelReason
  ): number {
    let cancelled = 0;
    for (const [correlationId, operation] of [...this.running]) {
      if (operation.settled || !predicate(operation.snapshot)) continue;
      if (this.cancel(correlationId, reason)) cancelled += 1;
    }
    return cancelled;
  }

  private abort(correlationId: string, error: PortalError, event: string): void {
    const operation = this.running.get(correlationId);
    if (operation === undefined || operation.settled) return;
    operation.settled = true;
    this.clearTimer(operation);
    operation.controller.abort(error);
    this.options.onEvent?.(event, {
      correlationId,
      action: operation.snapshot.action,
      portalId: operation.snapshot.portalId,
      workspaceId: operation.snapshot.workspaceId,
      code: error.code,
      ...error.details
    });
    operation.fail(error);
  }

  private release(correlationId: string): void {
    const operation = this.running.get(correlationId);
    if (operation === undefined) return;
    operation.settled = true;
    this.clearTimer(operation);
    this.running.delete(correlationId);
  }

  private clearTimer(operation: RunningOperation): void {
    if (operation.timer === null) return;
    clearTimeout(operation.timer);
    operation.timer = null;
  }
}
