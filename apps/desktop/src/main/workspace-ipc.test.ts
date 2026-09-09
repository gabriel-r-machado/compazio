import { describe, expect, it, vi } from "vitest";

import {
  handleWorkspaceCreate,
  handleWorkspaceList,
  handleWorkspaceReorder,
  handleWorkspaceUpdate
} from "./workspace-ipc";

const workspaceId = "44ec433d-b530-46c8-874c-c678a607c295";
const projectId = "5f752ec1-4f1e-4d78-9252-60e59f174b73";
const record = {
  id: workspaceId,
  projectId,
  canvasId: `workspace-${workspaceId}`,
  title: "API",
  position: 0,
  isOpen: true,
  createdAt: "2026-07-17T12:00:00.000Z",
  updatedAt: "2026-07-17T12:00:00.000Z"
};

describe("workspace IPC handlers", () => {
  it("never accepts a renderer path and maps legacy adoption explicitly", () => {
    const repository = createRepository();
    expect(() => handleWorkspaceCreate(repository, { projectId, path: "C:/private" })).toThrow();
    expect(handleWorkspaceCreate(repository, { projectId, adoptLegacyCanvas: true })).toEqual(
      record
    );
    expect(repository.create).toHaveBeenCalledWith({
      projectId,
      legacyCanvasId: "default"
    });
  });

  it("lists, updates and reorders through bounded typed requests", () => {
    const repository = createRepository();
    expect(handleWorkspaceList(repository, undefined)).toEqual([record]);
    expect(handleWorkspaceUpdate(repository, { workspaceId, title: "Renamed" }).title).toBe("API");
    expect(handleWorkspaceReorder(repository, { workspaceIds: [workspaceId] })).toEqual([record]);
    expect(() => handleWorkspaceList(repository, {})).toThrow();
  });
});

function createRepository() {
  return {
    list: vi.fn(() => [record]),
    create: vi.fn(() => record),
    rename: vi.fn(() => record),
    setOpen: vi.fn(() => record),
    reorder: vi.fn(() => [record])
  };
}
