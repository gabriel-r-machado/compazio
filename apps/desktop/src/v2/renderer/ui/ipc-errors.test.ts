import { describe, expect, it } from "vitest";

import { isFreeWorkspaceLimitError, userFacingIpcError } from "./ipc-errors";

describe("erros IPC exibidos ao usuário", () => {
  it("preserva a decisão de licença quando o Electron remove o code", () => {
    const error = new Error(
      "Error invoking remote method 'compazio-v2:workspace:create': EntitlementError: O beta gratuito permite um workspace por instalação."
    );
    expect(isFreeWorkspaceLimitError(error)).toBe(true);
    expect(userFacingIpcError(error, "fallback")).toBe(
      "O beta gratuito permite um workspace por instalação."
    );
  });

  it("usa o código estruturado quando ele estiver disponível", () => {
    expect(isFreeWorkspaceLimitError({ code: "FREE_WORKSPACE_LIMIT_REACHED" })).toBe(true);
  });

  it("não exibe framing de transporte ou stack", () => {
    expect(
      userFacingIpcError(
        new Error("Error invoking remote method 'x': Error: Falha recuperável\n    at handler"),
        "fallback"
      )
    ).toBe("Falha recuperável");
  });
});
