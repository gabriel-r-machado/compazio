import { describe, expect, it } from "vitest";

import {
  mergeConfirmRequestSchema,
  projectBranchesResponseSchema,
  qualityGateRunRequestSchema,
  worktreeCreateRequestSchema
} from "./git";

describe("Git IPC schemas", () => {
  it("does not accept renderer-controlled paths, refs or commands", () => {
    expect(() =>
      worktreeCreateRequestSchema.parse({
        projectId: "project-1",
        taskKey: "TASK-1",
        taskTitle: "Safe task",
        path: "C:/renderer-controlled",
        branchName: "main",
        command: "rm -rf"
      })
    ).toThrow();
  });

  it("requires explicit confirmation for gate and merge mutations", () => {
    expect(() =>
      qualityGateRunRequestSchema.parse({
        worktreeId: "worktree-1",
        presetId: "test",
        confirmed: false
      })
    ).toThrow();
    expect(() =>
      mergeConfirmRequestSchema.parse({
        planId: "plan-1",
        confirmationToken: "a".repeat(64),
        confirmed: false
      })
    ).toThrow();
  });

  it("exposes only a dirty flag during branch-switch preflight", () => {
    expect(
      projectBranchesResponseSchema.parse({
        currentBranch: "main",
        dirty: true,
        branches: [{ name: "main", current: true }]
      })
    ).toEqual({
      currentBranch: "main",
      dirty: true,
      branches: [{ name: "main", current: true }]
    });
    expect(() =>
      projectBranchesResponseSchema.parse({
        currentBranch: "main",
        dirty: true,
        changedPaths: ["C:/private/project/.env"],
        branches: []
      })
    ).toThrow();
  });
});
