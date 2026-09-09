import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runLocalMigrations, SqliteWorkflowDraftStore } from "@forgedeck/local-db";
import {
  applyDraftCommand,
  materializeWorkflowDraft,
  resolveNodeAgentAssignment
} from "@forgedeck/orchestration";
import type { AgentAssignmentCatalog } from "@forgedeck/orchestration";
import { agentDescriptorSchema, workflowDraftSchema } from "@forgedeck/schemas";
import type { AgentAdapterId, AgentDescriptor, WorkflowDraft } from "@forgedeck/schemas";

/**
 * Agent choices are part of the document, so they must survive a reload exactly as made — and a run
 * that already exists must never be re-judged or rewritten by a later change on the canvas.
 */

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

function runnable(id: AgentAdapterId): AgentDescriptor {
  return agentDescriptorSchema.parse({
    id,
    displayName: id,
    capabilities: ["planning", "backend", "testing"],
    available: true,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    hasImplementation: true
  });
}

function known(id: AgentAdapterId): AgentDescriptor {
  return agentDescriptorSchema.parse({
    id,
    displayName: id,
    capabilities: ["planning", "backend", "testing"],
    available: false,
    supportsPlanning: true,
    supportsExecution: true,
    supportsPipe: true,
    hasImplementation: false,
    unavailability: {
      code: "adapter_not_implemented",
      message: `${id} unavailable`,
      remediation: ""
    }
  });
}

/** Today's shape: only Claude runs; the other two are known options that are not installed. */
const catalog: AgentAssignmentCatalog = {
  descriptors: [runnable("claude-code"), known("codex"), known("opencode")]
};

const DRAFT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function draft(nodes: readonly Record<string, unknown>[]): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: DRAFT_ID,
    version: 1,
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Draft",
    objective: "Build it",
    state: "ready",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    nodes,
    edges: []
  });
}

const reducerContext = {
  now: "2026-07-25T12:00:00.000Z",
  newId: () => DRAFT_ID,
  capabilities: [],
  identity: {
    workspaceId: "workspace-1",
    sourceTerminalId: "terminal-1",
    creationMode: "automatic" as const,
    executionProfile: "balanced" as const,
    draftId: DRAFT_ID
  }
};

async function makeStore(): Promise<{ filename: string; store: SqliteWorkflowDraftStore }> {
  const directory = await mkdtemp(join(tmpdir(), "compazio-agents-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  runLocalMigrations({ filename });
  seedWorkspace(filename, directory);
  return { filename, store: new SqliteWorkflowDraftStore(filename) };
}

describe("agent assignments across a reload", () => {
  it("preserves every choice, the preset and the audit trail", async () => {
    const { filename, store } = await makeStore();
    try {
      const applied = applyDraftCommand(
        draft([
          { id: "ux", title: "UX", role: "designer" },
          { id: "backend", title: "Backend", role: "implementer" }
        ]),
        {
          kind: "assign_agents",
          preset: "automatic",
          assignments: [
            { nodeId: "ux", assignedAdapter: "claude-code", reason: "available" },
            { nodeId: "backend", assignedAdapter: "codex", reason: "recommended" }
          ]
        },
        reducerContext
      );
      store.persist(applied.draft as WorkflowDraft, [...applied.events]);
    } finally {
      store.close();
    }

    // A reload: a brand new store over the same database, exactly as reopening the app would do.
    const reopened = new SqliteWorkflowDraftStore(filename);
    try {
      const reloaded = reopened.getById(DRAFT_ID);
      expect(reloaded?.agentAssignmentPreset).toBe("automatic");
      expect(reloaded?.nodes.map((node) => node.agentAssignment?.assignedAdapter)).toEqual([
        "claude-code",
        "codex"
      ]);
      const events = reopened.listEvents(DRAFT_ID).map((entry) => entry.type);
      expect(events).toContain("workflow.node.adapter_assigned");
    } finally {
      reopened.close();
    }
  });

  it("opens a draft persisted before the agent model existed and demands an explicit choice", async () => {
    const { filename, store } = await makeStore();
    try {
      // A historical document: no agentAssignment at all, and a runtime id we do not recognize.
      store.persist(
        draft([
          {
            id: "legacy",
            title: "Legacy",
            role: "implementer",
            runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: "some-old-runtime" }
          }
        ]),
        []
      );
    } finally {
      store.close();
    }

    const reopened = new SqliteWorkflowDraftStore(filename);
    try {
      const reloaded = reopened.getById(DRAFT_ID) as WorkflowDraft;
      const legacyNode = reloaded.nodes[0] as WorkflowDraft["nodes"][number];
      // It still opens, unchanged — the field is genuinely optional on read.
      expect(legacyNode.agentAssignment).toBeUndefined();
      // And the unknown runtime id is never quietly promoted to an agent.
      expect(resolveNodeAgentAssignment(legacyNode).assignedAdapter).toBeNull();
      const result = materializeWorkflowDraft(reloaded, { agents: catalog });
      expect(result.workflow).toBeNull();
      expect(result.issues.map((issue) => issue.code)).toEqual(["missing_agent_assignment"]);
    } finally {
      reopened.close();
    }
  });

  it("keeps a legacy claude-code draft runnable after a reload with no user action", async () => {
    const { filename, store } = await makeStore();
    try {
      store.persist(
        draft([
          {
            id: "legacy",
            title: "Legacy",
            role: "implementer",
            runtimeRequirement: { strategy: "fixed", resolvedRuntimeId: "claude-code" }
          }
        ]),
        []
      );
    } finally {
      store.close();
    }

    const reopened = new SqliteWorkflowDraftStore(filename);
    try {
      const reloaded = reopened.getById(DRAFT_ID) as WorkflowDraft;
      const result = materializeWorkflowDraft(reloaded, { agents: catalog });
      expect(result.issues).toEqual([]);
      expect(result.workflow?.nodes[0]?.adapter).toBe("claude-code");
    } finally {
      reopened.close();
    }
  });

  it("a later canvas change never reaches a definition that was already materialized", async () => {
    const original = draft([
      {
        id: "backend",
        title: "Backend",
        role: "implementer",
        agentAssignment: { assignedAdapter: "claude-code" }
      }
    ]);
    const materialized = materializeWorkflowDraft(original, { agents: catalog });
    expect(materialized.workflow?.nodes[0]?.adapter).toBe("claude-code");

    // The user edits the draft afterwards. The already-materialized definition is a separate,
    // immutable value: there is no reverse synchronisation from the draft back into it.
    const edited = applyDraftCommand(
      original,
      {
        kind: "assign_agents",
        preset: "manual",
        assignments: [{ nodeId: "backend", assignedAdapter: "codex", reason: "changed" }]
      },
      reducerContext
    );
    expect(edited.draft?.nodes[0]?.agentAssignment?.assignedAdapter).toBe("codex");
    expect(materialized.workflow?.nodes[0]?.adapter).toBe("claude-code");
  });
});

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at) VALUES ('project-1', 'Compazio', ?, ?, 'main', 'abc', ?, ?)"
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
