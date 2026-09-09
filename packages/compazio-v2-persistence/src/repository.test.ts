import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEmptyOperationalState,
  createWorkspace,
  type DomainDependencies
} from "@forgedeck/compazio-v2-domain";
import { afterEach, describe, expect, it } from "vitest";

import { isTransient, V2WorkspaceRepository, WorkspacePersistenceError } from "./index";

const roots: string[] = [];

function deps(): DomainDependencies {
  let id = 0;
  return { createId: () => `workspace_${++id}`, now: () => "2026-07-28T12:00:00.000Z" };
}

async function createRepository(): Promise<{
  readonly repository: V2WorkspaceRepository;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "compazio-v2-persistence-"));
  roots.push(root);
  return {
    repository: new V2WorkspaceRepository({
      rootDirectory: root,
      now: () => "2026-07-28T12:00:00.000Z"
    }),
    root
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V2 workspace persistence", () => {
  it("atomically saves and restores an independently versioned workspace", async () => {
    const { repository, root } = await createRepository();
    const workspace = createWorkspace({ name: "V2", workingDirectory: "C:\\repo" }, deps());
    await repository.create(workspace);
    await repository.save({ ...workspace, name: "V2 renamed" });

    await expect(repository.get(workspace.id)).resolves.toMatchObject({
      name: "V2 renamed",
      schemaVersion: workspace.schemaVersion
    });
    await expect(
      readFile(join(root, "workspaces", `${workspace.id}.json.bak`), "utf8")
    ).resolves.toContain('"name": "V2"');
  });

  it("recovers a corrupt primary workspace from its backup without overwriting either file", async () => {
    const { repository, root } = await createRepository();
    const workspace = createWorkspace({ name: "V2", workingDirectory: "C:\\repo" }, deps());
    await repository.create(workspace);
    await repository.save({ ...workspace, name: "backup source" });
    const path = join(root, "workspaces", `${workspace.id}.json`);
    await writeFile(path, "{invalid", "utf8");

    await expect(repository.get(workspace.id)).resolves.toMatchObject({ name: "V2" });
    await expect(readFile(path, "utf8")).resolves.toBe("{invalid");
  });

  it("deletes only its own metadata and never resurrects the workspace", async () => {
    const { repository, root } = await createRepository();
    const workspace = createWorkspace({ name: "V2", workingDirectory: "C:\\repo" }, deps());
    await repository.create(workspace);
    await repository.saveOperationalState(
      createEmptyOperationalState(workspace.id, "2026-07-28T12:00:00.000Z")
    );
    await repository.delete(workspace.id);
    await repository.delete(workspace.id);

    await expect(repository.list()).resolves.toEqual({
      workspaces: [],
      lastOpenedWorkspaceId: null
    });
    await expect(repository.get(workspace.id)).rejects.toBeInstanceOf(WorkspacePersistenceError);
    await expect(
      readFile(join(root, "operations", `${workspace.id}.json`), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists operational history separately from the canvas document", async () => {
    const { repository, root } = await createRepository();
    const workspace = createWorkspace({ name: "V2", workingDirectory: "C:\\repo" }, deps());
    await repository.create(workspace);
    const state = createEmptyOperationalState(workspace.id, "2026-07-28T12:00:00.000Z");
    await repository.saveOperationalState({ ...state, policyId: "economy" });

    await expect(repository.loadOperationalState(workspace.id)).resolves.toMatchObject({
      workspaceId: workspace.id,
      policyId: "economy",
      events: []
    });
    await expect(
      readFile(join(root, "workspaces", `${workspace.id}.json`), "utf8")
    ).resolves.not.toContain('"policyId"');
  });

  it("serializes concurrent index writes without corrupting the last-opened workspace", async () => {
    const { repository } = await createRepository();
    const domain = deps();
    const first = createWorkspace({ name: "first", workingDirectory: "C:\\first" }, domain);
    const second = createWorkspace({ name: "second", workingDirectory: "C:\\second" }, domain);
    await Promise.all([repository.create(first), repository.create(second)]);
    await Promise.all([repository.setLastOpened(first.id), repository.setLastOpened(second.id)]);

    await expect(repository.list()).resolves.toMatchObject({
      workspaces: [{ id: first.id }, { id: second.id }],
      lastOpenedWorkspaceId: second.id
    });
  });

  it("keeps the final workspace document valid during concurrent saves", async () => {
    const { repository } = await createRepository();
    const workspace = createWorkspace({ name: "V2", workingDirectory: "C:\\repo" }, deps());
    await repository.create(workspace);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.save({
          ...workspace,
          name: `V2 ${index}`,
          updatedAt: `2026-07-28T12:00:${index.toString().padStart(2, "0")}.000Z`
        })
      )
    );

    await expect(repository.get(workspace.id)).resolves.toEqual(
      expect.objectContaining({ id: workspace.id, schemaVersion: workspace.schemaVersion })
    );
  });

  it("retenta apenas contenção transitória e nunca uma falha permanente", () => {
    // EACCES entra na lista: no Windows um indexador ou antivírus devolve EACCES por instantes.
    for (const code of ["EPERM", "EBUSY", "EACCES"])
      expect(isTransient(Object.assign(new Error("contenção"), { code }))).toBe(true);
    // Repetir estes não pode dar certo, então não são retentados.
    for (const code of ["ENOSPC", "EROFS", "EDQUOT", "EINVAL", "ENOENT"])
      expect(isTransient(Object.assign(new Error("permanente"), { code }))).toBe(false);
    expect(isTransient(new Error("sem code"))).toBe(false);
  });
});
