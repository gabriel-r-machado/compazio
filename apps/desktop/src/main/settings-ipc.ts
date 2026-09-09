import type { IpcMain } from "electron";

import type { SqliteAppSettingsRepository } from "@forgedeck/local-db";
import {
  SETTINGS_GET_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  appSettingsSchema,
  appSettingsUpdateRequestSchema
} from "@forgedeck/schemas";

type SettingsRepository = Pick<
  SqliteAppSettingsRepository,
  | "getLocale"
  | "setLocale"
  | "getTheme"
  | "setTheme"
  | "getActiveWorkspaceId"
  | "setActiveWorkspaceId"
>;

export function registerSettingsIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  repository: SettingsRepository
): void {
  register(ipc, SETTINGS_GET_CHANNEL, (payload) => handleSettingsGet(repository, payload));
  register(ipc, SETTINGS_UPDATE_CHANNEL, (payload) => handleSettingsUpdate(repository, payload));
}

export function handleSettingsGet(repository: SettingsRepository, payload: unknown) {
  assertNoPayload(payload);
  return readSettings(repository);
}

export function handleSettingsUpdate(repository: SettingsRepository, payload: unknown) {
  const request = appSettingsUpdateRequestSchema.parse(payload);
  if (request.locale !== undefined) {
    repository.setLocale(request.locale);
  }
  if (request.theme !== undefined) {
    repository.setTheme(request.theme);
  }
  if (request.activeWorkspaceId !== undefined) {
    repository.setActiveWorkspaceId(request.activeWorkspaceId);
  }
  return readSettings(repository);
}

function readSettings(repository: SettingsRepository) {
  return appSettingsSchema.parse({
    locale: repository.getLocale(),
    theme: repository.getTheme(),
    activeWorkspaceId: repository.getActiveWorkspaceId()
  });
}

function register(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  channel: string,
  handler: (payload: unknown) => unknown
): void {
  ipc.removeHandler(channel);
  ipc.handle(channel, (_event, payload: unknown) => handler(payload));
}

function assertNoPayload(payload: unknown): void {
  if (payload !== undefined) {
    throw new Error("This settings IPC channel does not accept a payload");
  }
}
