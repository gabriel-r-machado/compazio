import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteArtifactRegistry, SqliteWorkflowActivationStore } from "@forgedeck/local-db";
import { runLocalMigrations } from "@forgedeck/local-db";
import { SqliteWorkflowRunStore } from "@forgedeck/local-db";
import type {
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowExecutionCheckpointReference,
  WorkflowNodeExecutor,
  WorkflowRunExecutionContext
} from "@forgedeck/orchestration";
import { workflowDraftSchema } from "@forgedeck/schemas";
import type { WorkflowDraft, WorkflowEdgeDraft } from "@forgedeck/schemas";
import type { WorkflowNode } from "@forgedeck/workflow";

import { ActivationCoordinator } from "./activation-coordinator";
import { InMemoryWorkflowRunRootRegistry } from "./workflow-shell-execution-adapter";
import { WorkflowRunRuntime } from "./workflow-run-runtime";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

/** A PTY-free agent executor. The planner waits on an external gate so we can observe dependency gating. */
class GatedAgentExecutor implements WorkflowNodeExecutor {
  public release: () => void = () => undefined;
  private readonly gate: Promise<void>;
  public constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  public async execute(
    node: WorkflowNode,
    _context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    void _context;
    if (node.id === "planner") {
      await this.gate;
    }
    return {
      success: true,
      evidence: [
        {
          id: `evidence-${node.id}`,
          type: "artifact",
          summary: "done",
          metadata: { nodeId: node.id }
        }
      ],
      output: {}
    };
  }
}

function edge(from: string, to: string): WorkflowEdgeDraft {
  return {
    id: `${from}__${to}`,
    sourceNodeId: from,
    targetNodeId: to,
    type: "dependency",
    contract: { requiredArtifacts: [], requiredEvidence: [], completionCondition: "" }
  };
}

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "44444444-4444-4444-8444-444444444444",
    version: 5,
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Landing page",
    objective: "Build the landing page",
    state: "approved",
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    nodes: [
      {
        id: "planner",
        title: "Planner",
        role: "planner",
        runtimeRequirement: { resolvedRuntimeId: "fake-agent" }
      },
      {
        id: "executor",
        title: "Executor",
        role: "implementer",
        runtimeRequirement: { resolvedRuntimeId: "fake-agent" }
      }
    ],
    edges: [edge("planner", "executor")],
    ...overrides
  });
}

interface Harness {
  readonly runtime: WorkflowRunRuntime;
  readonly activations: SqliteWorkflowActivationStore;
  readonly coordinator: ActivationCoordinator;
  readonly executor: GatedAgentExecutor;
  readonly filename: string;
  readonly root: string;
  close(): void;
}

async function makeHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-materialize-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  runLocalMigrations({ filename });
  seedWorkspace(filename, directory);

  const store = new SqliteWorkflowRunStore(filename);
  const registry = new SqliteArtifactRegistry(filename, join(directory, "artifacts"));
  const roots = new InMemoryWorkflowRunRootRegistry();
  const executor = new GatedAgentExecutor();
  const runtime = new WorkflowRunRuntime(executor, store, registry, roots);
  const activations = new SqliteWorkflowActivationStore(filename);

  const coordinator = new ActivationCoordinator({
    onDispatch: () => undefined,
    newId: () => "unused",
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
    activations,
    coordinator,
    executor,
    filename,
    root: directory,
    close: () => {
      registry.close();
      store.close();
      activations.close();
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a run condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits until the run's terminal state is durably persisted (store-backed list), so closing the
 * database can never race the scheduler's final write. */
async function waitUntilSettled(runtime: WorkflowRunRuntime, runId: string): Promise<void> {
  await waitFor(() => {
    const state = runtime.list().find((run) => run.id === runId)?.state;
    return (
      state !== undefined && ["succeeded", "failed", "cancelled", "interrupted"].includes(state)
    );
  });
}

describe("approve → materialize → WorkflowRunRuntime", () => {
  it("creates exactly one official run whose nodes preserve the canvas workflowNodeIds", async () => {
    const harness = await makeHarness();
    try {
      const activation = await harness.coordinator.materialize(draft());
      expect(activation.status).toBe("started");
      expect(activation.runId).not.toBeNull();
      const runId = activation.runId as string;

      // The run is a real WorkflowRunRuntime run, visible via the official list/show.
      expect(harness.runtime.list().map((run) => run.id)).toContain(runId);
      const snapshot = harness.runtime.show(runId);
      expect(snapshot.nodeRuns.map((node) => node.nodeId).sort()).toEqual(["executor", "planner"]);
      expect(snapshot.executionContext?.workspaceId).toBe("workspace-1");
      // The official dependency graph preserves the executable dependency.
      const graph = harness.runtime.graph(runId);
      expect(graph.nodes.find((node) => node.id === "executor")?.dependsOn).toEqual(["planner"]);

      // The dependent stays blocked until the upstream completes (real scheduler gating).
      await waitFor(() =>
        harness.runtime
          .show(runId)
          .nodeRuns.some((n) => n.nodeId === "planner" && ["running", "starting"].includes(n.state))
      );
      const gated = harness.runtime.show(runId);
      expect(gated.nodeRuns.find((n) => n.nodeId === "executor")?.state).not.toBe("succeeded");

      harness.executor.release();
      await waitUntilSettled(harness.runtime, runId);
      const done = harness.runtime.show(runId);
      expect(done.state).toBe("succeeded");
      expect(done.nodeRuns.every((n) => n.state === "succeeded")).toBe(true);

      // Exactly one run — no parallel scheduler created another.
      expect(harness.runtime.list()).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("a repeated approval returns the same run without creating a second", async () => {
    const harness = await makeHarness();
    try {
      harness.executor.release();
      const first = await harness.coordinator.materialize(draft());
      const second = await harness.coordinator.materialize(draft());
      expect(second.runId).toBe(first.runId);
      expect(harness.runtime.list()).toHaveLength(1);
      await waitUntilSettled(harness.runtime, first.runId as string);
    } finally {
      harness.close();
    }
  });

  it("a validation failure never persists a run or an activation run id", async () => {
    const harness = await makeHarness();
    try {
      const unbound = draft({
        nodes: draft().nodes.map((node) => ({
          ...node,
          runtimeRequirement: { ...node.runtimeRequirement, resolvedRuntimeId: null }
        }))
      });
      const activation = await harness.coordinator.materialize(unbound);
      expect(activation.status).toBe("invalid");
      expect(activation.runId).toBeNull();
      expect(harness.runtime.list()).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("recovers the same run after reload and never approves again", async () => {
    const harness = await makeHarness();
    let runId: string;
    try {
      harness.executor.release();
      const activation = await harness.coordinator.materialize(draft());
      runId = activation.runId as string;
      await waitUntilSettled(harness.runtime, runId);
    } finally {
      harness.close();
    }

    // A fresh runtime + activation store over the same database (a reload) recovers both.
    const store = new SqliteWorkflowRunStore(harness.filename);
    const activations = new SqliteWorkflowActivationStore(harness.filename);
    try {
      expect(store.get(runId)?.state).toBe("succeeded");
      const association = activations.getByDraft(draft().id, draft().version);
      expect(association?.runId).toBe(runId);
      expect(activations.getLatestStartedForWorkspace("workspace-1")?.runId).toBe(runId);
    } finally {
      store.close();
      activations.close();
    }
  });
});

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-24T12:00:00.000Z");
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
