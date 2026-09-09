import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import { redactText } from "@forgedeck/logger";
import type { ArtifactRegistry, FinalReportInput } from "@forgedeck/orchestration";
import { handoffSchema } from "@forgedeck/workflow";
import type { ArtifactReference, Handoff } from "@forgedeck/workflow";

export class SqliteArtifactRegistry implements ArtifactRegistry {
  private readonly sqlite: Database.Database;
  private closed = false;

  public constructor(
    filename: string,
    private readonly trustedWorkspaceRoot: string
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public async createFinalReport(input: FinalReportInput): Promise<ArtifactReference> {
    const content = createReportMarkdown(input);
    return this.writeArtifact({
      runId: input.run.id,
      nodeRunId: null,
      artifactId: `report-${input.run.id}`,
      type: "run-report",
      directory: "reports",
      filename: "final-report.md",
      mediaType: "text/markdown",
      content
    });
  }

  public async createHandoff(runId: string, value: Handoff): Promise<ArtifactReference> {
    const handoff = handoffSchema.parse(value);
    ensureSafeIdentifier(runId, "run id");
    ensureSafeIdentifier(handoff.id, "handoff id");
    const nodeRows = this.sqlite
      .prepare("SELECT id, node_id FROM workflow_node_runs WHERE run_id = ?")
      .all(runId) as { readonly id: string; readonly node_id: string }[];
    const nodeRunIds = new Map(nodeRows.map((row) => [row.node_id, row.id]));
    const fromNodeRunId = nodeRunIds.get(handoff.fromNodeId);
    const toNodeRunId = nodeRunIds.get(handoff.toNodeId);
    if (fromNodeRunId === undefined || toNodeRunId === undefined) {
      throw new Error("Handoff references nodes outside the run");
    }
    for (const artifact of handoff.artifacts) {
      const row = this.sqlite
        .prepare("SELECT id FROM artifacts WHERE id = ? AND run_id = ?")
        .get(artifact.id, runId) as { readonly id: string } | undefined;
      if (row === undefined) {
        throw new Error(`Handoff artifact does not belong to run: ${artifact.id}`);
      }
    }
    const reference = await this.writeArtifact({
      runId,
      nodeRunId: null,
      artifactId: `handoff-${handoff.id}`,
      type: "handoff",
      directory: "handoffs",
      filename: `${handoff.id}.json`,
      mediaType: "application/json",
      content: JSON.stringify(handoff, null, 2)
    });
    this.sqlite
      .prepare(
        `INSERT INTO handoffs
          (id, run_id, from_node_run_id, to_node_run_id, handoff_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(handoff.id, runId, fromNodeRunId, toNodeRunId, JSON.stringify(handoff), Date.now());
    return reference;
  }

  /**
   * Publishes a node's structured output as an immutable, hashed artifact with run and node-run
   * provenance. This is the official record: a raw file left in the workspace is never proof. The
   * artifact id is deterministic per (run, node), so a node that is retried and finally succeeds
   * publishes exactly once and never overwrites a confirmed artifact.
   */
  public async publishNodeArtifact(input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly nodeId: string;
    readonly type: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly content: string;
  }): Promise<ArtifactReference> {
    ensureSafeIdentifier(input.nodeId, "node id");
    return this.writeArtifact({
      runId: input.runId,
      nodeRunId: input.nodeRunId,
      artifactId: nodeArtifactId(input.runId, input.nodeId),
      type: input.type,
      directory: "nodes",
      filename: `${input.nodeId}.${input.filename}`,
      mediaType: input.mediaType,
      content: input.content,
      metadata: { nodeId: input.nodeId }
    });
  }

  /** Resolves the immutable artifact a given node published, for the official context of a consumer. */
  public getNodeArtifact(
    runId: string,
    nodeId: string
  ): (ArtifactReference & { readonly nodeId: string; readonly nodeRunId: string | null }) | null {
    ensureSafeIdentifier(runId, "run id");
    ensureSafeIdentifier(nodeId, "node id");
    const row = this.sqlite
      .prepare(
        `SELECT id, node_run_id, type, relative_path, sha256, media_type
           FROM artifacts WHERE run_id = ? AND id = ?`
      )
      .get(runId, nodeArtifactId(runId, nodeId)) as
      | {
          readonly id: string;
          readonly node_run_id: string | null;
          readonly type: string;
          readonly relative_path: string;
          readonly sha256: string;
          readonly media_type: string;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      type: row.type,
      relative_path: row.relative_path,
      sha256: row.sha256,
      media_type: row.media_type,
      nodeId,
      nodeRunId: row.node_run_id
    };
  }

  /** Resolves an artifact reference to its absolute managed path without leaving the managed root. */
  public resolveArtifactPath(reference: ArtifactReference): string {
    const workspaceRoot = resolve(this.trustedWorkspaceRoot);
    const target = resolve(workspaceRoot, reference.relative_path);
    if (!isPathInside(workspaceRoot, target)) {
      throw new Error("Artifact reference escapes the managed workspace root");
    }
    return target;
  }

  /** Idempotent. A closed registry refuses to publish, so no artifact is written without its row. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }

  public isClosed(): boolean {
    return this.closed;
  }

  private async writeArtifact(input: {
    readonly runId: string;
    readonly nodeRunId: string | null;
    readonly artifactId: string;
    readonly type: string;
    readonly directory: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly content: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<ArtifactReference> {
    if (this.closed) throw new Error("Workflow artifact registry is closed");
    ensureSafeIdentifier(input.runId, "run id");
    ensureSafeIdentifier(input.artifactId, "artifact id");
    ensureSafeIdentifier(input.directory, "artifact directory");
    if (!/^[A-Za-z0-9_.-]+$/.test(input.filename) || isAbsolute(input.filename)) {
      throw new Error("Artifact filename is unsafe");
    }
    const workspaceRoot = resolve(this.trustedWorkspaceRoot);
    const managedRoot = join(workspaceRoot, ".forgedeck", "runs", input.runId);
    const targetDirectory = join(managedRoot, input.directory);
    await mkdir(targetDirectory, { recursive: true });
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);
    const canonicalRoot = await realpath(managedRoot);
    const canonicalDirectory = await realpath(targetDirectory);
    if (!isPathInside(canonicalWorkspaceRoot, canonicalRoot)) {
      throw new Error("Artifact storage escapes the managed workspace root");
    }
    if (!isPathInside(canonicalRoot, canonicalDirectory)) {
      throw new Error("Artifact directory escapes the managed run root");
    }
    const target = join(canonicalDirectory, input.filename);
    const temporary = join(canonicalDirectory, `.${input.filename}.${randomUUID()}.tmp`);
    const redactedContent = redactText(input.content);
    await writeFile(temporary, redactedContent, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    const sha256 = createHash("sha256").update(redactedContent).digest("hex");
    const relativePath = relative(canonicalWorkspaceRoot, target).split(sep).join("/");
    try {
      this.sqlite
        .prepare(
          `INSERT INTO artifacts
            (id, run_id, node_run_id, type, relative_path, sha256, media_type, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.artifactId,
          input.runId,
          input.nodeRunId,
          input.type,
          relativePath,
          sha256,
          input.mediaType,
          JSON.stringify(input.metadata ?? {}),
          Date.now()
        );
    } catch (error: unknown) {
      await rm(target, { force: true });
      throw error;
    }
    return {
      id: input.artifactId,
      type: input.type,
      relative_path: relativePath,
      sha256,
      media_type: input.mediaType
    };
  }
}

function createReportMarkdown(input: FinalReportInput): string {
  const retries = input.events.filter((event) => event.type === "node.retry_scheduled").length;
  const lines = [
    `# ${input.workflow.name} — run report`,
    "",
    `- Run: ${input.run.id}`,
    `- Status: ${input.run.state}`,
    `- Workflow version: ${input.run.workflowVersion}`,
    `- Dry run: ${input.run.dryRun ? "yes" : "no"}`,
    `- Retries: ${retries}`,
    "",
    ...executionContextReportLines(input.run.executionContext ?? null),
    "## Tasks",
    ""
  ];
  for (const node of input.run.nodeRuns) {
    lines.push(`- ${node.nodeId}: ${node.state} (attempts: ${node.attempt})`);
    for (const evidence of node.evidence) {
      lines.push(`  - Evidence: ${redactText(evidence.summary)}`);
    }
  }
  lines.push("", "## Remaining risks", "", "- Review failed or blocked nodes before merge.", "");
  return lines.join("\n");
}

function executionContextReportLines(
  context: FinalReportInput["run"]["executionContext"]
): readonly string[] {
  if (context === null || context === undefined) {
    return [
      "## Execution context",
      "",
      "- Context checkpoints: unavailable for this historical run.",
      ""
    ];
  }
  const delivery = context.deliveryCheckpoint;
  return [
    "## Execution context",
    "",
    `- Agent: ${context.agentNodeId}`,
    `- Task: ${redactText(context.task)}`,
    `- Profile version: ${context.profileVersion}`,
    `- Mission version: ${context.missionVersion ?? "none"}`,
    `- Workspace memory version: ${context.memoryVersion ?? "none"}`,
    `- Delivery contract: ${context.contractId ?? "none"} (version ${context.contractVersion ?? "none"})`,
    `- Function checkpoint: ${context.functionCheckpoint.checkpointId} (SHA-256 ${context.functionCheckpoint.sha256})`,
    `- Delivery checkpoint: ${
      delivery === null ? "not captured" : `${delivery.checkpointId} (SHA-256 ${delivery.sha256})`
    }`,
    ""
  ];
}

function ensureSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Unsafe ${label}`);
  }
}

function nodeArtifactId(runId: string, nodeId: string): string {
  return `node-${runId}-${nodeId}`;
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}
