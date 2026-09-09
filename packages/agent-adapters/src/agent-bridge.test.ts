import { describe, expect, it, vi } from "vitest";

import type { AdapterContext, AgentAdapter, AgentManifest } from "@forgedeck/agent-sdk";

import { AgentBridge } from "./agent-bridge";
import type { AgentBridgeError } from "./agent-bridge";

const manifest: AgentManifest = {
  id: "provider",
  displayName: "Provider CLI",
  version: "1",
  executables: ["provider"],
  platforms: ["win32", "darwin", "linux"],
  capabilities: {
    interactive: true,
    nonInteractive: true,
    resume: true,
    structuredOutput: true,
    mcp: false,
    imageInput: false,
    messageQueue: true
  },
  permissions: []
};

const context: AdapterContext = {
  platform: "win32",
  environment: {},
  cwd: "C:/workspace",
  detector: { find: async () => null },
  commandRunner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) }
};

describe("AgentBridge", () => {
  it("requires functional authentication before advertising an adapter as available", async () => {
    const adapter = createAdapter();
    const bridge = bridgeFor(adapter);

    await expect(bridge.inspect(context)).resolves.toEqual([
      expect.objectContaining({ id: "provider", available: true, issue: null })
    ]);
    expect(adapter.validateAuth).toHaveBeenCalledOnce();

    adapter.validateAuth.mockResolvedValueOnce({
      authenticated: false,
      issue: {
        code: "adapter_auth_unavailable",
        message: "Provider CLI needs sign in",
        remediation: "Sign in"
      }
    });
    await expect(bridge.status("provider", context)).resolves.toMatchObject({
      available: false,
      version: "1.2.3",
      issue: { code: "adapter_auth_unavailable" }
    });
  });

  it("sanitizes a failed functional check instead of returning provider diagnostics", async () => {
    const adapter = createAdapter();
    adapter.detect.mockRejectedValueOnce(new Error("C:/secrets/token.txt"));
    const status = await bridgeFor(adapter).status("provider", context);

    expect(status).toMatchObject({ available: false, issue: { code: "adapter_detection_failed" } });
    expect(status.issue?.message).not.toContain("token.txt");
  });

  it("bounds a stalled verification with a sanitized timeout result", async () => {
    const adapter = createAdapter();
    adapter.detect.mockImplementationOnce(
      () => new Promise(() => undefined) as ReturnType<typeof adapter.detect>
    );

    const status = await bridgeFor(adapter, 100).status("provider", context);
    expect(status).toMatchObject({ available: false, issue: { code: "adapter_detection_failed" } });
  });

  it("centralizes readiness, bounded sending and response observation", async () => {
    const adapter = createAdapter();
    const bridge = bridgeFor(adapter);
    expect(bridge.readiness("provider", { data: "ready", sequence: 1 })).toEqual({
      ready: true,
      reason: "ready"
    });

    await bridge.send("provider", controls(), { id: "message-1", content: "Review" });
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    await expect(
      bridge.waitForResponse(
        {
          getOutputSnapshot: () => ({ data: "prompt", sequence: 5 }),
          waitForOutputAfter: async () => ({ data: "answer", sequence: 6 })
        },
        500
      )
    ).resolves.toEqual({ status: "response_detected", responseSequence: 6 });
    await expect(
      bridge.waitForResponse(
        {
          getOutputSnapshot: () => ({ data: "prompt", sequence: 5 }),
          waitForOutputAfter: async () => null
        },
        500
      )
    ).resolves.toEqual({ status: "timed_out", responseSequence: null });

    adapter.sendMessage.mockRejectedValueOnce(new Error("C:/private/provider.log"));
    await expect(
      bridge.send("provider", controls(), { id: "message-2", content: "Retry" })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "agent_bridge_send_failed"
      } satisfies Partial<AgentBridgeError>)
    );
  });
});

function bridgeFor(adapter: ReturnType<typeof createAdapter>, timeoutMs?: number): AgentBridge {
  return new AgentBridge(
    {
      get: () => adapter as unknown as AgentAdapter,
      list: () => [adapter as unknown as AgentAdapter]
    },
    timeoutMs
  );
}

function createAdapter() {
  return {
    manifest,
    detect: vi.fn(async () => ({
      available: true,
      executable: { path: "C:/provider.exe", kind: "native" as const },
      version: "1.2.3",
      issue: null
    })),
    validateAuth: vi.fn(async () => ({ authenticated: true, issue: null })),
    isReadyForReviewedHandoff: vi.fn(() => true),
    sendMessage: vi.fn(async () => undefined)
  };
}

function controls() {
  return {
    write: async () => undefined,
    requestGracefulStop: async () => undefined,
    forceKill: async () => undefined
  };
}
