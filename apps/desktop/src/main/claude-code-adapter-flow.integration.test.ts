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
import {
  PipeProcessFactory,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { workflowSchema, type Workflow } from "@forgedeck/workflow";

import { AgentAdapterRegistry } from "./agent-adapter-registry";
import { AgentNodeExecutorRouter } from "./agent-node-executor-router";
import { ClaudeCodeFixtureAdapter } from "./claude-code-fixture-adapter";
import { ProcessAgentNodeExecutor } from "./process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "./workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "./workflow-run-runtime";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "..", "e2e", "fixtures");
// The fixture runs as `node <fixture.mjs>` over the pipe transport, so a single .mjs serves every
// platform; there is no .cmd shim, because the pipe transport launches a native binary (Node) directly.
const fixtureExecutable = join(fixturesDir, "claude-code-fixture.mjs");
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

function agentWorkflow(id: string, plannerToken: string, executorToken: string): Workflow {
  return workflowSchema.parse({
    schema_version: "1.0",
    id,
    name: "Claude adapter flow",
    concurrency: 1,
    permissions: {},
    nodes: [
      {
        id: "planner",
        type: "agent",
        role: "planner",
        adapter: "claude-code",
        title: `Plan ${plannerToken}`,
        permissions: {},
        retry: plannerToken.includes("fail")
          ? { max_attempts: 2, backoff_ms: 0, retry_on: ["process_exit_nonzero"] }
          : { max_attempts: 1, backoff_ms: 0, retry_on: [] }
      },
      {
        id: "executor",
        type: "agent",
        role: "implementer",
        adapter: "claude-code",
        title: `Build ${executorToken}`,
        depends_on: ["planner"],
        permissions: {}
      }
    ]
  });
}

function unknownAdapterWorkflow(): Workflow {
  return workflowSchema.parse({
    schema_version: "1.0",
    id: "claude-unknown-adapter",
    name: "Unknown adapter",
    concurrency: 1,
    permissions: {},
    nodes: [
      {
        id: "planner",
        type: "agent",
        role: "planner",
        adapter: "totally-unknown",
        title: "Plan #fixture:success",
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
  readonly close: () => Promise<void>;
}

function compose(dir: string): Harness {
  mkdirSync(dir, { recursive: true });
  const filename = join(dir, "forgedeck.db");
  runLocalMigrations({ filename, migrationsFolder });
  const store = new SqliteWorkflowRunStore(filename);
  const registry = new SqliteArtifactRegistry(filename, join(dir, "artifacts"));
  const roots = new InMemoryWorkflowRunRootRegistry();
  const supervisor = new ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PtyProcessFactory(platform()),
      pipe: new PipeProcessFactory()
    }),
    {
      platform: platform(),
      batchIntervalMs: 8,
      maxBufferLines: 100
    }
  );
  const adapterRegistry = new AgentAdapterRegistry([
    new ClaudeCodeFixtureAdapter({
      fixtureScriptPath: fixtureExecutable,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 15_000
    })
  ]);
  const processExecutor = new ProcessAgentNodeExecutor(
    supervisor,
    registry,
    roots,
    adapterRegistry,
    process.env
  );
  const executor = new SafeWorkflowNodeExecutor(
    null,
    new AgentNodeExecutorRouter(adapterRegistry, processExecutor, null),
    null
  );
  const runtime = new WorkflowRunRuntime(executor, store, registry, roots);
  return {
    runtime,
    store,
    registry,
    supervisor,
    close: async () => {
      // close(), not shutdown(): only close() reaps the process tree of already-terminal sessions, so a
      // fixture child cannot outlive the run and keep holding the workspace.
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

describe("Claude Code adapter through the official runtime (fixture, never real Claude)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-flow-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "the adapter reports availability from the fixture and resolves strictly by node.adapter",
    { timeout: 40_000 },
    async () => {
      const dir = join(root, "detect");
      const harness = compose(dir);
      try {
        const registry = new AgentAdapterRegistry([
          new ClaudeCodeFixtureAdapter({
            fixtureScriptPath: fixtureExecutable,
            commandRunner: new ExecFileCommandRunner(),
            environment: process.env
          })
        ]);
        const availability = await registry.detect("claude-code");
        expect(availability.available).toBe(true);
        expect(availability.version).toContain("claude-code-fixture");
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "runs claude-code nodes through ProcessAgentNodeExecutor, publishes and consumes official artifacts",
    { timeout: 40_000 },
    async () => {
      const dir = join(root, "success");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: agentWorkflow("claude-success", "#fixture:success", "#fixture:success"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");

        // Exactly one runtime/scheduler produced exactly one run.
        expect(harness.runtime.list()).toHaveLength(1);

        // Both nodes published official artifacts, and the dependent consumed the upstream hash.
        const plannerArtifact = harness.registry.getNodeArtifact(result.id, "planner");
        expect(plannerArtifact).not.toBeNull();
        expect(harness.registry.getNodeArtifact(result.id, "executor")).not.toBeNull();
        const executorNode = result.nodeRuns.find((node) => node.nodeId === "executor");
        const consumed = executorNode?.evidence.find((item) => item.id === "consumed-planner");
        expect(consumed?.metadata?.["sha256"]).toBe(plannerArtifact?.sha256);
      } finally {
        await harness.close();
      }
    }
  );

  it("fails an unknown adapter id before any process is started", { timeout: 40_000 }, async () => {
    const dir = join(root, "unknown");
    const harness = compose(dir);
    try {
      const handle = harness.runtime.startMaterialized({
        workflow: unknownAdapterWorkflow(),
        target: { root: dir, agentNodeId: "planner" }
      });
      const result = await handle.completion;
      expect(result.state).toBe("failed");
      expect(harness.supervisor.listSessions()).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it(
    "does not treat terminal completion words as success without a structural result",
    { timeout: 40_000 },
    async () => {
      const dir = join(root, "textonly");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: agentWorkflow("claude-textonly", "#fixture:textonly", "#fixture:success"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("failed");
        const planner = result.nodeRuns.find((node) => node.nodeId === "planner");
        expect(planner?.state).toBe("failed");
        // The dependent stayed blocked and produced no artifact.
        const executor = result.nodeRuns.find((node) => node.nodeId === "executor");
        expect(executor?.state).not.toBe("succeeded");
        expect(harness.registry.getNodeArtifact(result.id, "executor")).toBeNull();
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "blocks dependents when the agent fails, and retries create a new attempt",
    { timeout: 40_000 },
    async () => {
      const dir = join(root, "fail");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: agentWorkflow("claude-fail", "#fixture:fail", "#fixture:success"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("failed");
        const planner = result.nodeRuns.find((node) => node.nodeId === "planner");
        // retry policy max_attempts=2 → a second attempt was created.
        expect(planner?.attempt).toBe(2);
        const executor = result.nodeRuns.find((node) => node.nodeId === "executor");
        expect(executor?.state).not.toBe("succeeded");
        expect(executor?.attempt ?? 0).toBe(0);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "cancellation blocks dependents, publishes no success, and leaves no orphaned process",
    { timeout: 40_000 },
    async () => {
      const dir = join(root, "cancel");
      const harness = compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: agentWorkflow("claude-cancel", "#fixture:child", "#fixture:success"),
          target: { root: dir, agentNodeId: "planner" }
        });
        await waitFor(() =>
          harness.runtime
            .events(handle.runId)
            .some((event) => event.type === "node.started" && event.nodeRunId !== null)
        );
        await harness.runtime.cancel(handle.runId);
        const result = await handle.completion;
        expect(["cancelled", "failed"]).toContain(result.state);
        const executor = result.nodeRuns.find((node) => node.nodeId === "executor");
        expect(executor?.state).not.toBe("succeeded");
        expect(harness.registry.getNodeArtifact(result.id, "executor")).toBeNull();
        expect(
          harness.supervisor.listSessions().every((session) => session.state !== "running")
        ).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "recovers a completed run and its artifacts on reload without re-executing",
    { timeout: 40_000 },
    async () => {
      const dir = join(root, "reload");
      let runId: string;
      const first = compose(dir);
      try {
        const handle = first.runtime.startMaterialized({
          workflow: agentWorkflow("claude-reload", "#fixture:success", "#fixture:success"),
          target: { root: dir, agentNodeId: "planner" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");
        runId = result.id;
      } finally {
        await first.close();
      }

      const second = compose(dir);
      try {
        const recovered = second.store.get(runId);
        expect(recovered?.state).toBe("succeeded");
        expect(second.store.list({})).toHaveLength(1);
        expect(second.store.recoverInterruptedRuns()).toBe(0);
        expect(second.registry.getNodeArtifact(runId, "planner")).not.toBeNull();
        const planner = recovered?.nodeRuns.find((node) => node.nodeId === "planner");
        expect(planner?.attempt).toBe(1);
      } finally {
        await second.close();
      }
    }
  );
});
