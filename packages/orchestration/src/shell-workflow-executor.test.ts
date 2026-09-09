import { describe, expect, it } from "vitest";

import { workflowSchema } from "@forgedeck/workflow";

import { FakeShellExecutionAdapter, ShellWorkflowNodeExecutor } from "./shell-workflow-executor";

describe("ShellWorkflowNodeExecutor", () => {
  it("uses the fake shell adapter and returns evidence without terminal output", async () => {
    const fake = new FakeShellExecutionAdapter({
      pnpm: { exitCode: 0, durationMs: 24, timedOut: false }
    });
    const executor = new ShellWorkflowNodeExecutor(fake);
    const result = await executor.execute(shellNode(), context());

    expect(result).toMatchObject({ success: true, output: { exitCode: 0, durationMs: 24 } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.command).toEqual({ executable: "pnpm", args: ["run", "lint"] });
    expect(JSON.stringify(result)).not.toContain("terminal output");
  });

  it("requires explicit process permission and an approved command", async () => {
    const executor = new ShellWorkflowNodeExecutor(new FakeShellExecutionAdapter());
    const denied = await executor.execute(shellNode(), context(false));
    expect(denied).toMatchObject({ success: false, reason: "permission_denied" });

    const noCommand = workflowSchema.parse({
      schema_version: "1.0",
      id: "shell-test",
      name: "Shell test",
      permissions: { process: true },
      nodes: [{ id: "lint", type: "shell", permissions: { process: true } }]
    }).nodes[0];
    expect(noCommand).toBeDefined();
    const invalid = await executor.execute(requireNode(noCommand), context());
    expect(invalid).toMatchObject({ success: false, reason: "schema_invalid" });
  });

  it("preserves timeout and non-zero exit reasons for scheduler retry policy", async () => {
    const timeoutExecutor = new ShellWorkflowNodeExecutor(
      new FakeShellExecutionAdapter({ pnpm: { exitCode: null, durationMs: 500, timedOut: true } })
    );
    expect(await timeoutExecutor.execute(shellNode(), context())).toMatchObject({
      success: false,
      reason: "timeout"
    });

    const failureExecutor = new ShellWorkflowNodeExecutor(
      new FakeShellExecutionAdapter({ pnpm: { exitCode: 1, durationMs: 3, timedOut: false } })
    );
    expect(await failureExecutor.execute(shellNode(), context())).toMatchObject({
      success: false,
      reason: "process_exit_nonzero"
    });
  });

  it("treats a trusted quality gate as verified test evidence", async () => {
    const executor = new ShellWorkflowNodeExecutor(
      new FakeShellExecutionAdapter({ pnpm: { exitCode: 0, durationMs: 18, timedOut: false } })
    );

    expect(await executor.execute(qualityGateNode(), context())).toMatchObject({
      success: true,
      evidence: [expect.objectContaining({ type: "test" })]
    });
  });
});

function shellNode() {
  const node = workflowSchema.parse({
    schema_version: "1.0",
    id: "shell-test",
    name: "Shell test",
    permissions: { process: true },
    nodes: [
      {
        id: "lint",
        type: "shell",
        command: { executable: "pnpm", args: ["run", "lint"] },
        permissions: { process: true }
      }
    ]
  }).nodes[0];
  return requireNode(node);
}

function qualityGateNode() {
  const node = workflowSchema.parse({
    schema_version: "1.0",
    id: "quality-gate-test",
    name: "Quality gate test",
    permissions: { process: true },
    nodes: [
      {
        id: "typecheck",
        type: "quality_gate",
        command: { executable: "pnpm", args: ["run", "typecheck"] },
        permissions: { process: true }
      }
    ]
  }).nodes[0];
  return requireNode(node);
}

function requireNode<T>(node: T | undefined): T {
  if (node === undefined) throw new Error("Expected workflow node");
  return node;
}

function context(process = true) {
  return {
    runId: "run-1",
    nodeRunId: "node-run-1",
    attempt: 1,
    workflowVersion: "1.0" as const,
    grantedPermissions: { process },
    abortSignal: new AbortController().signal
  };
}
