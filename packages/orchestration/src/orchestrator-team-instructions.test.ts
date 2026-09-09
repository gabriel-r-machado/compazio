import { describe, expect, it } from "vitest";

import {
  ORCHESTRATOR_TEAM_PERMISSIONS,
  buildOrchestratorTeamInstructions
} from "./orchestrator-team-instructions";
import type { OrchestratorTeamInstructionsInput } from "./orchestrator-team-instructions";

function instructions(overrides: Partial<OrchestratorTeamInstructionsInput> = {}): string {
  return buildOrchestratorTeamInstructions({
    selfNodeId: "orchestrator-1",
    usableRuntimeIds: ["claude-code", "codex"],
    maxSpawnedAgents: 6,
    maxConcurrentAgents: 3,
    ...overrides
  });
}

describe("buildOrchestratorTeamInstructions", () => {
  it("teaches the commands that actually build a team", () => {
    const text = instructions();

    expect(text).toContain("compazio terminal create");
    expect(text).toContain("compazio connect create");
    expect(text).toContain("compazio note create");
    expect(text).toContain("compazio ask");
    expect(text).toContain("compazio terminal remove");
  });

  it("claims the canvas for Compazio so a foreign skill pack cannot pass for the product", () => {
    // The runtimes we launch load whatever skills the user's machine has; some rival canvas products
    // ship packs describing these exact verbs. Without this, an agent asked to "montar uma equipe"
    // can pick the foreign pack and narrate that product's name back to the user.
    const text = instructions();

    expect(text).toContain("Este canvas é do Compazio");
    expect(text).toContain("única superfície");
    expect(text).toContain("não use e não a mencione");
  });

  it("gives the orchestrator its own identity to sign commands with", () => {
    expect(instructions({ selfNodeId: "captain-9" })).toContain("--from captain-9");
  });

  it("offers only runtimes the host actually has", () => {
    const text = instructions({ usableRuntimeIds: ["codex"] });

    expect(text).toContain("Runtimes que você pode recrutar: codex.");
    expect(text).not.toContain("claude-code");
  });

  it("tells it not to recruit when nothing is installed, instead of trying anyway", () => {
    expect(instructions({ usableRuntimeIds: [] })).toContain("não tente recrutar");
  });

  it("states that a quiet terminal is not finished work", () => {
    const text = instructions();

    expect(text).toContain("Um terminal em silêncio não é");
    expect(text).toContain("só a resposta conclui");
  });

  it("warns that lifecycle commands are requests, not accomplished facts", () => {
    expect(instructions()).toContain("`queued`, não `feito`");
  });

  it("carries the real limits rather than a generic ceiling", () => {
    const text = instructions({ maxSpawnedAgents: 2, maxConcurrentAgents: 1 });

    expect(text).toContain("No máximo 2 agentes criados por você, 1 trabalhando");
  });
});

describe("ORCHESTRATOR_TEAM_PERMISSIONS", () => {
  it("grants what composing a team needs", () => {
    expect([...ORCHESTRATOR_TEAM_PERMISSIONS].sort()).toEqual([
      "assign_roles",
      "connect_context",
      "create_agents",
      "create_notes",
      "read_context",
      "remove_agents",
      "send_messages"
    ]);
  });

  it("does not let an orchestrator ship or approve its own team's work", () => {
    // Coordinating a team is not the same as being allowed to merge, deploy or sign off on it —
    // an orchestrator approving its own team's deliveries would be reviewing itself.
    for (const withheld of [
      "execute_tasks",
      "manage_worktrees",
      "merge_changes",
      "approve_deliveries",
      "publish_artifacts"
    ]) {
      expect(ORCHESTRATOR_TEAM_PERMISSIONS).not.toContain(withheld);
    }
  });
});
