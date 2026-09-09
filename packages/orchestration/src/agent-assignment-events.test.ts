import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { workflowDraftEventTypeSchema, workflowDraftSchema } from "@forgedeck/schemas";
import type { WorkflowDraft } from "@forgedeck/schemas";

import { applyDraftCommand } from "./workflow-draft-composer";

/**
 * Choosing who runs a node is a decision about the DOCUMENT, taken before any run exists. It is
 * audited on the draft's own append-only log, and deliberately not on the run event history — a run
 * event records what an execution actually did, and configuring a draft is not an execution.
 */

const context = {
  now: "2026-07-25T12:00:00.000Z",
  newId: () => "11111111-1111-4111-8111-111111111111",
  capabilities: [],
  identity: {
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic" as const,
    executionProfile: "balanced" as const,
    draftId: "99999999-9999-4999-8999-999999999999"
  }
};

function draft(nodes: readonly Record<string, unknown>[]): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "99999999-9999-4999-8999-999999999999",
    version: 1,
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Draft",
    objective: "Build it",
    state: "ready",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    nodes,
    edges: []
  });
}

const backend = { id: "backend", title: "Backend", role: "implementer" } as const;

describe("agent assignment events", () => {
  it("records the first choice as an assignment", () => {
    const result = applyDraftCommand(
      draft([backend]),
      {
        kind: "assign_agents",
        preset: "manual",
        assignments: [{ nodeId: "backend", assignedAdapter: "claude-code", reason: "chosen" }]
      },
      context
    );
    expect(result.status).toBe("applied");
    expect(result.events.map((entry) => entry.type)).toContain("workflow.node.adapter_assigned");
    expect(result.draft?.nodes[0]?.agentAssignment?.assignedAdapter).toBe("claude-code");
  });

  it("records a later change as a change, naming both agents", () => {
    const assigned = draft([{ ...backend, agentAssignment: { assignedAdapter: "claude-code" } }]);
    const result = applyDraftCommand(
      assigned,
      {
        kind: "assign_agents",
        preset: "manual",
        assignments: [{ nodeId: "backend", assignedAdapter: "codex", reason: "chosen" }]
      },
      context
    );
    const change = result.events.find((entry) => entry.type === "workflow.node.adapter_changed");
    expect(change?.summary).toContain("claude-code");
    expect(change?.summary).toContain("codex");
  });

  it("records clearing an agent as needing a decision again", () => {
    const assigned = draft([{ ...backend, agentAssignment: { assignedAdapter: "claude-code" } }]);
    const result = applyDraftCommand(
      assigned,
      {
        kind: "assign_agents",
        preset: "manual",
        assignments: [{ nodeId: "backend", assignedAdapter: null, reason: "cleared" }]
      },
      context
    );
    expect(result.events.map((entry) => entry.type)).toContain(
      "workflow.node.adapter_assignment_required"
    );
    expect(result.draft?.nodes[0]?.agentAssignment?.assignedAdapter).toBeNull();
  });

  it("emits nothing when the choice did not change", () => {
    const assigned = draft([{ ...backend, agentAssignment: { assignedAdapter: "claude-code" } }]);
    const result = applyDraftCommand(
      assigned,
      {
        kind: "assign_agents",
        preset: "automatic",
        assignments: [{ nodeId: "backend", assignedAdapter: "claude-code", reason: "same" }]
      },
      context
    );
    expect(result.events).toEqual([]);
    // The preset is still recorded, because how the choice was made is itself part of the document.
    expect(result.draft?.agentAssignmentPreset).toBe("automatic");
  });

  it("leaves nodes the command does not mention untouched", () => {
    const result = applyDraftCommand(
      draft([backend, { id: "tests", title: "Tests", role: "qa" }]),
      {
        kind: "assign_agents",
        preset: "manual",
        assignments: [{ nodeId: "backend", assignedAdapter: "claude-code", reason: "chosen" }]
      },
      context
    );
    expect(result.draft?.nodes[1]?.agentAssignment).toBeUndefined();
  });

  it("rejects an assignment for a node that does not exist", () => {
    const result = applyDraftCommand(
      draft([backend]),
      {
        kind: "assign_agents",
        preset: "manual",
        assignments: [{ nodeId: "ghost", assignedAdapter: "claude-code", reason: "chosen" }]
      },
      context
    );
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("unknown_node");
  });

  it("refuses to change the selection once the workflow is running", () => {
    // A canvas edit must never reach an existing run. Changing the agent of a running workflow is a
    // later milestone with its own official attempt and audit.
    const running = workflowDraftSchema.parse({ ...draft([backend]), state: "running" });
    const result = applyDraftCommand(
      running,
      {
        kind: "assign_agents",
        preset: "manual",
        assignments: [{ nodeId: "backend", assignedAdapter: "claude-code", reason: "chosen" }]
      },
      context
    );
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("invalid_state");
  });
});

describe("event boundary", () => {
  const configuration = [
    "workflow.orchestrator.selected",
    "workflow.node.adapter_assigned",
    "workflow.node.adapter_changed",
    "workflow.node.adapter_assignment_required"
  ];

  it("keeps every agent-configuration event on the draft log", () => {
    expect(workflowDraftEventTypeSchema.options).toEqual(expect.arrayContaining(configuration));
  });

  it("never widens the run event contract to carry a configuration event", () => {
    // The run event schema is the durable contract for what an execution did. A decision taken on a
    // draft, before any run exists, must never appear there.
    const schema = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../specs/schemas/run-event.schema.json"),
        "utf8"
      )
    ) as { readonly properties: { readonly type: { readonly enum: readonly string[] } } };
    const runEventTypes = schema.properties.type.enum;
    for (const type of configuration) {
      expect(runEventTypes).not.toContain(type);
    }
    // Nor may any run event be named after adapter assignment or fallback.
    expect(runEventTypes.filter((type) => type.includes("adapter"))).toEqual([]);
  });
});
