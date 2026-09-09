import type { IpcMain } from "electron";

import {
  AUTOMATIC_APPROVE_CHANNEL,
  AUTOMATIC_CANCEL_CHANNEL,
  AUTOMATIC_CREATE_CHANNEL,
  AUTOMATIC_LIST_CHANNEL,
  AUTOMATIC_ORCHESTRATORS_CHANNEL,
  AUTOMATIC_PAUSE_CHANNEL,
  AUTOMATIC_REJECT_CHANNEL,
  AUTOMATIC_RESUME_CHANNEL,
  AUTOMATIC_SHOW_CHANNEL,
  AUTOMATIC_START_CHANNEL,
  automaticApprovalDecisionRequestSchema,
  automaticCreateRequestSchema,
  automaticListRequestSchema,
  automaticListResponseSchema,
  automaticOrchestratorListResponseSchema,
  automaticRunRefSchema,
  automaticRunSnapshotSchema,
  type AutomaticListResponse,
  type AutomaticRunSnapshotDto
} from "@forgedeck/schemas";

import type { AutomaticModeService } from "./automatic-mode-service";

/**
 * The main-process IPC surface for automatic mode. Every request is parsed with its schema BEFORE the
 * service is touched, so an invalid payload is rejected without side effects, and every response is parsed
 * on the way out, so a projection that accidentally carried a prompt or a path cannot reach the renderer.
 *
 * The renderer only ever names an objective, a mode, a session and a decision. It never receives a store, a
 * runtime, an adapter, a SQLite handle or a workflow definition.
 */

export const AUTOMATIC_IPC_CHANNELS = [
  AUTOMATIC_CREATE_CHANNEL,
  AUTOMATIC_START_CHANNEL,
  AUTOMATIC_SHOW_CHANNEL,
  AUTOMATIC_LIST_CHANNEL,
  AUTOMATIC_PAUSE_CHANNEL,
  AUTOMATIC_RESUME_CHANNEL,
  AUTOMATIC_CANCEL_CHANNEL,
  AUTOMATIC_APPROVE_CHANNEL,
  AUTOMATIC_REJECT_CHANNEL,
  AUTOMATIC_ORCHESTRATORS_CHANNEL
] as const;

export function registerAutomaticIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  service: AutomaticModeService
): () => void {
  const snapshot = (value: AutomaticRunSnapshotDto): AutomaticRunSnapshotDto =>
    automaticRunSnapshotSchema.parse(value);

  ipc.handle(AUTOMATIC_CREATE_CHANNEL, async (_event, payload: unknown) => {
    const request = automaticCreateRequestSchema.parse(payload);
    return snapshot(await service.create(request));
  });

  // Availability only: listing planners never starts a planning turn and never touches a credential.
  ipc.handle(AUTOMATIC_ORCHESTRATORS_CHANNEL, async () =>
    automaticOrchestratorListResponseSchema.parse({
      orchestrators: [...(await service.orchestrators())]
    })
  );

  ipc.handle(AUTOMATIC_START_CHANNEL, async (_event, payload: unknown) => {
    const { automaticRunId } = automaticRunRefSchema.parse(payload);
    return snapshot(await service.start(automaticRunId));
  });

  ipc.handle(AUTOMATIC_SHOW_CHANNEL, async (_event, payload: unknown) => {
    const { automaticRunId } = automaticRunRefSchema.parse(payload);
    return snapshot(service.show(automaticRunId));
  });

  ipc.handle(AUTOMATIC_LIST_CHANNEL, async (_event, payload: unknown) => {
    const request = automaticListRequestSchema.parse(payload ?? {});
    const response: AutomaticListResponse = {
      runs: [
        ...service.list({
          ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
          ...(request.limit === undefined ? {} : { limit: request.limit })
        })
      ]
    };
    return automaticListResponseSchema.parse(response);
  });

  ipc.handle(AUTOMATIC_PAUSE_CHANNEL, async (_event, payload: unknown) => {
    const { automaticRunId } = automaticRunRefSchema.parse(payload);
    return snapshot(await service.pause(automaticRunId));
  });

  ipc.handle(AUTOMATIC_RESUME_CHANNEL, async (_event, payload: unknown) => {
    const { automaticRunId } = automaticRunRefSchema.parse(payload);
    return snapshot(await service.resume(automaticRunId));
  });

  ipc.handle(AUTOMATIC_CANCEL_CHANNEL, async (_event, payload: unknown) => {
    const { automaticRunId } = automaticRunRefSchema.parse(payload);
    return snapshot(await service.cancel(automaticRunId));
  });

  ipc.handle(AUTOMATIC_APPROVE_CHANNEL, async (_event, payload: unknown) => {
    const request = automaticApprovalDecisionRequestSchema.parse(payload);
    return snapshot(await service.decide({ ...request, decision: "approved" }));
  });

  ipc.handle(AUTOMATIC_REJECT_CHANNEL, async (_event, payload: unknown) => {
    const request = automaticApprovalDecisionRequestSchema.parse(payload);
    return snapshot(await service.decide({ ...request, decision: "rejected" }));
  });

  return () => {
    for (const channel of AUTOMATIC_IPC_CHANNELS) ipc.removeHandler(channel);
  };
}
