import { describe, expect, it } from "vitest";

import {
  buildInitialAgentPrompt,
  buildTerminalHandoff,
  terminalDeliveryDraft,
  terminalHandoffInput,
  terminalNeedsLogin
} from "./terminal-handoff";

const reviewer = {
  name: "Revisor",
  responsibilities: "Revisar a implementação",
  constraints: "Não alterar arquivos",
  expectedDeliverable: "Achados com evidências",
  completionCriteria: "Cada achado possui reprodução"
} as const;

describe("terminal handoff", () => {
  it("builds the initial prompt from one mission, a role and connected notes", () => {
    const prompt = buildInitialAgentPrompt({
      mission: "Entregar autenticação testada",
      nodeTitle: "Claude Code",
      role: reviewer,
      noteContext: ["PRD local", "\u001b[31mHeader amarelo\u001b[0m"]
    });

    expect(prompt).toContain("MISSÃO DO FLUXO\nEntregar autenticação testada");
    expect(prompt).toContain("FUNÇÃO: Revisor");
    expect(prompt).toContain("PRD local");
    expect(prompt).not.toContain("\u001b");
  });

  it("turns a reviewed delivery and edge contract into a targeted prompt", () => {
    const handoff = buildTerminalHandoff({
      mission: "Entregar autenticação testada",
      sourceTitle: "Implementação",
      sourceRole: undefined,
      targetTitle: "Claude Code",
      targetRole: reviewer,
      sourceDeliverable: "Código e testes",
      targetInstruction: "Revise regressões",
      delivery: "\u001b[32mfeito\u001b[0m\r\nTeste concluído"
    });

    expect(handoff).toContain("ENTREGA REAL REVISADA\nfeito\nTeste concluído");
    expect(handoff).toContain("PRÓXIMA AÇÃO\nRevise regressões");
    expect(terminalHandoffInput(handoff)).toBe(`\u001b[200~${handoff}\u001b[201~\r`);
  });

  it("limits terminal delivery context to recent safe output", () => {
    const delivery = terminalDeliveryDraft(`${"antigo".repeat(3_000)}resultado-final`);

    expect(delivery.length).toBeLessThanOrEqual(8_000);
    expect(delivery).toContain("resultado-final");
  });

  it("recognizes an agent that requires authentication", () => {
    expect(terminalNeedsLogin("\u001b[31mNot logged in · Run /login\u001b[0m")).toBe(true);
    expect(terminalNeedsLogin("Ready for work")).toBe(false);
  });
});
