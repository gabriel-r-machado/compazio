import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runLocalMigrations,
  SqliteCanvasHandoffRepository,
  SqliteCanvasRepository,
  SqlitePolicyEngine,
  SqliteGitStore,
  SqliteWorkspaceRepository
} from "@forgedeck/local-db";
import type { AgentAdapter } from "@forgedeck/agent-sdk";
import type { CanvasSnapshot } from "@forgedeck/schemas";

import { HandoffService } from "./handoff-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("reviewed handoff flow", () => {
  it("requires an explicit ready event before delivering a redacted package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-handoff-flow-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "compasso.db");
    runLocalMigrations({ filename });
    await seedProject(filename);

    const canvases = new SqliteCanvasRepository(filename);
    const store = new SqliteCanvasHandoffRepository(filename, sequentialIds());
    const policy = new SqlitePolicyEngine(filename);
    const workspaces = new SqliteWorkspaceRepository(filename);
    const writes: string[] = [];
    const adapter = reviewedHandoffAdapter();
    try {
      canvases.save(canvas());
      workspaces.create({ projectId: "project-1", legacyCanvasId: "default" });
      const service = new HandoffService({
        store,
        canvases,
        workspaces,
        sessions: {
          get: () => ({ projectId: "project-1", adapterId: "codex" })
        },
        terminal: {
          getSession: () => ({ state: "running" }),
          getBufferSnapshot: () => ({ data: "\u203a", sequence: 1 }),
          write: async (_sessionId, data) => {
            writes.push(data);
          }
        },
        adapters: { get: () => adapter },
        policy
      });

      const draft = service.createDraft({
        canvasId: "default",
        sourceNodeId: "source",
        targetNodeId: "target",
        edgeId: "edge-1"
      });
      expect(draft.status).toBe("draft");
      expect(writes).toEqual([]);
      await expect(
        service.deliver({ handoffId: draft.id, targetSessionId: "session-1" })
      ).rejects.toThrow("must be ready");
      expect(writes).toEqual([]);

      const ready = service.markReady({
        handoffId: draft.id,
        revision: draft.revision,
        content: {
          summary: "Landing page implemented; token=should-not-leak",
          completedWork: ["Hero and pricing completed"],
          decisions: ["Kept the local-first boundary"],
          evidence: [{ label: "Tests", detail: "lint and typecheck passed" }],
          openQuestions: ["Final copy approval"],
          risks: ["Visual review is still required"]
        }
      });
      expect(ready.status).toBe("ready");
      expect(writes).toEqual([]);

      const delivered = await service.deliver({
        handoffId: ready.id,
        targetSessionId: "session-1"
      });
      expect(delivered.status).toBe("delivered");
      expect(writes).toHaveLength(2);
      expect(writes[0]).toContain("MISSÃO");
      expect(writes[0]).toContain("SEU PAPEL");
      expect(writes[0]).toContain("CONTRATO");
      expect(writes[0]).toContain("Landing page implemented");
      expect(writes[0]).not.toContain("should-not-leak");
      expect(service.listEvents(delivered.id).map((event) => event.type)).toEqual([
        "draft_created",
        "handoff_ready",
        "delivery_attempt_started",
        "written_to_terminal",
        "submitted_to_agent",
        "response_detected"
      ]);
      expect(service.list({ canvasId: "default", limit: 10 })).toEqual([delivered]);
    } finally {
      workspaces.close();
      policy.close();
      store.close();
      canvases.close();
    }
  });
});

async function seedProject(filename: string): Promise<void> {
  const store = new SqliteGitStore(filename);
  try {
    await store.saveProject({
      id: "project-1",
      name: "Premium LP",
      rootPath: "C:/Projects/Premium LP",
      canonicalRootPath: "C:/Projects/Premium LP",
      defaultBranch: "main",
      headCommit: "0123456789abcdef0123456789abcdef01234567",
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z"
    });
  } finally {
    store.close();
  }
}

function canvas(): CanvasSnapshot {
  return {
    id: "default",
    title: "Landing page",
    mission: "Build the premium LP with api_key=should-not-leak",
    creationMode: "manual",
    executionProfile: "balanced",
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "source",
        type: "agent",
        position: { x: 0, y: 0 },
        data: nodeData("Implementação")
      },
      {
        id: "target",
        type: "agent",
        position: { x: 500, y: 0 },
        data: nodeData("Revisão")
      }
    ],
    edges: [
      {
        id: "edge-1",
        source: "source",
        target: "target",
        contract: {
          schemaVersion: "1.0",
          kind: "handoff",
          label: "Revisar",
          requiredEvidenceTypes: ["test"],
          handoffMode: "manual",
          sourceDeliverable: "Implementação com evidências",
          targetInstruction: "Validar contra os critérios de aceite"
        }
      }
    ]
  };
}

function nodeData(name: string) {
  return {
    title: name,
    state: "idle" as const,
    summary: "",
    retryMaxAttempts: 1,
    permissions: [],
    adapterId: "codex",
    role: {
      name,
      responsibilities: "Cumprir a etapa atribuída",
      constraints: "Não ampliar permissões",
      expectedDeliverable: "Pacote estruturado",
      completionCriteria: "Evidências revisáveis"
    }
  };
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `flow-${++value}`;
}

function reviewedHandoffAdapter(): AgentAdapter {
  return {
    manifest: {
      id: "codex",
      displayName: "Codex",
      version: "1",
      executables: ["codex"],
      platforms: ["win32"],
      capabilities: {
        interactive: true,
        nonInteractive: true,
        resume: true,
        structuredOutput: false,
        mcp: false,
        imageInput: false,
        messageQueue: false
      },
      permissions: []
    },
    detect: async () => ({ available: false, executable: null, version: null, issue: null }),
    validateAuth: async () => ({ authenticated: true, issue: null }),
    buildLaunch: async () => {
      throw new Error("not used");
    },
    parseOutput: (_chunk, state) => ({ outputs: [], state }),
    encodeMessage: (message) => message.content,
    sendMessage: async () => undefined,
    isReadyForReviewedHandoff: () => true,
    submitReviewedHandoff: async (control, payload) => {
      await control.write(payload);
      await control.reportPhase("written_to_terminal");
      await control.write("\r");
      await control.reportPhase("submitted_to_agent");
      return { confirmation: "response_detected", responseSequence: 2 };
    },
    requestStop: async () => undefined,
    forceKill: async () => undefined
  };
}
