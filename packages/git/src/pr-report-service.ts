import { createHash, randomUUID } from "node:crypto";

import { redactText } from "@forgedeck/logger";
import type { QualityGateStore } from "@forgedeck/orchestration";

import type {
  DeliveryReportStore,
  PrReadyReportRecord,
  ProjectStore,
  WorktreeStore
} from "./contracts";
import type { MergeConflictDetector } from "./conflict-detector";
import type { WorktreeDiffService } from "./diff-service";

export class PrReadyReportService {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly worktrees: WorktreeStore,
    private readonly gates: QualityGateStore,
    private readonly reports: DeliveryReportStore,
    private readonly diffs: WorktreeDiffService,
    private readonly conflicts: MergeConflictDetector,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID
  ) {}

  public async generate(worktreeId: string): Promise<PrReadyReportRecord> {
    const worktree = await this.worktrees.getWorktree(worktreeId);
    if (worktree === null || worktree.state !== "active") {
      throw new Error(`Unknown active worktree: ${worktreeId}`);
    }
    const project = await this.projects.getProject(worktree.projectId);
    if (project === null) {
      throw new Error(`Unknown project: ${worktree.projectId}`);
    }
    const [diff, gateRuns, conflictResult] = await Promise.all([
      this.diffs.getDiff(worktreeId),
      this.gates.listGateRuns(worktreeId),
      this.conflicts.detect(project.id, worktree.branchName, project.defaultBranch)
    ]);
    const title = `${worktree.taskKey}: ${worktree.taskTitle}`;
    const latestGates = new Map<(typeof gateRuns)[number]["presetId"], (typeof gateRuns)[number]>();
    for (const gate of gateRuns) {
      if (!latestGates.has(gate.presetId)) {
        latestGates.set(gate.presetId, gate);
      }
    }
    const changedFiles = [
      ...diff.files.map((file) => `${file.status} ${file.path}`),
      ...diff.untrackedFiles.map((path) => `? ${path}`)
    ];
    const lines = [
      `# ${title}`,
      "",
      "## Objective",
      "",
      worktree.taskTitle,
      "",
      "## Branches and worktree",
      "",
      `- Source: ${worktree.branchName}`,
      `- Target: ${project.defaultBranch}`,
      `- Source HEAD: ${diff.headCommit}`,
      `- Dirty: ${diff.dirty ? "yes" : "no"}`,
      "",
      "## Files changed",
      "",
      ...(changedFiles.length === 0
        ? ["- No changed files detected."]
        : changedFiles.map((file) => `- ${file}`)),
      "",
      "## Quality gates",
      ""
    ];
    for (const preset of ["lint", "typecheck", "test", "build", "playwright"] as const) {
      const gate = latestGates.get(preset);
      lines.push(
        gate === undefined
          ? `- ${preset}: not run`
          : `- ${preset}: ${gate.state}; exit=${gate.exitCode ?? "none"}; duration=${gate.durationMs ?? "none"}ms; HEAD=${gate.headCommit}`
      );
    }
    lines.push(
      "",
      "## Conflict check",
      "",
      conflictResult.hasConflicts
        ? `- Conflicts: ${conflictResult.conflictedFiles.join(", ")}`
        : "- No merge conflicts detected.",
      "",
      "## Remaining risks",
      "",
      diff.dirty
        ? "- Worktree contains uncommitted or untracked changes and is not merge-ready."
        : "- Re-run required gates if source HEAD changes.",
      "- Merge remains a separate human-confirmed action.",
      "",
      "## Suggested PR",
      "",
      `- Title: ${title}`,
      `- Description: Implements ${worktree.taskTitle} with recorded Git diff and quality-gate evidence.`,
      "",
      "## Rollback",
      "",
      "- If a merge commit is later created, prefer `git revert -m 1 <merge-commit>` to preserve shared history.",
      "- ForgeDeck never deletes the source branch or worktree automatically after merge.",
      ""
    );
    const markdown = redactText(lines.join("\n"));
    const report: PrReadyReportRecord = {
      id: this.id(),
      projectId: project.id,
      worktreeId,
      title,
      markdown,
      sha256: createHash("sha256").update(markdown).digest("hex"),
      createdAt: this.now().toISOString()
    };
    await this.reports.saveDeliveryReport(report);
    return report;
  }
}
