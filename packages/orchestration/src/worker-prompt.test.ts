import { workflowNodeDraftSchema } from "@forgedeck/schemas";
import { describe, expect, it } from "vitest";

import { buildWorkerPrompt } from "./worker-prompt";

function node(overrides: Record<string, unknown> = {}) {
  return workflowNodeDraftSchema.parse({
    id: "fe",
    title: "Front-end",
    role: "implementer",
    objective: "Implementar as seções responsivas",
    acceptanceCriteria: ["Responsivo", "Build sem erros"],
    ...overrides
  });
}

describe("buildWorkerPrompt", () => {
  it("carries the task, acceptance criteria and result-envelope contract", () => {
    const prompt = buildWorkerPrompt({
      node: node(),
      taskId: "fe",
      dispatchId: "d1",
      objective: "landing page premium"
    });
    expect(prompt).toContain("Implementar as seções responsivas");
    expect(prompt).toContain("Responsivo");
    expect(prompt).toContain("⟦compasso:result⟧");
    expect(prompt).toContain("taskId=fe");
    expect(prompt).toContain("dispatchId=d1");
  });

  it("states that idle does not complete the task", () => {
    const prompt = buildWorkerPrompt({
      node: node(),
      taskId: "fe",
      dispatchId: "d1",
      objective: "obj"
    });
    expect(prompt.toLowerCase()).toContain("ocioso");
  });

  it("different tasks produce different worker prompts", () => {
    const a = buildWorkerPrompt({
      node: node({ id: "a", title: "A", objective: "fazer A" }),
      taskId: "a",
      dispatchId: "d1",
      objective: "obj"
    });
    const b = buildWorkerPrompt({
      node: node({ id: "b", title: "B", objective: "fazer B" }),
      taskId: "b",
      dispatchId: "d2",
      objective: "obj"
    });
    expect(a).not.toBe(b);
  });
});
