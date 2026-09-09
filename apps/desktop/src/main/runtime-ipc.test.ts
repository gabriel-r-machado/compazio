import { describe, expect, it } from "vitest";

import { sanitizeRuntimeAdapterStatus } from "./runtime-ipc";

describe("runtime diagnostics", () => {
  it("redacts marked secrets and does not add executable details", () => {
    const secret = "FORGEDECK_TEST_SECRET_runtime-diagnostic";
    const result = sanitizeRuntimeAdapterStatus({
      id: "missing",
      displayName: `Agent ${secret}`,
      available: false,
      version: secret,
      issue: {
        code: "adapter_executable_not_found",
        message: `Missing ${secret}`,
        remediation: `Do not print ${secret}`
      },
      capabilities: {
        interactive: false,
        nonInteractive: true,
        resume: false,
        structuredOutput: false,
        mcp: false,
        imageInput: false,
        messageQueue: false
      }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("executablePath");
    expect(serialized).toContain("[REDACTED]");
  });
});
