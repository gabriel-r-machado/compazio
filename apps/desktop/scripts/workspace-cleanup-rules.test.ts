import { describe, expect, it } from "vitest";

import { HARNESS_FINGERPRINTS, matchHarness } from "./workspace-cleanup-rules";

const lpNodes = [
  "Briefing e progresso",
  "Arquivos do projeto",
  "Rosto-minimalista-em-preto-e-branco.png",
  "44a75487-5539-440c-a594-a608f59c752f.png",
  "Screenshot_24.png",
  "Screenshot_25.png",
  "Prévia da landing page",
  "Compazio — Claude"
];

describe("regras de limpeza de workspaces de teste", () => {
  it("reconhece a assinatura completa do fixture legado da LP", () => {
    expect(matchHarness("LP — validação final", lpNodes)).toBe("legacy:compazio-lp-validation");
  });

  it("não marca como teste um workspace que só repete o nome", () => {
    expect(matchHarness("LP — validação final", ["Nota", "Minha imagem.png"])).toBeNull();
  });

  it("preserva um workspace do usuário com nome parecido", () => {
    expect(matchHarness("lp", ["Nota", "Rosto-minimalista-em-preto-e-branco.png"])).toBeNull();
    expect(matchHarness("LP", lpNodes)).toBeNull();
  });

  it("exige todos os nós obrigatórios, não apenas alguns", () => {
    const partial = lpNodes.filter((title) => title !== "Screenshot_24.png");
    expect(matchHarness("LP — validação final", partial)).toBeNull();
  });

  it("mantém identificadores estáveis e não vazios para todas as assinaturas", () => {
    for (const fingerprint of HARNESS_FINGERPRINTS) expect(fingerprint.harness.trim()).not.toBe("");
  });
});
