import type { AgentLifecycleCanvasEvent, AgentLifecycleCommand } from "@forgedeck/schemas";

interface AgentLifecycleDeliveryStore {
  claimNext(projectId?: string): AgentLifecycleCommand | null;
  apply(commandId: string): AgentLifecycleCanvasEvent;
  markApplied(commandId: string): unknown;
  markFailed(commandId: string, errorCode: string): unknown;
}

export interface AgentLifecycleDispatcherServices {
  readonly store: AgentLifecycleDeliveryStore;
  /** Ends the target's terminal. Resolves even when the session is already gone. */
  readonly stopAgent: (sessionId: string) => Promise<unknown>;
  /**
   * Brings an agent's terminal back: after a reassignment, under its new responsibility, and after a
   * plain restart, under the one it already had. Either way the role reaches it the same way it
   * reaches any fresh terminal — through the staged context — so nothing here has to know how a
   * prompt is built. Returns the new session, or null when there is no agent to start.
   */
  readonly restartAgent: (
    command: AgentLifecycleCommand
  ) => Promise<{ readonly id: string } | null>;
  /** Releases material staged for a session that no longer exists. */
  readonly releaseSessionContext?: (sessionId: string) => void;
  readonly publish: (event: AgentLifecycleCanvasEvent) => void;
  readonly projectId?: string;
}

/**
 * Applies the process half of an agent lifecycle command: stopping a terminal, and restarting one
 * that was reassigned. The store owns the record and the canvas; this owns the processes, because
 * only the desktop runtime has them.
 *
 * The order matters. A terminal is stopped *before* the canvas changes, so a removal can never leave
 * a running agent whose node is gone — an orphan nothing on the canvas can reach or close.
 */
export class AgentLifecycleDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  public constructor(
    private readonly services: AgentLifecycleDispatcherServices,
    private readonly intervalMs = 250
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.drain(), this.intervalMs);
    this.timer.unref();
    void this.drain();
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let processed = 0;
    try {
      for (;;) {
        const command = this.services.store.claimNext(this.services.projectId);
        if (command === null) break;
        processed += 1;
        // Commands are applied one at a time: two of them can target the same agent, and applying
        // those concurrently would race over one terminal and one canvas node.
        await this.apply(command);
      }
      return processed;
    } finally {
      this.draining = false;
    }
  }

  private async apply(command: AgentLifecycleCommand): Promise<void> {
    if (command.sessionId !== null) {
      try {
        await this.services.stopAgent(command.sessionId);
        this.services.releaseSessionContext?.(command.sessionId);
      } catch {
        this.fail(command.id, "agent_stop_failed");
        return;
      }
    }

    let event: AgentLifecycleCanvasEvent;
    try {
      event = this.services.store.apply(command.id);
    } catch {
      this.fail(command.id, "canvas_update_failed");
      return;
    }
    this.publish(event);

    if (command.action === "assign_role" || command.action === "restart") {
      try {
        await this.services.restartAgent(command);
      } catch {
        // The new responsibility is already recorded and drawn; only the process failed to come
        // back. The command is still a failure — it asked for a working terminal under a new role —
        // and the error code says which half broke, rather than claiming the role never landed.
        this.fail(command.id, "agent_restart_failed");
        return;
      }
    }

    try {
      this.services.store.markApplied(command.id);
    } catch {
      // The canvas change is durable; the record just could not be closed out.
    }
  }

  private fail(commandId: string, errorCode: string): void {
    try {
      this.services.store.markFailed(commandId, errorCode);
    } catch {
      // Recovery on the next launch marks a command left in flight as interrupted.
    }
  }

  private publish(event: AgentLifecycleCanvasEvent): void {
    try {
      this.services.publish(event);
    } catch {
      // Canvas state is durable; a renderer opened later loads the persisted canvas.
    }
  }
}
