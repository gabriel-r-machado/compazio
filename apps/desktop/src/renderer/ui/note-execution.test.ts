import { describe, expect, it } from "vitest";

import { buildNoteExecution } from "./note-execution";

describe("note execution", () => {
  it("builds explicit forward and feedback instructions", () => {
    expect(buildNoteExecution("PRD", "Header amarelo", "forward")).toContain(
      "contexto explícito para o próximo trabalho"
    );
    expect(buildNoteExecution("Revisão", "Header amarelo, não laranja", "feedback")).toContain(
      "feedback explícito sobre o seu trabalho anterior"
    );
  });

  it("removes terminal control sequences and bounds the payload", () => {
    const prompt = buildNoteExecution(
      "\u001b[31mNota\u001b[0m",
      `\u001b]0;janela\u0007${"contexto".repeat(3_000)}fim`,
      "forward"
    );

    expect(prompt).not.toContain("\u001b");
    expect(prompt).not.toContain("janela");
    expect(prompt.length).toBeLessThan(12_500);
  });
});
