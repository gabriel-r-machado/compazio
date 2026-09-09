import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { automaticApprovalFingerprint, SqliteAutomaticRunStore } from "./automatic-run-store";
import { runLocalMigrations } from "./migrate";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createStore(): Promise<{ store: SqliteAutomaticRunStore; workspaceId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ForgeDeck automatic store "));
  directories.push(directory);
  const filename = join(directory, "automatic.db");
  runLocalMigrations({ filename, backupBeforeMigration: false });
  // The session belongs to a workspace, exactly like every other local record.
  const seed = new Database(filename);
  const projectId = "00000000-0000-4000-8000-000000000001";
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  try {
    seed
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, directory, directory, now, now);
    seed
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-1', 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(now, now);
    seed
      .prepare(
        `INSERT INTO workspaces
           (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES ('ws-1', ?, 'canvas-1', 'Principal', 0, 1, ?, ?)`
      )
      .run(projectId, now, now);
  } finally {
    seed.close();
  }
  return { store: new SqliteAutomaticRunStore(filename), workspaceId: "ws-1" };
}

const STATE = {
  runIds: ["run-1"],
  remediationCycle: 0,
  plan: { title: "Auth", nodes: [{ id: "impl" }] }
};

describe("SqliteAutomaticRunStore", () => {
  it("persists a session and restores its state verbatim after reload", async () => {
    const { store, workspaceId } = await createStore();
    try {
      const created = store.create({
        workspaceId,
        objective: "Add auth",
        mode: "standard",
        draftId: "draft-1",
        state: STATE
      });
      expect(created.status).toBe("planning");
      expect(created.currentRunId).toBeNull();

      const saved = store.save({
        automaticRunId: created.automaticRunId,
        status: "running",
        currentRunId: "run-2",
        remediationCycle: 1,
        state: { ...STATE, runIds: ["run-1", "run-2"], remediationCycle: 1 }
      });
      expect(saved.currentRunId).toBe("run-2");
      expect(saved.remediationCycle).toBe(1);
      // The coordinator state survives the round trip unchanged, so resume needs nothing else.
      expect(saved.state).toEqual({
        ...STATE,
        runIds: ["run-1", "run-2"],
        remediationCycle: 1
      });

      expect(store.listResumable(workspaceId).map((entry) => entry.automaticRunId)).toEqual([
        created.automaticRunId
      ]);
      const stopped = store.save({
        automaticRunId: created.automaticRunId,
        status: "stopped",
        remediationCycle: 1,
        stopReason: "remediation_exhausted",
        result: "Reached the remediation limit.",
        state: saved.state
      });
      expect(stopped.stopReason).toBe("remediation_exhausted");
      // A terminal session is no longer offered for resume.
      expect(store.listResumable(workspaceId)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("keeps each run's prompt separate and never rewrites one a run already used", async () => {
    const { store, workspaceId } = await createStore();
    try {
      const session = store.create({
        workspaceId,
        objective: "Add auth",
        mode: "standard",
        draftId: "draft-1",
        state: STATE
      });
      store.putNodePrompt(session.automaticRunId, {
        runId: "run-1",
        nodeId: "impl",
        cycle: 0,
        prompt: "Implement auth."
      });
      // The remediation run gets its own corrected prompt under its own run id.
      store.putNodePrompt(session.automaticRunId, {
        runId: "run-2",
        nodeId: "impl",
        cycle: 1,
        prompt: "Fix the type error."
      });
      // Re-recording an existing (run, node) pair is ignored, so a resume cannot alter history.
      store.putNodePrompt(session.automaticRunId, {
        runId: "run-1",
        nodeId: "impl",
        cycle: 0,
        prompt: "SOMETHING ELSE"
      });

      expect(store.getNodePrompt("run-1", "impl")).toBe("Implement auth.");
      expect(store.getNodePrompt("run-2", "impl")).toBe("Fix the type error.");
      // A node that is not automatic-mode work has no prompt, and the resolver must see that.
      expect(store.getNodePrompt("run-1", "unknown")).toBeNull();
      expect(store.listNodePrompts(session.automaticRunId)).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("makes an approval idempotent and refuses to authorize a different action", async () => {
    const { store, workspaceId } = await createStore();
    try {
      const session = store.create({
        workspaceId,
        objective: "Drop the table",
        mode: "standard",
        draftId: "draft-1",
        state: STATE
      });
      const action = {
        nodeId: "migrate",
        prompt: "Run the destructive migration.",
        operationRisk: "destructive",
        operation: "migrate"
      };
      const fingerprint = automaticApprovalFingerprint(action);
      const first = store.requireApproval({
        automaticRunId: session.automaticRunId,
        nodeId: action.nodeId,
        actionFingerprint: fingerprint
      });
      expect(first.decision).toBe("pending");
      // Asking twice does not create a second request.
      store.requireApproval({
        automaticRunId: session.automaticRunId,
        nodeId: action.nodeId,
        actionFingerprint: fingerprint
      });
      expect(store.listApprovals(session.automaticRunId)).toHaveLength(1);

      const approved = store.decideApproval({
        automaticRunId: session.automaticRunId,
        nodeId: action.nodeId,
        actionFingerprint: fingerprint,
        decision: "approved"
      });
      expect(approved.decision).toBe("approved");
      // Deciding again cannot flip a decision already taken.
      expect(
        store.decideApproval({
          automaticRunId: session.automaticRunId,
          nodeId: action.nodeId,
          actionFingerprint: fingerprint,
          decision: "rejected"
        }).decision
      ).toBe("approved");

      // A different action on the same node is a different fingerprint, so the approval does not carry.
      const otherFingerprint = automaticApprovalFingerprint({
        ...action,
        prompt: "Also delete the backups."
      });
      expect(otherFingerprint).not.toBe(fingerprint);
      expect(
        store.getApproval({
          automaticRunId: session.automaticRunId,
          nodeId: action.nodeId,
          actionFingerprint: otherFingerprint
        })
      ).toBeNull();
    } finally {
      store.close();
    }
  });
});
