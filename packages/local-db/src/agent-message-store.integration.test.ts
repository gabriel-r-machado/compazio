import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteAgentMessageStore } from "./agent-message-store";
import { runLocalMigrations } from "./migrate";
import { SqlitePolicyEngine } from "./policy-engine";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteAgentMessageStore", () => {
  it("discovers canvas agents and tracks their local endpoint", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      expect(store.listWorkspaces()).toEqual([
        expect.objectContaining({
          id: fixture.workspaceId,
          canvasId: fixture.canvasId,
          projectRoot: fixture.projectRoot
        })
      ]);
      expect(store.listAgents(fixture.workspaceId)).toEqual([
        expect.objectContaining({
          nodeId: "reviewer",
          name: "Revisor",
          roleName: "Revisor de código",
          adapterId: "codex",
          online: false,
          sessionId: null
        })
      ]);

      store.bindEndpoint({
        workspaceId: fixture.workspaceId,
        nodeId: "reviewer",
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        adapterId: "codex"
      });

      expect(store.listAgents(fixture.workspaceId)[0]).toMatchObject({
        online: true,
        sessionId: fixture.sessionId
      });
      store.markSessionOffline(fixture.sessionId);
      expect(store.listAgents(fixture.workspaceId)[0]).toMatchObject({ online: false });
    } finally {
      store.close();
    }
  });

  it("validates a persisted agent endpoint before a terminal process starts", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      expect(() =>
        store.assertEndpoint({
          workspaceId: fixture.workspaceId,
          nodeId: "reviewer",
          projectId: fixture.projectId,
          adapterId: "codex"
        })
      ).not.toThrow();
      expect(() =>
        store.assertEndpoint({
          workspaceId: fixture.workspaceId,
          nodeId: "note-1",
          projectId: fixture.projectId,
          adapterId: "codex"
        })
      ).toThrow("Message recipient is not an agent");
    } finally {
      store.close();
    }
  });

  it("queues idempotently, claims only online recipients and audits every transition", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      const first = store.enqueue({
        workspaceId: fixture.workspaceId,
        recipientNodeId: "reviewer",
        senderNodeId: null,
        content: "Revise a autenticação.",
        idempotencyKey: "request-1"
      });
      const duplicate = store.enqueue({
        workspaceId: fixture.workspaceId,
        recipientNodeId: "reviewer",
        senderNodeId: null,
        content: "Revise a autenticação.",
        idempotencyKey: "request-1"
      });
      expect(duplicate.id).toBe(first.id);
      expect(store.claimNext()).toBeNull();

      store.bindEndpoint({
        workspaceId: fixture.workspaceId,
        nodeId: "reviewer",
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        adapterId: "codex"
      });
      const claimed = store.claimNext();
      expect(claimed).toMatchObject({
        id: first.id,
        status: "delivering",
        attempt: 1,
        sessionId: fixture.sessionId,
        adapterId: "codex"
      });
      store.markSent(first.id);
      expect(store.get(first.id)).toMatchObject({ status: "sent", attempt: 1 });
      expect(store.listEvents(first.id).map((event) => event.type)).toEqual([
        "message_queued",
        "delivery_started",
        "message_sent"
      ]);
    } finally {
      store.close();
    }
  });

  it("marks an interrupted delivery as unknown instead of retrying it", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      store.bindEndpoint({
        workspaceId: fixture.workspaceId,
        nodeId: "reviewer",
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        adapterId: "codex"
      });
      const message = store.enqueue({
        workspaceId: fixture.workspaceId,
        recipientNodeId: "reviewer",
        senderNodeId: null,
        content: "Revise o componente.",
        idempotencyKey: "request-2"
      });
      expect(store.claimNext()?.id).toBe(message.id);

      expect(store.recoverInterruptedDeliveries()).toBe(1);
      expect(store.get(message.id)).toMatchObject({
        status: "delivery_unknown",
        errorCode: "application_restart"
      });
      expect(store.claimNext()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("lists an agent inbox, cancels only queued messages, and retries only by explicit request", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      const message = store.enqueue({
        workspaceId: fixture.workspaceId,
        recipientNodeId: "reviewer",
        senderNodeId: null,
        content: "Revise a fila.",
        idempotencyKey: "inbox-1"
      });

      expect(store.listInbox(fixture.workspaceId, "reviewer")).toEqual([
        expect.objectContaining({ id: message.id, status: "queued" })
      ]);
      expect(store.cancel(message.id)).toMatchObject({ status: "cancelled" });
      expect(() => store.cancel(message.id)).toThrow("before delivery starts");
      expect(store.retry(message.id)).toMatchObject({
        id: message.id,
        status: "queued",
        attempt: 0
      });
      expect(store.listEvents(message.id).map((event) => event.type)).toEqual([
        "message_queued",
        "message_cancelled",
        "retry_requested"
      ]);

      store.bindEndpoint({
        workspaceId: fixture.workspaceId,
        nodeId: "reviewer",
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        adapterId: "codex"
      });
      expect(store.claimNext()?.id).toBe(message.id);
      expect(() => store.cancel(message.id)).toThrow("before delivery starts");
      expect(() => store.retry(message.id)).toThrow("failed, unknown, or cancelled");
    } finally {
      store.close();
    }
  });

  it("enqueues a batch atomically and lists recent status", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      const messages = store.enqueueBatch([
        {
          workspaceId: fixture.workspaceId,
          recipientNodeId: "reviewer",
          senderNodeId: null,
          content: "Revise o fluxo.",
          idempotencyKey: "batch-1:reviewer"
        },
        {
          workspaceId: fixture.workspaceId,
          recipientNodeId: "reviewer",
          senderNodeId: null,
          content: "Revise os testes.",
          idempotencyKey: "batch-1:reviewer-tests"
        }
      ]);

      expect(messages).toHaveLength(2);
      expect(store.listMessages(fixture.workspaceId)).toEqual([
        expect.objectContaining({ content: "Revise os testes.", status: "queued" }),
        expect.objectContaining({ content: "Revise o fluxo.", status: "queued" })
      ]);

      expect(() =>
        store.enqueueBatch([
          {
            workspaceId: fixture.workspaceId,
            recipientNodeId: "reviewer",
            senderNodeId: null,
            content: "Esta inserção deve ser revertida.",
            idempotencyKey: "batch-rollback:reviewer"
          },
          {
            workspaceId: fixture.workspaceId,
            recipientNodeId: "note-1",
            senderNodeId: null,
            content: "Destino inválido.",
            idempotencyKey: "batch-rollback:note"
          }
        ])
      ).toThrow("recipient is not an agent");
      expect(store.listMessages(fixture.workspaceId)).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("records an idempotent response and queues it back to an agent sender", async () => {
    const fixture = await createFixture();
    insertAgentNode(
      fixture.filename,
      fixture.canvasId,
      "planner",
      "Planejador",
      "claude-code",
      "agent",
      ["send_messages"]
    );
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      store.bindEndpoint({
        workspaceId: fixture.workspaceId,
        nodeId: "reviewer",
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        adapterId: "codex"
      });
      const request = store.enqueue({
        workspaceId: fixture.workspaceId,
        recipientNodeId: "reviewer",
        senderNodeId: "planner",
        content: "Revise o fluxo.",
        idempotencyKey: "request-with-sender"
      });
      expect(store.claimNext()?.id).toBe(request.id);
      store.markSent(request.id);

      const response = store.recordResponse({
        requestMessageId: request.id,
        workspaceId: fixture.workspaceId,
        responderNodeId: "reviewer",
        content: "O fluxo precisa de um teste de timeout.",
        idempotencyKey: "response-1"
      });
      const duplicate = store.recordResponse({
        requestMessageId: request.id,
        workspaceId: fixture.workspaceId,
        responderNodeId: "reviewer",
        content: "O fluxo precisa de um teste de timeout.",
        idempotencyKey: "response-1"
      });

      expect(duplicate.id).toBe(response.id);
      expect(response).toMatchObject({
        status: "queued_to_sender",
        responderNodeId: "reviewer"
      });
      expect(response.deliveryMessageId).not.toBeNull();
      expect(store.listResponses(fixture.workspaceId, request.id)).toEqual([response]);
      expect(store.listMessages(fixture.workspaceId)[0]).toMatchObject({
        id: response.deliveryMessageId,
        recipientNodeId: "planner",
        senderNodeId: "reviewer",
        status: "queued"
      });
      expect(store.listEvents(request.id).at(-1)?.type).toBe("response_recorded");
    } finally {
      store.close();
    }
  });

  it("does not deliver an answer the sender is already blocked waiting for", async () => {
    const fixture = await createFixture();
    insertAgentNode(
      fixture.filename,
      fixture.canvasId,
      "planner",
      "Planejador",
      "claude-code",
      "agent",
      ["send_messages"]
    );
    const store = new SqliteAgentMessageStore(fixture.filename, sequentialIds(), clock());
    try {
      store.bindEndpoint({
        workspaceId: fixture.workspaceId,
        nodeId: "reviewer",
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        adapterId: "codex"
      });
      const request = store.enqueue({
        workspaceId: fixture.workspaceId,
        recipientNodeId: "reviewer",
        senderNodeId: "planner",
        content: "Revise o fluxo.",
        idempotencyKey: "awaited-request",
        awaitedBySender: true
      });
      expect(store.claimNext()?.id).toBe(request.id);
      store.markSent(request.id);

      const response = store.recordResponse({
        requestMessageId: request.id,
        workspaceId: fixture.workspaceId,
        responderNodeId: "reviewer",
        content: "Sem regressões.",
        idempotencyKey: "awaited-response"
      });

      // The waiting caller reads this from `ask --wait`; a second copy typed into the planner's
      // terminal would arrive there as a brand new instruction to act on.
      expect(response.status).toBe("recorded");
      expect(response.deliveryMessageId).toBeNull();
      expect(store.claimNext()).toBeNull();
      // The answer is still recorded and readable, just not re-delivered.
      expect(store.listResponses(fixture.workspaceId, request.id)).toEqual([response]);
    } finally {
      store.close();
    }
  });

  it("requires send_messages for a structural sender and records the denial", async () => {
    const fixture = await createFixture();
    insertAgentNode(fixture.filename, fixture.canvasId, "planner", "Planejador", "claude-code");
    const store = new SqliteAgentMessageStore(fixture.filename);
    const policy = new SqlitePolicyEngine(fixture.filename);
    try {
      expect(() =>
        store.enqueue({
          workspaceId: fixture.workspaceId,
          recipientNodeId: "reviewer",
          senderNodeId: "planner",
          content: "Revise a proposta.",
          idempotencyKey: "sender-without-permission"
        })
      ).toThrow("send_messages permission");
      expect(policy.list(fixture.workspaceId)).toEqual([
        expect.objectContaining({
          actorNodeId: "planner",
          permission: "send_messages",
          outcome: "denied",
          reason: "permission_missing"
        })
      ]);
    } finally {
      policy.close();
      store.close();
    }
  });

  it("never treats a plain shell terminal as a message recipient", async () => {
    const fixture = await createFixture();
    insertAgentNode(fixture.filename, fixture.canvasId, "shell-1", "Terminal", "shell", "terminal");
    const store = new SqliteAgentMessageStore(fixture.filename);
    try {
      expect(store.listAgents(fixture.workspaceId).map((agent) => agent.nodeId)).not.toContain(
        "shell-1"
      );
      expect(() =>
        store.enqueue({
          workspaceId: fixture.workspaceId,
          recipientNodeId: "shell-1",
          senderNodeId: null,
          content: "Remove-Item important.txt",
          idempotencyKey: "unsafe-shell-message"
        })
      ).toThrow("not an agent-capable terminal");
    } finally {
      store.close();
    }
  });

  it("rejects a recipient that is not a terminal-backed canvas node", async () => {
    const fixture = await createFixture();
    const store = new SqliteAgentMessageStore(fixture.filename);
    try {
      expect(() =>
        store.enqueue({
          workspaceId: fixture.workspaceId,
          recipientNodeId: "note-1",
          senderNodeId: null,
          content: "Review",
          idempotencyKey: "request-3"
        })
      ).toThrow("recipient is not an agent");
    } finally {
      store.close();
    }
  });
});

async function createFixture(): Promise<{
  readonly filename: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly canvasId: string;
  readonly sessionId: string;
  readonly projectRoot: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "compasso-agent-messages-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "local.db");
  const projectRoot = join(directory, "project");
  runLocalMigrations({ filename });
  const sqlite = new Database(filename);
  const projectId = "00000000-0000-4000-8000-000000000001";
  const workspaceId = "workspace-1";
  const canvasId = "canvas-1";
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  sqlite
    .prepare(
      `INSERT INTO projects
       (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
       VALUES (?, 'Compasso', ?, ?, 'main', 'abc123', ?, ?)`
    )
    .run(projectId, projectRoot, projectRoot, now, now);
  sqlite
    .prepare(
      `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
       VALUES (?, 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
    )
    .run(canvasId, now, now);
  sqlite
    .prepare(
      `INSERT INTO workspaces
       (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
       VALUES (?, ?, ?, 'Principal', 0, 1, ?, ?)`
    )
    .run(workspaceId, projectId, canvasId, now, now);
  const insertNode = sqlite.prepare(
    `INSERT INTO canvas_nodes
     (canvas_id, id, type, position_x, position_y, width, height, data_json)
     VALUES (?, ?, ?, 0, 0, NULL, NULL, ?)`
  );
  insertNode.run(
    canvasId,
    "reviewer",
    "agent",
    JSON.stringify({
      title: "Revisor",
      state: "idle",
      summary: "",
      adapterId: "codex",
      role: {
        name: "Revisor de código",
        responsibilities: "Revisar",
        constraints: "Não editar",
        expectedDeliverable: "Relatório",
        completionCriteria: "Problemas classificados"
      },
      retryMaxAttempts: 1,
      permissions: ["send_messages"]
    })
  );
  insertNode.run(
    canvasId,
    "note-1",
    "note",
    JSON.stringify({
      title: "Notas",
      state: "idle",
      summary: "",
      content: "Contexto",
      retryMaxAttempts: 1,
      permissions: []
    })
  );
  sqlite
    .prepare(
      `INSERT INTO runtime_sessions
       (id, adapter_id, state, cwd, process_id, started_at, updated_at, ended_at,
        exit_code, exit_signal, interruption_reason)
       VALUES (?, 'codex', 'running', ?, 123, ?, ?, NULL, NULL, NULL, NULL)`
    )
    .run(sessionId, projectRoot, now, now);
  sqlite.close();
  return { filename, projectId, workspaceId, canvasId, sessionId, projectRoot };
}

function sequentialIds(): () => string {
  let sequence = 16;
  return () => `00000000-0000-4000-8000-${(sequence++).toString().padStart(12, "0")}`;
}

function clock(): () => Date {
  let timestamp = Date.parse("2026-07-20T12:00:00.000Z");
  return () => new Date(timestamp++);
}

function insertAgentNode(
  filename: string,
  canvasId: string,
  nodeId: string,
  title: string,
  adapterId: string,
  type = "agent",
  permissions: readonly string[] = []
): void {
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(
        `INSERT INTO canvas_nodes
         (canvas_id, id, type, position_x, position_y, width, height, data_json)
         VALUES (?, ?, ?, 0, 0, NULL, NULL, ?)`
      )
      .run(
        canvasId,
        nodeId,
        type,
        JSON.stringify({
          title,
          state: "idle",
          summary: "",
          adapterId,
          retryMaxAttempts: 1,
          permissions
        })
      );
  } finally {
    sqlite.close();
  }
}
