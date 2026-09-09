import type { IpcMain } from "electron";

import type { SqliteCanvasRepository } from "@forgedeck/local-db";
import {
  CANVAS_LOAD_CHANNEL,
  CANVAS_SAVE_CHANNEL,
  canvasLoadRequestSchema,
  canvasLoadResponseSchema,
  canvasSaveRequestSchema,
  canvasSaveResponseSchema
} from "@forgedeck/schemas";

export function registerCanvasIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  repository: SqliteCanvasRepository
): void {
  ipc.removeHandler(CANVAS_LOAD_CHANNEL);
  ipc.handle(CANVAS_LOAD_CHANNEL, (_event, payload: unknown) =>
    handleCanvasLoad(repository, payload)
  );

  ipc.removeHandler(CANVAS_SAVE_CHANNEL);
  ipc.handle(CANVAS_SAVE_CHANNEL, (_event, payload: unknown) =>
    handleCanvasSave(repository, payload)
  );
}

export function handleCanvasLoad(
  repository: Pick<SqliteCanvasRepository, "load">,
  payload: unknown
) {
  const request = canvasLoadRequestSchema.parse(payload);
  return canvasLoadResponseSchema.parse({ snapshot: repository.load(request.canvasId) });
}

export function handleCanvasSave(
  repository: Pick<SqliteCanvasRepository, "save">,
  payload: unknown
) {
  const request = canvasSaveRequestSchema.parse(payload);
  return canvasSaveResponseSchema.parse(repository.save(request.snapshot));
}
