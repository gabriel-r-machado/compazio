import type { IpcMain } from "electron";

import {
  AdapterRegistry,
  AgentBridge,
  ExecFileCommandRunner,
  PathExecutableDetector
} from "@forgedeck/agent-adapters";
import {
  RUNTIME_DIAGNOSTICS_CHANNEL,
  RUNTIME_LIST_ADAPTERS_CHANNEL,
  runtimeDiagnosticsSchema,
  runtimeListAdaptersResponseSchema
} from "@forgedeck/schemas";
import type { RuntimeAdapterStatus, RuntimeDiagnostics } from "@forgedeck/schemas";
import { redactText } from "@forgedeck/logger";
import { createAllowedEnvironment } from "@forgedeck/terminal";

interface RuntimeIpcOptions {
  readonly interruptedSessionsRecovered: number;
  readonly interruptedRunsRecovered?: number;
  readonly interruptedWorktreeLeasesRecovered?: number;
  readonly interruptedProjectLeasesRecovered?: number;
  readonly interruptedGateRunsRecovered?: number;
}

/**
 * Inspects the real agent runtime adapters (executable presence, auth, capabilities). Shared by the
 * runtime IPC and the workflow-draft composer so runtime availability always comes from one honest
 * source and is never assumed.
 */
export async function inspectRuntimeAdapters(): Promise<RuntimeAdapterStatus[]> {
  const platform = normalizePlatform(process.platform);
  const environment = createAllowedEnvironment(process.env);
  const statuses = await new AgentBridge(new AdapterRegistry()).inspect({
    platform,
    environment,
    cwd: process.cwd(),
    detector: new PathExecutableDetector(),
    commandRunner: new ExecFileCommandRunner()
  });
  return runtimeListAdaptersResponseSchema.parse(
    statuses.map((status) =>
      sanitizeRuntimeAdapterStatus({
        id: status.id,
        displayName: status.displayName,
        available: status.available,
        version: status.version,
        issue: status.issue,
        capabilities: status.capabilities
      })
    )
  );
}

export function registerRuntimeIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  options: RuntimeIpcOptions
): void {
  const loadAdapters = inspectRuntimeAdapters;

  ipc.removeHandler(RUNTIME_LIST_ADAPTERS_CHANNEL);
  ipc.handle(RUNTIME_LIST_ADAPTERS_CHANNEL, () => loadAdapters());
  ipc.removeHandler(RUNTIME_DIAGNOSTICS_CHANNEL);
  ipc.handle(RUNTIME_DIAGNOSTICS_CHANNEL, async (): Promise<RuntimeDiagnostics> =>
    runtimeDiagnosticsSchema.parse({
      platform: normalizePlatform(process.platform),
      architecture: process.arch,
      nodeVersion: process.versions.node,
      terminalBackend: "node-pty",
      interruptedSessionsRecovered: options.interruptedSessionsRecovered,
      interruptedRunsRecovered: options.interruptedRunsRecovered ?? 0,
      interruptedWorktreeLeasesRecovered: options.interruptedWorktreeLeasesRecovered ?? 0,
      interruptedProjectLeasesRecovered: options.interruptedProjectLeasesRecovered ?? 0,
      interruptedGateRunsRecovered: options.interruptedGateRunsRecovered ?? 0,
      adapters: await loadAdapters()
    })
  );
}

export function sanitizeRuntimeAdapterStatus(status: RuntimeAdapterStatus): RuntimeAdapterStatus {
  return {
    ...status,
    displayName: redactText(status.displayName),
    version: status.version === null ? null : redactText(status.version),
    issue:
      status.issue === null
        ? null
        : {
            ...status.issue,
            message: redactText(status.issue.message),
            remediation: redactText(status.issue.remediation)
          }
  };
}

function normalizePlatform(platform: NodeJS.Platform): "win32" | "darwin" | "linux" {
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(`Unsupported runtime platform: ${platform}`);
}
