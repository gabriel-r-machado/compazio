import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  runLocalMigrations,
  SqliteArtifactRegistry,
  SqliteWorkflowActivationStore,
  SqliteWorkflowRunStore
} from "@forgedeck/local-db";
import type {
  ArtifactRegistry,
  FinalReportInput,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeRunSnapshot,
  NodeRunState,
  RunEvent,
  RunState,
  WorkflowExecutionCheckpointReference,
  WorkflowNodeExecutor,
  WorkflowRunExecutionContext,
  WorkflowRunSnapshot
} from "@forgedeck/orchestration";
import { workflowDraftSchema } from "@forgedeck/schemas";
import type { WorkflowDraft } from "@forgedeck/schemas";
import type { ArtifactReference, Workflow, WorkflowNode } from "@forgedeck/workflow";

import { ActivationCoordinator } from "./activation-coordinator";
import { InMemoryWorkflowRunRootRegistry } from "./workflow-shell-execution-adapter";
import { WorkflowRunRuntime } from "./workflow-run-runtime";

/**
 * Durability of the shutdown path, reproduced through the exact composition the Electron smoke uses:
 * ActivationCoordinator → materialized run → execution context → delivery checkpoint → final report.
 *
 * The race this pins down: the scheduler used to publish the terminal state on its in-memory snapshot
 * *before* the delivery checkpoint, the report and the terminal write had happened, so an official read
 * (`runtime.show`) could report `succeeded` while SQLite still held `running`. Closing right after that
 * observation lost the terminal transition, and the reload treated the run as interrupted.
 *
 * Nothing here uses a sleep, a retry, a poll budget or a timeout to become deterministic: every wait is
 * an explicit gate or an awaited close.
 */

const terminalStates: readonly RunState[] = ["succeeded", "failed", "cancelled", "interrupted"];
const terminalNodeStates: readonly NodeRunState[] = [
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
  "skipped"
];

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

/** An in-process node executor; each node can be held open and released explicitly. */
class ControllableExecutor implements WorkflowNodeExecutor {
  public readonly started = new Set<string>();
  private readonly gates = new Map<string, Promise<void>>();
  private readonly releases = new Map<string, () => void>();
  private readonly failures = new Set<string>();
  private started_?: () => void;
  private readonly firstStart = new Promise<void>((resolve) => {
    this.started_ = resolve;
  });

  public hold(nodeId: string): void {
    this.gates.set(nodeId, new Promise<void>((resolve) => this.releases.set(nodeId, resolve)));
  }

  public release(nodeId: string): void {
    this.releases.get(nodeId)?.();
  }

  public failOn(nodeId: string): void {
    this.failures.add(nodeId);
  }

  /** Resolves as soon as the scheduler has actually entered a node — no polling. */
  public async whenRunning(): Promise<void> {
    await this.firstStart;
  }

  public async execute(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    this.started.add(node.id);
    this.started_?.();
    const gate = this.gates.get(node.id);
    if (gate !== undefined) {
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (context.abortSignal.aborted) resolve();
          else context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        })
      ]);
    }
    if (this.failures.has(node.id)) {
      return {
        success: false,
        reason: "process_exit_nonzero",
        message: "deliberate node failure",
        evidence: []
      };
    }
    return {
      success: true,
      evidence: [{ id: `evidence-${node.id}`, type: "artifact", summary: "done", metadata: {} }],
      output: {}
    };
  }
}

/** Wraps the real registry so the report write — the widest await in the terminal path — can be held. */
class GatedArtifactRegistry implements ArtifactRegistry {
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private entered: (() => void) | null = null;
  private enteredPromise: Promise<void> | null = null;

  public constructor(private readonly inner: SqliteArtifactRegistry) {}

  /** Holds the next final report and returns a promise that resolves when the scheduler reached it. */
  public holdNextReport(): Promise<void> {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.enteredPromise = new Promise<void>((resolve) => {
      this.entered = resolve;
    });
    return this.enteredPromise;
  }

  public releaseReport(): void {
    this.release?.();
    this.gate = null;
  }

  public async createFinalReport(input: FinalReportInput): Promise<ArtifactReference> {
    const gate = this.gate;
    if (gate !== null) {
      this.entered?.();
      await gate;
    }
    return this.inner.createFinalReport(input);
  }
}

interface RunStorePort {
  createRun(snapshot: WorkflowRunSnapshot, workflow: Workflow, event: RunEvent): Promise<void>;
  saveRun(snapshot: WorkflowRunSnapshot): Promise<void>;
  saveRunWithEvent(snapshot: WorkflowRunSnapshot, event: RunEvent): Promise<void>;
  saveNodeRun(snapshot: NodeRunSnapshot): Promise<void>;
  saveNodeRunWithEvent(snapshot: NodeRunSnapshot, event: RunEvent): Promise<void>;
  appendEvent(event: RunEvent): Promise<void>;
  getWorkflow(runId: string): Workflow | null;
  get(runId: string): WorkflowRunSnapshot | null;
  list(input: {
    readonly state?: RunState;
    readonly limit?: number;
  }): readonly WorkflowRunSnapshot[];
  listEvents(runId: string, limit?: number): readonly RunEvent[];
}

/**
 * Delegates to the real SQLite store and records every write that was attempted after the database was
 * closed, so "no write after close" is an observation rather than an assumption. It can also be told to
 * fail one terminal write, which is how a real persistence failure is exercised.
 */
class RecordingRunStore implements RunStorePort {
  public readonly writesAfterClose: string[] = [];
  public failTerminalWrite = false;
  private closed = false;

  public constructor(private readonly inner: SqliteWorkflowRunStore) {}

  public close(): void {
    this.closed = true;
    this.inner.close();
  }

  public async createRun(
    snapshot: WorkflowRunSnapshot,
    workflow: Workflow,
    event: RunEvent
  ): Promise<void> {
    this.record("createRun");
    return this.inner.createRun(snapshot, workflow, event);
  }

  public async saveRun(snapshot: WorkflowRunSnapshot): Promise<void> {
    this.record("saveRun");
    return this.inner.saveRun(snapshot);
  }

  public async saveRunWithEvent(snapshot: WorkflowRunSnapshot, event: RunEvent): Promise<void> {
    this.record("saveRunWithEvent");
    if (this.failTerminalWrite && terminalStates.includes(snapshot.state)) {
      throw new Error("simulated durable store failure");
    }
    return this.inner.saveRunWithEvent(snapshot, event);
  }

  public async saveNodeRun(snapshot: NodeRunSnapshot): Promise<void> {
    this.record("saveNodeRun");
    return this.inner.saveNodeRun(snapshot);
  }

  public async saveNodeRunWithEvent(snapshot: NodeRunSnapshot, event: RunEvent): Promise<void> {
    this.record("saveNodeRunWithEvent");
    return this.inner.saveNodeRunWithEvent(snapshot, event);
  }

  public async appendEvent(event: RunEvent): Promise<void> {
    this.record("appendEvent");
    return this.inner.appendEvent(event);
  }

  public getWorkflow(runId: string): Workflow | null {
    return this.inner.getWorkflow(runId);
  }

  public get(runId: string): WorkflowRunSnapshot | null {
    return this.inner.get(runId);
  }

  public list(input: {
    readonly state?: RunState;
    readonly limit?: number;
  }): readonly WorkflowRunSnapshot[] {
    return this.inner.list(input);
  }

  public listEvents(runId: string, limit?: number): readonly RunEvent[] {
    return this.inner.listEvents(runId, limit);
  }

  private record(operation: string): void {
    if (this.closed) this.writesAfterClose.push(operation);
  }
}

interface Harness {
  readonly runtime: WorkflowRunRuntime;
  readonly store: RecordingRunStore;
  readonly reports: GatedArtifactRegistry;
  readonly executor: ControllableExecutor;
  readonly coordinator: ActivationCoordinator;
  readonly filename: string;
  /** The official shutdown order: drain the runtime, then close the stores. */
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-shutdown-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  runLocalMigrations({ filename });
  seedWorkspace(filename, directory);

  const sqliteStore = new SqliteWorkflowRunStore(filename);
  const store = new RecordingRunStore(sqliteStore);
  const innerRegistry = new SqliteArtifactRegistry(filename, join(directory, "artifacts"));
  const reports = new GatedArtifactRegistry(innerRegistry);
  const executor = new ControllableExecutor();
  const runtime = new WorkflowRunRuntime(
    executor,
    store,
    reports,
    new InMemoryWorkflowRunRootRegistry()
  );
  const activations = new SqliteWorkflowActivationStore(filename);

  const coordinator = new ActivationCoordinator({
    onDispatch: () => undefined,
    newId: () => globalThis.crypto.randomUUID(),
    materialization: {
      ledger: activations,
      resolveProjectRoot: () => directory,
      starter: {
        startMaterializedWorkflow: async (input) => {
          const checkpoint: WorkflowExecutionCheckpointReference = {
            checkpointId: globalThis.crypto.randomUUID(),
            snapshotId: globalThis.crypto.randomUUID(),
            sha256: input.definitionSha256,
            createdAt: new Date().toISOString()
          };
          const context: WorkflowRunExecutionContext = {
            workspaceId: input.workspaceId,
            agentNodeId: input.agentNodeId,
            task: input.task,
            contractId: null,
            profileVersion: 1,
            missionVersion: null,
            memoryVersion: null,
            contractVersion: null,
            functionCheckpoint: checkpoint,
            deliveryCheckpoint: null
          };
          const handle = runtime.startMaterialized({
            workflow: input.workflow,
            target: { root: input.root, agentNodeId: input.agentNodeId },
            executionContext: { context, createDeliveryCheckpoint: async () => checkpoint }
          });
          return runtime.get(handle.runId);
        }
      }
    }
  });

  return {
    runtime,
    store,
    reports,
    executor,
    coordinator,
    filename,
    // The stores are closed even when the drain fails, so a persistence failure leaks no handle —
    // but the failure itself still propagates and is never reported as a clean shutdown.
    close: async () => {
      try {
        await runtime.close();
      } finally {
        innerRegistry.close();
        activations.close();
        store.close();
      }
    }
  };
}

function draft(version = 1): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "77777777-7777-4777-8777-777777777777",
    version,
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Landing page",
    objective: "Build the landing page",
    state: "approved",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    nodes: [
      {
        id: "planner",
        title: "Planner",
        role: "planner",
        runtimeRequirement: { resolvedRuntimeId: "fake-agent" }
      },
      {
        id: "implementer",
        title: "Implementer",
        role: "implementer",
        runtimeRequirement: { resolvedRuntimeId: "fake-agent" }
      }
    ],
    edges: [
      {
        id: "planner__implementer",
        sourceNodeId: "planner",
        targetNodeId: "implementer",
        type: "dependency"
      }
    ]
  });
}

/** Reopens the same database exactly as a reload would, and reports what recovery finds. */
function reopen<T>(filename: string, read: (store: SqliteWorkflowRunStore) => T): T {
  const store = new SqliteWorkflowRunStore(filename);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

/**
 * Reproduces the exact observation the Electron smoke makes: read the runtime's own view — never the
 * store — until it reports the run as terminal. It yields the event loop rather than sleeping, and has
 * no timeout budget, so it can only resolve on the runtime's own claim of conclusion.
 */
async function whenRuntimeReportsTerminal(harness: Harness, runId: string): Promise<void> {
  while (!terminalStates.includes(harness.runtime.show(runId).state)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function materializeAndSettle(harness: Harness): Promise<string> {
  const activation = await harness.coordinator.materialize(draft());
  expect(activation.status).toBe("started");
  const runId = activation.runId as string;
  await whenRuntimeReportsTerminal(harness, runId);
  return runId;
}

describe("workflow shutdown durability", () => {
  it("never reports a terminal run before its terminal transition is durably persisted", async () => {
    const harness = await makeHarness();
    try {
      // Hold the final report: the scheduler is now inside the terminal path, past every node.
      const reachedReport = harness.reports.holdNextReport();
      const activation = await harness.coordinator.materialize(draft());
      const runId = activation.runId as string;
      await reachedReport;

      // Every node has settled and the run is finishing, but nothing terminal has been committed yet,
      // so no official read may claim a conclusion.
      const observed = harness.runtime.show(runId);
      expect(observed.nodeRuns.every((node) => node.state === "succeeded")).toBe(true);
      expect(terminalStates).not.toContain(observed.state);
      expect(harness.store.get(runId)?.state).toBe("running");

      harness.reports.releaseReport();
      await harness.runtime.drain();

      // Only now, and the store and the runtime agree.
      expect(harness.runtime.show(runId).state).toBe("succeeded");
      expect(harness.store.get(runId)?.state).toBe("succeeded");
      expect(harness.runtime.show(runId).reportArtifact).not.toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("survives close immediately after the runtime observed the run as terminal", async () => {
    // Repeated, because a race that only sometimes loses the write must fail this test every time.
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const harness = await makeHarness();
      const runId = await materializeAndSettle(harness);
      // No sleep, no drain budget: close right on the observation.
      await harness.close();

      expect(harness.store.writesAfterClose).toEqual([]);

      reopen(harness.filename, (store) => {
        const reloaded = store.get(runId);
        expect(reloaded?.state).toBe("succeeded");
        expect(reloaded?.endedAt).not.toBeNull();
        expect(reloaded?.reportArtifact).not.toBeNull();
        expect(reloaded?.nodeRuns.map((node) => node.state)).toEqual(["succeeded", "succeeded"]);
        expect(reloaded?.nodeRuns.every((node) => node.attempt === 1)).toBe(true);
        expect(reloaded?.executionContext?.deliveryCheckpoint).not.toBeNull();
        // The run's lineage and terminal event are part of the same committed transition.
        expect(store.listEvents(runId).some((event) => event.type === "run.completed")).toBe(true);
        // A terminal run is never resurrected and never gains an attempt on reload.
        expect(store.recoverInterruptedRuns()).toBe(0);
        expect(store.get(runId)?.state).toBe("succeeded");
        expect(store.get(runId)?.nodeRuns.every((node) => node.attempt === 1)).toBe(true);
        expect(store.list({})).toHaveLength(1);
      });
    }
  });

  it("closing during an active run persists an interrupted run that recovery leaves alone", async () => {
    const harness = await makeHarness();
    harness.executor.hold("planner");
    const activation = await harness.coordinator.materialize(draft());
    const runId = activation.runId as string;
    await harness.executor.whenRunning();

    // Close with a node still executing: the shutdown aborts it and waits for the terminal write.
    await harness.close();
    expect(harness.store.writesAfterClose).toEqual([]);

    reopen(harness.filename, (store) => {
      const reloaded = store.get(runId);
      expect(reloaded?.state).toBe("interrupted");
      expect(reloaded?.endedAt).not.toBeNull();
      expect(reloaded?.nodeRuns.every((node) => terminalNodeStates.includes(node.state))).toBe(
        true
      );
      expect(store.listEvents(runId).some((event) => event.type === "run.interrupted")).toBe(true);
      // The shutdown already left the durable state recovery would have produced.
      expect(store.recoverInterruptedRuns()).toBe(0);
      expect(store.list({})).toHaveLength(1);
      // The implementer never started, so it never gained an attempt.
      expect(
        store.get(runId)?.nodeRuns.find((node) => node.nodeId === "implementer")?.attempt
      ).toBe(0);
    });
    expect(harness.executor.started.has("implementer")).toBe(false);
  });

  it("persists the terminal state after a failed run", async () => {
    const harness = await makeHarness();
    harness.executor.failOn("planner");
    const runId = await materializeAndSettle(harness);
    expect(harness.runtime.show(runId).state).toBe("failed");
    await harness.close();

    reopen(harness.filename, (store) => {
      expect(store.get(runId)?.state).toBe("failed");
      expect(store.get(runId)?.nodeRuns.find((node) => node.nodeId === "planner")?.state).toBe(
        "failed"
      );
      expect(store.recoverInterruptedRuns()).toBe(0);
    });
    expect(harness.store.writesAfterClose).toEqual([]);
  });

  it("persists the terminal state after a cancelled run", async () => {
    const harness = await makeHarness();
    harness.executor.hold("planner");
    const activation = await harness.coordinator.materialize(draft());
    const runId = activation.runId as string;
    await harness.executor.whenRunning();
    await harness.runtime.cancel(runId);
    await whenRuntimeReportsTerminal(harness, runId);
    expect(harness.runtime.show(runId).state).toBe("cancelled");
    await harness.close();

    reopen(harness.filename, (store) => {
      expect(store.get(runId)?.state).toBe("cancelled");
      expect(store.get(runId)?.nodeRuns.every((node) => node.state !== "succeeded")).toBe(true);
      expect(store.recoverInterruptedRuns()).toBe(0);
    });
    expect(harness.store.writesAfterClose).toEqual([]);
  });

  it("close is idempotent and refuses to start anything afterwards", async () => {
    const harness = await makeHarness();
    const runId = await materializeAndSettle(harness);
    await harness.runtime.close();
    await harness.runtime.close();
    await harness.runtime.close();
    expect(() =>
      harness.runtime.startTemplate("delivery-report", false, { root: "/tmp", agentNodeId: "a" })
    ).toThrow(/shutting down/);
    await harness.close();

    reopen(harness.filename, (store) => {
      expect(store.get(runId)?.state).toBe("succeeded");
      expect(store.list({})).toHaveLength(1);
      expect(store.recoverInterruptedRuns()).toBe(0);
    });
    expect(harness.store.writesAfterClose).toEqual([]);
  });

  it("propagates a real persistence failure instead of reporting a clean close", async () => {
    const harness = await makeHarness();
    harness.store.failTerminalWrite = true;
    const activation = await harness.coordinator.materialize(draft());
    const runId = activation.runId as string;

    await expect(harness.runtime.close()).rejects.toThrow(/simulated durable store failure/);
    // The run never claimed a conclusion the store refused to accept.
    expect(terminalStates).not.toContain(harness.runtime.show(runId).state);
    expect(harness.store.get(runId)?.state).toBe("running");
    // The failure is sticky: a second close cannot launder it into a clean shutdown.
    await expect(harness.runtime.close()).rejects.toThrow(/simulated durable store failure/);
    await expect(harness.close()).rejects.toThrow(/simulated durable store failure/);
  });

  it("refuses every write once the store is closed", async () => {
    const harness = await makeHarness();
    const runId = await materializeAndSettle(harness);
    const snapshot = harness.store.get(runId) as WorkflowRunSnapshot;
    await harness.close();

    await expect(harness.store.saveRun(snapshot)).rejects.toThrow(/closed/);
    await expect(
      harness.store.saveNodeRun(snapshot.nodeRuns[0] as NodeRunSnapshot)
    ).rejects.toThrow(/closed/);
    // The attempts above are refused before touching SQLite, and the durable state is untouched.
    reopen(harness.filename, (store) => {
      expect(store.get(runId)?.state).toBe("succeeded");
      expect(store.get(runId)?.nodeRuns.every((node) => node.attempt === 1)).toBe(true);
    });
  });

  it("leaves no run in flight after close", async () => {
    const harness = await makeHarness();
    harness.executor.hold("planner");
    await harness.coordinator.materialize(draft());
    await harness.executor.whenRunning();
    await harness.runtime.close();

    // Nothing is still scheduled: a drain after close resolves without waiting on anything.
    await harness.runtime.drain();
    reopen(harness.filename, (store) => {
      expect(store.list({}).every((run) => terminalStates.includes(run.state))).toBe(true);
    });
    await harness.close();
  });
});

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at) VALUES ('project-1', 'Compasso', ?, ?, 'main', 'abc', ?, ?)"
      )
      .run(root, root, now, now);
    sqlite
      .prepare(
        "INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at) VALUES ('canvas-1', 'Main', '', 1, '{}', ?, ?)"
      )
      .run(now, now);
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at) VALUES ('workspace-1', 'project-1', 'canvas-1', 'Main', 0, 1, ?, ?)"
      )
      .run(now, now);
  } finally {
    sqlite.close();
  }
}
