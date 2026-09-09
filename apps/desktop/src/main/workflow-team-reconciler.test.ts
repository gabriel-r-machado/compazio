import { canvasSnapshotSchema, workflowDraftSchema } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import { reconcileWorkflowDraftWithCanvasTeam } from "./workflow-team-reconciler";

describe("reconcileWorkflowDraftWithCanvasTeam", () => {
  it("keeps the user's Codex implementer instead of replacing the whole team with Claude", () => {
    const draft = workflowDraftSchema.parse({
      id: "88888888-8888-4888-8888-888888888888",
      version: 1,
      workspaceId: "workspace-1",
      sourceTerminalId: "planner",
      creationMode: "automatic",
      executionProfile: "balanced",
      state: "ready",
      title: "Landing page premium",
      objective: "Criar uma landing page premium.",
      nodes: [
        { id: "research", title: "Pesquisar", role: "researcher" },
        { id: "implementation", title: "Implementar", role: "implementer" },
        { id: "verify", title: "Validar", role: "qa" }
      ],
      edges: [
        {
          id: "research-to-implementation",
          sourceNodeId: "research",
          targetNodeId: "implementation",
          type: "handoff"
        },
        {
          id: "implementation-to-verify",
          sourceNodeId: "implementation",
          targetNodeId: "verify",
          type: "handoff"
        }
      ],
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z"
    });
    const canvas = canvasSnapshotSchema.parse({
      id: "canvas-1",
      title: "LP",
      mission: "Criar uma landing page premium.",
      revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      creationMode: "automatic",
      executionProfile: "balanced",
      nodes: [
        {
          id: "shell-planner",
          type: "terminal",
          position: { x: 0, y: 0 },
          data: {
            title: "Terminal",
            state: "idle",
            adapterId: "shell",
            role: {
              name: "Planejador",
              responsibilities: "Planejar a execução.",
              constraints: "Não implementar.",
              expectedDeliverable: "Plano",
              completionCriteria: "Plano aprovado"
            }
          }
        },
        {
          id: "agent-codex",
          type: "agent",
          position: { x: 400, y: 0 },
          data: {
            title: "Codex",
            state: "idle",
            adapterId: "codex",
            role: {
              name: "Implementador",
              responsibilities: "Construir o front-end.",
              constraints: "Respeitar o projeto existente.",
              expectedDeliverable: "Landing page funcionando",
              completionCriteria: "Build e testes aprovados"
            }
          }
        },
        {
          id: "briefing",
          type: "note",
          position: { x: 200, y: 220 },
          data: {
            title: "Briefing",
            state: "idle",
            content: "Público: clínicas pequenas. CTA: começar grátis."
          }
        }
      ],
      edges: [
        {
          id: "planner-to-codex",
          source: "shell-planner",
          target: "agent-codex",
          contract: {
            schemaVersion: "1.0",
            kind: "dependency",
            label: "",
            requiredEvidenceTypes: []
          }
        },
        {
          id: "briefing-to-codex",
          source: "briefing",
          target: "agent-codex",
          contract: {
            schemaVersion: "1.0",
            kind: "context",
            label: "usar briefing",
            requiredEvidenceTypes: []
          }
        }
      ]
    });

    const result = reconcileWorkflowDraftWithCanvasTeam(draft, canvas);
    const implementer = result.nodes.find((node) => node.role === "implementer");

    expect(implementer).toMatchObject({
      id: "agent-codex",
      title: "Implementador",
      generatedByOrchestrator: false,
      lifecycle: "configured",
      runtimeRequirement: {
        strategy: "fixed",
        fixedRuntimeId: "codex",
        resolvedRuntimeId: "codex"
      },
      agentAssignment: {
        assignedAdapter: "codex"
      }
    });
    expect(implementer?.responsibilities).toContain("Construir o front-end.");
    expect(implementer?.acceptanceCriteria).toContain("Build e testes aprovados");
    expect(implementer?.inputs).toContainEqual({
      label: "Contexto conectado: Briefing",
      description: "Público: clínicas pequenas. CTA: começar grátis."
    });
    expect(result.nodes.some((node) => node.id === "shell-planner")).toBe(false);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeId: "research",
          targetNodeId: "agent-codex"
        }),
        expect.objectContaining({
          sourceNodeId: "agent-codex",
          targetNodeId: "verify"
        })
      ])
    );
  });

  it("adds connected configured agents that the generated plan omitted and preserves their edge", () => {
    const draft = workflowDraftSchema.parse({
      id: "99999999-9999-4999-8999-999999999999",
      version: 1,
      workspaceId: "workspace-1",
      sourceTerminalId: "planner",
      creationMode: "automatic",
      executionProfile: "balanced",
      state: "ready",
      title: "Front-end",
      objective: "Entregar o front-end.",
      nodes: [{ id: "implementation", title: "Implementar", role: "implementer" }],
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z"
    });
    const canvas = canvasSnapshotSchema.parse({
      id: "canvas-1",
      title: "Front-end",
      revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "agent-codex",
          type: "agent",
          position: { x: 0, y: 0 },
          data: {
            title: "Codex",
            state: "idle",
            adapterId: "codex",
            role: {
              name: "Implementador",
              responsibilities: "Criar o corpo da página.",
              constraints: "",
              expectedDeliverable: "Página",
              completionCriteria: "Build aprovado"
            }
          }
        },
        {
          id: "agent-opencode",
          type: "agent",
          position: { x: 400, y: 0 },
          data: {
            title: "OpenCode",
            state: "idle",
            adapterId: "opencode",
            role: {
              name: "Revisor",
              responsibilities: "Revisar e corrigir o footer.",
              constraints: "",
              expectedDeliverable: "Footer revisado",
              completionCriteria: "Sem regressões"
            }
          }
        }
      ],
      edges: [
        {
          id: "codex-to-opencode",
          source: "agent-codex",
          target: "agent-opencode",
          contract: {
            schemaVersion: "1.0",
            kind: "handoff",
            label: "Revisão",
            requiredEvidenceTypes: ["artifact"],
            handoffMode: "after-success"
          }
        }
      ]
    });

    const result = reconcileWorkflowDraftWithCanvasTeam(draft, canvas);

    expect(result.nodes.map((node) => node.id)).toEqual(["agent-codex", "agent-opencode"]);
    expect(result.nodes[1]).toMatchObject({
      role: "reviewer",
      agentAssignment: { assignedAdapter: "opencode" }
    });
    expect(result.edges).toEqual([
      expect.objectContaining({
        sourceNodeId: "agent-codex",
        targetNodeId: "agent-opencode",
        type: "handoff"
      })
    ]);
  });
});
