import { describe, expect, it } from "vitest";

import { preparePrompt } from "./prompt-composition";

describe("preparePrompt", () => {
  it("keeps one safe contextual reference and reports duplicates or unavailable items", () => {
    const prompt = preparePrompt("Revise isto", [
      { id: "note", kind: "note", title: "Especificação", value: "Critério A" },
      { id: "note", kind: "note", title: "Especificação", value: "Critério A" },
      { id: "missing", kind: "file", title: "Ausente", value: "x", unavailable: true }
    ]);

    expect(prompt.text).toContain("@Nota Especificação");
    expect(prompt.duplicateIds).toEqual(["note"]);
    expect(prompt.unavailableIds).toEqual(["missing"]);
    expect(prompt.bytes).toBeGreaterThan(0);
  });
});
