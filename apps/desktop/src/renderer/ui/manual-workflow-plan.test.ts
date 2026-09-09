import { describe, expect, it } from "vitest";

import type { ForgeFlowEdge, ForgeFlowNode } from "./canvas-store";
import { createManualWorkflowPlan } from "./manual-workflow-plan";

describe("createManualWorkflowPlan", () => {
  it("turns connected Claude, Codex and OpenCode cards into one ordered official workflow", () => {
    const nodes: ForgeFlowNode[] = [
      agent("agent-claude", "claude-code", "Planejador"),
      agent("agent-codex", "codex", "Implementador"),
      agent("agent-opencode", "opencode", "Revisor")
    ];
    const edges: ForgeFlowEdge[] = [
      edge("claude-codex", "agent-claude", "agent-codex"),
      edge("codex-opencode", "agent-codex", "agent-opencode")
    ];

    const plan = createManualWorkflowPlan({
      mission: "Criar uma landing page premium.",
      nodes,
      edges
    });

    expect(plan.nodes.map((node) => [node.ref, node.adapterId, node.role])).toEqual([
      ["agent-claude", "claude-code", "planner"],
      ["agent-codex", "codex", "implementer"],
      ["agent-opencode", "opencode", "reviewer"]
    ]);
    expect(plan.edges).toEqual([
      expect.objectContaining({ from: "agent-claude", to: "agent-codex" }),
      expect.objectContaining({ from: "agent-codex", to: "agent-opencode" })
    ]);
  });

  it("does not pretend a shell terminal became an AI agent because it has a role", () => {
    const plan = createManualWorkflowPlan({
      mission: "Planejar e implementar.",
      nodes: [agent("shell", "shell", "Planejador"), agent("codex", "codex", "Implementador")],
      edges: [edge("shell-codex", "shell", "codex")]
    });

    expect(plan.nodes.map((node) => node.ref)).toEqual(["codex"]);
    expect(plan.ignoredShellRoles).toEqual(["Planejador"]);
  });

  it("injects connected notes and chained context into the agent instruction", () => {
    const nodes: ForgeFlowNode[] = [
      agent("codex", "codex", "Implementador"),
      note("brief", "Briefing", "Público: clínicas pequenas."),
      note("references", "Referências", "Visual sóbrio e acessível.")
    ];
    const plan = createManualWorkflowPlan({
      mission: "Criar a interface.",
      nodes,
      edges: [
        edge("brief-agent", "brief", "codex"),
        edge("brief-references", "brief", "references")
      ]
    });

    expect(plan.nodes[0]?.action.inputs).toEqual([
      {
        label: "Contexto conectado: Briefing",
        description: "Público: clínicas pequenas."
      },
      {
        label: "Contexto conectado: Referências",
        description: "Visual sóbrio e acessível."
      }
    ]);
  });
});

function agent(id: string, adapterId: string, roleName: string): ForgeFlowNode {
  return {
    id,
    type: adapterId === "shell" ? "terminal" : "agent",
    position: { x: 0, y: 0 },
    data: {
      title: adapterId,
      state: "idle",
      adapterId,
      summary: "",
      retryMaxAttempts: 1,
      permissions: [],
      role: {
        name: roleName,
        responsibilities: `Responsabilidade de ${roleName}`,
        constraints: "Não ampliar o escopo.",
        expectedDeliverable: `Entrega de ${roleName}`,
        completionCriteria: "Entrega validada."
      }
    }
  };
}

function edge(id: string, source: string, target: string): ForgeFlowEdge {
  return {
    id,
    type: "contract",
    source,
    target,
    data: {
      schemaVersion: "1.0",
      kind: "handoff",
      label: "",
      requiredEvidenceTypes: ["artifact"],
      handoffMode: "after-success"
    }
  };
}

function note(id: string, title: string, content: string): ForgeFlowNode {
  return {
    id,
    type: "note",
    position: { x: 0, y: 0 },
    data: {
      title,
      content,
      state: "idle",
      summary: content,
      retryMaxAttempts: 1,
      permissions: []
    }
  };
}
