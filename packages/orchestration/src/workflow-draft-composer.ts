import {
  AGENT_ASSIGNMENT_DEFAULT,
  isRuntimeUsable,
  workflowDraftSchema,
  workflowEdgeDraftSchema,
  workflowNodeDraftSchema,
  workflowRuntimeRequirementSchema
} from "@forgedeck/schemas";
import type {
  AgentAdapterId,
  AgentAssignmentPreset,
  AgentRuntimeCapability,
  CreationMode,
  ExecutionProfile,
  OrchestratorCompositionAction,
  WorkflowAssumption,
  WorkflowDraft,
  WorkflowDraftEventType,
  WorkflowDraftRejectionReason,
  WorkflowDraftState,
  WorkflowEdgeDraft,
  WorkflowNodeDraft,
  WorkflowNodeDraftPatch,
  WorkflowNodeField,
  WorkflowNodeLock,
  WorkflowQuestion
} from "@forgedeck/schemas";

/**
 * Deterministic domain reducer for the Automatic Workflow Composer. This is the single source of
 * truth for how a {@link WorkflowDraft} changes. It is pure: given the current draft, a command and
 * a context (clock, id factory, real runtime capabilities), it returns the next draft plus the
 * events to persist. It performs no I/O and starts no process — composition can only shape a draft.
 *
 * Rejections are never silent: an illegal command returns `status: "rejected"` with a machine reason
 * and a `workflow.action.rejected` event so the terminal and UI can explain why nothing changed.
 */

/** A runtime requirement as it lives on a node (all fields resolved to concrete defaults). */
type NodeRuntimeRequirement = WorkflowNodeDraft["runtimeRequirement"];

export type DraftCommand =
  | { readonly kind: "composition"; readonly action: OrchestratorCompositionAction }
  | { readonly kind: "answer_question"; readonly questionId: string; readonly answer: string }
  | {
      readonly kind: "update_user_field";
      readonly nodeId: string;
      readonly patch: WorkflowNodeDraftPatch;
    }
  | {
      readonly kind: "lock_field";
      readonly nodeId: string;
      readonly field?: WorkflowNodeField;
      readonly locked: boolean;
    }
  | {
      /**
       * Records who runs each node. The assignments are decided OUTSIDE the reducer (by the user, or
       * by a preset evaluated against the live agent catalog) so this stays pure and invents no
       * availability — it only persists the decision and audits it.
       */
      readonly kind: "assign_agents";
      readonly preset: AgentAssignmentPreset;
      readonly assignments: readonly {
        readonly nodeId: string;
        readonly assignedAdapter: AgentAdapterId | null;
        readonly reason: string;
      }[];
    }
  | { readonly kind: "approve" };

export interface DraftReducerContext {
  /** ISO timestamp used for created/updated fields and event times. */
  readonly now: string;
  /** Opaque id factory (uuid) for new drafts, assumptions and questions. */
  readonly newId: () => string;
  /** Real runtime availability; the composer never invents a runtime. */
  readonly capabilities: readonly AgentRuntimeCapability[];
  /** Identity for minting a brand-new draft from `start_workflow_draft`. */
  readonly identity: {
    readonly workspaceId: string;
    readonly sourceTerminalId: string;
    readonly creationMode: CreationMode;
    readonly executionProfile: ExecutionProfile;
    readonly draftId: string;
  };
}

/** An event the store will finalize with an id, a per-draft sequence and a timestamp. */
export interface WorkflowDraftEventInput {
  readonly type: WorkflowDraftEventType;
  readonly actor: "orchestrator" | "local-user" | "system";
  readonly summary: string;
  readonly rejectionReason: WorkflowDraftRejectionReason | null;
}

export type DraftReducerStatus = "applied" | "rejected" | "needs_input" | "ignored";

export interface DraftReducerResult {
  readonly status: DraftReducerStatus;
  /** Authoritative draft after the command (unchanged for rejected/ignored). */
  readonly draft: WorkflowDraft | null;
  readonly events: readonly WorkflowDraftEventInput[];
  readonly rejectionReason: WorkflowDraftRejectionReason | null;
  readonly message: string;
}

const MUTABLE_STATES: readonly WorkflowDraftState[] = ["composing", "needs_input", "ready"];

export function applyDraftCommand(
  draft: WorkflowDraft | null,
  command: DraftCommand,
  context: DraftReducerContext
): DraftReducerResult {
  if (command.kind === "composition") {
    return applyComposition(draft, command.action, context);
  }
  if (draft === null) {
    return reject(null, "invalid_state", "No draft exists yet.");
  }
  switch (command.kind) {
    case "answer_question":
      return answerQuestion(draft, command.questionId, command.answer, context);
    case "update_user_field":
      return updateUserField(draft, command.nodeId, command.patch, context);
    case "lock_field":
      return lockField(draft, command.nodeId, command.field, command.locked, context);
    case "assign_agents":
      return assignAgents(draft, command.preset, command.assignments, context);
    case "approve":
      return approve(draft, context);
  }
}

// --- composition actions -------------------------------------------------------------------------

function applyComposition(
  draft: WorkflowDraft | null,
  action: OrchestratorCompositionAction,
  context: DraftReducerContext
): DraftReducerResult {
  switch (action.type) {
    case "inspect_workspace_context":
    case "inspect_available_runtimes":
    case "inspect_attached_materials":
      // Read-only signals; the orchestrator receives the data through its prompt, not by mutating.
      return { status: "ignored", draft, events: [], rejectionReason: null, message: "" };
    case "start_workflow_draft":
      return startDraft(draft, action.objective, action.title, context);
  }

  if (draft === null) {
    // Be forgiving: an orchestrator that jumps straight to composing (skipping start_workflow_draft)
    // still gets a draft implicitly, so the first node is not lost. The objective stays empty until a
    // later start_workflow_draft fills it.
    const started = startDraft(null, "", undefined, context);
    if (started.draft === null) {
      return started;
    }
    const applied = applyComposition(started.draft, action, context);
    return { ...applied, events: [...started.events, ...applied.events] };
  }
  if (!MUTABLE_STATES.includes(draft.state)) {
    return reject(draft, "invalid_state", `Draft is ${draft.state} and cannot be edited.`);
  }

  switch (action.type) {
    case "add_draft_node":
      return addNode(draft, action, context);
    case "update_draft_node":
      return updateNodeByOrchestrator(draft, action, context);
    case "remove_draft_node":
      return removeNode(draft, action.ref, context);
    case "connect_draft_nodes":
      return connectNodes(draft, action, context);
    case "disconnect_draft_nodes":
      return disconnectNodes(draft, action.from, action.to, context);
    case "request_user_input":
      return requestUserInput(draft, action, context);
    case "add_workflow_assumption":
      return addAssumption(draft, action.statement, context);
    case "finalize_workflow_draft":
      return finalize(draft, context);
  }
}

function startDraft(
  draft: WorkflowDraft | null,
  objective: string,
  title: string | undefined,
  context: DraftReducerContext
): DraftReducerResult {
  if (draft !== null && !MUTABLE_STATES.includes(draft.state)) {
    return reject(draft, "invalid_state", `Draft is ${draft.state} and cannot be restarted.`);
  }
  const resolvedTitle = title?.trim() ?? "";
  if (draft === null) {
    const created: WorkflowDraft = parseDraft({
      id: context.identity.draftId,
      version: 1,
      workspaceId: context.identity.workspaceId,
      sourceTerminalId: context.identity.sourceTerminalId,
      creationMode: context.identity.creationMode,
      executionProfile: context.identity.executionProfile,
      title: resolvedTitle,
      objective,
      rootContext: { prompt: objective },
      state: "composing",
      createdAt: context.now,
      updatedAt: context.now
    });
    return {
      status: "applied",
      draft: created,
      events: [
        event("workflow.draft.started", "orchestrator", "Draft started."),
        event("workflow.context.indexed", "system", "Root materials associated with the draft.")
      ],
      rejectionReason: null,
      message: ""
    };
  }
  const next = bump(draft, context, {
    title: resolvedTitle.length > 0 ? resolvedTitle : draft.title,
    objective,
    rootContext: { ...draft.rootContext, prompt: objective },
    state: "composing"
  });
  return applied(next, event("workflow.draft.started", "orchestrator", "Draft objective updated."));
}

function addNode(
  draft: WorkflowDraft,
  action: Extract<OrchestratorCompositionAction, { type: "add_draft_node" }>,
  context: DraftReducerContext
): DraftReducerResult {
  if (draft.nodes.some((node) => node.id === action.ref)) {
    return reject(draft, "duplicate_node", `A node named "${action.ref}" already exists.`);
  }
  const requirement = resolveRuntime(
    normalizeRequirement(action.runtimeRequirement),
    context.capabilities
  );
  const node = parseNode({
    id: action.ref,
    title: action.title,
    role: action.role,
    objective: action.objective ?? "",
    responsibilities: action.responsibilities ?? [],
    constraints: action.constraints ?? [],
    inputs: action.inputs ?? [],
    expectedOutputs: action.expectedOutputs ?? [],
    acceptanceCriteria: action.acceptanceCriteria ?? [],
    runtimeRequirement: requirement,
    execution: action.execution,
    contextPolicy: action.contextPolicy,
    lifecycle: "draft",
    generatedByOrchestrator: true
  });
  const next = bump(draft, context, { nodes: [...draft.nodes, node], state: "composing" });
  return applied(
    next,
    event("workflow.node.draft_created", "orchestrator", `Node "${node.title}" created.`)
  );
}

function updateNodeByOrchestrator(
  draft: WorkflowDraft,
  action: Extract<OrchestratorCompositionAction, { type: "update_draft_node" }>,
  context: DraftReducerContext
): DraftReducerResult {
  const node = draft.nodes.find((entry) => entry.id === action.ref);
  if (node === undefined) {
    return reject(draft, "unknown_node", `Unknown node "${action.ref}".`);
  }
  const patch = patchFromUpdateAction(action);
  const locked = firstLockedField(node.lock, patch);
  if (locked !== null) {
    return reject(
      draft,
      "locked_field",
      `Field "${locked}" is locked by the user and cannot be overwritten.`
    );
  }
  const updated = applyPatch(node, patch, context.capabilities);
  const next = bump(draft, context, {
    nodes: replaceNode(draft.nodes, updated),
    state: "composing"
  });
  return applied(
    next,
    event("workflow.node.draft_updated", "orchestrator", `Node "${updated.title}" updated.`)
  );
}

function removeNode(
  draft: WorkflowDraft,
  ref: string,
  context: DraftReducerContext
): DraftReducerResult {
  if (!draft.nodes.some((node) => node.id === ref)) {
    return reject(draft, "unknown_node", `Unknown node "${ref}".`);
  }
  const next = bump(draft, context, {
    nodes: draft.nodes.filter((node) => node.id !== ref),
    edges: draft.edges.filter((edge) => edge.sourceNodeId !== ref && edge.targetNodeId !== ref),
    approvalGates: draft.approvalGates.filter((gate) => gate.nodeId !== ref),
    state: "composing"
  });
  return applied(
    next,
    event("workflow.node.draft_removed", "orchestrator", `Node "${ref}" removed.`)
  );
}

function connectNodes(
  draft: WorkflowDraft,
  action: Extract<OrchestratorCompositionAction, { type: "connect_draft_nodes" }>,
  context: DraftReducerContext
): DraftReducerResult {
  if (action.from === action.to) {
    return reject(draft, "invalid_edge", "A node cannot be connected to itself.");
  }
  const hasFrom = draft.nodes.some((node) => node.id === action.from);
  const hasTo = draft.nodes.some((node) => node.id === action.to);
  if (!hasFrom || !hasTo) {
    return reject(draft, "unknown_node", "Both endpoints must be existing nodes.");
  }
  const edge: WorkflowEdgeDraft = parseEdge({
    id: edgeId(action.from, action.to),
    sourceNodeId: action.from,
    targetNodeId: action.to,
    type: action.edgeType,
    contract: {
      requiredArtifacts: action.requiredArtifacts ?? [],
      requiredEvidence: action.requiredEvidence ?? [],
      completionCondition: action.completionCondition ?? ""
    }
  });
  const others = draft.edges.filter((entry) => entry.id !== edge.id);
  const next = bump(draft, context, { edges: [...others, edge], state: "composing" });
  return applied(
    next,
    event("workflow.edge.draft_created", "orchestrator", `Connected ${action.from} → ${action.to}.`)
  );
}

function disconnectNodes(
  draft: WorkflowDraft,
  from: string,
  to: string,
  context: DraftReducerContext
): DraftReducerResult {
  const remaining = draft.edges.filter(
    (edge) => !(edge.sourceNodeId === from && edge.targetNodeId === to)
  );
  if (remaining.length === draft.edges.length) {
    return {
      status: "ignored",
      draft,
      events: [],
      rejectionReason: null,
      message: "No edge to remove."
    };
  }
  const next = bump(draft, context, { edges: remaining, state: "composing" });
  return applied(
    next,
    event("workflow.edge.draft_removed", "orchestrator", `Disconnected ${from} → ${to}.`)
  );
}

function requestUserInput(
  draft: WorkflowDraft,
  action: Extract<OrchestratorCompositionAction, { type: "request_user_input" }>,
  context: DraftReducerContext
): DraftReducerResult {
  const question: WorkflowQuestion = {
    id: context.newId(),
    prompt: action.prompt,
    responseKind: action.responseKind,
    options: action.options ?? [],
    answer: null,
    answeredAt: null
  };
  const next = bump(draft, context, {
    questions: [...draft.questions, question],
    state: "needs_input"
  });
  return {
    status: "needs_input",
    draft: next,
    events: [event("workflow.question.requested", "orchestrator", action.prompt)],
    rejectionReason: null,
    message: action.prompt
  };
}

function addAssumption(
  draft: WorkflowDraft,
  statement: string,
  context: DraftReducerContext
): DraftReducerResult {
  const assumption: WorkflowAssumption = {
    id: context.newId(),
    statement,
    createdBy: "orchestrator"
  };
  const next = bump(draft, context, { assumptions: [...draft.assumptions, assumption] });
  return applied(next, event("workflow.assumption.added", "orchestrator", statement));
}

function finalize(draft: WorkflowDraft, context: DraftReducerContext): DraftReducerResult {
  const unanswered = draft.questions.filter((question) => question.answer === null);
  if (unanswered.length > 0) {
    const next = bump(draft, context, { state: "needs_input" });
    return {
      status: "needs_input",
      draft: next,
      events: [event("workflow.question.requested", "system", "Open questions block finalizing.")],
      rejectionReason: null,
      message: "There are open questions to answer first."
    };
  }
  const blockers = computeBlockers(draft);
  if (blockers.length > 0) {
    const next = bump(draft, context, { blockers, state: "composing" });
    return {
      status: "rejected",
      draft: next,
      events: [
        event(
          "workflow.action.rejected",
          "system",
          `Cannot finalize: ${blockers.join("; ")}`,
          "runtime_unavailable"
        )
      ],
      rejectionReason: "runtime_unavailable",
      message: blockers.join("; ")
    };
  }
  const next = bump(draft, context, { blockers: [], state: "ready" });
  return applied(
    next,
    event("workflow.draft.ready", "orchestrator", "Draft is ready for approval.")
  );
}

// --- user commands -------------------------------------------------------------------------------

function answerQuestion(
  draft: WorkflowDraft,
  questionId: string,
  answer: string,
  context: DraftReducerContext
): DraftReducerResult {
  const question = draft.questions.find((entry) => entry.id === questionId);
  if (question === undefined) {
    return reject(draft, "invalid_state", `Unknown question "${questionId}".`);
  }
  const questions = draft.questions.map((entry) =>
    entry.id === questionId ? { ...entry, answer, answeredAt: context.now } : entry
  );
  const stillOpen = questions.some((entry) => entry.answer === null);
  const next = bump(draft, context, {
    questions,
    state: stillOpen ? draft.state : "composing"
  });
  return applied(next, event("workflow.question.answered", "local-user", answer));
}

function updateUserField(
  draft: WorkflowDraft,
  nodeId: string,
  patch: WorkflowNodeDraftPatch,
  context: DraftReducerContext
): DraftReducerResult {
  const node = draft.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) {
    return reject(draft, "unknown_node", `Unknown node "${nodeId}".`);
  }
  // A user's manual edit both changes the field and locks it so the orchestrator will not overwrite
  // the manual change on a later action.
  const editedFields = Object.keys(patch) as WorkflowNodeField[];
  const updated = applyPatch(node, patch, context.capabilities);
  const relocked = lockFields(updated.lock, editedFields, true);
  const nextNode: WorkflowNodeDraft = { ...updated, lock: relocked };
  const next = bump(draft, context, { nodes: replaceNode(draft.nodes, nextNode) });
  return {
    status: "applied",
    draft: next,
    events: [
      event("workflow.node.draft_updated", "local-user", `You edited "${nextNode.title}".`),
      ...agentAssignmentEvents(node, nextNode),
      event("workflow.node.locked", "local-user", `Locked ${editedFields.join(", ")}.`)
    ],
    rejectionReason: null,
    message: ""
  };
}

/**
 * Applies agent choices to the draft and records the preset that produced them. A node named by an
 * assignment keeps every other field untouched, and a node the command does not mention is left
 * exactly as it was. A `null` adapter is a legitimate outcome — that is how `manual`, and a preset
 * that found no compatible available agent, leave a node explicitly awaiting a decision instead of
 * quietly handing it to whichever agent happens to be installed.
 */
function assignAgents(
  draft: WorkflowDraft,
  preset: AgentAssignmentPreset,
  assignments: readonly {
    readonly nodeId: string;
    readonly assignedAdapter: AgentAdapterId | null;
    readonly reason: string;
  }[],
  context: DraftReducerContext
): DraftReducerResult {
  if (!MUTABLE_STATES.includes(draft.state)) {
    return reject(draft, "invalid_state", `Draft is ${draft.state} and cannot be edited.`);
  }
  const unknown = assignments.find(
    (entry) => !draft.nodes.some((node) => node.id === entry.nodeId)
  );
  if (unknown !== undefined) {
    return reject(draft, "unknown_node", `Unknown node "${unknown.nodeId}".`);
  }
  const byNode = new Map(assignments.map((entry) => [entry.nodeId, entry]));
  const events: WorkflowDraftEventInput[] = [];
  const nodes = draft.nodes.map((node) => {
    const entry = byNode.get(node.id);
    if (entry === undefined) return node;
    const next = parseNode({
      ...node,
      agentAssignment: {
        ...(node.agentAssignment ?? AGENT_ASSIGNMENT_DEFAULT),
        assignedAdapter: entry.assignedAdapter,
        recommendationReason: entry.reason
      }
    });
    events.push(...agentAssignmentEvents(node, next));
    return next;
  });
  return {
    status: "applied",
    draft: bump(draft, context, { nodes, agentAssignmentPreset: preset }),
    events,
    rejectionReason: null,
    message: ""
  };
}

/**
 * Audits an agent decision on the DRAFT's own event log. Choosing who runs a node happens before any
 * run exists, so it belongs here and never to the run event history, which records what an execution
 * actually did.
 */
function agentAssignmentEvents(
  before: WorkflowNodeDraft,
  after: WorkflowNodeDraft
): readonly WorkflowDraftEventInput[] {
  const previous = before.agentAssignment?.assignedAdapter ?? null;
  const current = after.agentAssignment?.assignedAdapter ?? null;
  if (previous === current) return [];
  if (current === null) {
    return [
      event(
        "workflow.node.adapter_assignment_required",
        "local-user",
        `"${after.title}" no longer has an agent and needs one before the run.`
      )
    ];
  }
  return [
    previous === null
      ? event(
          "workflow.node.adapter_assigned",
          "local-user",
          `"${after.title}" will run on ${current}.`
        )
      : event(
          "workflow.node.adapter_changed",
          "local-user",
          `"${after.title}" changed from ${previous} to ${current}.`
        )
  ];
}

function lockField(
  draft: WorkflowDraft,
  nodeId: string,
  field: WorkflowNodeField | undefined,
  locked: boolean,
  context: DraftReducerContext
): DraftReducerResult {
  const node = draft.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) {
    return reject(draft, "unknown_node", `Unknown node "${nodeId}".`);
  }
  const nextLock =
    field === undefined
      ? locked
        ? { lockedByUser: true }
        : undefined
      : lockFields(node.lock, [field], locked);
  const nextNode: WorkflowNodeDraft = {
    ...node,
    ...(nextLock === undefined ? {} : { lock: nextLock })
  };
  if (nextLock === undefined) {
    delete (nextNode as { lock?: WorkflowNodeLock }).lock;
  }
  const next = bump(draft, context, { nodes: replaceNode(draft.nodes, nextNode) });
  const label = field === undefined ? "the whole node" : `field "${field}"`;
  return applied(
    next,
    event("workflow.node.locked", "local-user", `${locked ? "Locked" : "Unlocked"} ${label}.`)
  );
}

function approve(draft: WorkflowDraft, context: DraftReducerContext): DraftReducerResult {
  if (draft.state !== "ready") {
    return reject(draft, "invalid_state", "Only a ready draft can be approved.");
  }
  const next = bump(draft, context, { state: "approved" });
  return applied(
    next,
    event("workflow.approved", "local-user", "Workflow approved (no processes started).")
  );
}

// --- helpers -------------------------------------------------------------------------------------

function computeBlockers(draft: WorkflowDraft): string[] {
  const blockers: string[] = [];
  for (const node of draft.nodes) {
    if (node.runtimeRequirement.resolvedRuntimeId === null) {
      blockers.push(`Node "${node.title}" has no compatible runtime.`);
    }
  }
  return blockers;
}

export function resolveRuntime(
  requirement: NodeRuntimeRequirement,
  capabilities: readonly AgentRuntimeCapability[]
): NodeRuntimeRequirement {
  const usable = capabilities.filter(isRuntimeUsable);
  if (requirement.strategy === "fixed" && requirement.fixedRuntimeId !== undefined) {
    const match = usable.find((entry) => entry.runtimeId === requirement.fixedRuntimeId);
    return match === undefined
      ? {
          ...requirement,
          resolvedRuntimeId: null,
          resolutionReason: "Fixed runtime is unavailable."
        }
      : {
          ...requirement,
          resolvedRuntimeId: match.runtimeId,
          resolutionReason: `Pinned to ${match.displayName}.`
        };
  }
  const candidates = usable
    .filter((entry) =>
      requirement.requiredCapabilities.every((capability) =>
        entry.capabilities.includes(capability)
      )
    )
    // Prefer real coding agents over a plain shell/custom runtime, so a role never binds to "shell"
    // when Claude Code, Codex or another agent is available.
    .slice()
    .sort((left, right) => providerRank(right.provider) - providerRank(left.provider));
  const preferred = candidates.find((entry) =>
    requirement.preferredProviders.includes(entry.provider)
  );
  const chosen = preferred ?? candidates[0];
  if (chosen === undefined) {
    return {
      ...requirement,
      resolvedRuntimeId: null,
      resolutionReason: "No installed and authenticated runtime matches the required capabilities."
    };
  }
  return {
    ...requirement,
    resolvedRuntimeId: chosen.runtimeId,
    resolutionReason: `Auto-resolved to ${chosen.displayName}.`
  };
}

/** Ranks providers so coding agents win over a bare shell/custom runtime during auto-resolution. */
function providerRank(provider: AgentRuntimeCapability["provider"]): number {
  switch (provider) {
    case "claude-code":
      return 5;
    case "codex":
      return 4;
    case "opencode":
      return 3;
    case "gemini-cli":
      return 2;
    case "custom":
      return 0;
  }
}

function applyPatch(
  node: WorkflowNodeDraft,
  patch: WorkflowNodeDraftPatch,
  capabilities: readonly AgentRuntimeCapability[]
): WorkflowNodeDraft {
  const merged: WorkflowNodeDraft = { ...node };
  if (patch.title !== undefined) merged.title = patch.title;
  if (patch.role !== undefined) merged.role = patch.role;
  if (patch.objective !== undefined) merged.objective = patch.objective;
  if (patch.responsibilities !== undefined) merged.responsibilities = patch.responsibilities;
  if (patch.constraints !== undefined) merged.constraints = patch.constraints;
  if (patch.inputs !== undefined) merged.inputs = patch.inputs;
  if (patch.expectedOutputs !== undefined) merged.expectedOutputs = patch.expectedOutputs;
  if (patch.acceptanceCriteria !== undefined) merged.acceptanceCriteria = patch.acceptanceCriteria;
  if (patch.execution !== undefined) merged.execution = patch.execution;
  if (patch.contextPolicy !== undefined) merged.contextPolicy = patch.contextPolicy;
  if (patch.runtimeRequirement !== undefined) {
    merged.runtimeRequirement = resolveRuntime(patch.runtimeRequirement, capabilities);
  }
  // The user's agent choice is taken exactly as given. No availability is invented here: whether the
  // chosen agent can actually run is decided once, at materialization, against the live catalog.
  if (patch.agentAssignment !== undefined) merged.agentAssignment = patch.agentAssignment;
  return parseNode(merged);
}

function firstLockedField(
  lock: WorkflowNodeLock | undefined,
  patch: WorkflowNodeDraftPatch
): string | null {
  if (lock === undefined || !lock.lockedByUser) return null;
  const fields = Object.keys(patch);
  if (lock.lockedFields === undefined) {
    // Whole-node lock: any field is protected.
    return fields[0] ?? null;
  }
  return fields.find((field) => lock.lockedFields?.includes(field)) ?? null;
}

function lockFields(
  lock: WorkflowNodeLock | undefined,
  fields: readonly string[],
  locked: boolean
): WorkflowNodeLock {
  const current = new Set(lock?.lockedFields ?? []);
  for (const field of fields) {
    if (locked) current.add(field);
    else current.delete(field);
  }
  const lockedFields = [...current];
  return { lockedByUser: lockedFields.length > 0, lockedFields };
}

function normalizeRequirement(
  requirement: NodeRuntimeRequirement | undefined
): NodeRuntimeRequirement {
  return requirement ?? workflowRuntimeRequirementSchema.parse({});
}

/** Extracts the node-field patch from an `update_draft_node` action, dropping `type` and `ref`. */
function patchFromUpdateAction(
  action: Extract<OrchestratorCompositionAction, { type: "update_draft_node" }>
): WorkflowNodeDraftPatch {
  const patch: WorkflowNodeDraftPatch = {};
  if (action.title !== undefined) patch.title = action.title;
  if (action.role !== undefined) patch.role = action.role;
  if (action.objective !== undefined) patch.objective = action.objective;
  if (action.responsibilities !== undefined) patch.responsibilities = action.responsibilities;
  if (action.constraints !== undefined) patch.constraints = action.constraints;
  if (action.inputs !== undefined) patch.inputs = action.inputs;
  if (action.expectedOutputs !== undefined) patch.expectedOutputs = action.expectedOutputs;
  if (action.acceptanceCriteria !== undefined) patch.acceptanceCriteria = action.acceptanceCriteria;
  if (action.runtimeRequirement !== undefined) patch.runtimeRequirement = action.runtimeRequirement;
  if (action.execution !== undefined) patch.execution = action.execution;
  if (action.contextPolicy !== undefined) patch.contextPolicy = action.contextPolicy;
  return patch;
}

function replaceNode(
  nodes: readonly WorkflowNodeDraft[],
  updated: WorkflowNodeDraft
): WorkflowNodeDraft[] {
  return nodes.map((node) => (node.id === updated.id ? updated : node));
}

function edgeId(from: string, to: string): string {
  return `${from}__${to}`;
}

function bump(
  draft: WorkflowDraft,
  context: DraftReducerContext,
  patch: Partial<WorkflowDraft>
): WorkflowDraft {
  return parseDraft({
    ...draft,
    ...patch,
    version: draft.version + 1,
    updatedAt: context.now
  });
}

function applied(draft: WorkflowDraft, ...events: WorkflowDraftEventInput[]): DraftReducerResult {
  return { status: "applied", draft, events, rejectionReason: null, message: "" };
}

function reject(
  draft: WorkflowDraft | null,
  reason: WorkflowDraftRejectionReason,
  message: string
): DraftReducerResult {
  return {
    status: "rejected",
    draft,
    events: [event("workflow.action.rejected", "system", message, reason)],
    rejectionReason: reason,
    message
  };
}

function event(
  type: WorkflowDraftEventType,
  actor: WorkflowDraftEventInput["actor"],
  summary: string,
  rejectionReason: WorkflowDraftRejectionReason | null = null
): WorkflowDraftEventInput {
  return { type, actor, summary: summary.slice(0, 4_000), rejectionReason };
}

function parseDraft(value: unknown): WorkflowDraft {
  return workflowDraftSchema.parse(value);
}

function parseNode(value: unknown): WorkflowNodeDraft {
  return workflowNodeDraftSchema.parse(value);
}

function parseEdge(value: unknown): WorkflowEdgeDraft {
  return workflowEdgeDraftSchema.parse(value);
}
