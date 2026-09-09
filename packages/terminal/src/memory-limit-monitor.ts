import { descendantsOf } from "./process-memory";
import type { ProcessMemoryReader, ProcessMemoryUsage } from "./process-memory";
import type { ProcessTreeKiller } from "./types";

/**
 * Kills a process that grows past the per-terminal memory limit, and leaves the terminal itself
 * running.
 *
 * That split is the whole point. A leaking agent should cost you the agent, not the shell you were
 * watching it in, not the other agents on the canvas, and not the machine. The person keeps the
 * terminal, its scrollback and its place on the canvas, and can simply start the work again.
 *
 * Nothing here is inferred from output or timing: a process is killed only for the resident size the
 * operating system reports, and every kill is announced so it can be shown rather than being a
 * terminal that mysteriously went quiet.
 */

export interface MemoryLimitBreach {
  readonly sessionId: string;
  readonly processId: number;
  readonly residentBytes: number;
  readonly limitBytes: number;
}

export interface MemoryLimitMonitorServices {
  /** The live sessions to watch, resolved on each sweep so new terminals are picked up. */
  readonly sessions: () => readonly { readonly sessionId: string; readonly processId: number }[];
  readonly reader: ProcessMemoryReader;
  readonly killer: ProcessTreeKiller;
  /** Announced for every process killed, so the UI can say what happened and why. */
  readonly onBreach: (breach: MemoryLimitBreach) => void;
  readonly limitBytes: number;
}

export class MemoryLimitMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  public constructor(
    private readonly services: MemoryLimitMonitorServices,
    private readonly intervalMs = 5_000
  ) {
    if (!Number.isFinite(services.limitBytes) || services.limitBytes <= 0) {
      throw new Error("Terminal memory limit must be a positive number of bytes");
    }
  }

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns how many processes were killed. Safe to call directly; sweeps never overlap. */
  public async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const sessions = this.services.sessions();
      if (sessions.length === 0) return 0;
      let processes: readonly ProcessMemoryUsage[];
      try {
        processes = await this.services.reader.read();
      } catch {
        // Losing one reading is not a reason to kill anything, nor to stop watching.
        return 0;
      }
      let killed = 0;
      for (const session of sessions) {
        for (const candidate of descendantsOf(processes, session.processId)) {
          if (candidate.residentBytes <= this.services.limitBytes) continue;
          try {
            await this.services.killer.kill(candidate.processId);
          } catch {
            // Already gone, or not ours to kill. Announcing it anyway would be a lie.
            continue;
          }
          killed += 1;
          this.announce({
            sessionId: session.sessionId,
            processId: candidate.processId,
            residentBytes: candidate.residentBytes,
            limitBytes: this.services.limitBytes
          });
        }
      }
      return killed;
    } finally {
      this.sweeping = false;
    }
  }

  private announce(breach: MemoryLimitBreach): void {
    try {
      this.services.onBreach(breach);
    } catch {
      // A consumer failure must not stop the monitor that protects the machine.
    }
  }
}
