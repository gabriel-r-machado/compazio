import { describe, expect, it, vi } from "vitest";

import {
  FakeShellExecutionAdapter,
  InMemoryArtifactRegistry,
  InMemoryRunStore,
  ShellWorkflowNodeExecutor
} from "@forgedeck/orchestration";
import { workflowSchema } from "@forgedeck/workflow";

import {
  SafeWorkflowNodeExecutor,
  selectWorkflowRetrySubgraph,
  WorkflowRunRuntime
} from "./workflow-run-runtime";

describe("WorkflowRunRuntime", () => {
  it("prepares durable per-run inputs before the first node can execute", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    let preparedRunId: string | null = null;
    const runtime = new WorkflowRunRuntime(
      {
        execute: async (_node, context) => {
          expect(preparedRunId).toBe(context.runId);
          return {
            success: true as const,
            evidence: [
              { id: "prepared", type: "output" as const, summary: "Prepared", metadata: {} }
            ],
            output: {}
          };
        }
      },
      persistence,
      new InMemoryArtifactRegistry()
    );
    const workflow = workflowSchema.parse({
      schema_version: "1.0",
      id: "prepared-run",
      name: "Prepared run",
      permissions: {},
      nodes: [{ id: "step", type: "artifact", permissions: {} }]
    });

    const handle = runtime.startMaterialized({
      workflow,
      target: { root: "C:\\workspace" },
      prepareRun: (runId) => {
        expect(store.runs.has(runId)).toBe(true);
        preparedRunId = runId;
      }
    });

    expect((await handle.completion).state).toBe("succeeded");
  });

  it("runs the trusted report-only workflow without accepting a client-defined command", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(),
      persistence,
      new InMemoryArtifactRegistry()
    );

    const handle = runtime.startTemplate("delivery-report", false);
    expect(() => runtime.retry(handle.runId)).toThrow("still active");
    const completed = await handle.completion;

    expect(completed.state).toBe("succeeded");
    expect(completed.reportArtifact?.type).toBe("run-report");
    expect(completed.nodeRuns).toMatchObject([{ nodeId: "report", state: "succeeded" }]);
    expect(() => runtime.startTemplate("../../arbitrary-command", false)).toThrow(
      "Workflow template is not available"
    );
  });

  it("creates a distinct retry from a persisted immutable workflow snapshot", async () => {
    const store = new InMemoryRunStore();
    const workflow = workflowSchema.parse({
      schema_version: "1.0",
      id: "delivery-report",
      name: "Delivery report",
      concurrency: 1,
      permissions: {},
      inputs: {},
      nodes: [{ id: "report", type: "artifact", permissions: {} }]
    });
    const persistence = Object.assign(store, {
      getWorkflow: () => workflow,
      get: () => ({
        id: "old-run",
        workflowId: workflow.id,
        workflowVersion: "1.0" as const,
        workflowHash: "0".repeat(64),
        inputHash: "0".repeat(64),
        effectivePermissions: {},
        state: "interrupted" as const,
        dryRun: false,
        concurrency: 1,
        startedAt: null,
        endedAt: null,
        nodeRuns: [],
        reportArtifact: null
      }),
      list: () => [],
      listEvents: () => []
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(),
      persistence,
      new InMemoryArtifactRegistry()
    );

    const retry = runtime.retry("old-run");
    expect(retry.runId).not.toBe("old-run");
    expect(await retry.completion).toMatchObject({
      state: "succeeded",
      lineage: {
        sourceRunId: "old-run",
        nodeId: null,
        scope: "run",
        alternativeGroupId: null,
        alternativeLabel: null
      }
    });
  });

  it("selects a closed dependency graph for node and dependent retries", () => {
    const workflow = workflowSchema.parse({
      schema_version: "1.0",
      id: "retry-graph",
      name: "Retry graph",
      concurrency: 1,
      permissions: {},
      nodes: [
        { id: "source", type: "artifact", permissions: {} },
        { id: "quality", type: "artifact", depends_on: ["source"], permissions: {} },
        { id: "delivery", type: "artifact", depends_on: ["quality"], permissions: {} },
        { id: "unrelated", type: "artifact", permissions: {} }
      ]
    });

    const node = selectWorkflowRetrySubgraph(workflow, { nodeId: "quality", scope: "node" });
    const dependents = selectWorkflowRetrySubgraph(workflow, {
      nodeId: "quality",
      scope: "dependents"
    });

    expect(node.nodes.map((candidate) => candidate.id)).toEqual(["source", "quality"]);
    expect(dependents.nodes.map((candidate) => candidate.id)).toEqual([
      "source",
      "quality",
      "delivery"
    ]);
    expect(() =>
      selectWorkflowRetrySubgraph(workflow, { nodeId: "missing", scope: "node" })
    ).toThrow("retry node was not found");
  });

  it("marks a manually requested alternative as a separate dependent branch", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(),
      persistence,
      new InMemoryArtifactRegistry()
    );
    const source = runtime.startTemplate("delivery-report", false);
    await source.completion;

    const alternative = runtime.retry(source.runId, undefined, {
      nodeId: "report",
      scope: "dependents",
      alternativeLabel: "fast"
    });

    expect(await alternative.completion).toMatchObject({
      lineage: {
        sourceRunId: source.runId,
        nodeId: "report",
        scope: "dependents",
        alternativeGroupId: `alternative:${source.runId}:report`,
        alternativeLabel: "fast"
      }
    });
  });

  it("runs the trusted shell check only through the registered shell executor", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    const shell = new FakeShellExecutionAdapter({
      pnpm: { exitCode: 0, durationMs: 5, timedOut: false }
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(new ShellWorkflowNodeExecutor(shell)),
      persistence,
      new InMemoryArtifactRegistry()
    );

    expect(() => runtime.startTemplate("local-shell-check", false)).toThrow(
      "approved project target"
    );
    const completed = await runtime.startTemplate("local-shell-check", false, {
      root: "C:\\approved-project"
    }).completion;

    expect(completed.state).toBe("succeeded");
    expect(shell.requests.map((request) => request.command.executable)).toEqual(["pnpm"]);
  });

  it("runs the trusted quality check with verified test evidence", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(
        new ShellWorkflowNodeExecutor(
          new FakeShellExecutionAdapter({ pnpm: { exitCode: 0, durationMs: 12, timedOut: false } })
        )
      ),
      persistence,
      new InMemoryArtifactRegistry()
    );

    const completed = await runtime.startTemplate("local-quality-check", false, {
      root: "C:\\approved-project"
    }).completion;

    expect(completed.state).toBe("succeeded");
    expect(completed.nodeRuns.find((node) => node.nodeId === "typecheck")).toMatchObject({
      evidence: [expect.objectContaining({ type: "test" })]
    });
  });

  it("runs the approved quality suite in lint, typecheck, test and build order", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    const shell = new FakeShellExecutionAdapter({
      pnpm: { exitCode: 0, durationMs: 4, timedOut: false }
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(new ShellWorkflowNodeExecutor(shell)),
      persistence,
      new InMemoryArtifactRegistry()
    );

    const completed = await runtime.startTemplate("local-quality-suite", false, {
      root: "C:\\approved-project"
    }).completion;

    expect(completed.state).toBe("succeeded");
    expect(shell.requests.map((request) => request.command.args)).toEqual([
      ["run", "lint"],
      ["run", "typecheck"],
      ["run", "test"],
      ["run", "build"]
    ]);
    expect(completed.nodeRuns.filter((node) => node.nodeId !== "report")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "lint",
          evidence: [expect.objectContaining({ type: "test" })]
        }),
        expect.objectContaining({
          nodeId: "typecheck",
          evidence: [expect.objectContaining({ type: "test" })]
        }),
        expect.objectContaining({
          nodeId: "test",
          evidence: [expect.objectContaining({ type: "test" })]
        }),
        expect.objectContaining({
          nodeId: "build",
          evidence: [expect.objectContaining({ type: "test" })]
        })
      ])
    );
  });

  it("projects workflow dependencies without exposing its trusted command", () => {
    const store = new InMemoryRunStore();
    const workflow = workflowSchema.parse({
      schema_version: "1.0",
      id: "safe-graph",
      name: "Safe graph",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        {
          id: "check",
          type: "shell",
          command: { executable: "pnpm", args: ["run", "typecheck"] },
          permissions: { process: true }
        },
        { id: "report", type: "artifact", depends_on: ["check"], permissions: {} }
      ]
    });
    const persistence = Object.assign(store, {
      getWorkflow: () => workflow,
      get: () => null,
      list: () => [],
      listEvents: () => []
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(),
      persistence,
      new InMemoryArtifactRegistry()
    );

    const graph = runtime.graph("stored-run");

    expect(graph).toEqual({
      runId: "stored-run",
      workflowId: "safe-graph",
      nodes: [
        { id: "check", type: "shell", title: null, dependsOn: [] },
        { id: "report", type: "artifact", title: null, dependsOn: ["check"] }
      ]
    });
    expect(JSON.stringify(graph)).not.toContain("pnpm");
    expect(JSON.stringify(graph)).not.toContain("process");
  });

  it("requires a selected existing agent for the trusted agent-delivery workflow", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    const execute = vi.fn().mockResolvedValue({
      success: true,
      evidence: [
        {
          id: "message-evidence",
          type: "message",
          summary: "Workflow request was queued.",
          metadata: {}
        }
      ],
      output: { queued: true }
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(null, { execute }),
      persistence,
      new InMemoryArtifactRegistry()
    );

    expect(() =>
      runtime.startTemplate("local-agent-delivery", false, { root: "C:\\approved-project" })
    ).toThrow("explicit existing agent target");
    const completed = await runtime.startTemplate("local-agent-delivery", false, {
      root: "C:\\approved-project",
      agentNodeId: "reviewer"
    }).completion;

    expect(completed.state).toBe("succeeded");
    expect(() => runtime.retry(completed.id)).toThrow("explicit existing agent target");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent" }),
      expect.objectContaining({ runId: completed.id })
    );
  });

  it("permits isolated templates only with an opaque managed worktree target", async () => {
    const store = new InMemoryRunStore();
    const persistence = Object.assign(store, {
      getWorkflow: () => null,
      get: (runId: string) => store.runs.get(runId) ?? null,
      list: () => [...store.runs.values()],
      listEvents: () => store.events
    });
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(),
      persistence,
      new InMemoryArtifactRegistry()
    );

    const preview = await runtime.startTemplate("blueprint-to-pr", true, {
      root: "C:\\approved-project",
      agentNodeId: "reviewer"
    }).completion;
    expect(preview.state).toBe("succeeded");
    expect(() =>
      runtime.startTemplate("blueprint-to-pr", false, {
        root: "C:\\approved-project",
        agentNodeId: "reviewer"
      })
    ).toThrow("managed Git worktree");
    const completed = await runtime.startTemplate("blueprint-to-pr", false, {
      root: "C:\\managed-worktrees\\worktree-1",
      worktreeId: "worktree-1",
      agentNodeId: "reviewer"
    }).completion;

    expect(completed.state).toBe("failed");
    expect(JSON.stringify(completed)).not.toContain("managed-worktrees");
  });
});
