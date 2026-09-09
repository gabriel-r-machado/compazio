import type { IpcMain } from "electron";

import type { SqliteWorkspaceRepository } from "@forgedeck/local-db";
import {
  WORKSPACES_CREATE_CHANNEL,
  WORKSPACES_LIST_CHANNEL,
  WORKSPACES_REORDER_CHANNEL,
  WORKSPACES_UPDATE_CHANNEL,
  workspaceCreateRequestSchema,
  workspaceListResponseSchema,
  workspaceReorderRequestSchema,
  workspaceSchema,
  workspaceUpdateRequestSchema
} from "@forgedeck/schemas";

type WorkspaceRepository = Pick<
  SqliteWorkspaceRepository,
  "list" | "create" | "rename" | "setOpen" | "reorder"
>;

export function registerWorkspaceIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  repository: WorkspaceRepository
): void {
  register(ipc, WORKSPACES_LIST_CHANNEL, (payload) => handleWorkspaceList(repository, payload));
  register(ipc, WORKSPACES_CREATE_CHANNEL, (payload) => handleWorkspaceCreate(repository, payload));
  register(ipc, WORKSPACES_UPDATE_CHANNEL, (payload) => handleWorkspaceUpdate(repository, payload));
  register(ipc, WORKSPACES_REORDER_CHANNEL, (payload) =>
    handleWorkspaceReorder(repository, payload)
  );
}

export function handleWorkspaceList(repository: WorkspaceRepository, payload: unknown) {
  assertNoPayload(payload);
  return workspaceListResponseSchema.parse(repository.list());
}

export function handleWorkspaceCreate(repository: WorkspaceRepository, payload: unknown) {
  const request = workspaceCreateRequestSchema.parse(payload);
  return workspaceSchema.parse(
    repository.create({
      projectId: request.projectId,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.adoptLegacyCanvas ? { legacyCanvasId: "default" as const } : {})
    })
  );
}

export function handleWorkspaceUpdate(repository: WorkspaceRepository, payload: unknown) {
  const request = workspaceUpdateRequestSchema.parse(payload);
  let workspace =
    request.title === undefined ? null : repository.rename(request.workspaceId, request.title);
  if (request.isOpen !== undefined) {
    workspace = repository.setOpen(request.workspaceId, request.isOpen);
  }
  if (workspace === null) {
    throw new Error("Workspace update did not contain a supported change");
  }
  return workspaceSchema.parse(workspace);
}

export function handleWorkspaceReorder(repository: WorkspaceRepository, payload: unknown) {
  const request = workspaceReorderRequestSchema.parse(payload);
  return workspaceListResponseSchema.parse(repository.reorder(request.workspaceIds));
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
    throw new Error("This workspace IPC channel does not accept a payload");
  }
}
