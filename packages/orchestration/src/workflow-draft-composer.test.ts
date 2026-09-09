import { describe, expect, it } from "vitest";

import type {
  AgentRuntimeCapability,
  OrchestratorCompositionAction,
  WorkflowDraft
} from "@forgedeck/schemas";

import { applyDraftCommand } from "./workflow-draft-composer";
import type { DraftCommand, DraftReducerContext } from "./workflow-draft-composer";

function capability(overrides: Partial<AgentRuntimeCapability> = {}): AgentRuntimeCapability {
  return {
    runtimeId: "claude-code-1",
    provider: "claude-code",
    displayName: "Claude Code",
    installed: true,
    authenticated: true,
    enabled: true,
    supportsParallelSessions: true,
    maxConcurrentSessions: 4,
    activeSessions: 0,
    availableModels: [],
    capabilities: ["code", "review"],
    lastCheckedAt: "2026-07-22T00:00:00.000Z",
    ...overrides
  };
}

let counter = 0;
function context(capabilities: readonly AgentRuntimeCapability[]): DraftReducerContext {
  counter = 0;
  return {
    now: "2026-07-22T00:00:00.000Z",
    newId: () => `id-${(counter += 1)}`,
    capabilities,
    identity: {
      workspaceId: "ws-1",
      sourceTerminalId: "term-1",
      creationMode: "automatic",
      executionProfile: "balanced",
      draftId: "11111111-1111-4111-8111-111111111111"
    }
  };
}

function composition(action: OrchestratorCompositionAction): DraftCommand {
  return { kind: "composition", action };
}

function startedDraft(capabilities: readonly AgentRuntimeCapability[] = [capability()]): {
  draft: WorkflowDraft;
  ctx: DraftReducerContext;
} {
  const ctx = context(capabilities);
  const result = applyDraftCommand(
    null,
    composition({ type: "start_workflow_draft", objective: "Build a tested page" }),
    ctx
  );
  expect(result.status).toBe("applied");
  return { draft: result.draft as WorkflowDraft, ctx };
}

describe("applyDraftCommand — composition", () => {
  it("starts a draft and associates root materials", () => {
    const { draft } = startedDraft();
    expect(draft.state).toBe("composing");
    expect(draft.objective).toBe("Build a tested page");
    expect(draft.rootContext.prompt).toBe("Build a tested page");
  });

  it("auto-starts a draft when the orchestrator skips start_workflow_draft", () => {
    const ctx = context([capability()]);
    const result = applyDraftCommand(
      null,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    );
    expect(result.status).toBe("applied");
    expect(result.draft?.nodes[0]?.id).toBe("impl");
    expect(result.events.some((entry) => entry.type === "workflow.draft.started")).toBe(true);
    expect(result.events.some((entry) => entry.type === "workflow.node.draft_created")).toBe(true);
  });

  it("adds a ghost node and resolves a compatible runtime", () => {
    const { draft, ctx } = startedDraft();
    const result = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    );
    expect(result.status).toBe("applied");
    const node = result.draft?.nodes[0];
    expect(node?.lifecycle).toBe("draft");
    expect(node?.runtimeRequirement.resolvedRuntimeId).toBe("claude-code-1");
  });

  it("leaves the runtime unresolved when nothing usable exists", () => {
    const { draft, ctx } = startedDraft([capability({ authenticated: false })]);
    const result = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    );
    expect(result.draft?.nodes[0]?.runtimeRequirement.resolvedRuntimeId).toBeNull();
  });

  it("rejects a duplicate node ref", () => {
    const { draft, ctx } = startedDraft();
    const once = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    );
    const twice = applyDraftCommand(
      once.draft as WorkflowDraft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl 2", role: "reviewer" }),
      ctx
    );
    expect(twice.status).toBe("rejected");
    expect(twice.rejectionReason).toBe("duplicate_node");
  });

  it("rejects connecting a node to itself and to an unknown node", () => {
    const { draft, ctx } = startedDraft();
    const withNode = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "a", title: "A", role: "planner" }),
      ctx
    ).draft as WorkflowDraft;
    const selfLoop = applyDraftCommand(
      withNode,
      composition({ type: "connect_draft_nodes", from: "a", to: "a", edgeType: "handoff" }),
      ctx
    );
    const unknown = applyDraftCommand(
      withNode,
      composition({ type: "connect_draft_nodes", from: "a", to: "ghost", edgeType: "handoff" }),
      ctx
    );
    expect(selfLoop.rejectionReason).toBe("invalid_edge");
    expect(unknown.rejectionReason).toBe("unknown_node");
  });

  it("finalizes to ready when every node has a runtime", () => {
    const { draft, ctx } = startedDraft();
    const withNode = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    ).draft as WorkflowDraft;
    const finalized = applyDraftCommand(
      withNode,
      composition({ type: "finalize_workflow_draft" }),
      ctx
    );
    expect(finalized.status).toBe("applied");
    expect(finalized.draft?.state).toBe("ready");
  });

  it("blocks finalize when a node has no compatible runtime", () => {
    const { draft, ctx } = startedDraft([]);
    const withNode = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    ).draft as WorkflowDraft;
    const finalized = applyDraftCommand(
      withNode,
      composition({ type: "finalize_workflow_draft" }),
      ctx
    );
    expect(finalized.status).toBe("rejected");
    expect(finalized.rejectionReason).toBe("runtime_unavailable");
    expect(finalized.draft?.blockers.length).toBeGreaterThan(0);
  });
});

describe("applyDraftCommand — locks and user edits", () => {
  it("rejects an orchestrator update to a user-locked field", () => {
    const { draft, ctx } = startedDraft();
    const withNode = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    ).draft as WorkflowDraft;
    const edited = applyDraftCommand(
      withNode,
      { kind: "update_user_field", nodeId: "impl", patch: { title: "My title" } },
      ctx
    ).draft as WorkflowDraft;
    expect(edited.nodes[0]?.lock?.lockedFields).toContain("title");

    const overwrite = applyDraftCommand(
      edited,
      composition({ type: "update_draft_node", ref: "impl", title: "Robot title" }),
      ctx
    );
    expect(overwrite.status).toBe("rejected");
    expect(overwrite.rejectionReason).toBe("locked_field");
    expect(overwrite.draft?.nodes[0]?.title).toBe("My title");
  });

  it("lets the orchestrator update a different, unlocked field", () => {
    const { draft, ctx } = startedDraft();
    const withNode = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    ).draft as WorkflowDraft;
    const edited = applyDraftCommand(
      withNode,
      { kind: "update_user_field", nodeId: "impl", patch: { title: "My title" } },
      ctx
    ).draft as WorkflowDraft;
    const objective = applyDraftCommand(
      edited,
      composition({ type: "update_draft_node", ref: "impl", objective: "Ship it" }),
      ctx
    );
    expect(objective.status).toBe("applied");
    expect(objective.draft?.nodes[0]?.objective).toBe("Ship it");
    expect(objective.draft?.nodes[0]?.title).toBe("My title");
  });

  it("rejects updating an unknown node", () => {
    const { draft, ctx } = startedDraft();
    const result = applyDraftCommand(
      draft,
      { kind: "update_user_field", nodeId: "ghost", patch: { title: "x" } },
      ctx
    );
    expect(result.rejectionReason).toBe("unknown_node");
  });
});

describe("applyDraftCommand — questions and approval", () => {
  it("moves to needs_input on request and back to composing on answer", () => {
    const { draft, ctx } = startedDraft();
    const asked = applyDraftCommand(
      draft,
      composition({ type: "request_user_input", prompt: "Which audience?" }),
      ctx
    );
    expect(asked.status).toBe("needs_input");
    expect(asked.draft?.state).toBe("needs_input");
    const questionId = asked.draft?.questions[0]?.id as string;
    const answered = applyDraftCommand(
      asked.draft as WorkflowDraft,
      { kind: "answer_question", questionId, answer: "Developers" },
      ctx
    );
    expect(answered.status).toBe("applied");
    expect(answered.draft?.state).toBe("composing");
    expect(answered.draft?.questions[0]?.answer).toBe("Developers");
  });

  it("only approves a ready draft and never starts a process", () => {
    const { draft, ctx } = startedDraft();
    const tooEarly = applyDraftCommand(draft, { kind: "approve" }, ctx);
    expect(tooEarly.rejectionReason).toBe("invalid_state");

    const withNode = applyDraftCommand(
      draft,
      composition({ type: "add_draft_node", ref: "impl", title: "Impl", role: "implementer" }),
      ctx
    ).draft as WorkflowDraft;
    const ready = applyDraftCommand(withNode, composition({ type: "finalize_workflow_draft" }), ctx)
      .draft as WorkflowDraft;
    const approved = applyDraftCommand(ready, { kind: "approve" }, ctx);
    expect(approved.status).toBe("applied");
    expect(approved.draft?.state).toBe("approved");
    expect(approved.events.some((entry) => entry.type === "workflow.approved")).toBe(true);
  });
});
