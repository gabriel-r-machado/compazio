import type { RuntimePlatform } from "@forgedeck/agent-sdk";

import { MessageQueue } from "./message-queue";
import { OutputBatcher, LineRingBuffer } from "./output";
import { PlatformProcessTreeKiller } from "./process-tree-killer";
import { validateLaunchSpec } from "./security";
import { InMemoryRuntimeSessionStore } from "./session-store";
import type {
  Disposable,
  ManagedProcess,
  ManagedProcessFactory,
  ProcessLifecycleState,
  ProcessSessionSnapshot,
  ProcessSupervisorEvent,
  ProcessTreeKiller,
  RuntimeSessionRecord,
  RuntimeSessionStore,
  StartProcessSessionInput
} from "./types";

interface SupervisorOptions {
  readonly platform?: RuntimePlatform;
  readonly sessionStore?: RuntimeSessionStore;
  readonly processTreeKiller?: ProcessTreeKiller;
  readonly batchIntervalMs?: number;
  readonly maxBatchChars?: number;
  readonly maxBufferLines?: number;
  readonly maxQueuedMessages?: number;
  readonly maxQueuedBytes?: number;
}

interface InternalSession {
  record: RuntimeSessionRecord;
  pty: ManagedProcess | null;
  readonly buffer: LineRingBuffer;
  readonly batcher: OutputBatcher;
  readonly queue: MessageQueue;
  readonly exitPromise: Promise<void>;
  resolveExit: () => void;
  readonly disposables: Disposable[];
  sequence: number;
  terminal: boolean;
  cancelPromise: Promise<ProcessSessionSnapshot> | null;
}

const terminalStates = new Set<ProcessLifecycleState>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted"
]);

export class ProcessSupervisor {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly listeners = new Set<(event: ProcessSupervisorEvent) => void>();
  private readonly platform: RuntimePlatform;
  private readonly store: RuntimeSessionStore;
  private readonly treeKiller: ProcessTreeKiller;
  private readonly batchIntervalMs: number;
  private readonly maxBatchChars: number;
  private readonly maxBufferLines: number;
  private readonly maxQueuedMessages: number;
  private readonly maxQueuedBytes: number;

  public constructor(
    private readonly factory: ManagedProcessFactory,
    options: SupervisorOptions = {}
  ) {
    this.platform = options.platform ?? normalizePlatform(process.platform);
    this.store = options.sessionStore ?? new InMemoryRuntimeSessionStore();
    this.treeKiller = options.processTreeKiller ?? new PlatformProcessTreeKiller();
    this.batchIntervalMs = options.batchIntervalMs ?? 16;
    this.maxBatchChars = options.maxBatchChars ?? 64 * 1024;
    this.maxBufferLines = options.maxBufferLines ?? 10_000;
    this.maxQueuedMessages = options.maxQueuedMessages ?? 100;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024;
  }

  public subscribe(listener: (event: ProcessSupervisorEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async recoverInterrupted(): Promise<number> {
    return this.store.markActiveSessionsInterrupted(new Date(), "application_restart");
  }

  public async start(input: StartProcessSessionInput): Promise<ProcessSessionSnapshot> {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`Session already exists: ${input.sessionId}`);
    }
    await validateLaunchSpec(
      input.launch,
      input.allowedCwdRoots,
      this.platform,
      input.additionalAllowedEnvKeys ?? []
    );

    const now = new Date();
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session: InternalSession = {
      record: {
        id: input.sessionId,
        adapterId: input.adapterId,
        state: "starting",
        cwd: input.launch.cwd,
        processId: null,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        exitCode: null,
        exitSignal: null,
        interruptionReason: null
      },
      pty: null,
      buffer: new LineRingBuffer(this.maxBufferLines),
      batcher: new OutputBatcher(
        (data) => this.emitOutput(input.sessionId, data),
        this.batchIntervalMs,
        this.maxBatchChars
      ),
      queue: new MessageQueue(this.maxQueuedMessages, this.maxQueuedBytes),
      exitPromise,
      resolveExit,
      disposables: [],
      sequence: 0,
      terminal: false,
      cancelPromise: null
    };
    this.sessions.set(input.sessionId, session);
    await this.persistAndEmit(session);

    try {
      const pty = await this.factory.spawn(input.launch);
      session.pty = pty;
      session.record = {
        ...session.record,
        state: "running",
        processId: pty.pid,
        updatedAt: new Date()
      };
      session.disposables.push(
        pty.onData((data) => {
          session.buffer.append(data);
          session.batcher.push(data);
        }),
        pty.onExit((event) => void this.handleExit(session, event.exitCode, event.signal ?? null))
      );
      session.queue.attach((data) => pty.write(data));
      await this.persistAndEmit(session);

      if (input.launch.initialInput !== undefined) {
        await session.queue.enqueue(input.launch.initialInput.data);
        if (input.launch.initialInput.closeAfterWrite) {
          pty.endInput();
        }
      }
      return toSnapshot(session.record);
    } catch (error: unknown) {
      await this.failSession(session, error instanceof Error ? error.message : "PTY spawn failed");
      throw error;
    }
  }

  public async write(sessionId: string, data: string): Promise<void> {
    const session = this.requireActiveSession(sessionId);
    await session.queue.enqueue(data);
  }

  public resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireActiveSession(sessionId);
    if (cols < 1 || cols > 500 || rows < 1 || rows > 500) {
      throw new Error("Terminal dimensions are outside the allowed range");
    }
    session.pty?.resize(cols, rows);
  }

  public cancel(sessionId: string, graceMs = 1500): Promise<ProcessSessionSnapshot> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (terminalStates.has(session.record.state)) {
      return Promise.resolve(toSnapshot(session.record));
    }
    if (session.cancelPromise !== null) {
      return session.cancelPromise;
    }
    session.cancelPromise = this.cancelActiveSession(session, graceMs);
    return session.cancelPromise;
  }

  private async cancelActiveSession(
    session: InternalSession,
    graceMs: number
  ): Promise<ProcessSessionSnapshot> {
    session.record = { ...session.record, state: "stopping", updatedAt: new Date() };
    await this.persistAndEmit(session);
    // Transport-specific graceful stop (pty: Ctrl-C; pipe: close stdin). Tree-kill follows on grace.
    session.pty?.requestCancel();

    const exited = await Promise.race([
      session.exitPromise.then(() => true),
      delay(graceMs).then(() => false)
    ]);
    if (!exited) {
      if (!session.terminal) {
        await this.forceKillSession(session);
      }
      await Promise.race([session.exitPromise, delay(500)]);
      if (!session.terminal) {
        await this.finishSession(session, "cancelled", null, null);
      }
    }
    return toSnapshot(session.record);
  }

  public async forceKill(sessionId: string): Promise<void> {
    const session = this.requireActiveSession(sessionId);
    await this.forceKillSession(session);
  }

  public async shutdown(graceMs = 1500): Promise<void> {
    const activeSessionIds = [...this.sessions.values()]
      .filter((session) => !terminalStates.has(session.record.state))
      .map((session) => session.record.id);
    await Promise.all(activeSessionIds.map((sessionId) => this.cancel(sessionId, graceMs)));
  }

  /**
   * Full teardown: cancels any active session, reaps every session's process tree (so a child a
   * process spawned cannot outlive it), disposes all per-session resources, and drops every session
   * and listener. Unlike {@link shutdown} it also releases already-terminal sessions, so the owning
   * process can exit cleanly. It changes no execution semantics — it is only called when the owner is
   * tearing the supervisor down (the official Electron shutdown or a one-off local check).
   */
  public async close(graceMs = 1500): Promise<void> {
    await this.shutdown(graceMs);
    for (const session of this.sessions.values()) {
      const pid = session.pty?.pid;
      if (pid !== undefined) {
        try {
          await this.treeKiller.kill(pid);
        } catch {
          try {
            session.pty?.kill();
          } catch {
            // The process is already gone; nothing more to reap.
          }
        }
      }
      session.batcher.dispose();
      session.queue.close();
      for (const disposable of session.disposables.splice(0)) {
        disposable.dispose();
      }
      session.pty?.dispose();
    }
    this.sessions.clear();
    this.listeners.clear();
  }

  private async forceKillSession(session: InternalSession): Promise<void> {
    const pid = session.pty?.pid;
    if (pid !== undefined) {
      try {
        await this.treeKiller.kill(pid);
      } catch {
        session.pty?.kill();
      }
    }
  }

  public getSession(sessionId: string): ProcessSessionSnapshot {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return toSnapshot(session.record);
  }

  /** Waits only for an already-known session; it never exposes its command, cwd or output. */
  public async waitForTerminal(
    sessionId: string,
    timeoutMs: number
  ): Promise<ProcessSessionSnapshot> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new Error("Process terminal wait timeout is invalid");
    }
    const current = this.getSession(sessionId);
    if (terminalStates.has(current.state)) return current;
    return new Promise<ProcessSessionSnapshot>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const subscription = this.subscribe((event) => {
        if (event.type !== "session.state" || event.session.id !== sessionId) return;
        if (!terminalStates.has(event.session.state)) return;
        cleanup();
        resolve(event.session);
      });
      const cleanup = (): void => {
        subscription.dispose();
        if (timeout !== null) clearTimeout(timeout);
      };
      timeout = setTimeout(() => {
        cleanup();
        reject(new ProcessTerminalWaitTimeoutError());
      }, timeoutMs);
      timeout.unref();
      const latest = this.getSession(sessionId);
      if (terminalStates.has(latest.state)) {
        cleanup();
        resolve(latest);
      }
    });
  }

  public getBuffer(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session.buffer.snapshot();
  }

  public getBufferSnapshot(sessionId: string): {
    readonly data: string;
    readonly sequence: number;
  } {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return { data: session.buffer.snapshot(), sequence: session.sequence };
  }

  public clearBuffer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    session.buffer.clear();
  }

  public listSessions(): readonly ProcessSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => toSnapshot(session.record));
  }

  private requireActiveSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (terminalStates.has(session.record.state)) {
      throw new Error(`Session is already terminal: ${sessionId}`);
    }
    return session;
  }

  private async handleExit(
    session: InternalSession,
    exitCode: number,
    signal: number | null
  ): Promise<void> {
    if (session.terminal) {
      return;
    }
    const state =
      session.record.state === "stopping" ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
    await this.finishSession(session, state, exitCode, signal);
  }

  private async failSession(session: InternalSession, message: string): Promise<void> {
    await this.finishSession(session, "failed", null, null);
    this.emit({
      type: "session.error",
      sessionId: session.record.id,
      code: "process_spawn_failed",
      message
    });
  }

  private async finishSession(
    session: InternalSession,
    state: "succeeded" | "failed" | "cancelled",
    exitCode: number | null,
    exitSignal: number | null
  ): Promise<void> {
    if (session.terminal) {
      return;
    }
    session.terminal = true;
    session.batcher.dispose();
    session.queue.close();
    for (const disposable of session.disposables.splice(0)) {
      disposable.dispose();
    }
    session.pty?.dispose();
    const now = new Date();
    session.record = {
      ...session.record,
      state,
      updatedAt: now,
      endedAt: now,
      exitCode,
      exitSignal
    };
    await this.persistAndEmit(session);
    session.resolveExit();
  }

  private emitOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    session.sequence += 1;
    this.emit({
      type: "session.output",
      sessionId,
      sequence: session.sequence,
      data,
      timestamp: new Date().toISOString()
    });
  }

  private async persistAndEmit(session: InternalSession): Promise<void> {
    await this.store.save(session.record);
    this.emit({ type: "session.state", session: toSnapshot(session.record) });
  }

  private emit(event: ProcessSupervisorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A consumer failure must not crash or corrupt the process supervisor.
      }
    }
  }
}

export class ProcessTerminalWaitTimeoutError extends Error {
  public constructor() {
    super("Process session did not reach a terminal state before its timeout");
    this.name = "ProcessTerminalWaitTimeoutError";
  }
}

function toSnapshot(record: RuntimeSessionRecord): ProcessSessionSnapshot {
  return {
    id: record.id,
    adapterId: record.adapterId,
    state: record.state,
    processId: record.processId,
    startedAt: record.startedAt?.toISOString() ?? null,
    endedAt: record.endedAt?.toISOString() ?? null,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal
  };
}

function normalizePlatform(platform: NodeJS.Platform): RuntimePlatform {
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(`Unsupported runtime platform: ${platform}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
