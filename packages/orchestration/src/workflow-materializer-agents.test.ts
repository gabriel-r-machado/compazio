import { describe, expect, it } from "vitest";

import { agentDescriptorSchema, workflowDraftSchema } from "@forgedeck/schemas";
import type { AgentAdapterId, AgentDescriptor, WorkflowDraft } from "@forgedeck/schemas";

import { materializeWorkflowDraft } from "./workflow-materializer";
import type { AgentAssignmentCatalog } from "./agent-assignment";

/**
 * The materialization boundary for the neutral agent model: the draft owns the editable choice, and
 * materialization is the single point that validates it and copies it into the definition's executable
 * `adapter`. There is no reverse synchronisation — once a definition exists, its adapter is the
 * authority for that run and a later canvas edit cannot reach it.
 */

function runnable(id: AgentAdapterId): AgentDescriptor {
  return agentDescriptorSchema.parse({
    id,
    displayName: id,
    capabilities: ["planning", "backend", "testing", "ui-ux"],
    available: true,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    hasImplementation: true
  });
}

function known(id: AgentAdapterId): AgentDescriptor {
  return agentDescriptorSchema.parse({
    id,
    displayName: id,
    capabilities: ["planning", "backend", "testing", "ui-ux"],
    available: false,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    hasImplementation: false,
    unavailability: {
      code: "adapter_not_implemented",
      message: `${id} is not available in this version`,
      remediation: ""
    }
  });
}

/** Today's reality: only Claude can execute; Codex and OpenCode are known but not runnable. */
const catalog: AgentAssignmentCatalog = {
  descriptors: [runnable("claude-code"), known("codex"), known("opencode")]
};

function draft(nodes: readonly Record<string, unknown>[]): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "88888888-8888-4888-8888-888888888888",
    version: 1,
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Multi agent",
    objective: "Build it",
    state: "approved",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    nodes,
    edges: []
  });
}

const plainNode = { id: "backend", title: "Backend", role: "implementer" } as const;

describe("materializing agent assignments", () => {
  it("copies the assigned adapter into the executable definition", () => {
    const result = materializeWorkflowDraft(
      draft([{ ...plainNode, agentAssignment: { assignedAdapter: "claude-code" } }]),
      { agents: catalog }
    );
    expect(result.issues).toEqual([]);
    expect(result.workflow?.nodes[0]?.adapter).toBe("claude-code");
  });

  it("keeps a legacy claude-code workflow working without any assignment", () => {
    const result = materializeWorkflowDraft(
      draft([
        {
          ...plainNode,
          runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: "claude-code" }
        }
      ]),
      { agents: catalog }
    );
    expect(result.issues).toEqual([]);
    expect(result.workflow?.nodes[0]?.adapter).toBe("claude-code");
  });

  it("refuses to materialize a node whose legacy runtime id is not a known agent", () => {
    const result = materializeWorkflowDraft(
      draft([
        {
          ...plainNode,
          runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: "some-other-runtime" }
        }
      ]),
      { agents: catalog }
    );
    expect(result.workflow).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(["missing_agent_assignment"]);
  });

  it("blocks the whole run when any node has no agent, and creates no partial definition", () => {
    const result = materializeWorkflowDraft(
      draft([
        { ...plainNode, agentAssignment: { assignedAdapter: "claude-code" } },
        { id: "tests", title: "Tests", role: "qa" }
      ]),
      { agents: catalog }
    );
    expect(result.workflow).toBeNull();
    expect(result.issues).toEqual([
      {
        code: "missing_agent_assignment",
        nodeId: "tests",
        message: expect.stringContaining("no agent selected")
      }
    ]);
  });

  it("blocks a node assigned to a known but unavailable agent, reporting it by nodeId", () => {
    const result = materializeWorkflowDraft(
      draft([{ ...plainNode, agentAssignment: { assignedAdapter: "codex" } }]),
      { agents: catalog }
    );
    expect(result.workflow).toBeNull();
    expect(result.issues.every((issue) => issue.nodeId === "backend")).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain("agent_unavailable");
    expect(result.issues.map((issue) => issue.code)).toContain("agent_not_executable");
  });

  it("blocks a node whose required capabilities the chosen agent does not declare", () => {
    const narrow: AgentAssignmentCatalog = {
      descriptors: [
        agentDescriptorSchema.parse({
          ...runnable("claude-code"),
          capabilities: ["planning"]
        })
      ]
    };
    const result = materializeWorkflowDraft(
      draft([
        {
          ...plainNode,
          agentAssignment: { assignedAdapter: "claude-code", requiredCapabilities: ["backend"] }
        }
      ]),
      { agents: narrow }
    );
    expect(result.workflow).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(["agent_capabilities_unmet"]);
  });

  it("materializes a mixed-agent draft once every chosen agent is runnable", () => {
    const everything: AgentAssignmentCatalog = {
      descriptors: [runnable("claude-code"), runnable("codex"), runnable("opencode")]
    };
    const result = materializeWorkflowDraft(
      draft([
        {
          id: "ux",
          title: "UX",
          role: "designer",
          agentAssignment: { assignedAdapter: "claude-code" }
        },
        {
          id: "backend",
          title: "Backend",
          role: "implementer",
          agentAssignment: { assignedAdapter: "opencode" }
        },
        { id: "tests", title: "Tests", role: "qa", agentAssignment: { assignedAdapter: "codex" } }
      ]),
      { agents: everything }
    );
    expect(result.issues).toEqual([]);
    // The definition is genuinely neutral: three different agents inside one workflow.
    expect(result.workflow?.nodes.map((node) => node.adapter)).toEqual([
      "claude-code",
      "opencode",
      "codex"
    ]);
  });

  it("a recommendation alone never authorizes execution", () => {
    const result = materializeWorkflowDraft(
      draft([{ ...plainNode, agentAssignment: { recommendedAdapters: ["claude-code"] } }]),
      { agents: catalog }
    );
    expect(result.workflow).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(["missing_agent_assignment"]);
  });

  it("without a catalog it judges only the legacy binding, so historical runs are never re-judged", () => {
    // A definition materialized before this model existed must stay readable on a machine whose
    // installed agents have since changed; it is never re-validated against today's availability.
    const result = materializeWorkflowDraft(
      draft([
        {
          ...plainNode,
          runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: "fake-agent" }
        }
      ])
    );
    expect(result.issues).toEqual([]);
    expect(result.workflow?.nodes[0]?.adapter).toBe("fake-agent");
  });
});
