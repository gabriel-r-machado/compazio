import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecFileCommandRunner } from "@forgedeck/agent-adapters";
import {
  SqliteArtifactRegistry,
  SqliteWorkflowRunStore,
  runLocalMigrations
} from "@forgedeck/local-db";
import { PipeProcessFactory, ProcessSupervisor } from "@forgedeck/terminal";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { materializeWorkflowDraft } from "@forgedeck/orchestration";
import type { AgentAssignmentCatalog } from "@forgedeck/orchestration";
import { agentDescriptorSchema, workflowDraftSchema } from "@forgedeck/schemas";
import type { AgentAdapterId, AgentDescriptor } from "@forgedeck/schemas";
import { workflowSchema, type Workflow } from "@forgedeck/workflow";

import { AgentAdapterRegistry } from "./agent-adapter-registry";
import { AgentDescriptorRegistry } from "./agent-descriptor-registry";
import { AgentNodeExecutorRouter } from "./agent-node-executor-router";
import { ClaudeCodeFixtureAdapter } from "./claude-code-fixture-adapter";
import { CodexFixtureAdapter } from "./codex-fixture-adapter";
import { ProcessAgentNodeExecutor } from "./process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "./workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "./workflow-run-runtime";

/**
 * Two different agents inside ONE workflow, driven by the single official runtime. The handoff between
 * them is Compazio's own artifact plus its recorded hash — never shared memory between the CLIs, and
 * never one agent invoking the other. Both are deterministic fixtures: no real Claude and no real
 * Codex is ever called here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "..", "e2e", "fixtures");
const claudeFixture = join(fixturesDir, "claude-code-fixture.mjs");
const codexFixture = join(fixturesDir, "codex-fixture.mjs");
const migrationsFolder = resolve(here, "..", "..", "..", "..", "packages", "local-db", "drizzle");

function platform(): RuntimePlatform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported test platform");
}

/** planner runs on Claude, builder runs on Codex — one run, one scheduler, one supervisor. */
function mixedWorkflow(id: string, codexToken: string): Workflow {
  return workflowSchema.parse({
    schema_version: "1.0",
    id,
    name: "Claude to Codex",
    concurrency: 1,
    permissions: {},
    nodes: [
      {
        id: "planner",
        type: "agent",
        role: "planner",
        adapter: "claude-code",
        title: "Plan #fixture:success",
        permissions: {}
      },
      {
        id: "builder",
        type: "agent",
        role: "implementer",
        adapter: "codex",
        title: `Build ${codexToken}`,
        depends_on: ["planner"],
        permissions: {}
      },
      {
        id: "reviewer",
        type: "agent",
        role: "reviewer",
        adapter: "claude-code",
        title: "Review #fixture:success",
        depends_on: ["builder"],
        permissions: {}
      }
    ]
  });
}

interface Harness {
  readonly runtime: WorkflowRunRuntime;
  readonly store: SqliteWorkflowRunStore;
  readonly registry: SqliteArtifactRegistry;
  readonly supervisor: ProcessSupervisor;
  readonly adapters: AgentAdapterRegistry;
  readonly filename: string;
  readonly close: () => Promise<void>;
}

function compose(dir: string): Harness {
  mkdirSync(dir, { recursive: true });
  const filename = join(dir, "forgedeck.db");
  runLocalMigrations({ filename, migrationsFolder });
  const store = new SqliteWorkflowRunStore(filename);
  const registry = new SqliteArtifactRegistry(filename, join(dir, "artifacts"));
  const roots = new InMemoryWorkflowRunRootRegistry();
  // ONE supervisor for both agents — there is no per-agent runtime, scheduler or supervisor. Both
  // single-shot agents run over the pipe transport by contract, so no pty factory is involved at all.
  const supervisor = new ProcessSupervisor(new PipeProcessFactory(), {
    platform: platform(),
    batchIntervalMs: 8,
    maxBufferLines: 100
  });
  const adapters = new AgentAdapterRegistry([
    new ClaudeCodeFixtureAdapter({
      fixtureScriptPath: claudeFixture,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 15_000
    }),
    new CodexFixtureAdapter({
      fixtureScriptPath: codexFixture,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 15_000
    })
  ]);
  const executor = new SafeWorkflowNodeExecutor(
    null,
    new AgentNodeExecutorRouter(
      adapters,
      new ProcessAgentNodeExecutor(supervisor, registry, roots, adapters, process.env),
      null
    ),
    null
  );
  const runtime = new WorkflowRunRuntime(executor, store, registry, roots);
  return {
    runtime,
    store,
    registry,
    supervisor,
    adapters,
    filename,
    close: async () => {
      await runtime.close();
      await supervisor.close();
      registry.close();
      store.close();
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a run condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function descriptor(id: AgentAdapterId, available: boolean): AgentDescriptor {
  return agentDescriptorSchema.parse({
    id,
    displayName: id,
    capabilities: ["planning", "backend", "testing"],
    available,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    hasImplementation: available
  });
}

describe("Codex adapter through the official runtime (fixture, never real Codex)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "codex-flow-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("the registry resolves Codex strictly by node.adapter and reports its version", async () => {
    const harness = compose(join(root, "detect"));
    try {
      expect(harness.adapters.has("codex")).toBe(true);
      expect(harness.adapters.get("codex").id).toBe("codex");
      const availability = await harness.adapters.detect("codex");
      expect(availability.available).toBe(true);
      expect(availability.version).toContain("codex-cli-fixture");
    } finally {
      await harness.close();
    }
  });

  it("the descriptor registry now reports Codex as an implemented, runnable agent", async () => {
    const harness = compose(join(root, "descriptor"));
    try {
      const descriptors = new AgentDescriptorRegistry(harness.adapters);
      await descriptors.refresh();
      const codex = descriptors.get("codex");
      expect(codex.hasImplementation).toBe(true);
      expect(codex.available).toBe(true);
      expect(codex.supportsExecution).toBe(true);
      expect(codex.supportsPipe).toBe(true);
      // Planning stays false: Codex has no orchestrator port in this phase.
      expect(codex.supportsPlanning).toBe(false);
      expect(codex.supportsInteractive).toBe(false);
      // OpenCode is untouched by this phase.
      expect(descriptors.get("opencode").hasImplementation).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("materializes assignedAdapter codex into node.adapter codex", () => {
    const catalog: AgentAssignmentCatalog = {
      descriptors: [descriptor("claude-code", true), descriptor("codex", true)]
    };
    const result = materializeWorkflowDraft(
      workflowDraftSchema.parse({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        version: 1,
        workspaceId: "workspace-1",
        sourceTerminalId: "terminal-1",
        creationMode: "automatic",
        executionProfile: "balanced",
        title: "Mixed",
        objective: "Build it",
        state: "approved",
        createdAt: "2026-07-25T12:00:00.000Z",
        updatedAt: "2026-07-25T12:00:00.000Z",
        nodes: [
          {
            id: "planner",
            title: "Planner",
            role: "planner",
            agentAssignment: { assignedAdapter: "claude-code" }
          },
          {
            id: "builder",
            title: "Builder",
            role: "implementer",
            agentAssignment: { assignedAdapter: "codex" }
          }
        ],
        edges: []
      }),
      { agents: catalog }
    );
    expect(result.issues).toEqual([]);
    expect(result.workflow?.nodes.map((node) => node.adapter)).toEqual(["claude-code", "codex"]);
  });

  it(
    "Claude produces an artifact, Codex consumes it by hash and produces its own, and a third node consumes that",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "handoff");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("codex-handoff", "#fixture:consume"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");

        const plannerArtifact = harness.registry.getNodeArtifact(result.id, "planner");
        const builderArtifact = harness.registry.getNodeArtifact(result.id, "builder");
        expect(plannerArtifact).not.toBeNull();
        expect(builderArtifact).not.toBeNull();

        // Codex consumed the upstream artifact by its officially recorded hash.
        const builder = result.nodeRuns.find((node) => node.nodeId === "builder");
        const consumed = builder?.evidence.find((item) => item.id === "consumed-planner");
        expect(consumed?.metadata?.["sha256"]).toBe(plannerArtifact?.sha256);
        // And the fixture proved it read the bytes at that path and they hashed to the same value.
        expect(builder?.state).toBe("succeeded");

        // The next node consumed Codex's own artifact, so the chain is genuinely agent-neutral.
        const reviewer = result.nodeRuns.find((node) => node.nodeId === "reviewer");
        const consumedFromCodex = reviewer?.evidence.find((item) => item.id === "consumed-builder");
        expect(consumedFromCodex?.metadata?.["sha256"]).toBe(builderArtifact?.sha256);

        // One run, one scheduler: no agent created a parallel execution.
        expect(harness.runtime.list()).toHaveLength(1);
        expect(
          harness.supervisor.listSessions().every((session) => session.state !== "running")
        ).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "a Codex failure blocks its dependents and publishes no downstream artifact",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "fail");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("codex-fail", "#fixture:fail"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("failed");
        expect(result.nodeRuns.find((node) => node.nodeId === "builder")?.state).toBe("failed");
        expect(result.nodeRuns.find((node) => node.nodeId === "reviewer")?.state).not.toBe(
          "succeeded"
        );
        expect(harness.registry.getNodeArtifact(result.id, "reviewer")).toBeNull();
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "a Codex node that exits 0 without writing its result is a failure, not a success",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "invalid");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("codex-invalid", "#fixture:invalid"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("failed");
        const builder = result.nodeRuns.find((node) => node.nodeId === "builder");
        expect(builder?.failureReason).toBe("missing_evidence");
      } finally {
        await harness.close();
      }
    }
  );

  it("completion words printed by Codex never count as success", { timeout: 60_000 }, async () => {
    const dir = join(root, "textonly");
    const harness = compose(dir);
    try {
      const handle = harness.runtime.startMaterialized({
        workflow: mixedWorkflow("codex-textonly", "#fixture:textonly"),
        target: { root: dir, agentNodeId: "planner" }
      });
      const result = await handle.completion;
      // The fixture printed success/completed/done/finished on stdout and exited 0.
      expect(result.state).toBe("failed");
      expect(result.nodeRuns.find((node) => node.nodeId === "builder")?.failureReason).toBe(
        "missing_evidence"
      );
    } finally {
      await harness.close();
    }
  });

  it(
    "cancelling a Codex node blocks its dependents and leaves no orphan process",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "cancel");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("codex-cancel", "#fixture:child"),
          target: { root: dir, agentNodeId: "planner" }
        });
        await waitFor(() =>
          harness.runtime
            .events(handle.runId)
            .some((event) => event.type === "node.started" && event.payload["nodeId"] === "builder")
        );
        await harness.runtime.cancel(handle.runId);
        const result = await handle.completion;
        expect(["cancelled", "failed"]).toContain(result.state);
        expect(result.nodeRuns.find((node) => node.nodeId === "reviewer")?.state).not.toBe(
          "succeeded"
        );
        expect(harness.registry.getNodeArtifact(result.id, "reviewer")).toBeNull();
        // The fixture's own child process is reaped with the tree.
        expect(
          harness.supervisor.listSessions().every((session) => session.state !== "running")
        ).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "a retry of a Codex node stays on Codex and reaches a second attempt",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "retry");
      const harness = compose(dir);
      try {
        const workflow = workflowSchema.parse({
          ...mixedWorkflow("codex-retry", "#fixture:fail"),
          nodes: mixedWorkflow("codex-retry", "#fixture:fail").nodes.map((node) =>
            node.id === "builder"
              ? {
                  ...node,
                  retry: { max_attempts: 2, backoff_ms: 0, retry_on: ["process_exit_nonzero"] }
                }
              : node
          )
        });
        const handle = harness.runtime.startMaterialized({
          workflow,
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        const builder = result.nodeRuns.find((node) => node.nodeId === "builder");
        expect(builder?.attempt).toBe(2);
        // The retry never migrated the node to another agent.
        expect(
          harness.runtime.definition(result.id).nodes.find((n) => n.id === "builder")?.adapter
        ).toBe("codex");
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "a reload preserves the mixed-agent definition, its artifacts and their hashes",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "reload");
      const harness = compose(dir);
      let runId: string;
      let plannerSha: string | undefined;
      let builderSha: string | undefined;
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("codex-reload", "#fixture:consume"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        runId = result.id;
        plannerSha = harness.registry.getNodeArtifact(runId, "planner")?.sha256;
        builderSha = harness.registry.getNodeArtifact(runId, "builder")?.sha256;
      } finally {
        await harness.close();
      }

      // A reload over the same database: nothing is re-executed and nothing is duplicated.
      const store = new SqliteWorkflowRunStore(harness.filename);
      const registry = new SqliteArtifactRegistry(harness.filename, join(dir, "artifacts"));
      try {
        expect(store.get(runId)?.state).toBe("succeeded");
        expect(store.getWorkflow(runId)?.nodes.find((n) => n.id === "builder")?.adapter).toBe(
          "codex"
        );
        expect(registry.getNodeArtifact(runId, "planner")?.sha256).toBe(plannerSha);
        expect(registry.getNodeArtifact(runId, "builder")?.sha256).toBe(builderSha);
        expect(store.list({})).toHaveLength(1);
        expect(store.recoverInterruptedRuns()).toBe(0);
        expect(store.get(runId)?.nodeRuns.every((node) => node.attempt === 1)).toBe(true);
      } finally {
        registry.close();
        store.close();
      }
    }
  );
});
