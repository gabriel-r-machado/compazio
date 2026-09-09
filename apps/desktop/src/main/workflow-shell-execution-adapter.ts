import { randomUUID } from "node:crypto";

import { PathExecutableDetector } from "@forgedeck/agent-adapters";
import type { ExecutableDetector, RuntimePlatform } from "@forgedeck/agent-sdk";
import type {
  ShellExecutionAdapter,
  ShellExecutionOutcome,
  ShellExecutionRequest
} from "@forgedeck/orchestration";
import { ShellExecutionAdapterError } from "@forgedeck/orchestration";
import { createAllowedEnvironment, ProcessTerminalWaitTimeoutError } from "@forgedeck/terminal";
import type { ProcessSessionSnapshot } from "@forgedeck/terminal";

export interface WorkflowRunRootResolver {
  resolveRunRoot(runId: string): string | null;
}

/** Runtime-private association; roots are never serialized into commands, IPC, or run events. */
export class InMemoryWorkflowRunRootRegistry implements WorkflowRunRootResolver {
  private readonly roots = new Map<string, string>();

  public bindRunRoot(runId: string, root: string): void {
    this.roots.set(runId, root);
  }

  public resolveRunRoot(runId: string): string | null {
    return this.roots.get(runId) ?? null;
  }

  public releaseRunRoot(runId: string): void {
    this.roots.delete(runId);
  }
}

interface ShellProcessSupervisor {
  start(input: {
    readonly sessionId: string;
    readonly adapterId: string;
    readonly launch: {
      readonly executable: { readonly path: string; readonly kind: "native" | "command-shim" };
      readonly args: readonly string[];
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly cols: number;
      readonly rows: number;
    };
    readonly allowedCwdRoots: readonly string[];
  }): Promise<ProcessSessionSnapshot>;
  waitForTerminal(sessionId: string, timeoutMs: number): Promise<ProcessSessionSnapshot>;
  cancel(sessionId: string): Promise<ProcessSessionSnapshot>;
}

/** Thrown only inside the runtime so callers receive a stable, non-sensitive failure category. */
/**
 * Real shell adapter backed by the desktop's existing ProcessSupervisor. Both the workspace root
 * and executable are resolved internally; no external API can submit a filesystem path or shell
 * command string.
 */
export class ProcessSupervisorShellExecutionAdapter implements ShellExecutionAdapter {
  public constructor(
    private readonly terminal: ShellProcessSupervisor,
    private readonly roots: WorkflowRunRootResolver,
    private readonly detector: ExecutableDetector = new PathExecutableDetector(),
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly platform: RuntimePlatform = platformFor(process.platform),
    private readonly id: () => string = randomUUID
  ) {}

  public async execute(input: ShellExecutionRequest): Promise<ShellExecutionOutcome> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.command.executable)) {
      throw new ShellExecutionAdapterError("adapter_unavailable");
    }
    const root = this.roots.resolveRunRoot(input.runId);
    if (root === null) throw new ShellExecutionAdapterError("target_unavailable");
    const executable = await this.detector.find([input.command.executable], {
      platform: this.platform,
      environment: this.environment
    });
    if (executable === null) throw new ShellExecutionAdapterError("adapter_unavailable");
    const sessionId = `workflow-shell-${this.id()}`;
    const startedAt = Date.now();
    await this.terminal.start({
      sessionId,
      adapterId: "workflow-shell",
      launch: {
        executable,
        args: input.command.args,
        cwd: root,
        environment: createAllowedEnvironment(this.environment, { TERM: "xterm-256color" }),
        cols: 120,
        rows: 30
      },
      allowedCwdRoots: [root]
    });
    const cancelOnAbort = (): void => {
      void this.terminal.cancel(sessionId).catch(() => undefined);
    };
    input.abortSignal.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      const session = await this.terminal.waitForTerminal(sessionId, input.timeoutMs ?? 600_000);
      return {
        exitCode: session.exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        timedOut: false
      };
    } catch (error: unknown) {
      if (error instanceof ProcessTerminalWaitTimeoutError) {
        await this.terminal.cancel(sessionId);
        return { exitCode: null, durationMs: Math.max(0, Date.now() - startedAt), timedOut: true };
      }
      throw error;
    } finally {
      input.abortSignal.removeEventListener("abort", cancelOnAbort);
    }
  }
}

function platformFor(value: NodeJS.Platform): RuntimePlatform {
  if (value === "win32" || value === "darwin" || value === "linux") return value;
  throw new Error("Unsupported runtime platform");
}
