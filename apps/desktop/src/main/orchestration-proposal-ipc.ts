import type { IpcMain } from "electron";

import {
  ORCHESTRATION_PROPOSAL_APPROVE_CHANNEL,
  ORCHESTRATION_PROPOSAL_CREATE_CHANNEL,
  ORCHESTRATION_PROPOSAL_EXECUTE_CHANNEL,
  ORCHESTRATION_PROPOSAL_EVENTS_CHANNEL,
  ORCHESTRATION_PROPOSAL_LIST_CHANNEL,
  ORCHESTRATION_PROPOSAL_PLANNING_OPTIONS_CHANNEL,
  ORCHESTRATION_PROPOSAL_REJECT_CHANNEL,
  ORCHESTRATION_PROPOSAL_SHOW_CHANNEL,
  ORCHESTRATION_PROPOSAL_UPDATE_CHANNEL,
  orchestrationProposalCreateRequestSchema,
  orchestrationProposalExecuteRequestSchema,
  orchestrationProposalExecutionResponseSchema,
  orchestrationProposalEventListResponseSchema,
  orchestrationProposalListRequestSchema,
  orchestrationProposalListResponseSchema,
  orchestrationProposalPlanningOptionsRequestSchema,
  orchestrationProposalPlanningOptionsResponseSchema,
  orchestrationProposalReferenceRequestSchema,
  orchestrationProposalReviewRequestSchema,
  orchestrationProposalSchema,
  orchestrationProposalUpdateRequestSchema
} from "@forgedeck/schemas";
import { builtInWorkflowTemplates } from "@forgedeck/workflow";

import type {
  OrchestrationProposalExecutionService,
  SqliteOrchestrationProposalStore
} from "@forgedeck/local-db";

type OrchestrationProposalStore = Pick<
  SqliteOrchestrationProposalStore,
  "create" | "get" | "list" | "listEvents" | "updateDraft" | "approve" | "reject"
>;

type ProposalExecutionService = Pick<OrchestrationProposalExecutionService, "request">;

export interface ProposalPlanningAgentDirectory {
  listAgents(workspaceId: string): readonly {
    readonly nodeId: string;
    readonly name: string;
    readonly roleName: string | null;
    readonly online: boolean;
  }[];
}

/** Proposal IPC accepts reviewed identifiers only; it never accepts a command or workflow payload. */
export function registerOrchestrationProposalIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  store: OrchestrationProposalStore,
  execution: ProposalExecutionService,
  agents: ProposalPlanningAgentDirectory
): void {
  register(ipc, ORCHESTRATION_PROPOSAL_CREATE_CHANNEL, (payload) =>
    orchestrationProposalSchema.parse(
      store.create(orchestrationProposalCreateRequestSchema.parse(payload))
    )
  );
  register(ipc, ORCHESTRATION_PROPOSAL_LIST_CHANNEL, (payload) => {
    const request = orchestrationProposalListRequestSchema.parse(payload);
    return orchestrationProposalListResponseSchema.parse(
      store.list(request.workspaceId, request.limit)
    );
  });
  register(ipc, ORCHESTRATION_PROPOSAL_SHOW_CHANNEL, (payload) => {
    const request = orchestrationProposalReferenceRequestSchema.parse(payload);
    return orchestrationProposalSchema.parse(store.get(request.workspaceId, request.proposalId));
  });
  register(ipc, ORCHESTRATION_PROPOSAL_EVENTS_CHANNEL, (payload) => {
    const request = orchestrationProposalReferenceRequestSchema.parse(payload);
    return orchestrationProposalEventListResponseSchema.parse(
      store.listEvents(request.workspaceId, request.proposalId)
    );
  });
  register(ipc, ORCHESTRATION_PROPOSAL_UPDATE_CHANNEL, (payload) => {
    const request = orchestrationProposalUpdateRequestSchema.parse(payload);
    return orchestrationProposalSchema.parse(
      store.updateDraft({
        workspaceId: request.workspaceId,
        proposalId: request.proposalId,
        expectedRevision: request.revision,
        draft: request.draft
      })
    );
  });
  register(ipc, ORCHESTRATION_PROPOSAL_APPROVE_CHANNEL, (payload) =>
    review(store, payload, "approve")
  );
  register(ipc, ORCHESTRATION_PROPOSAL_REJECT_CHANNEL, (payload) =>
    review(store, payload, "reject")
  );
  register(ipc, ORCHESTRATION_PROPOSAL_EXECUTE_CHANNEL, (payload) => {
    const request = orchestrationProposalExecuteRequestSchema.parse(payload);
    const command = execution.request(request);
    return orchestrationProposalExecutionResponseSchema.parse({
      commandId: command.id,
      status: command.status,
      createdAt: command.createdAt,
      runId: command.resultRunId,
      errorCode: command.errorCode
    });
  });
  register(ipc, ORCHESTRATION_PROPOSAL_PLANNING_OPTIONS_CHANNEL, (payload) => {
    const request = orchestrationProposalPlanningOptionsRequestSchema.parse(payload);
    return orchestrationProposalPlanningOptionsResponseSchema.parse({
      templates: builtInWorkflowTemplates.map((template) => ({
        id: template.id,
        name: template.name,
        requiresGitWorktree: template.nodes.some((node) => node.isolation === "git_worktree")
      })),
      agents: agents.listAgents(request.workspaceId).map((agent) => ({
        nodeId: agent.nodeId,
        name: agent.name,
        roleName: agent.roleName,
        online: agent.online
      }))
    });
  });
}

function review(store: OrchestrationProposalStore, payload: unknown, action: "approve" | "reject") {
  const request = orchestrationProposalReviewRequestSchema.parse(payload);
  const input = {
    workspaceId: request.workspaceId,
    proposalId: request.proposalId,
    expectedRevision: request.revision
  };
  return orchestrationProposalSchema.parse(
    action === "approve" ? store.approve(input) : store.reject(input)
  );
}

function register(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => unknown
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}
