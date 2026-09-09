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
import { OpenCodeFixtureAdapter } from "./opencode-fixture-adapter";
import { ProcessAgentNodeExecutor } from "./process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "./workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "./workflow-run-runtime";

/**
 * Three different agents inside ONE workflow, driven by the single official runtime. Every handoff is
 * Compazio's own artifact plus its recorded hash — never shared memory between the CLIs, and never one
 * agent invoking another. All three are deterministic fixtures: no real Claude, Codex or OpenCode is
 * ever called here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "..", "e2e", "fixtures");
const claudeFixture = join(fixturesDir, "claude-code-fixture.mjs");
const codexFixture = join(fixturesDir, "codex-fixture.mjs");
const openCodeFixture = join(fixturesDir, "opencode-fixture.mjs");
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

/** planner → Claude, builder → OpenCode, reviewer → Codex. One run, one scheduler, one supervisor. */
function mixedWorkflow(id: string, openCodeToken: string): Workflow {
  return workflowSchema.parse({
    schema_version: "1.0",
    id,
    name: "Claude to OpenCode to Codex",
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
        adapter: "opencode",
        title: `Build ${openCodeToken}`,
        depends_on: ["planner"],
        permissions: {}
      },
      {
        id: "reviewer",
        type: "agent",
        role: "reviewer",
        adapter: "codex",
        title: "Review #fixture:consume",
        depends_on: ["builder"],
        permissions: {}
      }
    ]
  });
}

interface Harness {
  readonly runtime: WorkflowRunRuntime;
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
  // ONE supervisor for all three agents; every single-shot agent runs over the pipe transport.
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
    }),
    new OpenCodeFixtureAdapter({
      fixtureScriptPath: openCodeFixture,
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

function runnable(id: AgentAdapterId): AgentDescriptor {
  return agentDescriptorSchema.parse({
    id,
    displayName: id,
    capabilities: ["planning", "backend", "testing"],
    available: true,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    hasImplementation: true
  });
}

describe("OpenCode adapter through the official runtime (fixture, never real OpenCode)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "opencode-flow-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("the registry resolves OpenCode strictly by node.adapter and reports its version", async () => {
    const harness = compose(join(root, "detect"));
    try {
      expect(harness.adapters.has("opencode")).toBe(true);
      expect(harness.adapters.get("opencode").id).toBe("opencode");
      const availability = await harness.adapters.detect("opencode");
      expect(availability.available).toBe(true);
      expect(availability.version).toContain("fixture");
    } finally {
      await harness.close();
    }
  });

  it("the descriptor registry now reports OpenCode as an implemented, runnable agent", async () => {
    const harness = compose(join(root, "descriptor"));
    try {
      const descriptors = new AgentDescriptorRegistry(harness.adapters);
      await descriptors.refresh();
      const openCode = descriptors.get("opencode");
      expect(openCode.hasImplementation).toBe(true);
      expect(openCode.available).toBe(true);
      expect(openCode.supportsExecution).toBe(true);
      expect(openCode.supportsPipe).toBe(true);
      // Planning stays false: OpenCode has no orchestrator port in this phase.
      expect(openCode.supportsPlanning).toBe(false);
      expect(openCode.supportsInteractive).toBe(false);
      // Claude and Codex keep the semantics earlier phases established.
      expect(descriptors.get("claude-code").supportsPlanning).toBe(true);
      expect(descriptors.get("codex").supportsPlanning).toBe(false);
      expect(descriptors.get("codex").supportsExecution).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("materializes assignedAdapter opencode into node.adapter opencode", () => {
    const catalog: AgentAssignmentCatalog = {
      descriptors: [runnable("claude-code"), runnable("codex"), runnable("opencode")]
    };
    const result = materializeWorkflowDraft(
      workflowDraftSchema.parse({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        version: 1,
        workspaceId: "workspace-1",
        sourceTerminalId: "terminal-1",
        creationMode: "automatic",
        executionProfile: "balanced",
        title: "Three agents",
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
            agentAssignment: { assignedAdapter: "opencode" }
          },
          {
            id: "reviewer",
            title: "Reviewer",
            role: "reviewer",
            agentAssignment: { assignedAdapter: "codex" }
          }
        ],
        edges: []
      }),
      { agents: catalog }
    );
    expect(result.issues).toEqual([]);
    expect(result.workflow?.nodes.map((node) => node.adapter)).toEqual([
      "claude-code",
      "opencode",
      "codex"
    ]);
  });

  it(
    "Claude produces an artifact, OpenCode consumes it by hash and produces its own, and Codex consumes that",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "handoff");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("opencode-handoff", "#fixture:consume"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");

        const plannerArtifact = harness.registry.getNodeArtifact(result.id, "planner");
        const builderArtifact = harness.registry.getNodeArtifact(result.id, "builder");
        const reviewerArtifact = harness.registry.getNodeArtifact(result.id, "reviewer");
        expect(plannerArtifact).not.toBeNull();
        expect(builderArtifact).not.toBeNull();
        expect(reviewerArtifact).not.toBeNull();

        // OpenCode consumed Claude's artifact by its officially recorded hash, and the fixture proved
        // it read the bytes at that path and they hashed to the same value.
        const builder = result.nodeRuns.find((node) => node.nodeId === "builder");
        expect(
          builder?.evidence.find((item) => item.id === "consumed-planner")?.metadata?.["sha256"]
        ).toBe(plannerArtifact?.sha256);
        expect(builder?.state).toBe("succeeded");

        // Codex then consumed OpenCode's own artifact: the chain is genuinely agent-neutral.
        const reviewer = result.nodeRuns.find((node) => node.nodeId === "reviewer");
        expect(
          reviewer?.evidence.find((item) => item.id === "consumed-builder")?.metadata?.["sha256"]
        ).toBe(builderArtifact?.sha256);

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
    "an OpenCode failure blocks its dependents and publishes no downstream artifact",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "fail");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("opencode-fail", "#fixture:fail"),
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
    "an OpenCode node that exits 0 without writing its result is a failure",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "invalid");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("opencode-invalid", "#fixture:invalid"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("failed");
        expect(result.nodeRuns.find((node) => node.nodeId === "builder")?.failureReason).toBe(
          "missing_evidence"
        );
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "an empty result and completion words both fail instead of passing as success",
    { timeout: 60_000 },
    async () => {
      for (const token of ["#fixture:empty", "#fixture:textonly"]) {
        const dir = join(root, `weak-${token.replace(/[^a-z]/g, "")}`);
        const harness = compose(dir);
        try {
          const handle = harness.runtime.startMaterialized({
            workflow: mixedWorkflow(`opencode-${token.replace(/[^a-z]/g, "")}`, token),
            target: { root: dir, agentNodeId: "planner" }
          });
          const result = await handle.completion;
          expect(result.state).toBe("failed");
          expect(result.nodeRuns.find((node) => node.nodeId === "builder")?.failureReason).toBe(
            "missing_evidence"
          );
        } finally {
          await harness.close();
        }
      }
    }
  );

  it(
    "only the declared result becomes an artifact; a stray file is ignored",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "stray");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("opencode-stray", "#fixture:stray"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");
        // The fixture wrote an undeclared file next to the result; exactly one artifact exists
        // for the node, and it is the declared one.
        const artifact = harness.registry.getNodeArtifact(result.id, "builder");
        expect(artifact?.relative_path).toContain("builder.result.txt");
        expect(artifact?.type).toBe("opencode-result");
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "cancelling an OpenCode node blocks its dependents and leaves no orphan process",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "cancel");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("opencode-cancel", "#fixture:child"),
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
        expect(
          harness.supervisor.listSessions().every((session) => session.state !== "running")
        ).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "a retry of an OpenCode node stays on OpenCode and reaches a second attempt",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "retry");
      const harness = compose(dir);
      try {
        const base = mixedWorkflow("opencode-retry", "#fixture:fail");
        const workflow = workflowSchema.parse({
          ...base,
          nodes: base.nodes.map((node) =>
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
        expect(result.nodeRuns.find((node) => node.nodeId === "builder")?.attempt).toBe(2);
        // The retry never migrated the node to another agent.
        expect(
          harness.runtime.definition(result.id).nodes.find((n) => n.id === "builder")?.adapter
        ).toBe("opencode");
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "a reload preserves the three-agent definition, its artifacts and their hashes",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "reload");
      const harness = compose(dir);
      let runId: string;
      let builderSha: string | undefined;
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: mixedWorkflow("opencode-reload", "#fixture:consume"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        runId = result.id;
        builderSha = harness.registry.getNodeArtifact(runId, "builder")?.sha256;
      } finally {
        await harness.close();
      }

      const store = new SqliteWorkflowRunStore(harness.filename);
      const registry = new SqliteArtifactRegistry(harness.filename, join(dir, "artifacts"));
      try {
        expect(store.get(runId)?.state).toBe("succeeded");
        expect(store.getWorkflow(runId)?.nodes.map((node) => node.adapter)).toEqual([
          "claude-code",
          "opencode",
          "codex"
        ]);
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
