import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DeterministicScheduler } from "@forgedeck/orchestration";
import type {
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowNodeExecutor
} from "@forgedeck/orchestration";
import { createAllowedEnvironment, NodePtyFactory, ProcessSupervisor } from "@forgedeck/terminal";
import { workflowSchema } from "@forgedeck/workflow";
import type { WorkflowNode } from "@forgedeck/workflow";

import { SqliteArtifactRegistry } from "./artifact-registry";
import { runLocalMigrations } from "./migrate";
import { SqliteWorkflowRunStore } from "./workflow-run-store";

const temporaryDirectories: string[] = [];
const fakeAgentPath = resolve("packages/fake-agent/bin/fake-agent.mjs");

// Removal is deliberately retry-free: the executor closes its supervisor (full reap) before the workspace is
// removed, so an EBUSY here would mean a real leak and must fail instead of being waited out.
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("workflow execution with fake-agent", () => {
  it("retries, redacts evidence, persists ordered events, and creates a final report", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ForgeDeck workflow with spaces "));
    temporaryDirectories.push(workspace);
    const filename = join(workspace, "workflow.db");
    const flakyState = join(workspace, "flaky-state.txt");
    runLocalMigrations({ filename });
    const store = new SqliteWorkflowRunStore(filename);
    const artifacts = new SqliteArtifactRegistry(filename, workspace);
    const executor = new FakeAgentExecutor(workspace, flakyState);
    try {
      const scheduler = new DeterministicScheduler(executor, store, artifacts, {
        sleep: async () => Promise.resolve()
      });
      let deliveryCheckpointCreated = false;
      const workflow = workflowSchema.parse({
        schema_version: "1.0",
        id: "fake-agent-workflow",
        name: "Fake agent workflow",
        concurrency: 2,
        permissions: { process: true },
        nodes: [
          {
            id: "flaky",
            type: "agent",
            permissions: { process: true },
            retry: { max_attempts: 2, backoff_ms: 1, retry_on: ["transient_error"] }
          },
          {
            id: "secret",
            type: "agent",
            depends_on: ["flaky"],
            permissions: { process: true }
          }
        ]
      });
      const result = await scheduler.start({
        workflow,
        grantedPermissions: { process: true },
        executionContext: {
          context: executionContext("function"),
          createDeliveryCheckpoint: async () => {
            deliveryCheckpointCreated = true;
            return checkpointReference("delivery");
          }
        }
      }).completion;
      expect(result.state).toBe("succeeded");
      expect(result.nodeRuns.find((node) => node.nodeId === "flaky")?.attempt).toBe(2);
      expect(result.reportArtifact).not.toBeNull();
      expect(deliveryCheckpointCreated).toBe(true);
      expect(result.executionContext?.deliveryCheckpoint?.checkpointId).toBe(
        "00000000-0000-4000-8000-000000000102"
      );
      if (result.reportArtifact === null) {
        throw new Error("Workflow did not create its required report artifact");
      }
      const reportPath = join(workspace, result.reportArtifact.relative_path);
      const report = await readFile(reportPath, "utf8");
      expect(report).toContain("Fake agent workflow");
      expect(report).toContain("## Execution context");
      expect(report).toContain("00000000-0000-4000-8000-000000000101");
      expect(report).toContain("00000000-0000-4000-8000-000000000102");
      expect(report).toContain("[REDACTED]");
      expect(report).not.toContain("FORGEDECK_TEST_SECRET_runtime-diagnostic");
      expect(
        store.getEventPayloads(result.id).some((payload) => payload.includes("REDACTED"))
      ).toBe(false);
      expect(store.get(result.id)).toMatchObject({
        id: result.id,
        state: "succeeded",
        nodeRuns: [
          expect.objectContaining({ nodeId: "flaky", state: "succeeded", attempt: 2 }),
          expect.objectContaining({ nodeId: "secret", state: "succeeded" })
        ],
        reportArtifact: expect.objectContaining({ id: result.reportArtifact.id })
      });
      expect(store.list({ state: "succeeded" })).toEqual([
        expect.objectContaining({ id: result.id, state: "succeeded" })
      ]);
      expect(store.listEvents(result.id).map((event) => event.sequence)).toEqual(
        expect.arrayContaining([1, 2])
      );

      const handoff = await artifacts.createHandoff(result.id, {
        id: "implementation-to-review",
        fromNodeId: "flaky",
        toNodeId: "secret",
        summary: "Implementation is ready for review",
        decisions: [{ summary: "Retry only transient failures" }],
        artifacts: [],
        openQuestions: [],
        acceptanceEvidence: [
          {
            id: "handoff-evidence",
            type: "test",
            summary: "Fake-agent integration passed",
            metadata: {}
          }
        ],
        schemaVersion: "1.0"
      });
      expect(
        JSON.parse(await readFile(join(workspace, handoff.relative_path), "utf8"))
      ).toMatchObject({ fromNodeId: "flaky", toNodeId: "secret" });
    } finally {
      await executor.close();
      artifacts.close();
      store.close();
    }
  }, 20_000);
});

class FakeAgentExecutor implements WorkflowNodeExecutor {
  private readonly supervisor = new ProcessSupervisor(new NodePtyFactory(), {
    platform: platform(),
    batchIntervalMs: 8,
    maxBufferLines: 100
  });

  public constructor(
    private readonly workspace: string,
    private readonly flakyState: string
  ) {}

  /** Reaps every fake-agent tree and disposes the sessions, so nothing outlives the run's workspace. */
  public async close(): Promise<void> {
    await this.supervisor.close();
  }

  public async execute(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    const sessionId = `${context.runId}-${node.id}-${context.attempt}`;
    const modeArgs =
      node.id === "flaky"
        ? ["--mode", "flaky", "--state-file", this.flakyState]
        : ["--mode", "secret"];
    await this.supervisor.start({
      sessionId,
      adapterId: "fake-agent",
      launch: {
        executable: { path: process.execPath, kind: "native" },
        args: [fakeAgentPath, ...modeArgs],
        cwd: this.workspace,
        environment: createAllowedEnvironment(process.env, { TERM: "xterm-256color" }),
        cols: 120,
        rows: 30
      },
      allowedCwdRoots: [this.workspace]
    });
    await waitForTerminal(this.supervisor, sessionId);
    const snapshot = this.supervisor.getSession(sessionId);
    const output = this.supervisor.getBuffer(sessionId);
    if (snapshot.state !== "succeeded") {
      return {
        success: false,
        reason: "transient_error",
        message: `fake-agent exited with ${snapshot.exitCode ?? "unknown"}`,
        evidence: []
      };
    }
    return {
      success: true,
      evidence: [
        {
          id: `evidence-${sessionId}`,
          type: "exit_code",
          summary: `exit=0 output=${output}`,
          metadata: { exitCode: snapshot.exitCode }
        }
      ],
      output: { exitCode: snapshot.exitCode }
    };
  }
}

function executionContext(kind: "function" | "delivery") {
  return {
    workspaceId: "workspace-1",
    agentNodeId: "reviewer",
    task: "Run the fake-agent workflow",
    contractId: null,
    profileVersion: 1,
    missionVersion: 1,
    memoryVersion: 1,
    contractVersion: null,
    functionCheckpoint: checkpointReference(kind),
    deliveryCheckpoint: null
  };
}

function checkpointReference(kind: "function" | "delivery") {
  const suffix = kind === "function" ? "101" : "102";
  return {
    checkpointId: `00000000-0000-4000-8000-000000000${suffix}`,
    snapshotId: `00000000-0000-4000-8000-000000000${kind === "function" ? "201" : "202"}`,
    sha256: kind === "function" ? "a".repeat(64) : "b".repeat(64),
    createdAt: "2026-07-21T12:00:00.000Z"
  };
}

async function waitForTerminal(supervisor: ProcessSupervisor, sessionId: string): Promise<void> {
  const deadline = Date.now() + 7_500;
  while (
    !["succeeded", "failed", "cancelled", "interrupted"].includes(
      supervisor.getSession(sessionId).state
    )
  ) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for workflow fake-agent");
    }
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
