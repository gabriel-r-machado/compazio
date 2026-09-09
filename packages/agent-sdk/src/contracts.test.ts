import { describe, expect, it } from "vitest";

import { agentManifestSchema } from "./contracts";

describe("agent manifest contract", () => {
  it("accepts a complete agent-agnostic manifest", () => {
    const manifest = agentManifestSchema.parse({
      id: "fake-agent",
      displayName: "Fake Agent",
      version: "0.1.0",
      executables: ["fake-agent"],
      platforms: ["win32", "darwin", "linux"],
      capabilities: {
        interactive: true,
        nonInteractive: true,
        resume: false,
        structuredOutput: true,
        mcp: false,
        imageInput: false,
        messageQueue: true
      },
      permissions: ["process"]
    });

    expect(manifest.id).toBe("fake-agent");
  });

  it("rejects unknown public capability fields", () => {
    const result = agentManifestSchema.safeParse({
      id: "unsafe",
      displayName: "Unsafe",
      version: "1",
      executables: ["unsafe"],
      platforms: ["win32"],
      capabilities: {
        interactive: true,
        nonInteractive: false,
        resume: false,
        structuredOutput: false,
        mcp: false,
        arbitraryShell: true
      }
    });

    expect(result.success).toBe(false);
  });
});
