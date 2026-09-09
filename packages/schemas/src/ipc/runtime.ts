import { z } from "zod";

export const RUNTIME_LIST_ADAPTERS_CHANNEL = "runtime:list-adapters" as const;
export const RUNTIME_DIAGNOSTICS_CHANNEL = "runtime:diagnostics" as const;

export const runtimeAdapterCapabilitiesSchema = z
  .object({
    interactive: z.boolean(),
    nonInteractive: z.boolean(),
    resume: z.boolean(),
    structuredOutput: z.boolean(),
    mcp: z.boolean(),
    imageInput: z.boolean(),
    messageQueue: z.boolean()
  })
  .strict();

export const runtimeAdapterIssueSchema = z
  .object({
    code: z.enum([
      "adapter_executable_not_found",
      "adapter_platform_unsupported",
      "adapter_auth_unavailable",
      "adapter_detection_failed"
    ]),
    message: z.string(),
    remediation: z.string()
  })
  .strict();

export const runtimeAdapterStatusSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    available: z.boolean(),
    version: z.string().nullable(),
    issue: runtimeAdapterIssueSchema.nullable(),
    capabilities: runtimeAdapterCapabilitiesSchema
  })
  .strict();

export const runtimeListAdaptersResponseSchema = z.array(runtimeAdapterStatusSchema);

export const runtimeDiagnosticsSchema = z
  .object({
    platform: z.enum(["win32", "darwin", "linux"]),
    architecture: z.string(),
    nodeVersion: z.string(),
    terminalBackend: z.literal("node-pty"),
    interruptedSessionsRecovered: z.number().int().nonnegative(),
    interruptedRunsRecovered: z.number().int().nonnegative().default(0),
    interruptedWorktreeLeasesRecovered: z.number().int().nonnegative().default(0),
    interruptedProjectLeasesRecovered: z.number().int().nonnegative().default(0),
    interruptedGateRunsRecovered: z.number().int().nonnegative().default(0),
    adapters: runtimeListAdaptersResponseSchema
  })
  .strict();

export type RuntimeAdapterStatus = z.infer<typeof runtimeAdapterStatusSchema>;
export type RuntimeDiagnostics = z.infer<typeof runtimeDiagnosticsSchema>;
