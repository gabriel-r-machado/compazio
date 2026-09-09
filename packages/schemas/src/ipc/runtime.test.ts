import { describe, expect, it } from "vitest";

import { runtimeDiagnosticsSchema } from "./runtime";

describe("runtime IPC schema", () => {
  it("accepts sanitized read-only diagnostics", () => {
    const result = runtimeDiagnosticsSchema.parse({
      platform: "win32",
      architecture: "x64",
      nodeVersion: "22.0.0",
      terminalBackend: "node-pty",
      interruptedSessionsRecovered: 1,
      interruptedRunsRecovered: 2,
      adapters: []
    });
    expect(result.terminalBackend).toBe("node-pty");
  });

  it("rejects executable paths and generic launch fields", () => {
    const result = runtimeDiagnosticsSchema.safeParse({
      platform: "win32",
      architecture: "x64",
      nodeVersion: "22.0.0",
      terminalBackend: "node-pty",
      interruptedSessionsRecovered: 0,
      interruptedRunsRecovered: 0,
      adapters: [],
      executablePath: "C:\\secret\\agent.exe",
      args: ["--dangerous"]
    });
    expect(result.success).toBe(false);
  });
});
