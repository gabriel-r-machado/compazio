import { describe, expect, it, vi } from "vitest";

import { bugfixTemplate } from "@forgedeck/workflow";

import type { WorkflowRunSnapshot } from "@forgedeck/orchestration";

import {
  handleListWorkflowTemplates,
  handleWorkflowDryRun,
  registerWorkflowIpc
} from "./workflow-ipc";
import type { WorkflowRunRuntime } from "./workflow-run-runtime";

describe("workflow IPC handlers", () => {
  it("lists the two built-in templates", () => {
    expect(handleListWorkflowTemplates().map((template) => template.id)).toEqual([
      "blueprint-to-pr",
      "bugfix"
    ]);
  });

  it("returns a deterministic dry-run and rejects undeclared fields", () => {
    const response = handleWorkflowDryRun({
      workflow: bugfixTemplate,
      grantedPermissions: bugfixTemplate.permissions
    });

    expect(response.valid).toBe(true);
    expect(response.order).toHaveLength(bugfixTemplate.nodes.length);
    expect(() =>
      handleWorkflowDryRun({
        workflow: bugfixTemplate,
        grantedPermissions: bugfixTemplate.permissions,
        cwd: "C:/renderer-controlled"
      })
    ).toThrow();
  });

  it("exposes typed run controls and rejects a renderer-supplied command surface", async () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => unknown>();
    const snapshot = runSnapshot();
    const runtime = {
      startTemplate: () => ({ runId: snapshot.id, completion: Promise.resolve(snapshot) }),
      get: () => snapshot,
      list: () => [snapshot],
      show: () => snapshot,
      graph: () => ({
        runId: snapshot.id,
        workflowId: snapshot.workflowId,
        nodes: [{ id: "report", type: "artifact", title: null, dependsOn: [] }]
      }),
      events: () => [],
      pause: async () => snapshot,
      resume: async () => snapshot,
      cancel: async () => snapshot,
      retry: () => ({ runId: snapshot.id, completion: Promise.resolve(snapshot) }),
      resolveApproval: async () => undefined
    } as unknown as WorkflowRunRuntime;
    const requestStart = vi.fn().mockReturnValue({
      id: "00000000-0000-4000-8000-000000000001",
      action: "start",
      status: "queued",
      createdAt: "2026-07-21T12:00:00.000Z"
    });
    const requestControl = vi.fn().mockReturnValue({
      id: "00000000-0000-4000-8000-000000000002",
      action: "pause",
      status: "queued",
      createdAt: "2026-07-21T12:00:01.000Z"
    });
    registerWorkflowIpc(
      {
        removeHandler: (channel) => handlers.delete(channel),
        handle: (channel, handler) => handlers.set(channel, handler as never)
      },
      runtime,
      { requestStart, requestControl }
    );

    expect(handlers.get("workflows:run-list")?.({}, {})).toEqual([snapshot]);
    expect(
      handlers.get("workflows:run-start")?.(
        {},
        {
          templateId: "delivery-report",
          workspaceId: "workspace-1",
          agentNodeId: "reviewer",
          task: "Create the delivery report"
        }
      )
    ).toEqual({
      commandId: "00000000-0000-4000-8000-000000000001",
      action: "start",
      status: "queued",
      createdAt: "2026-07-21T12:00:00.000Z"
    });
    expect(requestStart).toHaveBeenCalledWith({
      templateId: "delivery-report",
      workspaceId: "workspace-1",
      agentNodeId: "reviewer",
      task: "Create the delivery report",
      contextMode: "full",
      dryRun: false,
      requestedBy: "desktop-renderer"
    });
    expect(handlers.get("workflows:run-pause")?.({}, { runId: snapshot.id })).toEqual({
      commandId: "00000000-0000-4000-8000-000000000002",
      action: "pause",
      status: "queued",
      createdAt: "2026-07-21T12:00:01.000Z"
    });
    expect(requestControl).toHaveBeenCalledWith({
      action: "pause",
      runId: snapshot.id,
      requestedBy: "desktop-renderer"
    });
    await expect(
      handlers.get("workflows:template-preview-import")?.({}, { document: templateDocument() })
    ).resolves.toMatchObject({
      source_format_version: "1.1",
      document: { id: "safe-review" },
      warnings: []
    });
    const exportedPackage = await handlers.get("workflows:package-export")?.(
      {},
      {
        package: {
          format_version: "1.0",
          kind: "flow",
          flow: packageFlow()
        }
      }
    );
    expect(exportedPackage).toMatchObject({
      kind: "flow",
      flow: { nodes: [expect.objectContaining({ id: "agent" })] }
    });
    await expect(
      handlers.get("workflows:package-preview-import")?.({}, { package: exportedPackage })
    ).resolves.toMatchObject({ package: { kind: "flow" } });
    expect(handlers.get("workflows:run-graph")?.({}, { runId: snapshot.id })).toEqual({
      runId: snapshot.id,
      workflowId: snapshot.workflowId,
      nodes: [{ id: "report", type: "artifact", title: null, dependsOn: [] }]
    });
    expect(() =>
      handlers.get("workflows:run-start")?.(
        {},
        {
          templateId: "delivery-report",
          workspaceId: "workspace-1",
          agentNodeId: "reviewer",
          task: "Create the delivery report",
          cwd: "C:/renderer-controlled",
          command: "pnpm test"
        }
      )
    ).toThrow();
    await expect(
      handlers.get("workflows:template-preview-import")?.(
        {},
        {
          document: {
            ...templateDocument(),
            workflow: {
              ...templateDocument().workflow,
              nodes: [
                {
                  id: "unsafe",
                  type: "shell",
                  command: { executable: "pnpm", args: ["test"] },
                  permissions: { process: true }
                }
              ]
            }
          }
        }
      )
    ).rejects.toThrow("not allowed: command");
  });
});

function templateDocument() {
  return {
    format_version: "1.1",
    id: "safe-review",
    name: "Safe review",
    questionnaire: [],
    materials: { required: [], optional: [] },
    agents: [],
    contracts: [],
    gates: [],
    permissions: { process: true },
    workflow: {
      schema_version: "1.0",
      id: "safe-review",
      name: "Safe review",
      concurrency: 1,
      permissions: { process: true },
      nodes: [{ id: "review", type: "agent", permissions: { process: true } }]
    }
  };
}

function packageFlow() {
  return {
    id: "canvas-1",
    title: "Private canvas",
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "agent",
        type: "agent",
        position: { x: 0, y: 0 },
        data: { title: "Private agent", state: "idle", summary: "", permissions: [] }
      }
    ],
    edges: []
  };
}

function runSnapshot(): WorkflowRunSnapshot {
  return {
    id: "workflow-run-1",
    workflowId: "delivery-report",
    workflowVersion: "1.0",
    workflowHash: "0".repeat(64),
    inputHash: "0".repeat(64),
    effectivePermissions: {},
    state: "created",
    dryRun: false,
    concurrency: 1,
    startedAt: null,
    endedAt: null,
    executionContext: null,
    nodeRuns: [],
    reportArtifact: null
  };
}
