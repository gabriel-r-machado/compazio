import { describe, expect, it } from "vitest";

import {
  workspaceCreateRequestSchema,
  workspaceReorderRequestSchema,
  workspaceUpdateRequestSchema
} from "./workspace";
import { appSettingsUpdateRequestSchema } from "./settings";

const workspaceId = "44ec433d-b530-46c8-874c-c678a607c295";
const projectId = "5f752ec1-4f1e-4d78-9252-60e59f174b73";

describe("workspace and settings IPC schemas", () => {
  it("accepts identifiers and rejects paths or arbitrary settings", () => {
    expect(workspaceCreateRequestSchema.parse({ projectId })).toEqual({
      projectId,
      adoptLegacyCanvas: false
    });
    expect(
      workspaceCreateRequestSchema.safeParse({ projectId, path: "C:/private/project" }).success
    ).toBe(false);
    expect(appSettingsUpdateRequestSchema.safeParse({ locale: "fr" }).success).toBe(false);
    expect(appSettingsUpdateRequestSchema.safeParse({ telemetry: true }).success).toBe(false);
  });

  it("requires an explicit workspace update and unique reorder ids", () => {
    expect(workspaceUpdateRequestSchema.safeParse({ workspaceId }).success).toBe(false);
    expect(
      workspaceUpdateRequestSchema.safeParse({ workspaceId, title: "API workspace" }).success
    ).toBe(true);
    expect(
      workspaceReorderRequestSchema.safeParse({ workspaceIds: [workspaceId, workspaceId] }).success
    ).toBe(false);
  });
});
