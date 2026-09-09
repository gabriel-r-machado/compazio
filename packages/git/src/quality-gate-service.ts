import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { PathExecutableDetector } from "@forgedeck/agent-adapters";
import { redactText } from "@forgedeck/logger";
import type {
  GateCommandRunner,
  QualityGateDefinition,
  QualityGatePresetId,
  QualityGateRunRecord,
  QualityGateStore
} from "@forgedeck/orchestration";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import type { Evidence } from "@forgedeck/workflow";
import { z } from "zod";

import type { GateProcessStore, ProjectStore, WorktreeStore } from "./contracts";
import { canonicalizeDirectory, pathsEqual } from "./path-security";
import type { WorktreeManager } from "./worktree-manager";

const packageJsonSchema = z
  .object({
    packageManager: z.string().optional(),
    scripts: z.record(z.string(), z.string()).default({})
  })
  .passthrough();

const presetDefinitions: Readonly<Record<QualityGatePresetId, QualityGateDefinition>> = {
  lint: { id: "lint", label: "Lint", script: "lint", timeoutMs: 600_000, optional: false },
  typecheck: {
    id: "typecheck",
    label: "Typecheck",
    script: "typecheck",
    timeoutMs: 600_000,
    optional: false
  },
  test: { id: "test", label: "Tests", script: "test", timeoutMs: 900_000, optional: false },
  build: { id: "build", label: "Build", script: "build", timeoutMs: 900_000, optional: false },
  playwright: {
    id: "playwright",
    label: "Playwright",
    script: "test:e2e",
    timeoutMs: 900_000,
    optional: true
  }
};

export class QualityGateService {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly worktrees: WorktreeStore,
    private readonly worktreeManager: WorktreeManager,
    private readonly gateStore: QualityGateStore,
    private readonly gateProcesses: GateProcessStore,
    private readonly runner: GateCommandRunner,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly platform: RuntimePlatform = normalizePlatform(process.platform),
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
    private readonly detector = new PathExecutableDetector()
  ) {}

  public async discover(worktreeId: string): Promise<readonly QualityGateDefinition[]> {
    const context = await this.requireContext(worktreeId);
    const packageJson = packageJsonSchema.parse(
      JSON.parse(await readFile(join(context.worktreePath, "package.json"), "utf8")) as unknown
    );
    return Object.values(presetDefinitions).filter(
      (definition) => packageJson.scripts[definition.script] !== undefined
    );
  }

  public listRuns(worktreeId: string): Promise<readonly QualityGateRunRecord[]> {
    return this.gateStore.listGateRuns(worktreeId);
  }

  public async run(
    worktreeId: string,
    presetId: QualityGatePresetId
  ): Promise<QualityGateRunRecord> {
    const context = await this.requireContext(worktreeId);
    const definition = (await this.discover(worktreeId)).find((entry) => entry.id === presetId);
    if (definition === undefined) {
      throw new Error(`Quality gate preset is not available in this project: ${presetId}`);
    }
    const packageManager = await detectPackageManager(context.worktreePath);
    const executable = await this.detector.find([packageManager], {
      platform: this.platform,
      environment: this.environment
    });
    if (executable === null) {
      throw new Error(`Package manager executable was not found: ${packageManager}`);
    }

    const runId = this.id();
    const lease = await this.worktreeManager.acquireLease(worktreeId, `gate:${runId}`);
    try {
      const status = await this.worktreeManager.status(worktreeId);
      if (status.dirty) {
        throw new Error("Quality gates require a clean worktree so evidence matches its HEAD");
      }
      const startedAt = this.now();
      const args = ["run", definition.script];
      const running: QualityGateRunRecord = {
        id: runId,
        projectId: context.projectId,
        worktreeId,
        presetId,
        state: "running",
        executableName: basename(executable.path),
        args,
        headCommit: status.headCommit,
        exitCode: null,
        durationMs: null,
        timedOut: false,
        outputSummary: "",
        startedAt: startedAt.toISOString(),
        endedAt: null
      };
      await this.gateStore.saveGateRun(running);
      let completed: QualityGateRunRecord;
      try {
        const result = await this.runner.run({
          sessionId: `gate-${runId}`,
          executable,
          args,
          cwd: context.worktreePath,
          allowedCwdRoot: context.worktreePath,
          timeoutMs: definition.timeoutMs,
          onSpawn: async (processId) =>
            this.gateProcesses.saveGateProcess({
              gateRunId: runId,
              worktreeId,
              processId,
              startedAt: startedAt.toISOString()
            })
        });
        const finalStatus = await this.worktreeManager.status(worktreeId);
        const stable = !finalStatus.dirty && finalStatus.headCommit === running.headCommit;
        completed = {
          ...running,
          state: result.exitCode === 0 && !result.timedOut && stable ? "passed" : "failed",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          outputSummary: redactText(
            stable
              ? result.outputSummary
              : `${result.outputSummary}\nGate evidence invalidated because worktree content changed during execution.`
          ),
          endedAt: this.now().toISOString()
        };
      } catch (error: unknown) {
        completed = {
          ...running,
          state: "failed",
          durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
          outputSummary: redactText(
            error instanceof Error ? error.message : "Quality gate process failed"
          ),
          endedAt: this.now().toISOString()
        };
      }
      await this.gateStore.saveGateRun(completed);
      return completed;
    } finally {
      try {
        await this.gateProcesses.removeGateProcess(runId);
      } finally {
        await lease.release();
      }
    }
  }

  private async requireContext(worktreeId: string): Promise<{
    readonly projectId: string;
    readonly worktreePath: string;
  }> {
    const worktree = await this.worktrees.getWorktree(worktreeId);
    if (worktree === null || worktree.state !== "active") {
      throw new Error(`Unknown active worktree: ${worktreeId}`);
    }
    const project = await this.projects.getProject(worktree.projectId);
    if (project === null) {
      throw new Error(`Unknown project: ${worktree.projectId}`);
    }
    const canonicalPath = await canonicalizeDirectory(worktree.path);
    if (!pathsEqual(canonicalPath, worktree.path)) {
      throw new Error("Worktree path no longer resolves to its approved location");
    }
    return { projectId: project.id, worktreePath: canonicalPath };
  }
}

export function gateRunToEvidence(record: QualityGateRunRecord): Evidence {
  if (record.state !== "passed" || record.exitCode !== 0 || record.durationMs === null) {
    throw new Error("Only a passed gate with exit code and duration can become evidence");
  }
  return {
    id: `evidence-${record.id}`,
    type: "test",
    summary: `${presetDefinitions[record.presetId].label} passed with exit code 0 in ${record.durationMs}ms`,
    metadata: {
      gateRunId: record.id,
      presetId: record.presetId,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      headCommit: record.headCommit
    }
  };
}

async function detectPackageManager(worktreePath: string): Promise<string> {
  const packageJson = packageJsonSchema.parse(
    JSON.parse(await readFile(join(worktreePath, "package.json"), "utf8")) as unknown
  );
  const declared = packageJson.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "npm" || declared === "yarn" || declared === "bun") {
    return declared;
  }
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"]
  ] as const;
  for (const [filename, packageManager] of lockfiles) {
    try {
      await access(join(worktreePath, filename));
      return packageManager;
    } catch {
      // Continue to the next known lockfile.
    }
  }
  return "npm";
}

function normalizePlatform(platform: NodeJS.Platform): RuntimePlatform {
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(`Unsupported runtime platform: ${platform}`);
}
