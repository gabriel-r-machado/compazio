import type { IpcMain } from "electron";

import {
  SYSTEM_PING_CHANNEL,
  systemPingRequestSchema,
  systemPingResponseSchema
} from "@forgedeck/schemas";
import type { SystemPingResponse } from "@forgedeck/schemas";

export function handleSystemPing(payload: unknown): SystemPingResponse {
  const request = systemPingRequestSchema.parse(payload);
  return systemPingResponseSchema.parse({
    requestId: request.requestId,
    ok: true,
    mainProcessTime: new Date().toISOString()
  });
}

export function registerSystemIpc(ipc: Pick<IpcMain, "handle" | "removeHandler">): void {
  ipc.removeHandler(SYSTEM_PING_CHANNEL);
  ipc.handle(SYSTEM_PING_CHANNEL, (_event, payload: unknown) => handleSystemPing(payload));
}
