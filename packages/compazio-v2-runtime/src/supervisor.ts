import type { LaunchSpec } from "@forgedeck/agent-sdk";
import {
  type Disposable,
  type ManagedProcess,
  type ManagedProcessFactory,
  type ProcessTreeKiller
} from "@forgedeck/terminal";
import {
  type ProcessState,
  type TerminalSession,
  type V2TerminalEvent
} from "@forgedeck/compazio-v2-domain";

export interface V2StartTerminalInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly terminalNodeId: string;
  readonly launch: LaunchSpec;
}

export interface V2ProcessSupervisorOptions {
  readonly treeKiller: ProcessTreeKiller;
  readonly now?: () => string;
  readonly gracePeriodMs?: number;
}

interface InternalSession {
  snapshot: TerminalSession;
  process: ManagedProcess | null;
  readonly listeners: Disposable[];
  exitPromise: Promise<void>;
  resolveExit: () => void;
  terminal: boolean;
  stopPromise: Promise<TerminalSession> | null;
  requestedSize: { readonly cols: number; readonly rows: number } | null;
  /** Serializes renderer input and trusted connection delivery into one byte stream. */
  writeTail: Promise<void>;
  /** Output barriers split paste and submit without interpreting provider-specific text. */
  readonly outputWaiters: Set<(terminal?: boolean) => void>;
}

const activeStates = new Set<ProcessState>(["starting", "running", "waiting-input", "stopping"]);

/**
 * The V2's sole owner of child processes. It contains no Electron or renderer dependency and keeps
 * process handles strictly in memory; durable workspace records receive only node configuration.
 */
export class V2ProcessSupervisor {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly listeners = new Set<(event: V2TerminalEvent) => void>();
  private readonly now: () => string;
  private readonly gracePeriodMs: number;

  public constructor(
    private readonly factory: ManagedProcessFactory,
    private readonly options: V2ProcessSupervisorOptions
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.gracePeriodMs = options.gracePeriodMs ?? 1_500;
  }

  public subscribe(listener: (event: V2TerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async start(input: V2StartTerminalInput): Promise<TerminalSession> {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`Terminal session already exists: ${input.sessionId}`);
    }
    if (this.findByNode(input.workspaceId, input.terminalNodeId) !== null) {
      throw new Error(`Terminal node ${input.terminalNodeId} already has a session`);
    }
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const timestamp = this.now();
    const session: InternalSession = {
      snapshot: {
        id: input.sessionId,
        workspaceId: input.workspaceId,
        terminalNodeId: input.terminalNodeId,
        state: "starting",
        startedAt: timestamp,
        lastActivityAt: timestamp,
        exitCode: null,
        exitSignal: null
      },
      process: null,
      listeners: [],
      exitPromise,
      resolveExit,
      terminal: false,
      stopPromise: null,
      requestedSize: null,
      writeTail: Promise.resolve(),
      outputWaiters: new Set()
    };
    this.sessions.set(input.sessionId, session);
    this.emitState(session);
    try {
      const process = await this.factory.spawn(input.launch);
      session.process = process;
      session.listeners.push(
        process.onData((data) => this.onData(session, data)),
        process.onExit((result) => {
          void this.finish(
            session,
            session.snapshot.state === "stopping"
              ? "stopped"
              : result.exitCode === 0
                ? "completed"
                : "failed",
            result.exitCode,
            result.signal ?? null
          );
        })
      );
      if (session.requestedSize !== null) {
        process.resize(session.requestedSize.cols, session.requestedSize.rows);
      }
      this.updateState(session, "running");
      if (input.launch.initialInput !== undefined) {
        process.write(input.launch.initialInput.data);
        if (input.launch.initialInput.closeAfterWrite) process.endInput();
      }
      return session.snapshot;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unable to start the terminal process";
      await this.finish(session, "failed", null, null);
      this.emit({
        type: "terminal.error",
        sessionId: input.sessionId,
        terminalNodeId: input.terminalNodeId,
        code: "process_start_failed",
        message
      });
      throw error;
    }
  }

  public get(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown terminal session: ${sessionId}`);
    return session.snapshot;
  }

  public list(): readonly TerminalSession[] {
    return [...this.sessions.values()].map((session) => session.snapshot);
  }

  public diagnostics(): {
    readonly sessionCount: number;
    readonly activeSessionCount: number;
    readonly listenerCount: number;
  } {
    const sessions = this.list();
    return {
      sessionCount: sessions.length,
      activeSessionCount: sessions.filter((session) => activeStates.has(session.state)).length,
      listenerCount: this.listeners.size
    };
  }

  public async write(sessionId: string, data: string): Promise<void> {
    const session = this.requireRunning(sessionId);
    const write = session.writeTail.then(() => {
      if (session.terminal || session.process === null) {
        throw new Error(`Terminal session is not accepting input: ${sessionId}`);
      }
      session.process.write(data);
      this.touch(session);
    });
    // A failed native write is reported to its caller without poisoning later writes.
    session.writeTail = write.catch(() => undefined);
    await write;
  }

  /**
   * Writes a bracketed-paste frame, waits for the resulting PTY redraw to settle, then submits it.
   * Interactive TUIs need this transport barrier because ConPTY may coalesce two immediate writes
   * into one read and treat Enter as part of the paste. No provider text is inspected; the bounded
   * maximum also covers a terminal that continuously redraws or does not echo input.
   */
  public async writeWithOutputBarrier(
    sessionId: string,
    data: string,
    followingData: string,
    fallbackMs = 750
  ): Promise<void> {
    await this.writeSequenceWithOutputBarrier(sessionId, [data, followingData], fallbackMs);
  }

  /** Writes every frame only after the previous frame's PTY redraw has settled. */
  public async writeSequenceWithOutputBarrier(
    sessionId: string,
    frames: readonly string[],
    fallbackMs = 750
  ): Promise<void> {
    if (!Number.isInteger(fallbackMs) || fallbackMs < 1 || fallbackMs > 5_000) {
      throw new Error("Terminal output barrier timeout is outside the allowed range");
    }
    if (frames.length < 2 || frames.length > 4 || frames.some((frame) => frame.length === 0)) {
      throw new Error("Terminal output barrier sequence is invalid");
    }
    const session = this.requireRunning(sessionId);
    const write = session.writeTail.then(async () => {
      if (session.terminal || session.process === null) {
        throw new Error(`Terminal session is not accepting input: ${sessionId}`);
      }
      for (const [index, frame] of frames.entries()) {
        const output =
          index === frames.length - 1 ? undefined : this.waitForOutputSettle(session, fallbackMs);
        session.process.write(frame);
        this.touch(session);
        await output;
        if (index < frames.length - 1 && (session.terminal || session.process === null)) {
          throw new Error(`Terminal session stopped before input submission: ${sessionId}`);
        }
      }
    });
    session.writeTail = write.catch(() => undefined);
    await write;
  }

  public resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireResizeable(sessionId);
    if (cols < 1 || cols > 500 || rows < 1 || rows > 500) {
      throw new Error("Terminal dimensions are outside the allowed range");
    }
    session.requestedSize = { cols, rows };
    session.process?.resize(cols, rows);
    this.touch(session);
  }

  /** Gracefully stops a session first, killing the full tree only after the configured timeout. */
  public stop(sessionId: string): Promise<TerminalSession> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Unknown terminal session: ${sessionId}`);
    if (!activeStates.has(session.snapshot.state)) return Promise.resolve(session.snapshot);
    if (session.stopPromise !== null) return session.stopPromise;
    session.stopPromise = this.stopActiveSession(session);
    return session.stopPromise;
  }

  public async stopWorkspace(workspaceId: string): Promise<void> {
    const sessions = [...this.sessions.values()]
      .filter(
        (session) =>
          session.snapshot.workspaceId === workspaceId && activeStates.has(session.snapshot.state)
      )
      .map((session) => this.stop(session.snapshot.id));
    await Promise.all(sessions);
  }

  public async shutdown(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => activeStates.has(session.snapshot.state))
        .map((session) => this.stop(session.snapshot.id))
    );
    for (const session of [...this.sessions.values()]) this.release(session.snapshot.id);
    this.listeners.clear();
  }

  /** Releases a completed session's residual metadata/listeners. Idempotent by design. */
  public release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (activeStates.has(session.snapshot.state)) {
      throw new Error("An active terminal session must be stopped before release");
    }
    this.disposeSession(session);
    this.sessions.delete(sessionId);
  }

  public async releaseNode(workspaceId: string, terminalNodeId: string): Promise<void> {
    const session = this.findByNode(workspaceId, terminalNodeId);
    if (session === null) return;
    if (activeStates.has(session.snapshot.state)) await this.stop(session.snapshot.id);
    this.release(session.snapshot.id);
  }

  private async stopActiveSession(session: InternalSession): Promise<TerminalSession> {
    this.updateState(session, "stopping");
    // First revoke the process's input channel. In a pipe this closes stdin; in a PTY the factory
    // sends the platform EOF control sequence. A cooperative CLI gets a chance to finish before
    // the interrupt and, only after the bounded grace period, the owned process tree is forced.
    session.process?.endInput();
    shutdownTrace("stdin-closed", { sessionId: session.snapshot.id });
    session.process?.requestCancel();
    shutdownTrace("graceful-cancel-sent", { sessionId: session.snapshot.id });
    const exited = await Promise.race([
      session.exitPromise.then(() => true),
      delay(this.gracePeriodMs).then(() => false)
    ]);
    if (!exited && !session.terminal) {
      shutdownTrace("graceful-timeout", { sessionId: session.snapshot.id });
      await this.forceKill(session);
      shutdownTrace("force-kill-complete", { sessionId: session.snapshot.id });
      const killed = await Promise.race([
        session.exitPromise.then(() => true),
        delay(500).then(() => false)
      ]);
      if (!killed && !session.terminal) await this.finish(session, "stopped", null, null);
    }
    return session.snapshot;
  }

  private async forceKill(session: InternalSession): Promise<void> {
    const processId = session.process?.pid;
    if (processId === undefined || processId < 1) return;
    try {
      await this.options.treeKiller.kill(processId);
    } catch {
      try {
        session.process?.kill();
      } catch {
        // A concurrently exiting process has already reached the desired state.
      }
    }
  }

  private onData(session: InternalSession, data: string): void {
    if (session.terminal) return;
    this.touch(session);
    for (const notifyOutput of [...session.outputWaiters]) notifyOutput();
    this.emit({
      type: "terminal.output",
      sessionId: session.snapshot.id,
      terminalNodeId: session.snapshot.terminalNodeId,
      data,
      timestamp: this.now()
    });
  }

  private async finish(
    session: InternalSession,
    state: Extract<ProcessState, "stopped" | "completed" | "failed">,
    exitCode: number | null,
    exitSignal: number | null
  ): Promise<void> {
    if (session.terminal) return;
    session.terminal = true;
    for (const notifyOutput of [...session.outputWaiters]) notifyOutput(true);
    for (const listener of session.listeners.splice(0)) listener.dispose();
    session.process?.dispose();
    session.process = null;
    session.snapshot = {
      ...session.snapshot,
      state,
      exitCode,
      exitSignal,
      lastActivityAt: this.now()
    };
    this.emitState(session);
    session.resolveExit();
  }

  private updateState(session: InternalSession, state: ProcessState): void {
    session.snapshot = { ...session.snapshot, state, lastActivityAt: this.now() };
    this.emitState(session);
  }

  private touch(session: InternalSession): void {
    session.snapshot = { ...session.snapshot, lastActivityAt: this.now() };
  }

  private emitState(session: InternalSession): void {
    this.emit({ type: "terminal.state", session: session.snapshot });
  }

  private emit(event: V2TerminalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A renderer listener cannot be allowed to corrupt lifecycle ownership.
      }
    }
  }

  private findByNode(workspaceId: string, terminalNodeId: string): InternalSession | null {
    for (const session of this.sessions.values()) {
      if (
        session.snapshot.workspaceId === workspaceId &&
        session.snapshot.terminalNodeId === terminalNodeId
      ) {
        return session;
      }
    }
    return null;
  }

  private requireRunning(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !["running", "waiting-input"].includes(session.snapshot.state)) {
      throw new Error(`Terminal session is not accepting input: ${sessionId}`);
    }
    return session;
  }

  private requireResizeable(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (
      session === undefined ||
      !["starting", "running", "waiting-input"].includes(session.snapshot.state)
    ) {
      throw new Error(`Terminal session is not accepting resize: ${sessionId}`);
    }
    return session;
  }

  private waitForOutputSettle(session: InternalSession, fallbackMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (!session.outputWaiters.delete(onOutput)) return;
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        clearTimeout(maximumTimer);
        resolve();
      };
      const onOutput = (terminal = false): void => {
        if (terminal) {
          finish();
          return;
        }
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 100);
      };
      session.outputWaiters.add(onOutput);
      const maximumTimer = setTimeout(finish, fallbackMs);
    });
  }

  private disposeSession(session: InternalSession): void {
    for (const notifyOutput of [...session.outputWaiters]) notifyOutput(true);
    for (const listener of session.listeners.splice(0)) listener.dispose();
    session.process?.dispose();
    session.process = null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shutdownTrace(stage: string, metadata: Readonly<Record<string, unknown>> = {}): void {
  if (process.env.COMPAZIO_V2_SHUTDOWN_TRACE !== "1") return;
  console.info(
    `COMPAZIO_SHUTDOWN_TRACE ${JSON.stringify({ stage, at: new Date().toISOString(), ...metadata })}`
  );
}
