import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { V2WorkspaceRepository } from "@forgedeck/compazio-v2-persistence";
import { afterEach, describe, expect, it } from "vitest";

import { terminalWorkspaceFixtures } from "./terminal-workspace-fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal golden workspaces", () => {
  it("persists and restores fixtures A-D without sessions, lost nodes or connections", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-terminal-golden-"));
    roots.push(root);
    const repository = new V2WorkspaceRepository({ rootDirectory: root });
    const fixtures = terminalWorkspaceFixtures(join(root, "project"));

    for (const workspace of Object.values(fixtures)) {
      await repository.create(workspace);
      await expect(repository.get(workspace.id)).resolves.toEqual(workspace);
    }

    expect(fixtures.A.nodes.map((node) => node.type)).toEqual(["terminal"]);
    expect(fixtures.B.nodes.filter((node) => node.type === "terminal")).toHaveLength(2);
    expect(fixtures.C.nodes.map((node) => node.type)).toEqual([
      "terminal",
      "terminal",
      "terminal",
      "note",
      "file-tree",
      "file-preview"
    ]);
    expect(fixtures.C.edges).toHaveLength(4);
    expect(fixtures.D.nodes.filter((node) => node.type === "terminal")).toHaveLength(5);
    expect(
      Object.values(fixtures).flatMap((workspace) =>
        workspace.nodes.filter((node) => node.type === "terminal" && "sessionId" in node)
      )
    ).toEqual([]);
  });
});
