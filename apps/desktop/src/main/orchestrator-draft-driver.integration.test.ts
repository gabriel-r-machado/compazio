import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLocalMigrations,
  SqliteCanvasRepository,
  SqliteGitStore,
  SqliteWorkflowDraftStore,
  SqliteWorkspaceRepository
} from "@forgedeck/local-db";
import type { AgentRuntimeCapability, WorkflowDraft } from "@forgedeck/schemas";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorDraftDriver } from "./orchestrator-draft-driver";

/**
 * End-to-end validation of the Lote 4 pipeline against REAL persistence: a real orchestrator session's
 * output (⟦compasso:draft⟧ envelopes) flows through the driver into a real SqliteWorkflowDraftStore and
 * survives a reload — with no process ever started. This is the closest automated proof to running the
 * app that does not require a GUI or an installed CLI agent.
 */

const OPEN = "⟦compasso:draft⟧";
const CLOSE = "⟦/compasso⟧";
function envelope(json: string): string {
  return `${OPEN}${json}${CLOSE}`;
}

const claude: AgentRuntimeCapability = {
  runtimeId: "claude-code",
  provider: "claude-code",
  displayName: "Claude Code",
  installed: true,
  authenticated: true,
  enabled: true,
  supportsParallelSessions: true,
  maxConcurrentSessions: 4,
  activeSessions: 0,
  availableModels: [],
  capabilities: ["code", "interactive"],
  lastCheckedAt: "2026-07-23T00:00:00.000Z"
};

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
);

async function freshWorkspace(): Promise<{
  store: SqliteWorkflowDraftStore;
  filename: string;
  workspaceId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-orch-"));
  directories.push(directory);
  const filename = join(directory, "local.db");
  runLocalMigrations({ filename });
  const workspaceId = await seedWorkspace(filename);
  return { store: new SqliteWorkflowDraftStore(filename), filename, workspaceId };
}

function driverFor(store: SqliteWorkflowDraftStore): OrchestratorDraftDriver {
  return new OrchestratorDraftDriver({
    store,
    loadCapabilities: () => Promise.resolve([claude])
  });
}

describe("orchestrator draft pipeline (integration)", () => {
  it("composes a draft from real session output and reloads it exactly", async () => {
    const { store, filename, workspaceId } = await freshWorkspace();
    try {
      const driver = driverFor(store);
      driver.attach({
        sessionId: "session-1",
        workspaceId,
        creationMode: "automatic",
        executionProfile: "balanced"
      });
      // A realistic agent transcript: natural-language chatter interleaved with wire actions,
      // arriving in several chunks the way a PTY streams it.
      await driver.ingest("session-1", "Analisando o objetivo. Vou montar uma equipe pequena.\n");
      await driver.ingest(
        "session-1",
        envelope('{"type":"start_workflow_draft","objective":"landing page premium"}') +
          envelope('{"type":"add_draft_node","ref":"ux","title":"UX & Conteúdo","role":"designer"}')
      );
      await driver.ingest(
        "session-1",
        envelope('{"type":"add_draft_node","ref":"fe","title":"Front-end","role":"implementer"}') +
          envelope('{"type":"connect_draft_nodes","from":"ux","to":"fe"}') +
          envelope('{"type":"finalize_workflow_draft"}')
      );

      // Reload from a brand-new store instance backed by the same file: persistence is authoritative.
      store.close();
      const reloaded = new SqliteWorkflowDraftStore(filename);
      try {
        const draft = reloaded.getLatestForWorkspace(workspaceId);
        expect(draft).not.toBeNull();
        expect(draft?.objective).toBe("landing page premium");
        expect(draft?.nodes.map((node) => node.id)).toEqual(["ux", "fe"]);
        expect(draft?.edges).toHaveLength(1);
        // Ready for the user to approve — and NOTHING has executed (the draft only shapes ghost nodes).
        expect(draft?.state).toBe("ready");
        expect(draft?.nodes.every((node) => node.lifecycle === "draft")).toBe(true);
      } finally {
        reloaded.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        /* already closed on the happy path */
      }
    }
  });

  it("different objectives produce different persisted drafts (invariant 1)", async () => {
    const { store, workspaceId } = await freshWorkspace();
    try {
      const driver = driverFor(store);
      driver.attach({
        sessionId: "s-a",
        workspaceId,
        creationMode: "automatic",
        executionProfile: "balanced"
      });
      await driver.ingest(
        "s-a",
        envelope('{"type":"start_workflow_draft","objective":"landing page de vendas"}')
      );
      const first = store.getLatestForTerminal(workspaceId, "s-a") as WorkflowDraft;

      driver.attach({
        sessionId: "s-b",
        workspaceId,
        creationMode: "automatic",
        executionProfile: "balanced"
      });
      await driver.ingest(
        "s-b",
        envelope('{"type":"start_workflow_draft","objective":"corrigir bug de autenticação"}')
      );
      const second = store.getLatestForTerminal(workspaceId, "s-b") as WorkflowDraft;

      expect(first.id).not.toBe(second.id);
      expect(first.objective).toBe("landing page de vendas");
      expect(second.objective).toBe("corrigir bug de autenticação");
    } finally {
      store.close();
    }
  });
});

/** Seeds a project, canvas and workspace through typed repositories and returns the workspace id. */
async function seedWorkspace(filename: string): Promise<string> {
  const git = new SqliteGitStore(filename);
  try {
    await git.saveProject({
      id: "project-1",
      name: "Premium LP",
      rootPath: "C:/Projects/Premium LP",
      canonicalRootPath: "C:/Projects/Premium LP",
      defaultBranch: "main",
      headCommit: "0123456789abcdef0123456789abcdef01234567",
      createdAt: "2026-07-23T12:00:00.000Z",
      updatedAt: "2026-07-23T12:00:00.000Z"
    });
  } finally {
    git.close();
  }
  const canvases = new SqliteCanvasRepository(filename);
  try {
    canvases.save({
      id: "default",
      title: "Main",
      creationMode: "manual",
      executionProfile: "balanced",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: []
    });
  } finally {
    canvases.close();
  }
  const workspaces = new SqliteWorkspaceRepository(filename);
  try {
    return workspaces.create({ projectId: "project-1", legacyCanvasId: "default" }).id;
  } finally {
    workspaces.close();
  }
}
