import { describe, expect, it } from "vitest";

import { appendWorkspaceNoteSchema, createWorkspaceNoteSchema } from "./workspace-notes";

describe("workspace note schemas", () => {
  it("accepts a durable note created by a local user", () => {
    expect(
      createWorkspaceNoteSchema.parse({
        workspaceId: "workspace-1",
        title: "Decisões de autenticação",
        content: "",
        createdByNodeId: null,
        idempotencyKey: "note-create-1"
      })
    ).toMatchObject({ title: "Decisões de autenticação" });
  });

  it("requires meaningful appended content", () => {
    expect(
      appendWorkspaceNoteSchema.safeParse({
        workspaceId: "workspace-1",
        noteId: "00000000-0000-4000-8000-000000000001",
        content: "",
        appendedByNodeId: null,
        idempotencyKey: "note-append-1"
      }).success
    ).toBe(false);
  });
});
