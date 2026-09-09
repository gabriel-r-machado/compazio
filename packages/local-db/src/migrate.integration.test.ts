import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { restoreLocalDatabaseBackup, runLocalMigrations } from "./migrate";
import { SqliteCanvasRepository } from "./canvas-repository";
import { SqliteRuntimeSessionStore } from "./runtime-session-store";
import { SqliteWorkflowRunStore } from "./workflow-run-store";
import { SqliteWorkflowRunCommandStore } from "./workflow-run-command-store";
import { SqliteGitStore } from "./git-store";
import { SqliteCanvasHandoffRepository } from "./canvas-handoff-repository";
import { SqliteOrchestrationProposalStore } from "./orchestration-proposal-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("local database migrations", () => {
  it("creates foundation and runtime tables and can run twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-db-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "foundation.db");

    runLocalMigrations({ filename });
    runLocalMigrations({ filename });

    const sqlite = new Database(filename, { readonly: true });
    try {
      const row = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("app_settings") as { readonly name: string } | undefined;
      expect(row?.name).toBe("app_settings");
      const runtimeRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("runtime_sessions") as { readonly name: string } | undefined;
      expect(runtimeRow?.name).toBe("runtime_sessions");
      const canvasRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("canvases") as { readonly name: string } | undefined;
      const eventRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("run_events") as { readonly name: string } | undefined;
      const localIdentityRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("local_identities") as { readonly name: string } | undefined;
      const localSessionRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("local_auth_sessions") as { readonly name: string } | undefined;
      const policyDecisionRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("policy_decisions") as { readonly name: string } | undefined;
      const runtimeProjectLeaseRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("runtime_project_leases") as { readonly name: string } | undefined;
      const runtimeLifecycleRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("runtime_lifecycle_commands") as { readonly name: string } | undefined;
      const agentProfilesRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("agent_profiles") as { readonly name: string } | undefined;
      const missionsRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("missions") as { readonly name: string } | undefined;
      const workspaceMemoriesRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workspace_memories") as { readonly name: string } | undefined;
      const artifactMemoriesRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("artifact_memories") as { readonly name: string } | undefined;
      const deliveryContractsRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("delivery_contracts") as { readonly name: string } | undefined;
      const executionContextsRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("execution_context_snapshots") as { readonly name: string } | undefined;
      const executionCheckpointsRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("execution_checkpoints") as { readonly name: string } | undefined;
      const contextIndexRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("context_source_indexes") as { readonly name: string } | undefined;
      const contextCacheRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("context_selection_caches") as { readonly name: string } | undefined;
      const workflowRunCommandRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workflow_run_commands") as { readonly name: string } | undefined;
      const workflowRunTargetRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workflow_run_targets") as { readonly name: string } | undefined;
      const orchestrationProposalRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("orchestration_proposals") as { readonly name: string } | undefined;
      const orchestrationProposalEventRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("orchestration_proposal_events") as { readonly name: string } | undefined;
      const orchestrationProposalExecutionRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("orchestration_proposal_executions") as { readonly name: string } | undefined;
      expect(canvasRow?.name).toBe("canvases");
      expect(eventRow?.name).toBe("run_events");
      expect(localIdentityRow?.name).toBe("local_identities");
      expect(localSessionRow?.name).toBe("local_auth_sessions");
      expect(policyDecisionRow?.name).toBe("policy_decisions");
      expect(runtimeProjectLeaseRow?.name).toBe("runtime_project_leases");
      expect(runtimeLifecycleRow?.name).toBe("runtime_lifecycle_commands");
      expect(agentProfilesRow?.name).toBe("agent_profiles");
      expect(missionsRow?.name).toBe("missions");
      expect(workspaceMemoriesRow?.name).toBe("workspace_memories");
      expect(artifactMemoriesRow?.name).toBe("artifact_memories");
      expect(deliveryContractsRow?.name).toBe("delivery_contracts");
      expect(executionContextsRow?.name).toBe("execution_context_snapshots");
      expect(executionCheckpointsRow?.name).toBe("execution_checkpoints");
      expect(contextIndexRow?.name).toBe("context_source_indexes");
      expect(contextCacheRow?.name).toBe("context_selection_caches");
      expect(workflowRunCommandRow?.name).toBe("workflow_run_commands");
      expect(workflowRunTargetRow?.name).toBe("workflow_run_targets");
      expect(orchestrationProposalRow?.name).toBe("orchestration_proposals");
      expect(orchestrationProposalEventRow?.name).toBe("orchestration_proposal_events");
      expect(orchestrationProposalExecutionRow?.name).toBe("orchestration_proposal_executions");
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('orchestration_proposals') ORDER BY cid")
          .all()
          .map((column) => (column as { readonly name: string }).name)
      ).toEqual(expect.arrayContaining(["revision", "created_by", "reviewed_by"]));
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('workflow_run_targets') ORDER BY cid")
          .all()
          .map((column) => (column as { readonly name: string }).name)
      ).toEqual(expect.arrayContaining(["agent_node_id", "worktree_id"]));
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('workflow_runs') ORDER BY cid")
          .all()
          .map((column) => (column as { readonly name: string }).name)
      ).toContain("execution_context_json");
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('workflow_run_commands') ORDER BY cid")
          .all()
          .map((column) => (column as { readonly name: string }).name)
      ).toEqual(
        expect.arrayContaining([
          "task",
          "contract_id",
          "retry_scope",
          "alternative_label",
          "context_mode"
        ])
      );
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('workflow_runs') ORDER BY cid")
          .all()
          .map((column) => (column as { readonly name: string }).name)
      ).toEqual(
        expect.arrayContaining([
          "retry_of_run_id",
          "retry_node_id",
          "retry_scope",
          "alternative_group_id",
          "alternative_label"
        ])
      );
      const projectRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("projects") as { readonly name: string } | undefined;
      const gateRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("quality_gate_runs") as { readonly name: string } | undefined;
      const gateProcessRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("quality_gate_processes") as { readonly name: string } | undefined;
      expect(projectRow?.name).toBe("projects");
      expect(gateRow?.name).toBe("quality_gate_runs");
      expect(gateProcessRow?.name).toBe("quality_gate_processes");
      const workspaceRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workspaces") as { readonly name: string } | undefined;
      expect(workspaceRow?.name).toBe("workspaces");
      const canvasHandoffRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("canvas_handoffs") as { readonly name: string } | undefined;
      const canvasHandoffEventRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("canvas_handoff_events") as { readonly name: string } | undefined;
      expect(canvasHandoffRow?.name).toBe("canvas_handoffs");
      expect(canvasHandoffEventRow?.name).toBe("canvas_handoff_events");
      const handoffAttemptRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("canvas_handoff_delivery_attempts") as { readonly name: string } | undefined;
      expect(handoffAttemptRow?.name).toBe("canvas_handoff_delivery_attempts");
      const agentSpawnRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("agent_spawns") as { readonly name: string } | undefined;
      const agentSpawnEventRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("agent_spawn_events") as { readonly name: string } | undefined;
      expect(agentSpawnRow?.name).toBe("agent_spawns");
      expect(agentSpawnEventRow?.name).toBe("agent_spawn_events");
      const workspaceNoteRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workspace_notes") as { readonly name: string } | undefined;
      const workspaceNoteEventRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workspace_note_events") as { readonly name: string } | undefined;
      expect(workspaceNoteRow?.name).toBe("workspace_notes");
      expect(workspaceNoteEventRow?.name).toBe("workspace_note_events");
      const workspaceArtifactRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workspace_artifacts") as { readonly name: string } | undefined;
      const workspaceArtifactEventRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("workspace_artifact_events") as { readonly name: string } | undefined;
      expect(workspaceArtifactRow?.name).toBe("workspace_artifacts");
      expect(workspaceArtifactEventRow?.name).toBe("workspace_artifact_events");
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('workspace_connection_events') ORDER BY cid")
          .all()
          .map((column) => (column as { readonly name: string }).name)
      ).toContain("event_type");
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('workspace_connection_events') ORDER BY cid")
          .all()
          .map((column) => (column as { readonly name: string }).name)
      ).toContain("canvas_revision");
    } finally {
      sqlite.close();
    }
  });

  it("backs up a pending migration and recovers only to an explicit new database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-migration-backup-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "local.db");
    const legacyMigrations = await createLegacyMigrations(directory, 39);

    runLocalMigrations({ filename, migrationsFolder: legacyMigrations });
    const legacy = new Database(filename);
    try {
      legacy.exec("CREATE TABLE migration_backup_marker (value text NOT NULL)");
      legacy.prepare("INSERT INTO migration_backup_marker (value) VALUES (?)").run("preserved");
    } finally {
      legacy.close();
    }

    runLocalMigrations({ filename });

    const backups = await readdir(join(directory, "backups"));
    expect(backups).toHaveLength(1);
    const backupName = backups[0];
    if (backupName === undefined) throw new Error("Migration backup was not created");
    const backupFilename = join(directory, "backups", backupName);
    const upgraded = new Database(filename, { readonly: true });
    const snapshot = new Database(backupFilename, { readonly: true });
    try {
      expect(
        upgraded
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("context_source_indexes")
      ).toMatchObject({ name: "context_source_indexes" });
      expect(
        snapshot
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("context_source_indexes")
      ).toBeUndefined();
      expect(snapshot.prepare("SELECT value FROM migration_backup_marker").get()).toEqual({
        value: "preserved"
      });
      expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      upgraded.close();
      snapshot.close();
    }

    const recoveredFilename = join(directory, "recovered.db");
    restoreLocalDatabaseBackup({ backupFilename, targetFilename: recoveredFilename });
    const recovered = new Database(recoveredFilename, { readonly: true });
    try {
      expect(recovered.prepare("SELECT value FROM migration_backup_marker").get()).toEqual({
        value: "preserved"
      });
      expect(
        recovered
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("context_source_indexes")
      ).toBeUndefined();
    } finally {
      recovered.close();
    }
    expect(() =>
      restoreLocalDatabaseBackup({ backupFilename, targetFilename: recoveredFilename })
    ).toThrow("already exists");
  });

  it("adds execution context columns when upgrading a pre-context workflow database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-workflow-context-upgrade-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "upgraded.db");
    const legacyMigrations = await createLegacyMigrations(directory, 27);

    runLocalMigrations({ filename, migrationsFolder: legacyMigrations });
    runLocalMigrations({ filename });

    const sqlite = new Database(filename, { readonly: true });
    try {
      const runColumns = sqlite
        .prepare("SELECT name FROM pragma_table_info('workflow_runs') ORDER BY cid")
        .all()
        .map((column) => (column as { readonly name: string }).name);
      const commandColumns = sqlite
        .prepare("SELECT name FROM pragma_table_info('workflow_run_commands') ORDER BY cid")
        .all()
        .map((column) => (column as { readonly name: string }).name);
      const targetColumns = sqlite
        .prepare("SELECT name FROM pragma_table_info('workflow_run_targets') ORDER BY cid")
        .all()
        .map((column) => (column as { readonly name: string }).name);
      expect(runColumns).toContain("execution_context_json");
      expect(commandColumns).toEqual(
        expect.arrayContaining([
          "task",
          "contract_id",
          "retry_scope",
          "alternative_label",
          "context_mode"
        ])
      );
      expect(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("context_source_indexes")
      ).toMatchObject({ name: "context_source_indexes" });
      expect(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("context_selection_caches")
      ).toMatchObject({ name: "context_selection_caches" });
      expect(runColumns).toEqual(
        expect.arrayContaining([
          "retry_of_run_id",
          "retry_node_id",
          "retry_scope",
          "alternative_group_id",
          "alternative_label"
        ])
      );
      expect(targetColumns).toEqual(expect.arrayContaining(["agent_node_id", "worktree_id"]));
    } finally {
      sqlite.close();
    }
  });

  it("upgrades persisted orchestration proposals with review metadata intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-proposal-upgrade-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "upgraded.db");
    const legacyMigrations = await createLegacyMigrations(directory, 31);
    const timestamp = Date.parse("2026-07-21T12:00:00.000Z");

    runLocalMigrations({ filename, migrationsFolder: legacyMigrations });
    const sqlite = new Database(filename);
    try {
      sqlite
        .prepare(
          `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
           VALUES ('project-1', 'Compasso', ?, ?, 'main', 'abc', ?, ?)`
        )
        .run(directory, directory, timestamp, timestamp);
      sqlite
        .prepare(
          `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
           VALUES ('canvas-1', 'Main', '', 1, '{}', ?, ?)`
        )
        .run(timestamp, timestamp);
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
           VALUES ('workspace-1', 'project-1', 'canvas-1', 'Main', 0, 1, ?, ?)`
        )
        .run(timestamp, timestamp);
      sqlite
        .prepare(
          `INSERT INTO orchestration_proposals
           (id, workspace_id, status, autonomy_level, proposal_json, checksum, created_at, updated_at, approved_at, rejected_at)
           VALUES (?, 'workspace-1', 'draft', 'assisted', ?, ?, ?, ?, NULL, NULL)`
        )
        .run(
          "00000000-0000-4000-8000-000000000042",
          JSON.stringify({
            id: "00000000-0000-4000-8000-000000000042",
            workspaceId: "workspace-1",
            objective: "Preserve this draft",
            understanding: "The persisted proposal must remain reviewable.",
            questions: [],
            requiredMaterials: [],
            suggestedTeam: [],
            workflowTemplateId: null,
            executionAgentNodeId: null,
            dependencies: [],
            requestedPermissions: [],
            gates: ["human_approval"],
            risks: [],
            estimatedCost: null,
            estimatedDuration: null,
            autonomyLevel: "assisted",
            status: "draft",
            checksum: "a".repeat(64),
            createdAt: "2026-07-21T12:00:00.000Z",
            updatedAt: "2026-07-21T12:00:00.000Z",
            approvedAt: null,
            rejectedAt: null
          }),
          "a".repeat(64),
          timestamp,
          timestamp
        );
    } finally {
      sqlite.close();
    }

    runLocalMigrations({ filename });
    const store = new SqliteOrchestrationProposalStore(filename);
    try {
      expect(store.get("workspace-1", "00000000-0000-4000-8000-000000000042")).toMatchObject({
        objective: "Preserve this draft",
        revision: 1,
        createdBy: "local-user",
        reviewedBy: null
      });
      const sqlite = new Database(filename, { readonly: true });
      try {
        expect(
          sqlite
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get("orchestration_proposal_executions")
        ).toEqual({ name: "orchestration_proposal_executions" });
      } finally {
        sqlite.close();
      }
    } finally {
      store.close();
    }
  });

  it("persists typed workflow controls and never replays an interrupted command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-workflow-controls-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "controls.db");
    runLocalMigrations({ filename });
    const store = new SqliteWorkflowRunCommandStore(
      filename,
      () => new Date("2026-07-20T12:00:00.000Z")
    );
    try {
      const requested = store.requestStart({
        templateId: "delivery-report",
        workspaceId: "workspace-1",
        agentNodeId: "reviewer",
        task: "Create a delivery report",
        dryRun: false
      });
      expect(requested).toMatchObject({
        action: "start",
        status: "queued",
        runId: null,
        retryScope: "run",
        agentNodeId: "reviewer",
        task: "Create a delivery report"
      });
      const claimed = store.claimNext();
      expect(claimed).toMatchObject({ id: requested.id, status: "applying" });
      expect(store.recoverInterrupted()).toBe(1);
      expect(store.get(requested.id)).toMatchObject({
        status: "failed",
        errorCode: "application_restart",
        resultRunId: null
      });
      const selectiveRetry = store.requestControl({
        action: "retry",
        runId: "run-1",
        nodeId: "quality",
        retryScope: "dependents"
      });
      expect(selectiveRetry).toMatchObject({
        action: "retry",
        runId: "run-1",
        nodeId: "quality",
        retryScope: "dependents"
      });
      const alternative = store.requestControl({
        action: "alternative",
        runId: "run-1",
        nodeId: "quality",
        alternativeLabel: "fast"
      });
      expect(alternative).toMatchObject({
        action: "alternative",
        nodeId: "quality",
        retryScope: "dependents",
        alternativeLabel: "fast"
      });
    } finally {
      store.close();
    }
  });

  it("migrates persisted pre-attempt handoffs without declaring their delivery successful", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-legacy-handoff-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "legacy.db");
    const legacyMigrations = await createLegacyMigrations(directory);
    runLocalMigrations({ filename, migrationsFolder: legacyMigrations });
    seedLegacyHandoff(filename);

    runLocalMigrations({ filename });
    const repository = new SqliteCanvasHandoffRepository(filename);
    try {
      const persisted = repository.get("legacy-handoff");
      expect(persisted).toMatchObject({
        status: "delivering",
        deliveryAttempts: []
      });
      expect(repository.recoverDeliveries(new Date("2026-07-19T12:05:00.000Z"))).toBe(1);
      expect(repository.get("legacy-handoff")).toMatchObject({
        status: "delivery_unknown",
        deliveryAttempts: []
      });
      expect(repository.listEvents("legacy-handoff").at(-1)).toMatchObject({
        type: "delivery_unknown",
        deliveryAttemptId: null,
        responsible: "system"
      });
    } finally {
      repository.close();
    }
  });

  it("upgrades an existing local database without losing persisted settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-identity-upgrade-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "legacy.db");
    const legacyMigrations = await createLegacyMigrations(directory, 16);
    runLocalMigrations({ filename, migrationsFolder: legacyMigrations });
    const sqlite = new Database(filename);
    try {
      sqlite
        .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run("locale", "pt-BR", Date.parse("2026-07-20T12:00:00.000Z"));
    } finally {
      sqlite.close();
    }

    runLocalMigrations({ filename });
    const migrated = new Database(filename, { readonly: true });
    try {
      expect(migrated.prepare("SELECT value FROM app_settings WHERE key = 'locale'").get()).toEqual(
        {
          value: "pt-BR"
        }
      );
      expect(
        migrated
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_identity_events'"
          )
          .get()
      ).toEqual({ name: "local_identity_events" });
      expect(
        migrated
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_decisions'"
          )
          .get()
      ).toEqual({ name: "policy_decisions" });
    } finally {
      migrated.close();
    }
  });

  it("backfills artifact canvas nodes and marks historic artifact events as published", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-legacy-artifact-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "legacy-artifact.db");
    const legacyMigrations = await createLegacyMigrations(directory, 14);
    runLocalMigrations({ filename, migrationsFolder: legacyMigrations });
    const projectId = "00000000-0000-4000-8000-000000000001";
    const artifactId = "00000000-0000-4000-8000-000000000002";
    const now = Date.parse("2026-07-20T12:00:00.000Z");
    const sqlite = new Database(filename);
    try {
      sqlite
        .prepare(
          `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
           VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
        )
        .run(projectId, directory, directory, now, now);
      sqlite
        .prepare(
          `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
           VALUES ('canvas-1', 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
        )
        .run(now, now);
      sqlite
        .prepare(
          `INSERT INTO workspaces
           (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
           VALUES ('workspace-1', ?, 'canvas-1', 'Principal', 0, 1, ?, ?)`
        )
        .run(projectId, now, now);
      sqlite
        .prepare(
          `INSERT INTO workspace_artifacts
           (id, workspace_id, project_id, kind, source_relative_path, relative_path, filename,
            sha256, byte_size, media_type, published_by_node_id, idempotency_key, created_at)
           VALUES (?, 'workspace-1', ?, 'report', 'reports/test.json',
                   '.forgedeck/artifacts/report/test.json', 'test.json', ?, 12,
                   'application/json', NULL, 'legacy-artifact-1', ?)`
        )
        .run(artifactId, projectId, "a".repeat(64), now);
      sqlite
        .prepare(
          `INSERT INTO workspace_artifact_events (id, artifact_id, sequence, type, created_at)
           VALUES (?, ?, 1, 'artifact_published', ?)`
        )
        .run("00000000-0000-4000-8000-000000000003", artifactId, now);
    } finally {
      sqlite.close();
    }

    runLocalMigrations({ filename });
    const migrated = new Database(filename, { readonly: true });
    try {
      const node = migrated
        .prepare("SELECT type, data_json FROM canvas_nodes WHERE canvas_id = 'canvas-1' AND id = ?")
        .get(`artifact-${artifactId}`) as { readonly type: string; readonly data_json: string };
      expect(node.type).toBe("artifact");
      expect(JSON.parse(node.data_json)).toMatchObject({
        artifact: { artifactId, filename: "test.json", sha256: "a".repeat(64) }
      });
      expect(
        migrated
          .prepare("SELECT projection_state FROM workspace_artifact_events WHERE artifact_id = ?")
          .get(artifactId)
      ).toEqual({ projection_state: "published" });
      expect(migrated.prepare("SELECT revision FROM canvases WHERE id = 'canvas-1'").get()).toEqual(
        {
          revision: 2
        }
      );
    } finally {
      migrated.close();
    }
  });

  it("restores an exact canvas snapshot and rejects stale autosave revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-canvas-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "canvas.db");
    runLocalMigrations({ filename });
    const repository = new SqliteCanvasRepository(filename);
    try {
      const initial = {
        id: "canvas-1",
        title: "Workflow",
        mission: "Deliver a tested workflow",
        revision: 0,
        viewport: { x: -120, y: 48, zoom: 0.85 },
        nodes: [
          {
            id: "task-1",
            type: "task" as const,
            position: { x: 100, y: 200 },
            width: 260,
            height: 140,
            zIndex: -1,
            data: { title: "Implement", state: "idle" as const, summary: "Typed task" }
          },
          {
            id: "gate-1",
            type: "gate" as const,
            position: { x: 480, y: 200 },
            data: { title: "Tests", state: "blocked" as const }
          }
        ],
        edges: [
          {
            id: "edge-1",
            source: "task-1",
            target: "gate-1",
            contract: {
              schemaVersion: "1.0" as const,
              kind: "dependency" as const,
              label: "evidence",
              requiredEvidenceTypes: ["test" as const]
            }
          }
        ]
      };
      const saved = repository.save(initial);
      expect(saved.revision).toBe(1);
      const firstNode = initial.nodes[0];
      const secondNode = initial.nodes[1];
      if (firstNode === undefined || secondNode === undefined) {
        throw new Error("Canvas test fixture is incomplete");
      }
      expect(repository.load("canvas-1")).toEqual({
        ...initial,
        creationMode: "manual",
        executionProfile: "balanced",
        revision: 1,
        nodes: [
          {
            ...firstNode,
            data: { ...firstNode.data, retryMaxAttempts: 1, permissions: [] }
          },
          {
            ...secondNode,
            data: { ...secondNode.data, summary: "", retryMaxAttempts: 1, permissions: [] }
          }
        ]
      });
      expect(() => repository.save(initial)).toThrow("revision conflict");
    } finally {
      repository.close();
    }
  });

  it("upgrades legacy canvas context edges into audited context connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-legacy-connection-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "legacy.db");
    const legacyMigrations = await createLegacyMigrations(directory, 15);
    const timestamp = Date.parse("2026-07-20T12:00:00.000Z");
    runLocalMigrations({ filename, migrationsFolder: legacyMigrations });
    const sqlite = new Database(filename);
    try {
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
           VALUES ('project-1', 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
        )
        .run(directory, directory, timestamp, timestamp);
      sqlite
        .prepare(
          `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
           VALUES ('canvas-1', 'Principal', '', 3, '{"x":0,"y":0,"zoom":1}', ?, ?)`
        )
        .run(timestamp, timestamp);
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
           VALUES ('workspace-1', 'project-1', 'canvas-1', 'Principal', 0, 1, ?, ?)`
        )
        .run(timestamp, timestamp);
      sqlite
        .prepare(
          `INSERT INTO canvas_nodes (canvas_id, id, type, position_x, position_y, width, height, data_json)
           VALUES ('canvas-1', 'note-1', 'note', 0, 0, 360, 220, ?),
                  ('canvas-1', 'agent-1', 'agent', 0, 0, 560, 380, ?)`
        )
        .run(
          JSON.stringify({
            title: "Requirements",
            state: "idle",
            summary: "",
            content: "",
            retryMaxAttempts: 1,
            permissions: []
          }),
          JSON.stringify({
            title: "Reviewer",
            state: "idle",
            summary: "",
            adapterId: "codex",
            retryMaxAttempts: 1,
            permissions: []
          })
        );
      const contract = JSON.stringify({
        schemaVersion: "1.0",
        kind: "dependency",
        label: "Context",
        requiredEvidenceTypes: []
      });
      sqlite
        .prepare(
          `INSERT INTO canvas_edges (canvas_id, id, source_node_id, target_node_id, contract_json)
           VALUES ('canvas-1', 'edge-1', 'note-1', 'agent-1', ?)`
        )
        .run(contract);
      sqlite
        .prepare(
          `INSERT INTO workspace_connection_events
           (id, workspace_id, canvas_id, edge_id, source_node_id, target_node_id, contract_json,
            idempotency_key, projection_state, created_at)
           VALUES ('event-1', 'workspace-1', 'canvas-1', 'edge-1', 'note-1', 'agent-1', ?,
                   'legacy-connection-1', 'published', ?)`
        )
        .run(contract, timestamp);
    } finally {
      sqlite.close();
    }

    runLocalMigrations({ filename });
    const migrated = new Database(filename, { readonly: true });
    try {
      expect(
        migrated.prepare("SELECT contract_json FROM canvas_edges WHERE id = 'edge-1'").get()
      ).toEqual({
        contract_json: expect.stringContaining('"kind":"context"')
      });
      expect(
        migrated
          .prepare(
            "SELECT event_type, actor_node_id, canvas_revision FROM workspace_connection_events WHERE id = 'event-1'"
          )
          .get()
      ).toEqual({ event_type: "connection_created", actor_node_id: null, canvas_revision: 3 });
    } finally {
      migrated.close();
    }
  });

  it("persists lifecycle and recovers interrupted runtime sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-recovery-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "runtime.db");
    runLocalMigrations({ filename });

    const store = new SqliteRuntimeSessionStore(filename);
    try {
      const now = new Date();
      await store.save({
        id: "runtime-1",
        adapterId: "fake-agent",
        state: "running",
        cwd: directory,
        processId: 123,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        exitCode: null,
        exitSignal: null,
        interruptionReason: null
      });
      expect(await store.markActiveSessionsInterrupted(new Date(), "application_restart")).toBe(1);
      expect(store.get("runtime-1")?.state).toBe("interrupted");
      expect(store.get("runtime-1")?.processId).toBeNull();
    } finally {
      store.close();
    }
  });

  it("recovers active workflow and node projections as interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-workflow-recovery-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "workflow.db");
    runLocalMigrations({ filename });
    const store = new SqliteWorkflowRunStore(filename);
    try {
      const timestamp = new Date().toISOString();
      const workflow = {
        schema_version: "1.0" as const,
        id: "recovery-workflow",
        name: "Recovery workflow",
        concurrency: 1,
        permissions: {},
        inputs: {},
        nodes: [
          {
            id: "task",
            type: "shell" as const,
            depends_on: [],
            isolation: "none" as const,
            permissions: {},
            resources: [],
            retry: { max_attempts: 1, backoff_ms: 0, retry_on: [] }
          }
        ]
      };
      await store.createRun(
        {
          id: "run-recovery",
          workflowId: workflow.id,
          workflowVersion: "1.0",
          workflowHash: "workflow-hash",
          inputHash: "input-hash",
          effectivePermissions: {},
          state: "paused",
          dryRun: false,
          concurrency: 1,
          startedAt: timestamp,
          endedAt: null,
          lineage: {
            sourceRunId: "source-run",
            nodeId: "task",
            scope: "dependents",
            alternativeGroupId: "alternative:source-run:task",
            alternativeLabel: "fast"
          },
          nodeRuns: [],
          reportArtifact: null
        },
        workflow,
        {
          id: "event-recovery-created",
          runId: "run-recovery",
          nodeRunId: null,
          type: "run.created",
          timestamp,
          schemaVersion: "1.0",
          sequence: 1,
          payload: {}
        }
      );
      await store.saveNodeRun({
        id: "node-run-recovery",
        runId: "run-recovery",
        nodeId: "task",
        state: "running",
        attempt: 1,
        inputHash: "node-input-hash",
        idempotencyKey: "recovery-idempotency-key",
        evidence: [],
        failureReason: null
      });

      const recoveredEvents: {
        readonly type: string;
        readonly payload: Readonly<Record<string, unknown>>;
      }[] = [];
      expect(store.listAlternatives("source-run", "task")).toEqual([
        expect.objectContaining({
          id: "run-recovery",
          lineage: expect.objectContaining({ alternativeLabel: "fast" })
        })
      ]);
      const unsubscribe = store.subscribe((event) => recoveredEvents.push(event));
      expect(store.recoverInterruptedRuns(new Date("2026-01-01T00:00:00.000Z"))).toBe(1);
      unsubscribe();
      const sqlite = new Database(filename, { readonly: true });
      try {
        expect(
          sqlite.prepare("SELECT state FROM workflow_runs WHERE id = ?").get("run-recovery")
        ).toEqual({ state: "interrupted" });
        expect(
          sqlite
            .prepare("SELECT state, failure_reason FROM workflow_node_runs WHERE id = ?")
            .get("node-run-recovery")
        ).toEqual({ state: "interrupted", failure_reason: "unknown_error" });
        expect(
          sqlite
            .prepare(
              "SELECT type, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1"
            )
            .get("run-recovery")
        ).toEqual({ type: "run.interrupted", payload_json: '{"reason":"runtime_restart"}' });
        expect(recoveredEvents).toEqual([
          expect.objectContaining({
            type: "run.interrupted",
            payload: { reason: "runtime_restart" }
          })
        ]);
        expect(store.recoverInterruptedRuns(new Date("2026-01-01T00:00:01.000Z"))).toBe(0);
      } finally {
        sqlite.close();
      }
    } finally {
      store.close();
    }
  });

  it("persists Git metadata and atomically recovers leases and running gates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgedeck-git-store-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "git-store.db");
    runLocalMigrations({ filename });
    const store = new SqliteGitStore(filename);
    const timestamp = "2026-01-01T00:00:00.000Z";
    try {
      await store.saveProject({
        id: "project-1",
        name: "Project",
        rootPath: directory,
        canonicalRootPath: directory,
        defaultBranch: "main",
        headCommit: "a".repeat(40),
        createdAt: timestamp,
        updatedAt: timestamp
      });
      await store.saveWorktree({
        id: "worktree-1",
        projectId: "project-1",
        taskKey: "TASK-1",
        taskTitle: "Store test",
        branchName: "forgedeck/store-test-task-1",
        path: join(directory, "worktree"),
        baseRef: "main",
        baseCommit: "a".repeat(40),
        state: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const worktreeLease = {
        id: "lease-1",
        worktreeId: "worktree-1",
        ownerId: "run:1",
        acquiredAt: timestamp
      };
      expect(await store.tryAcquireLease(worktreeLease)).toBe(true);
      expect(await store.tryAcquireLease({ ...worktreeLease, id: "lease-2" })).toBe(false);
      const projectLease = {
        id: "project-lease-1",
        projectId: "project-1",
        ownerId: "merge:1",
        acquiredAt: timestamp
      };
      expect(await store.tryAcquireProjectLease(projectLease)).toBe(true);
      expect(await store.tryAcquireProjectLease({ ...projectLease, id: "project-lease-2" })).toBe(
        false
      );

      await store.saveGateRun({
        id: "gate-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        presetId: "test",
        state: "running",
        executableName: "pnpm",
        args: ["run", "test"],
        headCommit: "b".repeat(40),
        exitCode: null,
        durationMs: null,
        timedOut: false,
        outputSummary: "API_KEY=must-not-persist",
        startedAt: timestamp,
        endedAt: null
      });
      expect((await store.getGateRun("gate-1"))?.outputSummary).not.toContain("must-not-persist");
      await store.saveGateProcess({
        gateRunId: "gate-1",
        worktreeId: "worktree-1",
        processId: 4242,
        startedAt: timestamp
      });
      expect((await store.listGateProcesses())[0]?.processId).toBe(4242);
      expect(await store.recoverGateRuns("2026-01-01T00:01:00.000Z")).toBe(1);
      expect((await store.getGateRun("gate-1"))?.state).toBe("interrupted");
      expect(await store.recoverLeases(["worktree-1"])).toBe(0);
      await store.removeGateProcess("gate-1");
      expect(await store.recoverLeases()).toBe(1);
      expect(await store.recoverProjectLeases()).toBe(1);
      expect((await store.getProject("project-1"))?.defaultBranch).toBe("main");
      expect((await store.getWorktree("worktree-1"))?.taskTitle).toBe("Store test");
    } finally {
      store.close();
    }
  });
});

async function createLegacyMigrations(directory: string, maxIndex = 7): Promise<string> {
  const source = fileURLToPath(new URL("../drizzle", import.meta.url));
  const destination = join(directory, "legacy-migrations");
  await mkdir(join(destination, "meta"), { recursive: true });
  const journal = JSON.parse(await readFile(join(source, "meta", "_journal.json"), "utf8")) as {
    readonly version: string;
    readonly dialect: string;
    readonly entries: readonly {
      readonly idx: number;
      readonly tag: string;
      readonly version: string;
      readonly when: number;
      readonly breakpoints: boolean;
    }[];
  };
  const entries = journal.entries.filter((entry) => entry.idx <= maxIndex);
  await writeFile(
    join(destination, "meta", "_journal.json"),
    JSON.stringify({ version: journal.version, dialect: journal.dialect, entries }, null, 2)
  );
  await Promise.all(
    entries.map((entry) =>
      copyFile(join(source, `${entry.tag}.sql`), join(destination, `${entry.tag}.sql`))
    )
  );
  return destination;
}

function seedLegacyHandoff(filename: string): void {
  const sqlite = new Database(filename);
  const timestamp = Date.parse("2026-07-19T12:00:00.000Z");
  const role = {
    name: "Reviewer",
    responsibilities: "Review the handoff",
    constraints: "Stay in the project",
    expectedDeliverable: "Reviewed package",
    completionCriteria: "Evidence reviewed"
  };
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-project",
        "Legacy project",
        "C:/legacy",
        "C:/legacy",
        "main",
        "0123456789abcdef0123456789abcdef01234567",
        timestamp,
        timestamp
      );
    sqlite
      .prepare(
        `INSERT INTO canvases
           (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run("legacy-canvas", "Legacy", "Preserve the package", 1, "{}", timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO canvas_handoffs
           (id, canvas_id, project_id, status, revision, mission, source_json, target_json,
            edge_json, content_json, error, created_at, updated_at, ready_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-handoff",
        "legacy-canvas",
        "legacy-project",
        "delivering",
        4,
        "Preserve the package",
        JSON.stringify({ nodeId: "source", title: "Source", role }),
        JSON.stringify({ nodeId: "target", title: "Target", role }),
        JSON.stringify({
          edgeId: "legacy-edge",
          contract: {
            schemaVersion: "1.0",
            kind: "handoff",
            label: "Review",
            requiredEvidenceTypes: ["test"],
            handoffMode: "manual"
          }
        }),
        JSON.stringify({
          summary: "Reviewed package",
          completedWork: [],
          decisions: [],
          evidence: [],
          openQuestions: [],
          risks: []
        }),
        null,
        timestamp,
        timestamp,
        timestamp,
        null
      );
    sqlite
      .prepare(
        `INSERT INTO canvas_handoff_events
           (id, handoff_id, sequence, type, from_status, to_status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-event",
        "legacy-handoff",
        1,
        "delivery_started",
        "ready",
        "delivering",
        null,
        timestamp
      );
  } finally {
    sqlite.close();
  }
}
