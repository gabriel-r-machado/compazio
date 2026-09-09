import type { IpcMain } from "electron";

import {
  HANDOFF_CREATE_DRAFT_CHANNEL,
  HANDOFF_AWAIT_DESTINATION_CHANNEL,
  HANDOFF_CANCEL_DELIVERY_CHANNEL,
  HANDOFF_DELIVER_CHANNEL,
  HANDOFF_LIST_CHANNEL,
  HANDOFF_LIST_EVENTS_CHANNEL,
  HANDOFF_MARK_READY_CHANNEL,
  HANDOFF_MARK_SENT_CHANNEL,
  HANDOFF_RETRY_CHANNEL,
  HANDOFF_UPDATE_DRAFT_CHANNEL,
  canvasHandoffEventSchema,
  canvasHandoffSchema,
  handoffCreateDraftRequestSchema,
  handoffAwaitDestinationRequestSchema,
  handoffCancelDeliveryRequestSchema,
  handoffDeliverRequestSchema,
  handoffListEventsRequestSchema,
  handoffListRequestSchema,
  handoffMarkReadyRequestSchema,
  handoffMarkSentRequestSchema,
  handoffRetryRequestSchema,
  handoffUpdateDraftRequestSchema
} from "@forgedeck/schemas";

import type { HandoffService } from "./handoff-service";

type HandoffApi = Pick<
  HandoffService,
  | "createDraft"
  | "updateDraft"
  | "markReady"
  | "deliver"
  | "awaitDestination"
  | "retry"
  | "markSent"
  | "cancelDelivery"
  | "list"
  | "listEvents"
>;

export function registerHandoffIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  service: HandoffApi
): void {
  register(ipc, HANDOFF_CREATE_DRAFT_CHANNEL, (payload) => handleCreateDraft(service, payload));
  register(ipc, HANDOFF_UPDATE_DRAFT_CHANNEL, (payload) => handleUpdateDraft(service, payload));
  register(ipc, HANDOFF_MARK_READY_CHANNEL, (payload) => handleMarkReady(service, payload));
  register(ipc, HANDOFF_DELIVER_CHANNEL, (payload) => handleDeliver(service, payload));
  register(ipc, HANDOFF_AWAIT_DESTINATION_CHANNEL, (payload) =>
    handleAwaitDestination(service, payload)
  );
  register(ipc, HANDOFF_RETRY_CHANNEL, (payload) => handleRetry(service, payload));
  register(ipc, HANDOFF_MARK_SENT_CHANNEL, (payload) => handleMarkSent(service, payload));
  register(ipc, HANDOFF_CANCEL_DELIVERY_CHANNEL, (payload) =>
    handleCancelDelivery(service, payload)
  );
  register(ipc, HANDOFF_LIST_CHANNEL, (payload) => handleList(service, payload));
  register(ipc, HANDOFF_LIST_EVENTS_CHANNEL, (payload) => handleListEvents(service, payload));
}

export function handleCreateDraft(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(
    service.createDraft(handoffCreateDraftRequestSchema.parse(payload))
  );
}

export function handleUpdateDraft(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(
    service.updateDraft(handoffUpdateDraftRequestSchema.parse(payload))
  );
}

export function handleMarkReady(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(service.markReady(handoffMarkReadyRequestSchema.parse(payload)));
}

export async function handleDeliver(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(
    await service.deliver(handoffDeliverRequestSchema.parse(payload))
  );
}

export function handleAwaitDestination(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(
    service.awaitDestination(handoffAwaitDestinationRequestSchema.parse(payload))
  );
}

export async function handleRetry(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(await service.retry(handoffRetryRequestSchema.parse(payload)));
}

export function handleMarkSent(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(service.markSent(handoffMarkSentRequestSchema.parse(payload)));
}

export function handleCancelDelivery(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.parse(
    service.cancelDelivery(handoffCancelDeliveryRequestSchema.parse(payload))
  );
}

export function handleList(service: HandoffApi, payload: unknown) {
  return canvasHandoffSchema.array().parse(service.list(handoffListRequestSchema.parse(payload)));
}

export function handleListEvents(service: HandoffApi, payload: unknown) {
  const request = handoffListEventsRequestSchema.parse(payload);
  return canvasHandoffEventSchema.array().parse(service.listEvents(request.handoffId));
}

function register(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => unknown
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}
