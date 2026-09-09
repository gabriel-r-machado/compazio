import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitService } from "./git-service";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly git: GitService }> {
  const root = await mkdtemp(join(tmpdir(), "compazio-v2-git-"));
  roots.push(root);
  await run("git", ["init"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.email", "test@compazio.local"], {
    cwd: root,
    windowsHide: true
  });
  await run("git", ["config", "user.name", "Compazio Test"], { cwd: root, windowsHide: true });
  await writeFile(join(root, "example.ts"), "export const value = 1;\n", "utf8");
  await run("git", ["add", "--", "example.ts"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "initial"], { cwd: root, windowsHide: true });
  return { root, git: new GitService({ workspaceRoot: async () => root }) };
}

describe("GitService", () => {
  it("reports status, produces a bounded diff and stages then commits an edit", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "example.ts"), "export const value = 2;\n", "utf8");
    const status = await git.status("workspace");
    expect(status.files).toMatchObject([{ path: "example.ts", status: "modified" }]);
    expect(await git.diff("workspace", "example.ts")).toContain("+export const value = 2");
    const staged = await git.stage("workspace", ["example.ts"]);
    expect(staged.files[0]).toMatchObject({ staged: true });
    const clean = await git.commit("workspace", "update fixture");
    expect(clean.files).toEqual([]);
  });

  it("rejects a repository root outside the selected workspace", async () => {
    const { root, git } = await fixture();
    const nested = join(root, "nested");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested);
    const narrowed = new GitService({ workspaceRoot: async () => nested });
    await expect(narrowed.status("workspace")).rejects.toMatchObject({
      code: "GIT_REPOSITORY_NOT_FOUND"
    });
    await expect(git.checkout("workspace", "../invalid")).rejects.toMatchObject({
      code: "GIT_COMMAND_FAILED"
    });
  });

  it("reports a clear error when the workspace is not a Git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "compazio-v2-no-git-"));
    roots.push(root);
    const git = new GitService({ workspaceRoot: async () => root });
    await expect(git.status("workspace")).rejects.toMatchObject({
      code: "GIT_REPOSITORY_NOT_FOUND",
      message: "Este workspace nÃ£o contÃ©m um repositÃ³rio Git."
    });
  });
});
