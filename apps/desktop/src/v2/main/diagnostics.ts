import { createHash } from "node:crypto";
import { arch, platform, release } from "node:os";

import { sanitizeEventMetadata, WORKSPACE_SCHEMA_VERSION } from "@forgedeck/compazio-v2-domain";
import type { AgentRuntime, V2ProcessSupervisor } from "@forgedeck/compazio-v2-runtime";

import type { V2OperationalService } from "./operational-service";
import type { V2OrchestratorBridge } from "./orchestrator-bridge";
import type { V2WorkspaceService } from "./workspace-service";

export interface V2DiagnosticsOptions {
  readonly version: string;
  readonly workspaces: V2WorkspaceService;
  readonly operations: V2OperationalService;
  readonly agents: AgentRuntime;
  readonly supervisor: V2ProcessSupervisor;
  readonly bridge: V2OrchestratorBridge;
  readonly now?: () => string;
}

export async function createSafeV2Diagnostics(
  workspaceId: string,
  options: V2DiagnosticsOptions
): Promise<string> {
  const [workspace, operations, installations] = await Promise.all([
    options.workspaces.snapshot(workspaceId),
    options.operations.get(workspaceId),
    options.agents.detectAll()
  ]);
  const sessions = options.supervisor
    .list()
    .filter((session) => session.workspaceId === workspaceId);
  const terminalIds = new Set(
    workspace.nodes.filter((node) => node.type === "terminal").map((node) => node.id)
  );
  const anonymousWorkspaceId = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
  const failures = [
    ...operations.runs.flatMap((run) => (run.failure === undefined ? [] : [run.failure])),
    ...operations.tasks.flatMap((task) => (task.failure === undefined ? [] : [task.failure]))
  ].map(({ code, message, suggestedAction, retryable, correlationId }) => ({
    code,
    message,
    suggestedAction,
    retryable,
    correlationId
  }));
  const report = {
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    compazioVersion: options.version,
    runtime: {
      electron: process.versions.electron ?? "unavailable",
      node: process.versions.node,
      architecture: arch()
    },
    operatingSystem: { platform: platform(), release: release(), architecture: arch() },
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspace: {
      anonymousId: anonymousWorkspaceId,
      nodeCount: workspace.nodes.length,
      edgeCount: workspace.edges.length
    },
    agents: installations.map((installation) => ({
      agentId: installation.agentId,
      status: installation.status,
      ...(installation.version === undefined ? {} : { version: installation.version }),
      ...(installation.error === undefined ? {} : { errorCode: installation.error.code })
    })),
    supervisor: {
      ...options.supervisor.diagnostics(),
      sessions: sessions.map((session) => ({
        terminalNodeId: session.terminalNodeId,
        state: session.state,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        exitCode: session.exitCode
      })),
      orphanedSessionCount: sessions.filter((session) => !terminalIds.has(session.terminalNodeId))
        .length
    },
    bridge: options.bridge.diagnostics(),
    operations: {
      policyId: operations.policyId,
      runs: operations.runs.map((run) => ({
        id: run.id,
        status: run.status,
        taskCount: run.taskIds.length,
        recruitedAgentCount: run.recruitedTerminalIds.length,
        updatedAt: run.updatedAt
      })),
      tasks: operations.tasks.map((task) => ({
        id: task.id,
        runId: task.runId,
        status: task.status,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts
      })),
      openAttentionCount: operations.attention.filter((request) => request.status === "open")
        .length,
      activityCount: operations.activities.length,
      eventCount: operations.events.length,
      recoveryActionCount: operations.recoveryActions.length,
      failures,
      latestEvents: operations.events.slice(-100).map((event) => ({
        id: event.id,
        type: event.type,
        runId: event.runId,
        actor: event.actor === workspaceId ? `workspace:${anonymousWorkspaceId}` : event.actor,
        target: event.target === workspaceId ? `workspace:${anonymousWorkspaceId}` : event.target,
        timestamp: event.timestamp,
        correlationId: event.correlationId,
        metadata: sanitizeEventMetadata(event.metadata)
      }))
    },
    privacy: {
      omitted: [
        "tokens",
        "credentials",
        "prompts",
        "terminal output",
        "file contents",
        "environment variables",
        "personal paths"
      ]
    }
  };
  return JSON.stringify(report, null, 2);
}
