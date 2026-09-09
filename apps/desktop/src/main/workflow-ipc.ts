import type { IpcMain } from "electron";

import {
  WORKFLOW_DRY_RUN_CHANNEL,
  WORKFLOW_LIST_TEMPLATES_CHANNEL,
  WORKFLOW_PACKAGE_EXPORT_CHANNEL,
  WORKFLOW_PACKAGE_PREVIEW_IMPORT_CHANNEL,
  WORKFLOW_TEMPLATE_PREVIEW_IMPORT_CHANNEL,
  WORKFLOW_RUN_APPROVE_CHANNEL,
  WORKFLOW_RUN_CANCEL_CHANNEL,
  WORKFLOW_RUN_EVENTS_CHANNEL,
  WORKFLOW_RUN_GRAPH_CHANNEL,
  WORKFLOW_RUN_LIST_CHANNEL,
  WORKFLOW_RUN_PAUSE_CHANNEL,
  WORKFLOW_RUN_REJECT_CHANNEL,
  WORKFLOW_RUN_RESUME_CHANNEL,
  WORKFLOW_RUN_RETRY_CHANNEL,
  WORKFLOW_RUN_SHOW_CHANNEL,
  WORKFLOW_RUN_START_CHANNEL,
  workflowDryRunRequestSchema,
  workflowDryRunResponseSchema,
  workflowTemplateImportRequestSchema,
  workflowTemplateImportPreviewSchema,
  compassoPackageRequestSchema,
  compassoPackagePreviewSchema,
  compassoPackageSchema,
  workflowRunApprovalRequestSchema,
  workflowRunCommandResponseSchema,
  workflowRunControlRequestSchema,
  workflowRunEventSchema,
  workflowRunGraphSchema,
  workflowRunListRequestSchema,
  workflowRunSnapshotSchema,
  workflowRunStartRequestSchema,
  workflowTemplateSummarySchema
} from "@forgedeck/schemas";
import {
  builtInWorkflowTemplates,
  createDryRunPlan,
  previewWorkflowTemplateImport
} from "@forgedeck/workflow";
import { exportCompassoPackage, previewCompassoPackageImport } from "@forgedeck/schemas";

import type { WorkflowRunRuntime } from "./workflow-run-runtime";

export function registerWorkflowIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  runtime: WorkflowRunRuntime,
  commands: WorkflowRunCommandRequestStore
): void {
  ipc.removeHandler(WORKFLOW_LIST_TEMPLATES_CHANNEL);
  ipc.handle(WORKFLOW_LIST_TEMPLATES_CHANNEL, handleListWorkflowTemplates);

  ipc.removeHandler(WORKFLOW_DRY_RUN_CHANNEL);
  ipc.handle(WORKFLOW_DRY_RUN_CHANNEL, (_event, payload: unknown) => handleWorkflowDryRun(payload));

  ipc.removeHandler(WORKFLOW_TEMPLATE_PREVIEW_IMPORT_CHANNEL);
  ipc.handle(WORKFLOW_TEMPLATE_PREVIEW_IMPORT_CHANNEL, async (_event, payload: unknown) =>
    workflowTemplateImportPreviewSchema.parse(
      await previewWorkflowTemplateImport(
        workflowTemplateImportRequestSchema.parse(payload).document
      )
    )
  );

  ipc.removeHandler(WORKFLOW_PACKAGE_EXPORT_CHANNEL);
  ipc.handle(WORKFLOW_PACKAGE_EXPORT_CHANNEL, async (_event, payload: unknown) =>
    compassoPackageSchema.parse(
      await exportCompassoPackage(compassoPackageRequestSchema.parse(payload).package)
    )
  );
  ipc.removeHandler(WORKFLOW_PACKAGE_PREVIEW_IMPORT_CHANNEL);
  ipc.handle(WORKFLOW_PACKAGE_PREVIEW_IMPORT_CHANNEL, async (_event, payload: unknown) =>
    compassoPackagePreviewSchema.parse(
      await previewCompassoPackageImport(compassoPackageRequestSchema.parse(payload).package)
    )
  );

  ipc.removeHandler(WORKFLOW_RUN_START_CHANNEL);
  ipc.handle(WORKFLOW_RUN_START_CHANNEL, (_event, payload: unknown) => {
    const request = workflowRunStartRequestSchema.parse(payload);
    const command = commands.requestStart({
      templateId: request.templateId,
      workspaceId: request.workspaceId,
      agentNodeId: request.agentNodeId,
      task: request.task,
      ...(request.contractId === undefined ? {} : { contractId: request.contractId }),
      contextMode: request.contextMode,
      dryRun: request.dryRun,
      requestedBy: "desktop-renderer"
    });
    return workflowRunCommandResponseSchema.parse({
      commandId: command.id,
      action: command.action,
      status: command.status,
      createdAt: command.createdAt
    });
  });
  ipc.removeHandler(WORKFLOW_RUN_LIST_CHANNEL);
  ipc.handle(WORKFLOW_RUN_LIST_CHANNEL, (_event, payload: unknown) => {
    const request = workflowRunListRequestSchema.parse(payload ?? {});
    const snapshots =
      request.state === undefined
        ? runtime.list({ limit: request.limit })
        : runtime.list({ state: request.state, limit: request.limit });
    return snapshots.map((snapshot) => workflowRunSnapshotSchema.parse(snapshot));
  });
  ipc.removeHandler(WORKFLOW_RUN_SHOW_CHANNEL);
  ipc.handle(WORKFLOW_RUN_SHOW_CHANNEL, (_event, payload: unknown) =>
    workflowRunSnapshotSchema.parse(
      runtime.show(workflowRunControlRequestSchema.parse(payload).runId)
    )
  );
  ipc.removeHandler(WORKFLOW_RUN_GRAPH_CHANNEL);
  ipc.handle(WORKFLOW_RUN_GRAPH_CHANNEL, (_event, payload: unknown) =>
    workflowRunGraphSchema.parse(
      runtime.graph(workflowRunControlRequestSchema.parse(payload).runId)
    )
  );
  ipc.removeHandler(WORKFLOW_RUN_EVENTS_CHANNEL);
  ipc.handle(WORKFLOW_RUN_EVENTS_CHANNEL, (_event, payload: unknown) =>
    runtime
      .events(workflowRunControlRequestSchema.parse(payload).runId)
      .map((event) => workflowRunEventSchema.parse(event))
  );
  registerRunControlHandlers(ipc, commands);
}

export interface WorkflowRunCommandRequestStore {
  requestStart(input: {
    readonly templateId: string;
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly task: string;
    readonly contractId?: string;
    readonly contextMode: "full" | "intelligent" | "economical";
    readonly dryRun: boolean;
    readonly requestedBy: string;
  }): {
    readonly id: string;
    readonly action: "start" | "pause" | "resume" | "cancel" | "retry" | "approve" | "reject";
    readonly status: "queued";
    readonly createdAt: string;
  };
  requestControl(input: {
    readonly action: "pause" | "resume" | "cancel" | "retry" | "approve" | "reject";
    readonly runId: string;
    readonly nodeId?: string;
    readonly decisionNote?: string;
    readonly requestedBy: string;
  }): {
    readonly id: string;
    readonly action: "pause" | "resume" | "cancel" | "retry" | "approve" | "reject";
    readonly status: "queued";
    readonly createdAt: string;
  };
}

export function handleListWorkflowTemplates() {
  return builtInWorkflowTemplates.map((template) =>
    workflowTemplateSummarySchema.parse({
      id: template.id,
      name: template.name,
      description: template.description ?? "",
      nodeCount: template.nodes.length,
      requiresGitWorktree: template.nodes.some((node) => node.isolation === "git_worktree")
    })
  );
}

export function handleWorkflowDryRun(payload: unknown) {
  const request = workflowDryRunRequestSchema.parse(payload);
  return workflowDryRunResponseSchema.parse(
    createDryRunPlan(request.workflow, request.grantedPermissions)
  );
}

function registerRunControlHandlers(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  commands: WorkflowRunCommandRequestStore
): void {
  for (const [channel, action] of [
    [WORKFLOW_RUN_PAUSE_CHANNEL, "pause"],
    [WORKFLOW_RUN_RESUME_CHANNEL, "resume"],
    [WORKFLOW_RUN_CANCEL_CHANNEL, "cancel"],
    [WORKFLOW_RUN_RETRY_CHANNEL, "retry"]
  ] as const) {
    ipc.removeHandler(channel);
    ipc.handle(channel, (_event, payload: unknown) => {
      const request = workflowRunControlRequestSchema.parse(payload);
      return toCommandResponse(
        commands.requestControl({
          action,
          runId: request.runId,
          requestedBy: "desktop-renderer"
        })
      );
    });
  }
  for (const [channel, approved] of [
    [WORKFLOW_RUN_APPROVE_CHANNEL, true],
    [WORKFLOW_RUN_REJECT_CHANNEL, false]
  ] as const) {
    ipc.removeHandler(channel);
    ipc.handle(channel, (_event, payload: unknown) => {
      const request = workflowRunApprovalRequestSchema.parse(payload);
      return toCommandResponse(
        commands.requestControl({
          action: approved ? "approve" : "reject",
          runId: request.runId,
          nodeId: request.nodeId,
          decisionNote: request.note,
          requestedBy: "desktop-renderer"
        })
      );
    });
  }
}

function toCommandResponse(command: {
  readonly id: string;
  readonly action: "start" | "pause" | "resume" | "cancel" | "retry" | "approve" | "reject";
  readonly status: "queued";
  readonly createdAt: string;
}) {
  return workflowRunCommandResponseSchema.parse({
    commandId: command.id,
    action: command.action,
    status: command.status,
    createdAt: command.createdAt
  });
}
