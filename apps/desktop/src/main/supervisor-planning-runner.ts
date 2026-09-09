import { randomUUID } from "node:crypto";

import {
  createAllowedEnvironment,
  ProcessTerminalWaitTimeoutError,
  type ProcessSupervisor
} from "@forgedeck/terminal";

import { redactSensitive } from "./claude-code-agent-adapter";
import type { PlanningProcessOutcome, PlanningProcessRunner } from "./codex-orchestrator-port";

/**
 * The transport a planning turn shares with everything else: the single live ProcessSupervisor, over
 * the pipe transport, with no shell, the prompt on stdin, an allowlisted environment, a timeout, and
 * cancellation that terminates the whole process tree.
 *
 * It is the ONLY thing a planning port borrows from execution. The port decides what to run and how to
 * read the answer; this decides nothing and reads nothing — it returns an exit code and a bounded,
 * redacted tail of the output for diagnostics, never a plan.
 */

/** How much output is kept for a diagnostic. Terminal text is never authority, only a hint. */
const MAX_DIAGNOSTIC_CHARS = 400;

export class SupervisorPlanningRunner implements PlanningProcessRunner {
  public constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly adapterId: string,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly newSessionId: () => string = () => randomUUID()
  ) {}

  public async run(input: {
    readonly executable: { readonly path: string; readonly kind: "native" | "command-shim" };
    readonly args: readonly string[];
    readonly cwd: string;
    readonly stdin: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<PlanningProcessOutcome> {
    const sessionId = `orchestrator-planning-${this.newSessionId()}`;
    await this.supervisor.start({
      sessionId,
      adapterId: `orchestrator:${this.adapterId}`,
      launch: {
        executable: input.executable,
        args: [...input.args],
        cwd: input.cwd,
        environment: createAllowedEnvironment(this.environment),
        cols: 120,
        rows: 30,
        // Single-shot planning runs over a real stdin pipe, never a pty: the prompt is written and
        // stdin is closed, and a batch turn has no terminal to attach to.
        transport: "pipe",
        initialInput: { data: input.stdin, closeAfterWrite: true }
      },
      // The disposable snapshot is the only root this turn may work in; the real workspace is not here.
      allowedCwdRoots: [input.cwd]
    });

    const cancelOnAbort = (): void => {
      void this.supervisor.cancel(sessionId).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      const snapshot = await this.supervisor.waitForTerminal(sessionId, input.timeoutMs);
      if (input.signal?.aborted === true) {
        return { exitCode: snapshot.exitCode, timedOut: false, cancelled: true };
      }
      return {
        exitCode: snapshot.exitCode,
        timedOut: false,
        cancelled: false,
        sanitizedError: this.tail(sessionId)
      };
    } catch (error: unknown) {
      if (error instanceof ProcessTerminalWaitTimeoutError) {
        // The tree is terminated before reporting, so no planner process outlives its own timeout.
        await this.supervisor.cancel(sessionId).catch(() => undefined);
        return { exitCode: null, timedOut: true, cancelled: false };
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", cancelOnAbort);
    }
  }

  /** A bounded, redacted tail of the session output, for diagnostics only. */
  private tail(sessionId: string): string {
    try {
      return redactSensitive(this.supervisor.getBuffer(sessionId).slice(-MAX_DIAGNOSTIC_CHARS));
    } catch {
      return "";
    }
  }
}
