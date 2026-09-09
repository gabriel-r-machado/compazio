import type { IpcMain } from "electron";

import type { SqliteWorkspaceIncidentStore } from "@forgedeck/local-db";
import {
  WORKSPACE_INCIDENTS_LIST_CHANNEL,
  workspaceIncidentListRequestSchema,
  workspaceIncidentListResponseSchema
} from "@forgedeck/schemas";

type IncidentStore = Pick<SqliteWorkspaceIncidentStore, "list">;

/**
 * Read-only surface over failures the runtime already recorded. It answers a question the renderer
 * asks; it never pushes, so a reload rehydrates the panel instead of depending on an event that may
 * have been emitted while no window was listening.
 */
export function registerWorkspaceIncidentIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  store: IncidentStore
): void {
  ipc.removeHandler(WORKSPACE_INCIDENTS_LIST_CHANNEL);
  ipc.handle(WORKSPACE_INCIDENTS_LIST_CHANNEL, (_event, payload: unknown) =>
    handleWorkspaceIncidentList(store, payload)
  );
}

export function handleWorkspaceIncidentList(store: IncidentStore, payload: unknown) {
  const request = workspaceIncidentListRequestSchema.parse(payload);
  return workspaceIncidentListResponseSchema.parse(
    store.list({ workspaceId: request.workspaceId, limit: request.limit })
  );
}
