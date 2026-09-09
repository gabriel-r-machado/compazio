import type { IpcMain } from "electron";

import {
  ORCHESTRATOR_SESSION_CANCEL_CHANNEL,
  ORCHESTRATOR_SESSION_SEND_OBJECTIVE_CHANNEL,
  ORCHESTRATOR_SESSION_START_CHANNEL,
  orchestratorSessionCancelRequestSchema,
  orchestratorSessionCancelResponseSchema,
  orchestratorSessionSendObjectiveRequestSchema,
  orchestratorSessionSendObjectiveResponseSchema,
  orchestratorSessionStartRequestSchema,
  orchestratorSessionStartResponseSchema
} from "@forgedeck/schemas";
import type { WorkflowComposition } from "@forgedeck/schemas";

import type { OrchestratorDraftDriver } from "./orchestrator-draft-driver";
import type { OrchestratorSessionService } from "./orchestrator-session-service";

/**
 * Wires the real orchestrator session channels. `start` spawns an orchestrator-capable CLI session and
 * attaches the draft driver to it, so the session's output becomes ghost nodes. `send-objective` writes
 * the primed prompt to that session. Neither channel starts a worker or touches files — composition can
 * only shape a draft; execution waits for the user's inline approval.
 */
export interface OrchestratorSessionIpcDeps {
  readonly service: OrchestratorSessionService;
  readonly driver: OrchestratorDraftDriver;
  readonly publishComposition: (composition: WorkflowComposition) => void;
}

export function registerOrchestratorSessionIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  deps: OrchestratorSessionIpcDeps
): void {
  deps.service.onCompositionUpdated(deps.publishComposition);
  handle(ipc, ORCHESTRATOR_SESSION_START_CHANNEL, async (payload) => {
    const request = orchestratorSessionStartRequestSchema.parse(payload);
    const result = await deps.service.start({
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      ...(request.preferredRuntimeId === undefined
        ? {}
        : { preferredRuntimeId: request.preferredRuntimeId })
    });
    // From now on, this session's output composes the workspace's draft.
    deps.driver.attach({
      sessionId: result.sessionId,
      workspaceId: request.workspaceId,
      creationMode: "automatic",
      executionProfile: request.executionProfile
    });
    return orchestratorSessionStartResponseSchema.parse(result);
  });

  handle(ipc, ORCHESTRATOR_SESSION_SEND_OBJECTIVE_CHANNEL, async (payload) => {
    const request = orchestratorSessionSendObjectiveRequestSchema.parse(payload);
    // Persist the pending composition before the CLI receives any text. This is what lets a restart
    // surface it as interrupted/retryable even if the agent never emits a first action.
    await deps.driver.beginComposition(request.sessionId, request.objective);
    await deps.service.sendObjective({
      sessionId: request.sessionId,
      objective: request.objective,
      canvas: request.canvas,
      executionProfile: request.executionProfile,
      ...(request.reuseRecentPlan === undefined ? {} : { reuseRecentPlan: request.reuseRecentPlan })
    });
    return orchestratorSessionSendObjectiveResponseSchema.parse({ accepted: true });
  });

  handle(ipc, ORCHESTRATOR_SESSION_CANCEL_CHANNEL, async (payload) => {
    const request = orchestratorSessionCancelRequestSchema.parse(payload);
    const composition = await deps.service.cancel(request.sessionId);
    deps.driver.detach(request.sessionId);
    return orchestratorSessionCancelResponseSchema.parse(composition);
  });
}

function handle(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => Promise<unknown>
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}
