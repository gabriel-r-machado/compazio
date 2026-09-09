import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { InMemoryQualityGateStore } from "@forgedeck/orchestration";
import type {
  GateCommandResult,
  GateCommandRunner,
  QualityGatePresetId,
  QualityGateRunRecord
} from "@forgedeck/orchestration";
import { afterEach, describe, expect, it } from "vitest";

import { createTaskBranchName } from "./branch-naming";
import { MergeConflictDetector } from "./conflict-detector";
import { ConfirmedMergeService } from "./merge-service";
import { WorktreeDiffService } from "./diff-service";
import { InMemoryGitStore } from "./memory-store";
import { ProjectRepositoryService } from "./project-service";
import { PrReadyReportService } from "./pr-report-service";
import { gateRunToEvidence, QualityGateService } from "./quality-gate-service";
import { WorktreeManager } from "./worktree-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Git projects and managed worktrees", () => {
  it("initializes a selected local folder with spaces and accents without staging its files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "Compazio criação local "));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "meu arquivo.txt"), "preserve me\n", "utf8");

    const projects = new ProjectRepositoryService(new InMemoryGitStore());
    const project = await projects.initializeDirectory(directory);
    const git = simpleGit({ baseDir: directory });
    const status = await git.status();

    expect(project.rootPath).toBe(await realpath(directory));
    expect(project.defaultBranch).toBe("main");
    expect(project.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(status.not_added).toContain("meu arquivo.txt");
  });

  it("supports paths with spaces, exclusive leases, Git locks and safe cleanup", async () => {
    const fixture = await createRepositoryFixture("worktree safety");
    const store = new InMemoryGitStore();
    const projects = new ProjectRepositoryService(store, () => new Date("2026-01-01T00:00:00Z"));
    const project = await projects.addDirectory(fixture.repository);
    const manager = new WorktreeManager(store, store, fixture.managedRoot);
    const worktree = await manager.create({
      projectId: project.id,
      taskKey: "TASK-1",
      taskTitle: "Implement safe cleanup"
    });

    expect(worktree.path).toContain("managed worktrees");
    expect((await manager.status(worktree.id)).dirty).toBe(false);

    const lease = await manager.acquireLease(worktree.id, "run:task-1");
    await expect(manager.acquireLease(worktree.id, "run:task-2")).rejects.toThrow("already in use");
    await expect(manager.cleanup(worktree.id)).rejects.toThrow("in use");
    await lease.release();

    const dirtyFile = join(worktree.path, "unsaved.txt");
    await writeFile(dirtyFile, "unsaved\n", "utf8");
    await expect(manager.cleanup(worktree.id)).rejects.toThrow("uncommitted");
    await rm(dirtyFile);

    const worktreeGit = simpleGit({ baseDir: worktree.path });
    await writeFile(join(worktree.path, ".gitignore"), ".env\n", "utf8");
    await worktreeGit.add([".gitignore"]);
    await worktreeGit.commit("ignore local environment");
    await writeFile(join(worktree.path, ".env"), "API_KEY=must-survive\n", "utf8");
    expect((await manager.status(worktree.id)).ignoredFiles).toContain(".env");
    await expect(manager.cleanup(worktree.id)).rejects.toThrow("ignored files");
    expect(await readFile(join(worktree.path, ".env"), "utf8")).toContain("must-survive");
    await rm(join(worktree.path, ".env"));

    const projectGit = simpleGit({ baseDir: fixture.repository });
    await projectGit.raw(["worktree", "lock", worktree.path]);
    await expect(manager.cleanup(worktree.id)).rejects.toThrow("locked by Git");
    await projectGit.raw(["worktree", "unlock", worktree.path]);
    await manager.cleanup(worktree.id);
    expect((await store.getWorktree(worktree.id))?.state).toBe("removed");
  }, 20_000);

  it("rejects a branch that already exists before creating a worktree", async () => {
    const fixture = await createRepositoryFixture("existing branch");
    const store = new InMemoryGitStore();
    const project = await new ProjectRepositoryService(store).addDirectory(fixture.repository);
    const manager = new WorktreeManager(store, store, fixture.managedRoot);
    const branchName = createTaskBranchName("Existing task", "TASK-2");
    await simpleGit({ baseDir: fixture.repository }).raw(["branch", branchName]);

    await expect(
      manager.create({ projectId: project.id, taskKey: "TASK-2", taskTitle: "Existing task" })
    ).rejects.toThrow(`Git branch already exists: ${branchName}`);
  });

  it("returns a bounded diff and includes dirty/untracked state", async () => {
    const fixture = await createRepositoryFixture("diff viewer");
    const store = new InMemoryGitStore();
    const project = await new ProjectRepositoryService(store).addDirectory(fixture.repository);
    const manager = new WorktreeManager(store, store, fixture.managedRoot);
    const worktree = await manager.create({
      projectId: project.id,
      taskKey: "TASK-3",
      taskTitle: "Diff viewer"
    });
    await writeFile(join(worktree.path, "README.md"), "feature change\n", "utf8");
    await writeFile(join(worktree.path, "untracked.txt"), "local only\n", "utf8");

    const diff = await new WorktreeDiffService(store, store, 256 * 1024).getDiff(worktree.id);
    expect(diff.dirty).toBe(true);
    expect(diff.files).toContainEqual({ path: "README.md", status: "M", oldPath: null });
    expect(diff.untrackedFiles).toContain("untracked.txt");
    expect(diff.patch).toContain("feature change");
    expect(diff.truncated).toBe(false);
  });

  it("detects merge conflicts in a disposable worktree without mutating the project", async () => {
    const fixture = await createRepositoryFixture("conflict detection");
    const store = new InMemoryGitStore();
    const project = await new ProjectRepositoryService(store).addDirectory(fixture.repository);
    const manager = new WorktreeManager(store, store, fixture.managedRoot);
    const worktree = await manager.create({
      projectId: project.id,
      taskKey: "TASK-4",
      taskTitle: "Conflicting change"
    });
    const worktreeGit = simpleGit({ baseDir: worktree.path });
    await writeFile(join(worktree.path, "README.md"), "feature side\n", "utf8");
    await worktreeGit.add(["README.md"]);
    await worktreeGit.commit("feature change");

    const projectGit = simpleGit({ baseDir: fixture.repository });
    await writeFile(join(fixture.repository, "README.md"), "main side\n", "utf8");
    await projectGit.add(["README.md"]);
    await projectGit.commit("main change");

    const sourceCommit = (await projectGit.revparse([`${worktree.branchName}^{commit}`])).trim();
    const targetCommit = (await projectGit.revparse([`${project.defaultBranch}^{commit}`])).trim();
    expect(sourceCommit).not.toBe(targetCommit);
    expect(await projectGit.show([`${sourceCommit}:README.md`])).toBe("feature side\n");
    expect(await projectGit.show([`${targetCommit}:README.md`])).toBe("main side\n");

    const result = await new MergeConflictDetector(store, fixture.managedRoot).detect(
      project.id,
      worktree.branchName,
      project.defaultBranch
    );
    expect(result).toEqual({ hasConflicts: true, conflictedFiles: ["README.md"] });
    expect(await readFile(join(fixture.repository, "README.md"), "utf8")).toBe("main side\n");
    expect((await projectGit.status()).isClean()).toBe(true);
  });

  it("records exit code and duration as evidence and redacts gate output", async () => {
    const fixture = await createRepositoryFixture("quality gates");
    const store = new InMemoryGitStore();
    const gateStore = new InMemoryQualityGateStore();
    const project = await new ProjectRepositoryService(store).addDirectory(fixture.repository);
    const manager = new WorktreeManager(store, store, fixture.managedRoot);
    const worktree = await manager.create({
      projectId: project.id,
      taskKey: "TASK-5",
      taskTitle: "Quality evidence"
    });
    const gates = new QualityGateService(
      store,
      store,
      manager,
      gateStore,
      store,
      new StaticGateRunner({
        exitCode: 0,
        durationMs: 37,
        outputSummary: "ok FORGEDECK_TEST_SECRET_gate-output",
        timedOut: false
      })
    );

    expect((await gates.discover(worktree.id)).map((gate) => gate.id)).toEqual([
      "lint",
      "typecheck",
      "test",
      "build",
      "playwright"
    ]);
    await writeFile(join(worktree.path, "README.md"), "dirty gate input\n", "utf8");
    await expect(gates.run(worktree.id, "lint")).rejects.toThrow("clean worktree");
    expect(await store.getActiveLease(worktree.id)).toBeNull();
    await simpleGit({ baseDir: worktree.path }).raw(["restore", "README.md"]);
    const run = await gates.run(worktree.id, "lint");
    expect(run).toMatchObject({ state: "passed", exitCode: 0, durationMs: 37 });
    expect(run.outputSummary).toContain("[REDACTED]");
    expect(run.outputSummary).not.toContain("FORGEDECK_TEST_SECRET_gate-output");
    expect(gateRunToEvidence(run).metadata).toMatchObject({ exitCode: 0, durationMs: 37 });
  });

  it("prefers main over the currently checked out feature branch", async () => {
    const fixture = await createRepositoryFixture("default branch");
    await simpleGit({ baseDir: fixture.repository }).checkoutLocalBranch("feature/current");
    const project = await new ProjectRepositoryService(new InMemoryGitStore()).addDirectory(
      fixture.repository
    );
    expect(project.defaultBranch).toBe("main");
  });

  it("lists and switches local branches only when the project is clean", async () => {
    const fixture = await createRepositoryFixture("branch selector");
    const store = new InMemoryGitStore();
    const service = new ProjectRepositoryService(store);
    const project = await service.addDirectory(fixture.repository);
    const git = simpleGit({ baseDir: fixture.repository });
    await git.raw(["branch", "feature/ui"]);

    expect(await service.listBranches(project.id)).toMatchObject({
      currentBranch: "main",
      branches: expect.arrayContaining([
        { name: "main", current: true },
        { name: "feature/ui", current: false }
      ])
    });
    expect(await service.switchBranch(project.id, "feature/ui")).toMatchObject({
      currentBranch: "feature/ui"
    });

    await writeFile(join(fixture.repository, "README.md"), "dirty\n", "utf8");
    await expect(service.switchBranch(project.id, "main")).rejects.toThrow("Commit or stash");
  });

  it("requires passing gates and an explicit fresh token before merge", async () => {
    const fixture = await createRepositoryFixture("confirmed merge");
    const store = new InMemoryGitStore();
    const gateStore = new InMemoryQualityGateStore();
    const project = await new ProjectRepositoryService(store).addDirectory(fixture.repository);
    const manager = new WorktreeManager(store, store, fixture.managedRoot);
    const worktree = await manager.create({
      projectId: project.id,
      taskKey: "TASK-6",
      taskTitle: "Confirmed merge"
    });
    const worktreeGit = simpleGit({ baseDir: worktree.path });
    await writeFile(join(worktree.path, "feature.txt"), "feature\n", "utf8");
    await worktreeGit.add(["feature.txt"]);
    await worktreeGit.commit("feature commit");
    const sourceHead = (await worktreeGit.revparse(["HEAD"])).trim();
    for (const presetId of ["lint", "typecheck", "test", "build"] as const) {
      await gateStore.saveGateRun(passingGateRun(project.id, worktree.id, sourceHead, presetId));
    }

    const quality = new QualityGateService(
      store,
      store,
      manager,
      gateStore,
      store,
      new StaticGateRunner({ exitCode: 0, durationMs: 10, outputSummary: "ok", timedOut: false })
    );
    const conflicts = new MergeConflictDetector(store, fixture.managedRoot);
    const service = new ConfirmedMergeService(
      store,
      store,
      store,
      gateStore,
      store,
      manager,
      quality,
      conflicts,
      () => new Date("2026-01-01T00:00:00Z"),
      undefined,
      () => "a".repeat(64)
    );
    const preview = await service.prepare(worktree.id);
    expect(preview.plan.issues).toEqual([]);
    expect(preview.plan.eligible).toBe(true);
    expect(preview.confirmationToken).toBe("a".repeat(64));
    await expect(
      service.confirm({
        planId: preview.plan.id,
        confirmationToken: preview.confirmationToken,
        confirmed: false
      })
    ).rejects.toThrow("explicit human confirmation");
    await expect(
      service.confirm({
        planId: preview.plan.id,
        confirmationToken: "b".repeat(64),
        confirmed: true
      })
    ).rejects.toThrow("token is invalid");

    const result = await service.confirm({
      planId: preview.plan.id,
      confirmationToken: preview.confirmationToken,
      confirmed: true
    });
    expect(result.state).toBe("confirmed");
    expect(result.rollbackCommand).toMatch(/^git revert -m 1 [a-f0-9]{40,64}$/);
    expect(
      (await readFile(join(fixture.repository, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")
    ).toBe("feature\n");
    expect((await store.getWorktree(worktree.id))?.state).toBe("active");

    const report = await new PrReadyReportService(
      store,
      store,
      gateStore,
      store,
      new WorktreeDiffService(store, store),
      conflicts
    ).generate(worktree.id);
    expect(report.markdown).toContain("exit=0");
    expect(report.markdown).toContain("Merge remains a separate human-confirmed action");
    expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

async function createRepositoryFixture(name: string): Promise<{
  readonly repository: string;
  readonly managedRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `ForgeDeck ${name} with spaces `));
  temporaryDirectories.push(root);
  const repository = join(root, "repository with spaces");
  const managedRoot = join(root, "managed worktrees");
  await Promise.all([mkdir(repository), mkdir(managedRoot)]);
  const git = simpleGit({ baseDir: repository });
  await git.init();
  await git.addConfig("user.name", "ForgeDeck Tests");
  await git.addConfig("user.email", "forgedeck-tests@example.invalid");
  await writeFile(join(repository, "README.md"), "base\n", "utf8");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      name: "forgedeck-fixture",
      private: true,
      packageManager: "npm@10.0.0",
      scripts: {
        lint: 'node -e "process.exit(0)"',
        typecheck: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(0)"',
        "test:e2e": 'node -e "process.exit(0)"'
      }
    }),
    "utf8"
  );
  await git.add(["README.md", "package.json"]);
  await git.commit("initial commit");
  await git.raw(["branch", "-M", "main"]);
  return { repository, managedRoot };
}

class StaticGateRunner implements GateCommandRunner {
  public constructor(private readonly result: GateCommandResult) {}

  public async run(): Promise<GateCommandResult> {
    return this.result;
  }
}

function passingGateRun(
  projectId: string,
  worktreeId: string,
  headCommit: string,
  presetId: QualityGatePresetId
): QualityGateRunRecord {
  return {
    id: `gate-${presetId}`,
    projectId,
    worktreeId,
    presetId,
    state: "passed",
    executableName: "npm",
    args: ["run", presetId],
    headCommit,
    exitCode: 0,
    durationMs: 25,
    timedOut: false,
    outputSummary: "ok",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.025Z"
  };
}
