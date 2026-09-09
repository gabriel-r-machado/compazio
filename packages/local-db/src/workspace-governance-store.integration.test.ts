import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations } from "./migrate";
import { SqliteWorkspaceGovernanceStore } from "./workspace-governance-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteWorkspaceGovernanceStore", () => {
  it("versions an agent identity pack whenever its configured canvas role changes", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceGovernanceStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const first = store.getAgentProfile(fixture.workspaceId, "reviewer");
      expect(first).toMatchObject({
        version: 1,
        identity: "Reviewer",
        adapterId: "codex",
        capabilities: ["send_messages"],
        expectedDeliverables: ["Review report"]
      });
      expect(store.getAgentProfile(fixture.workspaceId, "reviewer").id).toBe(first.id);

      updateAgentRole(fixture.filename, fixture.canvasId, "Updated review report");
      const second = store.getAgentProfile(fixture.workspaceId, "reviewer");
      expect(second).toMatchObject({ version: 2, expectedDeliverables: ["Updated review report"] });
      expect(
        store.listAgentProfiles(fixture.workspaceId, "reviewer").map((profile) => profile.version)
      ).toEqual([2, 1]);
    } finally {
      store.close();
    }
  });

  it("keeps detailed missions and workspace memory as immutable versions", async () => {
    const fixture = await createFixture();
    const store = new SqliteWorkspaceGovernanceStore(fixture.filename, {
      createId: sequentialIds(),
      now: clock()
    });
    try {
      const firstMission = store.setMission({
        workspaceId: fixture.workspaceId,
        objective: "Ship a reviewed local beta",
        scope: ["Desktop runtime"],
        decisions: ["Keep execution manual"],
        constraints: ["No cloud"],
        progress: "Runtime ready",
        blockers: []
      });
      expect(store.getMission(fixture.workspaceId)).toEqual(firstMission);
      expect(readCanvasMission(fixture.filename, fixture.canvasId)).toBe(
        "Ship a reviewed local beta"
      );

      updateCanvasMission(fixture.filename, fixture.canvasId, "Ship a recoverable local beta");
      expect(store.getMission(fixture.workspaceId)).toMatchObject({
        version: 2,
        objective: "Ship a recoverable local beta",
        scope: ["Desktop runtime"],
        decisions: ["Keep execution manual"]
      });

      const firstMemory = store.setWorkspaceMemory({
        workspaceId: fixture.workspaceId,
        stack: ["TypeScript", "SQLite"],
        architecture: "Local-first desktop",
        patterns: ["Append-only audit"],
        commands: ["pnpm test"],
        conventions: ["Typed boundaries"],
        technicalDecisions: ["No automatic retry"]
      });
      const secondMemory = store.setWorkspaceMemory({
        workspaceId: fixture.workspaceId,
        stack: ["TypeScript", "SQLite"],
        architecture: "Local-first desktop",
        patterns: ["Append-only audit", "Bounded queues"],
        commands: ["pnpm test"],
        conventions: ["Typed boundaries"],
        technicalDecisions: ["No automatic retry"]
      });
      expect(firstMemory.version).toBe(1);
      expect(secondMemory.version).toBe(2);
      expect(store.getWorkspaceMemory(fixture.workspaceId)).toEqual(secondMemory);
      expect(
        store.listWorkspaceMemories(fixture.workspaceId).map((memory) => memory.version)
      ).toEqual([2, 1]);
    } finally {
      store.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly workspaceId: string;
  readonly canvasId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-governance-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "local.db");
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const timestamp = Date.parse("2026-07-20T12:00:00.000Z");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, directory, directory, timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES (?, 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(canvasId, timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO workspaces
         (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, ?, 'Principal', 0, 1, ?, ?)`
      )
      .run(workspaceId, projectId, canvasId, timestamp, timestamp);
    sqlite
      .prepare(
        `INSERT INTO canvas_nodes
         (canvas_id, id, type, position_x, position_y, width, height, data_json)
         VALUES (?, 'reviewer', 'agent', 0, 0, 560, 380, ?)`
      )
      .run(canvasId, JSON.stringify(agentData("Review report")));
  } finally {
    sqlite.close();
  }
  return { filename, workspaceId, canvasId };
}

function updateAgentRole(filename: string, canvasId: string, deliverable: string): void {
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = 'reviewer'")
      .run(JSON.stringify(agentData(deliverable)), canvasId);
  } finally {
    sqlite.close();
  }
}

function agentData(expectedDeliverable: string): Record<string, unknown> {
  return {
    title: "Reviewer",
    state: "idle",
    summary: "",
    adapterId: "codex",
    role: {
      name: "Reviewer",
      responsibilities: "Review evidence",
      constraints: "Do not change scope",
      expectedDeliverable,
      completionCriteria: "All checks reviewed"
    },
    retryMaxAttempts: 1,
    permissions: ["send_messages"]
  };
}

function readCanvasMission(filename: string, canvasId: string): string {
  const sqlite = new Database(filename, { readonly: true });
  try {
    return (
      sqlite.prepare("SELECT mission FROM canvases WHERE id = ?").get(canvasId) as {
        mission: string;
      }
    ).mission;
  } finally {
    sqlite.close();
  }
}

function updateCanvasMission(filename: string, canvasId: string, mission: string): void {
  const sqlite = new Database(filename);
  try {
    sqlite.prepare("UPDATE canvases SET mission = ? WHERE id = ?").run(mission, canvasId);
  } finally {
    sqlite.close();
  }
}

function sequentialIds(): () => string {
  let sequence = 100;
  return () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`;
}

function clock(): () => Date {
  let timestamp = Date.parse("2026-07-20T12:00:00.000Z");
  return () => new Date(timestamp++);
}
