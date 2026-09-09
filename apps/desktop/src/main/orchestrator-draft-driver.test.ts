import { agentDescriptorSchema, workflowDraftSchema } from "@forgedeck/schemas";
import type { AgentRuntimeCapability, WorkflowDraft, WorkflowDraftEvent } from "@forgedeck/schemas";
import type { AgentAssignmentCatalog } from "@forgedeck/orchestration";
import { beforeEach, describe, expect, it } from "vitest";

import { OrchestratorDraftDriver } from "./orchestrator-draft-driver";

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

const agents = {
  descriptors: [
    agentDescriptorSchema.parse({
      id: "claude-code",
      displayName: "Claude Code",
      capabilities: ["planning", "backend", "testing", "review"],
      available: true,
      supportsPlanning: true,
      supportsExecution: true,
      supportsPipe: true,
      hasImplementation: true
    })
  ]
} satisfies AgentAssignmentCatalog;

/** Minimal in-memory stand-in for SqliteWorkflowDraftStore. */
class FakeDraftStore {
  private drafts = new Map<string, WorkflowDraft>();
  private byTerminal = new Map<string, string>();
  public persists = 0;

  getById(draftId: string): WorkflowDraft | null {
    return this.drafts.get(draftId) ?? null;
  }
  getLatestForTerminal(workspaceId: string, sourceTerminalId: string): WorkflowDraft | null {
    const id = this.byTerminal.get(`${workspaceId}:${sourceTerminalId}`);
    return id === undefined ? null : (this.drafts.get(id) ?? null);
  }
  persist(draft: WorkflowDraft): { draft: WorkflowDraft; lastEvent: WorkflowDraftEvent | null } {
    this.persists += 1;
    this.drafts.set(draft.id, draft);
    this.byTerminal.set(`${draft.workspaceId}:${draft.sourceTerminalId}`, draft.id);
    return { draft, lastEvent: null };
  }
}

function driver(store: FakeDraftStore): OrchestratorDraftDriver {
  return new OrchestratorDraftDriver({
    store,
    loadCapabilities: () => Promise.resolve([claude]),
    loadAgents: () => Promise.resolve(agents),
    newId: () => globalThis.crypto.randomUUID(),
    now: () => new Date("2026-07-23T00:00:00.000Z")
  });
}

describe("OrchestratorDraftDriver", () => {
  let store: FakeDraftStore;
  let changed: WorkflowDraft[];
  let drv: OrchestratorDraftDriver;

  beforeEach(() => {
    store = new FakeDraftStore();
    changed = [];
    drv = driver(store);
    drv.attach({
      sessionId: "session-1",
      workspaceId: "w1",
      creationMode: "automatic",
      executionProfile: "balanced"
    });
    drv.onDraftChanged((draft) => changed.push(draft));
  });

  it("turns parsed composition actions into ghost nodes on the draft", async () => {
    await drv.ingest(
      "session-1",
      "Vou montar a equipe.\n" +
        envelope('{"type":"start_workflow_draft","objective":"landing page premium"}') +
        envelope('{"type":"add_draft_node","ref":"ux","title":"UX","role":"designer"}') +
        envelope('{"type":"add_draft_node","ref":"fe","title":"Front-end","role":"implementer"}') +
        envelope('{"type":"connect_draft_nodes","from":"ux","to":"fe"}')
    );
    const draft = store.getLatestForTerminal("w1", "session-1");
    expect(draft).not.toBeNull();
    expect(draft?.objective).toBe("landing page premium");
    expect(draft?.nodes.map((node) => node.id)).toEqual(["ux", "fe"]);
    expect(draft?.edges).toHaveLength(1);
    expect(changed.at(-1)?.nodes).toHaveLength(2);
  });

  it("ignores terminal chatter with no envelopes and never persists", async () => {
    await drv.ingest("session-1", "só texto normal, estou pensando...\n");
    expect(store.persists).toBe(0);
    expect(changed).toHaveLength(0);
  });

  it("reassembles envelopes split across output chunks", async () => {
    const full = envelope('{"type":"start_workflow_draft","objective":"api rest"}');
    const mid = Math.floor(full.length / 2);
    await drv.ingest("session-1", full.slice(0, mid));
    expect(store.getLatestForTerminal("w1", "session-1")).toBeNull();
    await drv.ingest("session-1", full.slice(mid));
    expect(store.getLatestForTerminal("w1", "session-1")?.objective).toBe("api rest");
  });

  it("finalize assigns the live automatic preset before presenting a ready draft", async () => {
    await drv.ingest(
      "session-1",
      envelope('{"type":"start_workflow_draft","objective":"x"}') +
        envelope('{"type":"add_draft_node","ref":"impl","title":"Impl","role":"implementer"}') +
        envelope('{"type":"finalize_workflow_draft"}')
    );
    const draft = store.getLatestForTerminal("w1", "session-1");
    expect(draft?.state).toBe("ready");
    expect(draft?.agentAssignmentPreset).toBe("automatic");
    expect(draft?.nodes[0]?.agentAssignment?.assignedAdapter).toBe("claude-code");
  });

  it("projects a validated single-shot plan into the same ready-to-approve draft", async () => {
    await drv.acceptDraft(
      "session-1",
      workflowDraftSchema.parse({
        id: "99999999-9999-4999-8999-999999999999",
        version: 0,
        workspaceId: "other-workspace",
        sourceTerminalId: "other-session",
        creationMode: "automatic",
        executionProfile: "balanced",
        state: "ready",
        title: "Landing page premium",
        objective: "criar uma landing page premium",
        nodes: [{ id: "front-end", title: "Front-end", role: "implementer" }],
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z"
      })
    );

    const draft = store.getLatestForTerminal("w1", "session-1");
    expect(draft).toMatchObject({
      state: "ready",
      workspaceId: "w1",
      sourceTerminalId: "session-1"
    });
    expect(draft?.nodes[0]?.agentAssignment?.assignedAdapter).toBe("claude-code");
  });

  it("ignores output from a session it is not attached to", async () => {
    await drv.ingest(
      "unknown-session",
      envelope('{"type":"start_workflow_draft","objective":"y"}')
    );
    expect(store.persists).toBe(0);
  });
});
