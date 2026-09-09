import { describe, expect, it } from "vitest";

import type { WorkspaceDto } from "@forgedeck/schemas";

import {
  findWorkspaceForProject,
  replaceWorkspace,
  selectInitialWorkspace
} from "./workspace-state";

const first = workspace("302f7b3b-bda6-4f69-bc21-b7403177bbf9", "project-a", 0, true);
const second = workspace("c5fc2ed7-f7f2-4cb8-a04a-94ed90acd069", "project-b", 1, true);

describe("workspace tab state", () => {
  it("restores the persisted active open workspace and ignores closed tabs", () => {
    expect(selectInitialWorkspace([first, second], second.id)?.id).toBe(second.id);
    expect(selectInitialWorkspace([{ ...first, isOpen: false }, second], first.id)?.id).toBe(
      second.id
    );
  });

  it("finds an existing project workspace and replaces it without duplicates", () => {
    expect(findWorkspaceForProject([first, second], "project-b")?.id).toBe(second.id);
    const renamed = { ...first, title: "Renamed" };
    expect(replaceWorkspace([first, second], renamed)).toEqual([renamed, second]);
  });
});

function workspace(id: string, projectId: string, position: number, isOpen: boolean): WorkspaceDto {
  return {
    id,
    projectId,
    canvasId: `canvas-${id}`,
    title: projectId,
    position,
    isOpen,
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z"
  };
}
