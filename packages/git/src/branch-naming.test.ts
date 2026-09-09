import { describe, expect, it } from "vitest";

import { assertForgeDeckBranchName, createTaskBranchName } from "./branch-naming";

describe("ForgeDeck branch naming", () => {
  it("creates a bounded portable branch under the managed namespace", () => {
    expect(createTaskBranchName("Corrigir autenticação / Windows", "TASK-42")).toBe(
      "forgedeck/corrigir-autenticacao-windows-task-42"
    );
  });

  it("rejects refs outside the managed namespace", () => {
    expect(() => assertForgeDeckBranchName("main")).toThrow("managed namespace");
    expect(() => assertForgeDeckBranchName("forgedeck/../../main")).toThrow("managed namespace");
    expect(() => createTaskBranchName("Task", "---")).toThrow("Task key");
  });
});
