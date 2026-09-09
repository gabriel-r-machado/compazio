import { randomUUID } from "node:crypto";

import type { IpcMain } from "electron";

import type { SqliteWorkflowDraftStore, WorkflowDraftEventInput } from "@forgedeck/local-db";
import { applyDraftCommand, suggestAgentAssignments } from "@forgedeck/orchestration";
import type {
  AgentAssignmentCatalog,
  DraftCommand,
  DraftReducerResult
} from "@forgedeck/orchestration";
import {
  WORKFLOW_AGENTS_LIST_CHANNEL,
  WORKFLOW_DRAFT_ASSIGN_AGENTS_CHANNEL,
  workflowAgentsListResponseSchema,
  workflowDraftAssignAgentsRequestSchema,
  WORKFLOW_DRAFT_ANSWER_QUESTION_CHANNEL,
  WORKFLOW_DRAFT_APPLY_ACTION_CHANNEL,
  WORKFLOW_DRAFT_APPROVE_CHANNEL,
  WORKFLOW_DRAFT_LOAD_CHANNEL,
  WORKFLOW_DRAFT_LOCK_FIELD_CHANNEL,
  WORKFLOW_DRAFT_UPDATE_USER_FIELD_CHANNEL,
  deriveAgentRuntimeCapabilities,
  orchestratorCompositionActionSchema,
  workflowDraftAnswerQuestionRequestSchema,
  workflowDraftApplyActionRequestSchema,
  workflowDraftApproveRequestSchema,
  workflowDraftCommandResultSchema,
  workflowDraftLoadRequestSchema,
  workflowDraftLoadResponseSchema,
  workflowDraftLockFieldRequestSchema,
  workflowDraftUpdateUserFieldRequestSchema
} from "@forgedeck/schemas";
import type {
  AgentRuntimeCapability,
  RuntimeAdapterStatus,
  WorkflowActivationResult,
  WorkflowDraft,
  WorkflowDraftCommandResult
} from "@forgedeck/schemas";

export interface WorkflowDraftIpcDependencies {
  /** Real runtime discovery; the composer resolves roles only against what this returns. */
  readonly inspectAdapters: () => Promise<readonly RuntimeAdapterStatus[]>;
  readonly newId?: () => string;
  readonly now?: () => Date;
  /** Milliseconds a capability snapshot is reused before re-inspecting adapters. */
  readonly capabilityTtlMs?: number;
  /**
   * Called when a draft is approved. It materializes the draft into exactly one official run and
   * returns the activation result (runId/status/issues), or null when materialization is unavailable.
   * Nothing runs before approval.
   */
  readonly onApproved?: (
    draft: WorkflowDraft
  ) => Promise<WorkflowActivationResult | null> | WorkflowActivationResult | null;
  /**
   * The live agent catalog. Read on demand so availability is always an observation of now, never a
   * value cached into a document. Absent when the neutral agent model is not composed.
   */
  readonly agents?: () => Promise<AgentAssignmentCatalog> | AgentAssignmentCatalog;
}

/**
 * Main-process IPC surface for the Automatic Workflow Composer. Every channel is a specific command:
 * the renderer never saves a draft object. Each handler validates the request, applies the
 * deterministic domain reducer, persists the result with idempotent events, and returns a structured
 * result. No handler ever starts a process or touches project files — composition only shapes a draft.
 */
export function registerWorkflowDraftIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  store: SqliteWorkflowDraftStore,
  deps: WorkflowDraftIpcDependencies
): void {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const ttl = deps.capabilityTtlMs ?? 30_000;

  let cache: { readonly value: AgentRuntimeCapability[]; readonly at: number } | null = null;
  const loadCapabilities = async (): Promise<AgentRuntimeCapability[]> => {
    const at = now().getTime();
    if (cache !== null && at - cache.at < ttl) {
      return cache.value;
    }
    const adapters = await deps.inspectAdapters();
    const value = deriveAgentRuntimeCapabilities(adapters, now().toISOString());
    cache = { value, at };
    return value;
  };

  handle(ipc, WORKFLOW_DRAFT_LOAD_CHANNEL, (payload) => {
    const request = workflowDraftLoadRequestSchema.parse(payload);
    const draft =
      request.draftId === undefined
        ? store.getLatestForWorkspace(request.workspaceId)
        : store.getById(request.draftId);
    return workflowDraftLoadResponseSchema.parse({ draft });
  });

  handle(ipc, WORKFLOW_DRAFT_APPLY_ACTION_CHANNEL, async (payload) => {
    const request = workflowDraftApplyActionRequestSchema.parse(payload);
    const current =
      request.draftId === undefined
        ? store.getLatestForTerminal(request.workspaceId, request.sourceTerminalId)
        : store.getById(request.draftId);

    const parsedAction = orchestratorCompositionActionSchema.safeParse(request.action);
    if (!parsedAction.success) {
      return persistRejection(store, current, "The orchestrator emitted a malformed action.");
    }

    const capabilities = await loadCapabilities();
    const result = applyDraftCommand(
      current,
      { kind: "composition", action: parsedAction.data },
      {
        now: now().toISOString(),
        newId,
        capabilities,
        identity: {
          workspaceId: request.workspaceId,
          sourceTerminalId: request.sourceTerminalId,
          creationMode: request.creationMode,
          executionProfile: request.executionProfile,
          draftId: current?.id ?? newId()
        }
      }
    );
    return persistResult(store, current, result);
  });

  handle(ipc, WORKFLOW_DRAFT_ANSWER_QUESTION_CHANNEL, async (payload) => {
    const request = workflowDraftAnswerQuestionRequestSchema.parse(payload);
    return runUserCommand(store, loadCapabilities, newId, now, request.draftId, {
      kind: "answer_question",
      questionId: request.questionId,
      answer: request.answer
    });
  });

  handle(ipc, WORKFLOW_DRAFT_UPDATE_USER_FIELD_CHANNEL, async (payload) => {
    const request = workflowDraftUpdateUserFieldRequestSchema.parse(payload);
    return runUserCommand(store, loadCapabilities, newId, now, request.draftId, {
      kind: "update_user_field",
      nodeId: request.nodeId,
      patch: request.patch
    });
  });

  handle(ipc, WORKFLOW_DRAFT_LOCK_FIELD_CHANNEL, async (payload) => {
    const request = workflowDraftLockFieldRequestSchema.parse(payload);
    return runUserCommand(store, loadCapabilities, newId, now, request.draftId, {
      kind: "lock_field",
      nodeId: request.nodeId,
      ...(request.field === undefined ? {} : { field: request.field }),
      locked: request.locked
    });
  });

  handle(ipc, WORKFLOW_AGENTS_LIST_CHANNEL, async () => {
    const catalog = (await deps.agents?.()) ?? { descriptors: [] };
    return workflowAgentsListResponseSchema.parse({ agents: catalog.descriptors });
  });

  /**
   * Records who runs each node. The preset is evaluated HERE, in the main process, against the live
   * catalog — the renderer never decides availability. Explicit per-node choices always win over the
   * preset, which is what lets the user override any single node after applying one.
   */
  handle(ipc, WORKFLOW_DRAFT_ASSIGN_AGENTS_CHANNEL, async (payload) => {
    const request = workflowDraftAssignAgentsRequestSchema.parse(payload);
    const draft = store.getById(request.draftId);
    if (draft === null) {
      return commandResult(
        { status: "rejected", draft: null, rejectionReason: null },
        null,
        "Draft not found."
      );
    }
    const catalog = (await deps.agents?.()) ?? { descriptors: [] };
    const suggested = new Map(
      suggestAgentAssignments({ nodes: draft.nodes, preset: request.preset, catalog }).map(
        (entry) => [entry.nodeId, entry]
      )
    );
    const overrides = new Map(
      request.assignments.map((entry) => [entry.nodeId, entry.assignedAdapter])
    );
    const assignments = draft.nodes.map((node) => {
      if (overrides.has(node.id)) {
        return {
          nodeId: node.id,
          assignedAdapter: overrides.get(node.id) ?? null,
          reason: "Chosen explicitly for this node."
        };
      }
      const suggestion = suggested.get(node.id);
      return {
        nodeId: node.id,
        assignedAdapter: suggestion?.assignedAdapter ?? null,
        reason: suggestion?.reason ?? ""
      };
    });
    return runUserCommand(store, loadCapabilities, newId, now, request.draftId, {
      kind: "assign_agents",
      preset: request.preset,
      assignments
    });
  });

  handle(ipc, WORKFLOW_DRAFT_APPROVE_CHANNEL, async (payload) => {
    const request = workflowDraftApproveRequestSchema.parse(payload);
    const result = await runUserCommand(store, loadCapabilities, newId, now, request.draftId, {
      kind: "approve"
    });
    // Approval is the single gate that materializes one official run (spec §5.6). Composition never did.
    if (result.status === "applied" && result.draft?.state === "approved") {
      const activation = (await deps.onApproved?.(result.draft)) ?? null;
      return workflowDraftCommandResultSchema.parse({ ...result, activation });
    }
    return result;
  });
}

async function runUserCommand(
  store: SqliteWorkflowDraftStore,
  loadCapabilities: () => Promise<AgentRuntimeCapability[]>,
  newId: () => string,
  now: () => Date,
  draftId: string,
  command: DraftCommand
): Promise<WorkflowDraftCommandResult> {
  const current = store.getById(draftId);
  if (current === null) {
    return commandResult(
      { status: "rejected", draft: null, rejectionReason: null },
      null,
      "Draft not found."
    );
  }
  const capabilities = await loadCapabilities();
  const result = applyDraftCommand(current, command, {
    now: now().toISOString(),
    newId,
    capabilities,
    identity: {
      workspaceId: current.workspaceId,
      sourceTerminalId: current.sourceTerminalId,
      creationMode: current.creationMode,
      executionProfile: current.executionProfile,
      draftId: current.id
    }
  });
  return persistResult(store, current, result);
}

function persistResult(
  store: SqliteWorkflowDraftStore,
  current: WorkflowDraft | null,
  result: DraftReducerResult
): WorkflowDraftCommandResult {
  if (result.status === "ignored" || result.draft === null) {
    return commandResult(result, null, result.message);
  }
  const persisted = store.persist(result.draft, result.events as WorkflowDraftEventInput[]);
  return commandResult({ ...result, draft: persisted.draft }, persisted.lastEvent, result.message);
}

function persistRejection(
  store: SqliteWorkflowDraftStore,
  current: WorkflowDraft | null,
  message: string
): WorkflowDraftCommandResult {
  const event: WorkflowDraftEventInput = {
    type: "workflow.action.rejected",
    actor: "system",
    summary: message,
    rejectionReason: "schema_invalid"
  };
  if (current === null) {
    return workflowDraftCommandResultSchema.parse({
      status: "rejected",
      draft: null,
      event: null,
      rejectionReason: "schema_invalid",
      message
    });
  }
  const persisted = store.persist(current, [event]);
  return workflowDraftCommandResultSchema.parse({
    status: "rejected",
    draft: persisted.draft,
    event: persisted.lastEvent,
    rejectionReason: "schema_invalid",
    message
  });
}

function commandResult(
  result: Pick<DraftReducerResult, "status" | "draft" | "rejectionReason">,
  event: WorkflowDraftCommandResult["event"],
  message: string
): WorkflowDraftCommandResult {
  return workflowDraftCommandResultSchema.parse({
    status: result.status,
    draft: result.draft,
    event,
    rejectionReason: result.rejectionReason,
    message
  });
}

function handle(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => unknown
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}
