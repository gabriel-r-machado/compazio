import { z } from "zod";

import type { RuntimeAdapterStatus } from "./ipc/runtime";

/**
 * Central description of an agent runtime the desktop can actually use. It is derived from real
 * runtime discovery — never assumed. The composer resolves abstract roles against these entries and
 * blocks approval (with a reason) when nothing compatible exists, rather than inventing availability.
 */
export const agentRuntimeProviderSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "gemini-cli",
  "custom"
]);
export type AgentRuntimeProvider = z.infer<typeof agentRuntimeProviderSchema>;

export const agentModelCapabilitySchema = z
  .object({
    modelId: z.string().min(1).max(160),
    displayName: z.string().min(1).max(160),
    tier: z.enum(["low", "standard", "high"]).default("standard")
  })
  .strict();
export type AgentModelCapability = z.infer<typeof agentModelCapabilitySchema>;

export const agentRuntimeCapabilitySchema = z
  .object({
    runtimeId: z.string().min(1).max(160),
    provider: agentRuntimeProviderSchema,
    displayName: z.string().min(1).max(160),
    installed: z.boolean(),
    authenticated: z.boolean(),
    enabled: z.boolean(),
    supportsParallelSessions: z.boolean(),
    maxConcurrentSessions: z.number().int().min(0).max(64),
    activeSessions: z.number().int().min(0).max(64),
    availableModels: z.array(agentModelCapabilitySchema).max(32).default([]),
    capabilities: z.array(z.string().min(1).max(64)).max(64).default([]),
    lastCheckedAt: z.string().datetime({ offset: true })
  })
  .strict();
export type AgentRuntimeCapability = z.infer<typeof agentRuntimeCapabilitySchema>;

/**
 * A runtime is usable for composition/resolution only when it is installed, authenticated and
 * enabled. Non-installed or non-authenticated runtimes are ignored — the exact rule the acceptance
 * criteria require ("Codex instalado mas não autenticado deve ser ignorado").
 */
export function isRuntimeUsable(runtime: AgentRuntimeCapability): boolean {
  return runtime.installed && runtime.authenticated && runtime.enabled;
}

const providerById: Readonly<Record<string, AgentRuntimeProvider>> = {
  "claude-code": "claude-code",
  codex: "codex",
  opencode: "opencode",
  "gemini-cli": "gemini-cli"
};

/**
 * Maps the desktop's real runtime adapter statuses into capability entries the composer can resolve
 * against. Availability is read straight from discovery — an adapter whose executable is missing is
 * `installed: false`; one whose only problem is authentication is `installed: true` but
 * `authenticated: false`. The composer treats only fully usable entries as bindable, so an installed
 * but unauthenticated runtime is ignored exactly as the acceptance criteria require.
 */
export function deriveAgentRuntimeCapabilities(
  adapters: readonly RuntimeAdapterStatus[],
  now: string
): AgentRuntimeCapability[] {
  // The shell is a terminal, not an agent that can own a workflow role, so it never enters the
  // capability registry the composer resolves against.
  return adapters
    .filter((adapter) => adapter.id !== "shell")
    .map((adapter) => {
      const issue = adapter.issue?.code ?? null;
      const missingExecutable =
        issue === "adapter_executable_not_found" || issue === "adapter_platform_unsupported";
      const installed = adapter.available || (issue !== null && !missingExecutable);
      const authenticated = adapter.available;
      return agentRuntimeCapabilitySchema.parse({
        runtimeId: adapter.id,
        provider: providerById[adapter.id] ?? "custom",
        displayName: adapter.displayName,
        installed,
        authenticated,
        enabled: true,
        supportsParallelSessions: adapter.capabilities.messageQueue,
        maxConcurrentSessions: adapter.capabilities.messageQueue ? 4 : 1,
        activeSessions: 0,
        availableModels: [],
        capabilities: adapterCapabilityList(adapter),
        lastCheckedAt: now
      });
    });
}

function adapterCapabilityList(adapter: RuntimeAdapterStatus): string[] {
  const capabilities = ["code"];
  if (adapter.capabilities.interactive) capabilities.push("interactive");
  if (adapter.capabilities.nonInteractive) capabilities.push("non_interactive");
  if (adapter.capabilities.structuredOutput) capabilities.push("structured_output");
  if (adapter.capabilities.mcp) capabilities.push("mcp");
  if (adapter.capabilities.imageInput) capabilities.push("image_input");
  return capabilities;
}
