import type { LaunchSpec } from "@forgedeck/agent-sdk";

export type ProcessLifecycleState =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface Disposable {
  dispose(): void;
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

/**
 * A neutral managed child process, independent of its transport (pty or pipe). The ProcessSupervisor
 * drives every session through this one interface, so it stays the single authority for lifecycle,
 * output, timeout, cancellation, tree termination and cleanup regardless of how the child was spawned.
 */
export interface ManagedProcess {
  readonly pid: number;
  /** Writes to the child's input channel when it is still open; a no-op once input has been closed. */
  write(data: string): void;
  /** Closes the child's input (pipe: `stdin.end()`; pty: sends the platform EOF marker). Idempotent. */
  endInput(): void;
  /** Transport-specific graceful stop request (pty: Ctrl-C; pipe: close stdin). Idempotent. */
  requestCancel(): void;
  /** Resizes the terminal window; a no-op for the pipe transport, which has no terminal. */
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExitEvent) => void): Disposable;
  /** Releases retained stream/listener handles; called once the session reaches a terminal state. */
  dispose(): void;
}

/** The spawn input for a managed process. It is the launch spec, including the transport selector. */
export type ManagedProcessSpawnInput = LaunchSpec;

export interface ManagedProcessFactory {
  spawn(input: ManagedProcessSpawnInput): Promise<ManagedProcess>;
}

/** @deprecated Kept for back-compat; use {@link ManagedProcess}. */
export type ManagedPtyProcess = ManagedProcess;
/** @deprecated Kept for back-compat; use {@link ManagedProcessFactory}. */
export type PtyFactory = ManagedProcessFactory;

export interface ProcessTreeKiller {
  kill(pid: number): Promise<void>;
}

export interface RuntimeSessionRecord {
  readonly id: string;
  readonly adapterId: string;
  readonly state: ProcessLifecycleState;
  readonly cwd: string;
  readonly processId: number | null;
  readonly startedAt: Date | null;
  readonly updatedAt: Date;
  readonly endedAt: Date | null;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly interruptionReason: string | null;
}

export interface RuntimeSessionStore {
  save(record: RuntimeSessionRecord): Promise<void>;
  markActiveSessionsInterrupted(at: Date, reason: string): Promise<number>;
}

export interface StartProcessSessionInput {
  readonly sessionId: string;
  readonly adapterId: string;
  readonly launch: LaunchSpec;
  readonly allowedCwdRoots: readonly string[];
  /**
   * Extra environment keys a real adapter legitimately needs for this launch (e.g. an agent CLI's
   * local profile directory). They are unioned into the allowlist for validation only; unknown keys
   * are still rejected.
   */
  readonly additionalAllowedEnvKeys?: readonly string[];
}

export interface ProcessSessionSnapshot {
  readonly id: string;
  readonly adapterId: string;
  readonly state: ProcessLifecycleState;
  readonly processId: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
}

export type ProcessSupervisorEvent =
  | {
      readonly type: "session.state";
      readonly session: ProcessSessionSnapshot;
    }
  | {
      readonly type: "session.output";
      readonly sessionId: string;
      readonly sequence: number;
      readonly data: string;
      readonly timestamp: string;
    }
  | {
      readonly type: "session.error";
      readonly sessionId: string;
      readonly code: string;
      readonly message: string;
    };
