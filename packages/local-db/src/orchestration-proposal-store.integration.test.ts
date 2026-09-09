import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { defaultAutonomyConfig } from "@forgedeck/schemas";

import { runLocalMigrations } from "./migrate";
import { SqliteOrchestrationProposalStore } from "./orchestration-proposal-store";
import { SqliteWorkflowRunCommandStore } from "./workflow-run-command-store";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

describe("SqliteOrchestrationProposalStore", () => {
  it("persists a human-reviewed proposal without creating a workflow run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-proposal-"));
    directories.push(directory);
    const filename = join(directory, "local.db");
    runLocalMigrations({ filename });
    seedWorkspace(filename, directory);
    const store = new SqliteOrchestrationProposalStore(
      filename,
      () => "00000000-0000-4000-8000-000000000010",
      () => new Date("2026-07-21T12:00:00.000Z")
    );
    try {
      const draft = store.create(input());
      expect(draft).toMatchObject({
        status: "draft",
        autonomyLevel: "assisted",
        revision: 1,
        createdBy: "local-user"
      });
      expect(draft.autonomy).toEqual({ ...defaultAutonomyConfig, maxConcurrentAgents: 2 });
      expect(draft.checksum).toHaveLength(64);
      const revised = store.updateDraft({
        workspaceId: "workspace-1",
        proposalId: draft.id,
        expectedRevision: 1,
        draft: { ...input(), objective: "Ship a revised local change" }
      });
      expect(revised).toMatchObject({ objective: "Ship a revised local change", revision: 2 });
      // The reviewed autonomy limits survive a revision instead of resetting to the default.
      expect(revised.autonomy.maxConcurrentAgents).toBe(2);
      expect(() =>
        store.updateDraft({
          workspaceId: "workspace-1",
          proposalId: draft.id,
          expectedRevision: 1,
          draft: input()
        })
      ).toThrow("revision conflict");
      const approved = store.approve({
        workspaceId: "workspace-1",
        proposalId: draft.id,
        expectedRevision: 2
      });
      expect(approved).toMatchObject({
        status: "approved",
        revision: 3,
        reviewedBy: "local-user",
        approvedAt: "2026-07-21T12:00:00.000Z"
      });
      expect(() =>
        store.reject({ workspaceId: "workspace-1", proposalId: draft.id, expectedRevision: 3 })
      ).toThrow("Only draft");
      expect(store.listEvents("workspace-1", draft.id).map((event) => event.type)).toEqual([
        "created",
        "updated",
        "approved"
      ]);
      const commands = new SqliteWorkflowRunCommandStore(filename);
      try {
        expect(() =>
          commands.requestStart({
            templateId: "local-agent-delivery",
            workspaceId: "workspace-1",
            agentNodeId: "reviewer",
            task: "A different renderer-controlled task",
            dryRun: false,
            proposalId: approved.id,
            requestedBy: "desktop-proposal-review"
          })
        ).toThrow("does not match the approved proposal");
        const requested = commands.requestStart({
          templateId: "local-agent-delivery",
          workspaceId: "workspace-1",
          agentNodeId: "reviewer",
          task: approved.objective,
          dryRun: false,
          proposalId: approved.id,
          requestedBy: "desktop-proposal-review"
        });
        const repeated = commands.requestStart({
          templateId: "local-agent-delivery",
          workspaceId: "workspace-1",
          agentNodeId: "reviewer",
          task: approved.objective,
          dryRun: false,
          proposalId: approved.id,
          requestedBy: "desktop-proposal-review"
        });
        expect(repeated.id).toBe(requested.id);
        expect(commands.getForProposal("workspace-1", approved.id)).toMatchObject({
          id: requested.id,
          status: "queued"
        });
      } finally {
        commands.close();
      }
      expect(store.listEvents("workspace-1", draft.id).map((event) => event.type)).toEqual([
        "created",
        "updated",
        "approved",
        "execution_requested"
      ]);
      const sqlite = new Database(filename, { readonly: true });
      try {
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get()).toEqual({
          count: 0
        });
      } finally {
        sqlite.close();
      }
    } finally {
      store.close();
    }
  });

  it("reads a pre-E4 proposal without autonomy limits as the conservative default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-proposal-legacy-"));
    directories.push(directory);
    const filename = join(directory, "local.db");
    runLocalMigrations({ filename });
    seedWorkspace(filename, directory);
    const store = new SqliteOrchestrationProposalStore(
      filename,
      () => "00000000-0000-4000-8000-000000000011",
      () => new Date("2026-07-21T12:00:00.000Z")
    );
    try {
      const draft = store.create(input());
      // Simulate a row persisted before the autonomy field existed by stripping it from the JSON.
      const sqlite = new Database(filename);
      try {
        const row = sqlite
          .prepare("SELECT proposal_json FROM orchestration_proposals WHERE id = ?")
          .get(draft.id) as { readonly proposal_json: string };
        const stored = JSON.parse(row.proposal_json) as Record<string, unknown>;
        delete stored.autonomy;
        sqlite
          .prepare("UPDATE orchestration_proposals SET proposal_json = ? WHERE id = ?")
          .run(JSON.stringify(stored), draft.id);
      } finally {
        sqlite.close();
      }
      const legacy = store.get("workspace-1", draft.id);
      expect(legacy.autonomy).toEqual(defaultAutonomyConfig);
    } finally {
      store.close();
    }
  });
});

function input() {
  return {
    workspaceId: "workspace-1",
    objective: "Ship a reviewed change",
    understanding: "A reviewed local delivery is needed.",
    questions: ["Which template applies?"],
    requiredMaterials: ["Current canvas"],
    suggestedTeam: [{ nodeId: "reviewer", role: "Review" }],
    workflowTemplateId: "local-agent-delivery",
    executionAgentNodeId: "reviewer",
    dependencies: [],
    requestedPermissions: ["execute_tasks" as const],
    gates: ["typecheck"],
    risks: ["Scope ambiguity"],
    estimatedCost: "Estimated locally",
    estimatedDuration: "Estimated 1 hour",
    autonomyLevel: "assisted" as const,
    autonomy: { ...defaultAutonomyConfig, maxConcurrentAgents: 2 }
  };
}

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at) VALUES ('project-1', 'Compasso', ?, ?, 'main', 'abc', ?, ?)"
      )
      .run(root, root, now, now);
    sqlite
      .prepare(
        "INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at) VALUES ('canvas-1', 'Main', '', 1, '{}', ?, ?)"
      )
      .run(now, now);
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at) VALUES ('workspace-1', 'project-1', 'canvas-1', 'Main', 0, 1, ?, ?)"
      )
      .run(now, now);
  } finally {
    sqlite.close();
  }
}
