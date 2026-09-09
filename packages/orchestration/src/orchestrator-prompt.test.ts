import { canvasSnapshotSchema } from "@forgedeck/schemas";
import type { AgentRuntimeCapability, CanvasSnapshot } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import {
  ORCHESTRATOR_DENIED_BY_DEFAULT,
  ORCHESTRATOR_GLOBAL_LIMITS,
  buildOrchestratorPrompt,
  renderOrchestratorPrompt
} from "./orchestrator-prompt";

function emptyCanvas(overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot {
  return canvasSnapshotSchema.parse({
    id: "canvas-1",
    title: "Canvas",
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    creationMode: "automatic",
    executionProfile: "balanced",
    nodes: [],
    edges: [],
    ...overrides
  });
}

function capability(overrides: Partial<AgentRuntimeCapability>): AgentRuntimeCapability {
  return {
    runtimeId: "claude-code",
    provider: "claude-code",
    displayName: "Claude Code",
    installed: true,
    authenticated: true,
    enabled: true,
    supportsParallelSessions: true,
    maxConcurrentSessions: 4,
    activeSessions: 0,
    availableModels: [],
    capabilities: ["code", "interactive"],
    lastCheckedAt: "2026-07-23T00:00:00.000Z",
    ...overrides
  };
}

const claude = capability({ runtimeId: "claude-code", provider: "claude-code" });
const codexUnauthenticated = capability({
  runtimeId: "codex",
  provider: "codex",
  displayName: "Codex",
  authenticated: false
});

describe("buildOrchestratorPrompt", () => {
  it("invariant 1: different objectives produce different session input", () => {
    const base = {
      canvas: emptyCanvas(),
      capabilities: [claude],
      executionProfile: "balanced" as const
    };
    const landing = buildOrchestratorPrompt({
      ...base,
      objective: "criar uma landing page premium para uma personal trainer"
    });
    const bug = buildOrchestratorPrompt({
      ...base,
      objective: "corrigir o bug de autenticação que derruba a sessão"
    });

    expect(landing.objectiveMessage).not.toBe(bug.objectiveMessage);
    expect(renderOrchestratorPrompt(landing)).not.toBe(renderOrchestratorPrompt(bug));
    // The user's own words reach the session verbatim.
    expect(landing.objectiveMessage).toContain("landing page premium");
    expect(bug.objectiveMessage).toContain("bug de autenticação");
  });

  it("invariant 2: never emits a predetermined team or generic workflow", () => {
    const landing = renderOrchestratorPrompt(
      buildOrchestratorPrompt({
        objective: "landing page de vendas",
        canvas: emptyCanvas(),
        capabilities: [claude],
        executionProfile: "balanced"
      })
    );
    // No role/team names from the deprecated template composer may leak into the prompt.
    for (const forbidden of [
      "UX & Wireframes",
      "Front-end (seções)",
      "Direção Visual",
      "Planejador",
      "Implementador"
    ]) {
      expect(landing).not.toContain(forbidden);
    }
    // Instead the agent is instructed to decide the team itself.
    expect(landing.toLowerCase()).toContain("decid");
  });

  it("invariant 3: only detected and usable runtimes are offered", () => {
    const prompt = buildOrchestratorPrompt({
      objective: "qualquer objetivo",
      canvas: emptyCanvas(),
      capabilities: [claude, codexUnauthenticated],
      executionProfile: "balanced"
    });
    expect(prompt.usableRuntimes.map((entry) => entry.runtimeId)).toEqual(["claude-code"]);
    const rendered = renderOrchestratorPrompt(prompt);
    expect(rendered).toContain("Claude Code");
    expect(rendered).not.toContain("Codex");
  });

  it("fails loudly on an empty objective instead of fabricating a plan", () => {
    expect(() =>
      buildOrchestratorPrompt({
        objective: "   ",
        canvas: emptyCanvas(),
        capabilities: [claude],
        executionProfile: "balanced"
      })
    ).toThrow(/objective/i);
  });

  it("states draft semantics: ghost nodes, wire protocol, deny-by-default", () => {
    const rendered = renderOrchestratorPrompt(
      buildOrchestratorPrompt({
        objective: "montar um app web",
        canvas: emptyCanvas(),
        capabilities: [claude],
        executionProfile: "balanced"
      })
    );
    // Nothing runs while drafting.
    expect(rendered.toLowerCase()).toMatch(/rascunho|draft|ghost/);
    // The machine-readable wire protocol the desktop parses.
    expect(rendered).toContain("COMPASSO_DRAFT:");
    // The terminal echoes its prompt. An executable action example here would be parsed as a generic
    // workflow before the real orchestrator answers, so the prompt must never contain one.
    expect(rendered).not.toContain('COMPASSO_DRAFT: {"type"');
    // Deny-by-default surfaced so the agent knows the boundaries.
    expect(rendered.toLowerCase()).toMatch(/push|deploy|merge/);
  });

  it("exposes the execution policy and global limits for the chosen profile", () => {
    const economy = buildOrchestratorPrompt({
      objective: "objetivo",
      canvas: emptyCanvas(),
      capabilities: [claude],
      executionProfile: "economy"
    });
    expect(economy.executionPolicy.defaultParallelism).toBe(1);
    expect(economy.executionPolicy.maxRetries).toBe(1);
    expect(ORCHESTRATOR_GLOBAL_LIMITS.maxConcurrentAgents).toBe(3);
    expect(ORCHESTRATOR_GLOBAL_LIMITS.maxSpawnedAgents).toBe(6);
    expect(ORCHESTRATOR_DENIED_BY_DEFAULT.allowGitPush).toBe(false);
  });

  it("summarizes the configured team, connected notes and handoffs so the agent produces a delta", () => {
    const canvas = emptyCanvas({
      nodes: [
        {
          id: "n1",
          type: "agent",
          position: { x: 0, y: 0 },
          data: {
            title: "Frontend",
            state: "idle",
            adapterId: "codex",
            role: {
              name: "Hero e primeira dobra",
              responsibilities: "Implementar somente a abertura da LP.",
              constraints: "Não editar o footer.",
              expectedDeliverable: "Hero responsivo.",
              completionCriteria: "CTA visível e sem overflow."
            }
          }
        },
        {
          id: "brief",
          type: "note",
          position: { x: 0, y: 220 },
          data: {
            title: "Briefing",
            state: "idle",
            content: "Público: clínicas pequenas. Oferta: agenda sem mensalidade inicial."
          }
        }
      ],
      edges: [
        {
          id: "brief-front",
          source: "brief",
          target: "n1",
          contract: {
            schemaVersion: "1.0",
            kind: "context",
            label: "usar briefing",
            requiredEvidenceTypes: []
          }
        }
      ]
    });
    const prompt = buildOrchestratorPrompt({
      objective: "finalizar a landing page",
      canvas,
      capabilities: [claude],
      executionProfile: "balanced"
    });
    expect(prompt.objectiveMessage).toContain("Frontend");
    expect(prompt.objectiveMessage).toContain("agente=codex");
    expect(prompt.objectiveMessage).toContain("Hero e primeira dobra");
    expect(prompt.objectiveMessage).toContain("Público: clínicas pequenas");
    expect(prompt.objectiveMessage).toContain("brief -> n1 [context]");
  });

  it("teaches the CLI only to an orchestrator that has a canvas node of its own", () => {
    const withoutNode = buildOrchestratorPrompt({
      objective: "montar uma equipe",
      canvas: emptyCanvas(),
      capabilities: [claude],
      executionProfile: "balanced"
    });
    // A composition session that lives outside the canvas can honestly only propose.
    expect(withoutNode.teamInstructions).toBeNull();
    expect(renderOrchestratorPrompt(withoutNode)).not.toContain("compazio terminal create");

    const withNode = buildOrchestratorPrompt({
      objective: "montar uma equipe",
      canvas: emptyCanvas(),
      capabilities: [claude],
      executionProfile: "balanced",
      selfNodeId: "orchestrator-1"
    });

    const rendered = renderOrchestratorPrompt(withNode);
    expect(rendered).toContain("compazio terminal create");
    expect(rendered).toContain("--from orchestrator-1");
    // Only runtimes the host actually has are offered for recruiting.
    expect(withNode.teamInstructions).toContain("Runtimes que você pode recrutar: claude-code.");
  });
});
