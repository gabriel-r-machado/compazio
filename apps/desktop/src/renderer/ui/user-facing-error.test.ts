import { describe, expect, it } from "vitest";

import { toUserFacingErrorMessage } from "./user-facing-error";

describe("user-facing renderer errors", () => {
  it("removes Electron IPC implementation details without hiding the actionable error", () => {
    expect(
      toUserFacingErrorMessage(
        new Error(
          "Error invoking remote method 'terminal:create': Error: Claude Code was found but could not be executed. Verify the installation."
        ),
        "Terminal indisponível"
      )
    ).toBe("Claude Code was found but could not be executed. Verify the installation.");
  });

  it("uses the provided fallback for unknown or empty errors", () => {
    expect(toUserFacingErrorMessage(null, "Terminal indisponível")).toBe("Terminal indisponível");
    expect(toUserFacingErrorMessage(new Error(""), "Terminal indisponível")).toBe(
      "Terminal indisponível"
    );
  });
});
