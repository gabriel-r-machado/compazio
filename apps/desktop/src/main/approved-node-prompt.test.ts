import { workflowDraftSchema } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import { buildApprovedNodePrompt } from "./approved-node-prompt";

describe("buildApprovedNodePrompt", () => {
  it("combines the shared mission with the node's configured function", () => {
    const draft = workflowDraftSchema.parse({
      id: "88888888-8888-4888-8888-888888888888",
      version: 1,
      workspaceId: "workspace-1",
      sourceTerminalId: "manual",
      creationMode: "manual",
      executionProfile: "balanced",
      state: "approved",
      title: "Landing page",
      objective: "Criar uma landing page premium.",
      nodes: [
        {
          id: "codex",
          title: "Implementador",
          role: "implementer",
          objective: "Implementar o footer.",
          responsibilities: ["Respeitar o layout existente."],
          acceptanceCriteria: ["Build aprovado"],
          runtimeRequirement: { resolvedRuntimeId: "codex" }
        }
      ],
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z"
    });
    const node = draft.nodes[0];
    if (node === undefined) throw new Error("Expected one draft node");
    const prompt = buildApprovedNodePrompt(draft, node);
    expect(prompt).toContain("Criar uma landing page premium.");
    expect(prompt).toContain("Implementar o footer.");
    expect(prompt).toContain("Respeitar o layout existente.");
    expect(prompt).toContain("Build aprovado");
  });
});
