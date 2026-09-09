import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FakeShellExecutionAdapter,
  ShellWorkflowNodeExecutor,
  type WorkflowRunSnapshot
} from "@forgedeck/orchestration";
import { NodePtyFactory, ProcessSupervisor } from "@forgedeck/terminal";
import {
  SqliteArtifactRegistry,
  SqliteWorkflowRunStore,
  runLocalMigrations
} from "@forgedeck/local-db";

import { createFakeAgentLaunchResolver } from "./fake-agent-launch-resolver";
import { ProcessAgentNodeExecutor } from "./process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "./workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "./workflow-run-runtime";

/**
 * Integrated proof that the *production* desktop runtime composition executes the vertical slice.
 * There is no test-local executor: the run is driven by WorkflowRunRuntime + SafeWorkflowNodeExecutor
 * + the reusable ProcessAgentNodeExecutor, exactly as the desktop wires them. The only fake pieces
 * are the external boundaries the project deliberately keeps deterministic: the fake-agent binary
 * (spawned through the real ProcessSupervisor) and the FakeShellExecutionAdapter behind the real
 * ShellWorkflowNodeExecutor.
 */
const temporaryDirectories: string[] = [];
const fakeAgentPath = resolve("packages/fake-agent/bin/fake-agent.mjs");

// Removal is deliberately retry-free: the harness closes the supervisor (full reap) before the workspace is
// removed, so an EBUSY here would mean a real leak and must fail instead of being waited out.
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

interface Harness {
  readonly runtime: WorkflowRunRuntime;
  readonly registry: SqliteArtifactRegistry;
  readonly store: SqliteWorkflowRunStore;
  readonly supervisor: ProcessSupervisor;
  readonly registryRoot: string;
  readonly close: () => Promise<void>;
}

async function createHarness(filename: string, workspace: string): Promise<Harness> {
  const registryRoot = join(workspace, "managed-artifacts");
  const store = new SqliteWorkflowRunStore(filename);
  const registry = new SqliteArtifactRegistry(filename, registryRoot);
  const roots = new InMemoryWorkflowRunRootRegistry();
  const supervisor = new ProcessSupervisor(new NodePtyFactory(), {
    platform: platform(),
    batchIntervalMs: 8,
    maxBufferLines: 100
  });
  const executor = new SafeWorkflowNodeExecutor(
    new ShellWorkflowNodeExecutor(new FakeShellExecutionAdapter()),
    new ProcessAgentNodeExecutor(
      supervisor,
      registry,
      roots,
      createFakeAgentLaunchResolver(fakeAgentPath)
    ),
    null
  );
  const runtime = new WorkflowRunRuntime(executor, store, registry, roots);
  return {
    runtime,
    registry,
    store,
    supervisor,
    registryRoot,
    close: async () => {
      // close(), not shutdown(): shutdown only cancels active sessions, leaving already-terminal ones
      // unreaped, so a process they spawned could outlive the run and keep holding the workspace.
      await supervisor.close();
      registry.close();
      store.close();
    }
  };
}

describe("vertical slice through the production runtime", () => {
  it("publishes an official artifact, passes it by context, retries a failed step, and survives reload", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ForgeDeck production slice "));
    temporaryDirectories.push(workspace);
    const filename = join(workspace, "workflow.db");
    runLocalMigrations({ filename });
    const harness = await createHarness(filename, workspace);

    let runId: string;
    let result: WorkflowRunSnapshot;
    try {
      const handle = harness.runtime.startTemplate("vertical-slice-reference", false, {
        root: workspace,
        agentNodeId: "planner"
      });
      runId = handle.runId;
      result = await handle.completion;

      expect(result.state).toBe("succeeded");

      // Retry ran through the official mechanism: the flaky planner needed a second attempt.
      const planner = result.nodeRuns.find((node) => node.nodeId === "planner");
      expect(planner?.attempt).toBe(2);
      expect(planner?.state).toBe("succeeded");
      expect(
        harness.runtime.events(runId).some((event) => event.type === "node.retry_scheduled")
      ).toBe(true);

      // The planner published an official, immutable, hashed artifact with node-run provenance.
      const plannerArtifact = harness.registry.getNodeArtifact(runId, "planner");
      expect(plannerArtifact).not.toBeNull();
      if (plannerArtifact === null) throw new Error("planner artifact missing");
      expect(plannerArtifact.type).toBe("agent-plan");
      expect(plannerArtifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(plannerArtifact.nodeRunId).not.toBeNull();
      const plannerContent = JSON.parse(
        await readFile(harness.registry.resolveArtifactPath(plannerArtifact), "utf8")
      );
      expect(plannerContent).toMatchObject({
        type: "plan",
        steps: ["design", "implement", "verify"]
      });

      // The executor received the planner's reference through context and verified consumption by id.
      const executor = result.nodeRuns.find((node) => node.nodeId === "executor");
      const consumed = executor?.evidence.find((item) => item.id === "consumed-planner");
      expect(consumed?.metadata).toMatchObject({
        consumedArtifactId: plannerArtifact.id,
        sha256: plannerArtifact.sha256
      });

      // The executor published its own official artifact derived from the plan.
      const executorArtifact = harness.registry.getNodeArtifact(runId, "executor");
      expect(executorArtifact).not.toBeNull();
      if (executorArtifact === null) throw new Error("executor artifact missing");
      const executorContent = JSON.parse(
        await readFile(harness.registry.resolveArtifactPath(executorArtifact), "utf8")
      );
      expect(executorContent).toMatchObject({ type: "build", status: "built" });

      // The quality gate contributed structured exit-code evidence (fake shell adapter boundary).
      const gate = result.nodeRuns.find((node) => node.nodeId === "gate");
      expect(gate?.state).toBe("succeeded");
      expect(gate?.evidence[0]?.metadata).toMatchObject({ exitCode: 0 });

      // Auditable final report.
      expect(result.reportArtifact).not.toBeNull();
    } finally {
      await harness.close();
    }

    // Reload: fresh store + registry over the same database recover run, artifacts, events, report.
    const reopenedStore = new SqliteWorkflowRunStore(filename);
    const reopenedRegistry = new SqliteArtifactRegistry(filename, harness.registryRoot);
    try {
      const rehydrated = reopenedStore.get(runId);
      if (rehydrated === null) throw new Error("reopened store lost the run");
      expect(rehydrated.state).toBe("succeeded");
      expect(rehydrated.reportArtifact).not.toBeNull();
      expect(
        Object.fromEntries(rehydrated.nodeRuns.map((node) => [node.nodeId, node.state]))
      ).toEqual({
        planner: "succeeded",
        executor: "succeeded",
        gate: "succeeded",
        report: "succeeded"
      });
      const events = reopenedStore.listEvents(runId);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(reopenedStore.recoverInterruptedRuns()).toBe(0);
      // Official artifacts survive the reload and remain resolvable.
      const plannerAfterReload = reopenedRegistry.getNodeArtifact(runId, "planner");
      expect(plannerAfterReload?.type).toBe("agent-plan");
    } finally {
      reopenedRegistry.close();
      reopenedStore.close();
    }
  }, 40_000);

  it("keeps dependents blocked when a step fails deterministically", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ForgeDeck blocked slice "));
    temporaryDirectories.push(workspace);
    const filename = join(workspace, "workflow.db");
    runLocalMigrations({ filename });
    const harness = await createHarness(filename, workspace);
    try {
      const handle = harness.runtime.startTemplate("vertical-slice-reference-blocked", false, {
        root: workspace,
        agentNodeId: "planner"
      });
      const result = await handle.completion;

      expect(result.state).toBe("failed");
      expect(result.nodeRuns.find((node) => node.nodeId === "planner")?.state).toBe("failed");
      // The dependent executor never succeeds and never publishes a downstream artifact.
      const executor = result.nodeRuns.find((node) => node.nodeId === "executor");
      expect(executor?.state).not.toBe("succeeded");
      expect(harness.registry.getNodeArtifact(handle.runId, "executor")).toBeNull();
    } finally {
      await harness.close();
    }
  }, 40_000);

  it("keeps dependents blocked when the run is cancelled mid-flight", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ForgeDeck cancel slice "));
    temporaryDirectories.push(workspace);
    const filename = join(workspace, "workflow.db");
    runLocalMigrations({ filename });
    const harness = await createHarness(filename, workspace);
    try {
      const handle = harness.runtime.startTemplate("vertical-slice-reference-cancel", false, {
        root: workspace,
        agentNodeId: "planner"
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
      expect(harness.registry.getNodeArtifact(handle.runId, "executor")).toBeNull();
    } finally {
      await harness.close();
    }
  }, 40_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a run condition");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function platform(): "win32" | "darwin" | "linux" {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported test platform");
}
