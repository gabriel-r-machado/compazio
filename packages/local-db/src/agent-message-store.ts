import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  agentMessageEventTypeSchema,
  agentMessageResponseSchema,
  agentMessageSchema,
  canvasNodeDataSchema,
  enqueueAgentMessageSchema,
  recordAgentResponseSchema
} from "@forgedeck/schemas";
import type {
  AgentConversation,
  AgentConversationState,
  AgentMessage,
  AgentMessageEventType,
  AgentMessageResponse,
  EnqueueAgentMessage,
  RecordAgentResponse
} from "@forgedeck/schemas";

import { SqlitePolicyEngine } from "./policy-engine";

export interface AgentWorkspace {
  readonly id: string;
  readonly canvasId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly title: string;
}

export interface AgentDirectoryEntry {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly roleName: string | null;
  readonly adapterId: string;
  readonly online: boolean;
  readonly sessionId: string | null;
}

export interface BindAgentEndpointInput {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly adapterId: string;
}

export interface AssertAgentEndpointInput {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly projectId: string;
  readonly adapterId: string;
}

export interface AgentMessageEvent {
  readonly sequence: number;
  readonly type: AgentMessageEventType;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

interface WorkspaceRow {
  readonly id: string;
  readonly canvas_id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly canonical_root_path: string;
  readonly title: string;
}

interface AgentRow {
  readonly workspace_id: string;
  readonly node_id: string;
  readonly type: string;
  readonly data_json: string;
  readonly endpoint_adapter_id: string | null;
  readonly endpoint_state: string | null;
  readonly session_id: string | null;
  readonly session_state: string | null;
}

interface MessageRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly recipient_node_id: string;
  readonly sender_node_id: string | null;
  readonly content: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly attempt: number;
  readonly session_id: string | null;
  readonly adapter_id: string | null;
  readonly error_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly sent_at: number | null;
}

interface EventRow {
  readonly sequence: number;
  readonly type: string;
  readonly detail_json: string;
  readonly created_at: number;
}

interface ResponseRow {
  readonly id: string;
  readonly request_message_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly responder_node_id: string;
  readonly content: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly delivery_message_id: string | null;
  readonly created_at: number;
}

interface ResolvedAgent {
  readonly workspace_id: string;
  readonly canvas_id: string;
  readonly project_id: string;
  readonly type: string;
  readonly data_json: string;
}

const activeSessionStates = ["starting", "running", "waiting"] as const;

export class SqliteAgentMessageStore {
  private readonly sqlite: Database.Database;
  private readonly policy: SqlitePolicyEngine;

  public constructor(
    filename: string,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.policy = new SqlitePolicyEngine(filename);
  }

  public listWorkspaces(): readonly AgentWorkspace[] {
    const rows = this.sqlite
      .prepare(
        `SELECT w.id, w.canvas_id, w.project_id, p.name AS project_name,
                p.canonical_root_path, w.title
         FROM workspaces w
         JOIN projects p ON p.id = w.project_id
         ORDER BY w.position, w.created_at`
      )
      .all() as WorkspaceRow[];
    return rows.map((row) => ({
      id: row.id,
      canvasId: row.canvas_id,
      projectId: row.project_id,
      projectName: row.project_name,
      projectRoot: row.canonical_root_path,
      title: row.title
    }));
  }

  public listAgents(workspaceId: string): readonly AgentDirectoryEntry[] {
    const rows = this.sqlite
      .prepare(
        `SELECT w.id AS workspace_id, n.id AS node_id, n.type, n.data_json,
                e.adapter_id AS endpoint_adapter_id, e.state AS endpoint_state,
                e.session_id, s.state AS session_state
         FROM workspaces w
         JOIN canvas_nodes n ON n.canvas_id = w.canvas_id
         LEFT JOIN agent_endpoints e ON e.workspace_id = w.id AND e.node_id = n.id
         LEFT JOIN runtime_sessions s ON s.id = e.session_id
         WHERE w.id = ? AND n.type IN ('terminal', 'agent')
         ORDER BY n.id`
      )
      .all(workspaceId) as AgentRow[];

    return rows.flatMap((row) => {
      const data = canvasNodeDataSchema.parse(JSON.parse(row.data_json) as unknown);
      const adapterId = data.adapterId ?? (row.type === "terminal" ? "shell" : null);
      if (adapterId === null || adapterId === "shell") return [];
      return [
        {
          workspaceId: row.workspace_id,
          nodeId: row.node_id,
          name: data.title,
          roleName: data.role?.name ?? null,
          adapterId,
          online:
            row.endpoint_state === "online" &&
            activeSessionStates.some((state) => state === row.session_state),
          sessionId: row.session_id
        }
      ];
    });
  }

  public bindEndpoint(input: BindAgentEndpointInput): void {
    const agent = this.resolveEndpoint(input);
    const session = this.sqlite
      .prepare("SELECT adapter_id, state FROM runtime_sessions WHERE id = ?")
      .get(input.sessionId) as { readonly adapter_id: string; readonly state: string } | undefined;
    if (session === undefined || session.adapter_id !== input.adapterId) {
      throw new Error("Agent endpoint session is not available for this adapter");
    }
    const timestamp = this.now().getTime();
    this.sqlite
      .prepare(
        `INSERT INTO agent_endpoints
         (workspace_id, canvas_id, node_id, project_id, session_id, adapter_id, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'online', ?)
         ON CONFLICT(workspace_id, node_id) DO UPDATE SET
           project_id = excluded.project_id,
           session_id = excluded.session_id,
           adapter_id = excluded.adapter_id,
           state = excluded.state,
           updated_at = excluded.updated_at`
      )
      .run(
        input.workspaceId,
        agent.canvas_id,
        input.nodeId,
        input.projectId,
        input.sessionId,
        input.adapterId,
        timestamp
      );
  }

  /** Validates a canvas endpoint before a terminal process is started. */
  public assertEndpoint(input: AssertAgentEndpointInput): void {
    this.resolveEndpoint(input);
  }

  public markSessionOffline(sessionId: string): void {
    this.sqlite
      .prepare("UPDATE agent_endpoints SET state = 'offline', updated_at = ? WHERE session_id = ?")
      .run(this.now().getTime(), sessionId);
  }

  public enqueue(input: EnqueueAgentMessage): AgentMessage {
    const parsed = enqueueAgentMessageSchema.parse(input);
    this.authorizeMessage(parsed.workspaceId, parsed.senderNodeId);
    const insert = this.sqlite.transaction(() => this.enqueueParsed(parsed));
    return insert();
  }

  public enqueueBatch(inputs: readonly EnqueueAgentMessage[]): readonly AgentMessage[] {
    if (inputs.length < 1 || inputs.length > 32) {
      throw new Error("Agent message batch must contain between 1 and 32 requests");
    }
    const parsed = inputs.map((input) => enqueueAgentMessageSchema.parse(input));
    if (new Set(parsed.map((input) => input.workspaceId)).size !== 1) {
      throw new Error("Agent message batch must belong to one workspace");
    }
    if (new Set(parsed.map((input) => input.idempotencyKey)).size !== parsed.length) {
      throw new Error("Agent message batch idempotency keys must be unique");
    }
    parsed.forEach((input) => this.authorizeMessage(input.workspaceId, input.senderNodeId));
    const insert = this.sqlite.transaction(() => parsed.map((input) => this.enqueueParsed(input)));
    return insert();
  }

  public listMessages(workspaceId: string, limit = 50): readonly AgentMessage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Agent message list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM agent_messages
         WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Returns the durable inbox for one declared canvas agent. */
  public listInbox(
    workspaceId: string,
    recipientNodeId: string,
    limit = 50
  ): readonly AgentMessage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Agent inbox limit must be between 1 and 500");
    }
    this.requireMessageAgent(workspaceId, recipientNodeId);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM agent_messages
         WHERE workspace_id = ? AND recipient_node_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, recipientNodeId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Where the latest exchange between each pair of agents stands, for the canvas to draw on the
   * edge that connects them. It returns state only — never content — because an edge shows that
   * work was asked for and whether it came back, not what was said.
   *
   * Only the most recent request per (sender, recipient) pair counts: an edge shows the current
   * situation, and an older answered request must not keep a live one looking finished.
   */
  public listConversations(workspaceId: string): readonly AgentConversation[] {
    const rows = this.sqlite
      .prepare(
        `SELECT m.sender_node_id, m.recipient_node_id, m.status, m.attempt, m.updated_at,
                EXISTS (SELECT 1 FROM agent_message_responses r WHERE r.request_message_id = m.id)
                  AS answered
         FROM agent_messages m
         WHERE m.workspace_id = ? AND m.sender_node_id IS NOT NULL
           AND m.id = (
             SELECT latest.id FROM agent_messages latest
             WHERE latest.workspace_id = m.workspace_id
               AND latest.sender_node_id = m.sender_node_id
               AND latest.recipient_node_id = m.recipient_node_id
             ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
           )
         ORDER BY m.updated_at DESC, m.id DESC
         LIMIT 2000`
      )
      .all(workspaceId) as {
      readonly sender_node_id: string;
      readonly recipient_node_id: string;
      readonly status: string;
      readonly attempt: number;
      readonly updated_at: number;
      readonly answered: number;
    }[];
    return rows.map((row) => ({
      senderNodeId: row.sender_node_id,
      recipientNodeId: row.recipient_node_id,
      state: conversationState(row.status, row.answered === 1),
      attempt: row.attempt,
      updatedAt: new Date(row.updated_at).toISOString()
    }));
  }

  public recordResponse(input: RecordAgentResponse): AgentMessageResponse {
    const parsed = recordAgentResponseSchema.parse(input);
    this.authorizeMessage(parsed.workspaceId, parsed.responderNodeId);
    const record = this.sqlite.transaction(() => this.recordResponseParsed(parsed));
    return record();
  }

  public listResponses(
    workspaceId: string,
    requestMessageId: string | null = null,
    limit = 50
  ): readonly AgentMessageResponse[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Agent response list limit must be between 1 and 500");
    }
    const rows =
      requestMessageId === null
        ? (this.sqlite
            .prepare(
              `SELECT * FROM agent_message_responses
               WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(workspaceId, limit) as ResponseRow[])
        : (this.sqlite
            .prepare(
              `SELECT * FROM agent_message_responses
               WHERE workspace_id = ? AND request_message_id = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(workspaceId, requestMessageId, limit) as ResponseRow[]);
    return rows.map(toResponse);
  }

  private enqueueParsed(parsed: EnqueueAgentMessage): AgentMessage {
    const agent = this.requireMessageAgent(parsed.workspaceId, parsed.recipientNodeId);
    if (parsed.senderNodeId !== null) {
      this.requireMessageAgent(parsed.workspaceId, parsed.senderNodeId);
    }

    const existing = this.findByIdempotencyKey(parsed.workspaceId, parsed.idempotencyKey);
    if (existing !== null) {
      if (
        existing.recipientNodeId !== parsed.recipientNodeId ||
        existing.senderNodeId !== parsed.senderNodeId ||
        existing.content !== parsed.content
      ) {
        throw new Error("Agent message idempotency key conflicts with another request");
      }
      return existing;
    }

    const id = this.createId();
    const timestamp = this.now().getTime();
    this.sqlite
      .prepare(
        `INSERT INTO agent_messages
         (id, workspace_id, project_id, recipient_node_id, sender_node_id, content, status,
          idempotency_key, attempt, session_id, adapter_id, error_code, awaited_by_sender,
          created_at, updated_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, NULL, NULL, ?, ?, ?, NULL)`
      )
      .run(
        id,
        parsed.workspaceId,
        agent.project_id,
        parsed.recipientNodeId,
        parsed.senderNodeId,
        parsed.content,
        parsed.idempotencyKey,
        parsed.awaitedBySender ? 1 : 0,
        timestamp,
        timestamp
      );
    this.insertEvent(id, 1, "message_queued", {}, timestamp);
    return this.requireMessage(id);
  }

  private isAwaitedBySender(messageId: string): boolean {
    const row = this.sqlite
      .prepare("SELECT awaited_by_sender FROM agent_messages WHERE id = ?")
      .get(messageId) as { readonly awaited_by_sender: number } | undefined;
    return row?.awaited_by_sender === 1;
  }

  private recordResponseParsed(parsed: RecordAgentResponse): AgentMessageResponse {
    const request = this.requireMessage(parsed.requestMessageId);
    if (request.workspaceId !== parsed.workspaceId) {
      throw new Error("Agent response request does not belong to this workspace");
    }
    if (request.status !== "sent" && request.status !== "delivery_unknown") {
      throw new Error("Agent response request has not been delivered");
    }
    this.requireMessageAgent(parsed.workspaceId, parsed.responderNodeId);
    if (request.recipientNodeId !== parsed.responderNodeId) {
      throw new Error("Agent response must come from the request recipient");
    }

    const existing = this.findResponseByIdempotencyKey(
      parsed.requestMessageId,
      parsed.idempotencyKey
    );
    if (existing !== null) {
      if (
        existing.workspaceId !== parsed.workspaceId ||
        existing.responderNodeId !== parsed.responderNodeId ||
        existing.content !== parsed.content
      ) {
        throw new Error("Agent response idempotency key conflicts with another response");
      }
      return existing;
    }

    const id = this.createId();
    let deliveryMessageId: string | null = null;
    if (
      request.senderNodeId !== null &&
      // A sender blocked on `ask --wait` already receives this answer as that command's output.
      // Delivering it again into its terminal would arrive as a fresh instruction to act on.
      !this.isAwaitedBySender(parsed.requestMessageId) &&
      this.isMessageAgent(parsed.workspaceId, request.senderNodeId)
    ) {
      deliveryMessageId = this.enqueueParsed({
        workspaceId: parsed.workspaceId,
        recipientNodeId: request.senderNodeId,
        senderNodeId: parsed.responderNodeId,
        content: parsed.content,
        idempotencyKey: `response-delivery:${id}`,
        // A delivery is itself a plain message; nobody blocks waiting on it.
        awaitedBySender: false
      }).id;
    }
    const status = deliveryMessageId === null ? "recorded" : "queued_to_sender";
    const timestamp = this.now().getTime();
    this.sqlite
      .prepare(
        `INSERT INTO agent_message_responses
         (id, request_message_id, workspace_id, project_id, responder_node_id, content, status,
          idempotency_key, delivery_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        parsed.requestMessageId,
        parsed.workspaceId,
        request.projectId,
        parsed.responderNodeId,
        parsed.content,
        status,
        parsed.idempotencyKey,
        deliveryMessageId,
        timestamp
      );
    this.insertEvent(
      request.id,
      this.nextEventSequence(request.id),
      "response_recorded",
      { responseId: id, deliveryMessageId, status },
      timestamp
    );
    return this.requireResponse(id);
  }

  public claimNext(projectId?: string): AgentMessage | null {
    const claim = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT m.id, e.session_id, e.adapter_id
           FROM agent_messages m
           JOIN agent_endpoints e
             ON e.workspace_id = m.workspace_id AND e.node_id = m.recipient_node_id
           JOIN runtime_sessions s ON s.id = e.session_id
           WHERE m.status = 'queued' AND e.state = 'online'
             AND e.adapter_id <> 'shell'
             AND s.state IN ('starting', 'running', 'waiting')
             AND (? IS NULL OR m.project_id = ?)
           ORDER BY m.created_at, m.id
           LIMIT 1`
        )
        .get(projectId ?? null, projectId ?? null) as
        | { readonly id: string; readonly session_id: string; readonly adapter_id: string }
        | undefined;
      if (row === undefined) return null;
      const timestamp = this.now().getTime();
      const result = this.sqlite
        .prepare(
          `UPDATE agent_messages
           SET status = 'delivering', attempt = attempt + 1, session_id = ?, adapter_id = ?,
               error_code = NULL, updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(row.session_id, row.adapter_id, timestamp, row.id);
      if (result.changes !== 1) return null;
      this.insertEvent(
        row.id,
        this.nextEventSequence(row.id),
        "delivery_started",
        { sessionId: row.session_id, adapterId: row.adapter_id },
        timestamp
      );
      return this.requireMessage(row.id);
    });
    return claim();
  }

  public markSent(messageId: string): AgentMessage {
    return this.transitionDelivery(messageId, "sent", "message_sent", null);
  }

  public markFailed(messageId: string, errorCode: string): AgentMessage {
    if (errorCode.length < 1 || errorCode.length > 160) {
      throw new Error("Agent message error code is invalid");
    }
    return this.transitionDelivery(messageId, "failed", "delivery_failed", errorCode);
  }

  /** Cancellation is intentionally limited to messages that were never claimed for delivery. */
  public cancel(messageId: string): AgentMessage {
    const message = this.requireMessage(messageId);
    this.authorizeMessage(message.workspaceId, null);
    return this.sqlite.transaction(() => {
      const message = this.requireMessage(messageId);
      if (message.status !== "queued") {
        throw new Error("Agent message can only be cancelled before delivery starts");
      }
      const timestamp = this.now().getTime();
      const result = this.sqlite
        .prepare(
          `UPDATE agent_messages SET status = 'cancelled', error_code = NULL, updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(timestamp, messageId);
      if (result.changes !== 1) throw new Error("Agent message can no longer be cancelled");
      this.insertEvent(
        messageId,
        this.nextEventSequence(messageId),
        "message_cancelled",
        {},
        timestamp
      );
      return this.requireMessage(messageId);
    })();
  }

  /** A retry always reuses the original record; no automatic or duplicate delivery is created. */
  public retry(messageId: string): AgentMessage {
    const message = this.requireMessage(messageId);
    this.authorizeMessage(message.workspaceId, null);
    return this.sqlite.transaction(() => {
      const message = this.requireMessage(messageId);
      if (!["failed", "delivery_unknown", "cancelled"].includes(message.status)) {
        throw new Error(
          "Agent message can only be retried after a failed, unknown, or cancelled delivery"
        );
      }
      const timestamp = this.now().getTime();
      const result = this.sqlite
        .prepare(
          `UPDATE agent_messages
           SET status = 'queued', session_id = NULL, adapter_id = NULL, error_code = NULL,
               sent_at = NULL, updated_at = ?
           WHERE id = ? AND status IN ('failed', 'delivery_unknown', 'cancelled')`
        )
        .run(timestamp, messageId);
      if (result.changes !== 1) throw new Error("Agent message can no longer be retried");
      this.insertEvent(
        messageId,
        this.nextEventSequence(messageId),
        "retry_requested",
        {},
        timestamp
      );
      return this.requireMessage(messageId);
    })();
  }

  public recoverInterruptedDeliveries(): number {
    const recover = this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare("SELECT id FROM agent_messages WHERE status = 'delivering' ORDER BY created_at")
        .all() as { readonly id: string }[];
      for (const row of rows) {
        const timestamp = this.now().getTime();
        this.sqlite
          .prepare(
            `UPDATE agent_messages
             SET status = 'delivery_unknown', error_code = 'application_restart', updated_at = ?
             WHERE id = ? AND status = 'delivering'`
          )
          .run(timestamp, row.id);
        this.insertEvent(
          row.id,
          this.nextEventSequence(row.id),
          "delivery_interrupted",
          { errorCode: "application_restart" },
          timestamp
        );
      }
      return rows.length;
    });
    return recover();
  }

  public get(messageId: string): AgentMessage | null {
    const row = this.sqlite.prepare("SELECT * FROM agent_messages WHERE id = ?").get(messageId) as
      MessageRow | undefined;
    return row === undefined ? null : toMessage(row);
  }

  public listEvents(messageId: string): readonly AgentMessageEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT sequence, type, detail_json, created_at
         FROM agent_message_events WHERE message_id = ? ORDER BY sequence`
      )
      .all(messageId) as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      type: agentMessageEventTypeSchema.parse(row.type),
      detail: parseDetail(row.detail_json),
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  public close(): void {
    this.policy.close();
    this.sqlite.close();
  }

  private authorizeMessage(workspaceId: string, actorNodeId: string | null): void {
    this.policy.assertAllowed({ workspaceId, actorNodeId, permission: "send_messages" });
  }

  private requireAgent(workspaceId: string, nodeId: string): ResolvedAgent {
    const row = this.sqlite
      .prepare(
        `SELECT w.id AS workspace_id, w.canvas_id, w.project_id, n.type, n.data_json
         FROM workspaces w
         JOIN canvas_nodes n ON n.canvas_id = w.canvas_id
         WHERE w.id = ? AND n.id = ?`
      )
      .get(workspaceId, nodeId) as ResolvedAgent | undefined;
    if (row === undefined || (row.type !== "terminal" && row.type !== "agent")) {
      throw new Error("Message recipient is not an agent");
    }
    return row;
  }

  private resolveEndpoint(input: AssertAgentEndpointInput): ResolvedAgent {
    const agent = this.requireAgent(input.workspaceId, input.nodeId);
    if (agent.project_id !== input.projectId) {
      throw new Error("Agent endpoint project does not match its workspace");
    }
    const data = canvasNodeDataSchema.parse(JSON.parse(agent.data_json) as unknown);
    const expectedAdapter = data.adapterId ?? (agent.type === "terminal" ? "shell" : null);
    if (expectedAdapter === null || expectedAdapter !== input.adapterId) {
      throw new Error("Agent endpoint adapter does not match its canvas node");
    }
    return agent;
  }

  private requireMessageAgent(workspaceId: string, nodeId: string): ResolvedAgent {
    const agent = this.requireAgent(workspaceId, nodeId);
    const data = canvasNodeDataSchema.parse(JSON.parse(agent.data_json) as unknown);
    const adapterId = data.adapterId ?? (agent.type === "terminal" ? "shell" : null);
    if (adapterId === null || adapterId === "shell") {
      throw new Error("Message recipient is not an agent-capable terminal");
    }
    return agent;
  }

  private isMessageAgent(workspaceId: string, nodeId: string): boolean {
    try {
      this.requireMessageAgent(workspaceId, nodeId);
      return true;
    } catch {
      return false;
    }
  }

  private findByIdempotencyKey(workspaceId: string, key: string): AgentMessage | null {
    const row = this.sqlite
      .prepare("SELECT * FROM agent_messages WHERE workspace_id = ? AND idempotency_key = ?")
      .get(workspaceId, key) as MessageRow | undefined;
    return row === undefined ? null : toMessage(row);
  }

  private findResponseByIdempotencyKey(
    requestMessageId: string,
    key: string
  ): AgentMessageResponse | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM agent_message_responses
         WHERE request_message_id = ? AND idempotency_key = ?`
      )
      .get(requestMessageId, key) as ResponseRow | undefined;
    return row === undefined ? null : toResponse(row);
  }

  private requireMessage(messageId: string): AgentMessage {
    const message = this.get(messageId);
    if (message === null) throw new Error("Agent message was not found");
    return message;
  }

  private requireResponse(responseId: string): AgentMessageResponse {
    const row = this.sqlite
      .prepare("SELECT * FROM agent_message_responses WHERE id = ?")
      .get(responseId) as ResponseRow | undefined;
    if (row === undefined) throw new Error("Agent response was not found");
    return toResponse(row);
  }

  private transitionDelivery(
    messageId: string,
    status: "sent" | "failed",
    eventType: "message_sent" | "delivery_failed",
    errorCode: string | null
  ): AgentMessage {
    const transition = this.sqlite.transaction(() => {
      const timestamp = this.now().getTime();
      const result = this.sqlite
        .prepare(
          `UPDATE agent_messages
           SET status = ?, error_code = ?, updated_at = ?, sent_at = ?
           WHERE id = ? AND status = 'delivering'`
        )
        .run(status, errorCode, timestamp, status === "sent" ? timestamp : null, messageId);
      if (result.changes !== 1) {
        throw new Error("Agent message is not being delivered");
      }
      this.insertEvent(
        messageId,
        this.nextEventSequence(messageId),
        eventType,
        errorCode === null ? {} : { errorCode },
        timestamp
      );
      return this.requireMessage(messageId);
    });
    return transition();
  }

  private nextEventSequence(messageId: string): number {
    const row = this.sqlite
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_message_events WHERE message_id = ?"
      )
      .get(messageId) as { readonly sequence: number };
    return row.sequence;
  }

  private insertEvent(
    messageId: string,
    sequence: number,
    type: AgentMessageEventType,
    detail: Readonly<Record<string, unknown>>,
    timestamp: number
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO agent_message_events
         (id, message_id, sequence, type, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(this.createId(), messageId, sequence, type, JSON.stringify(detail), timestamp);
  }
}

/**
 * A recorded answer wins over the request's own status: an answered request is answered even if the
 * delivery row still says `sent`. Everything short of an answer is "still waiting", because a
 * request that was merely written into a terminal proves nothing about the work.
 */
function conversationState(status: string, answered: boolean): AgentConversationState {
  if (answered) return "responded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "awaiting-response";
}

function toMessage(row: MessageRow): AgentMessage {
  return agentMessageSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    recipientNodeId: row.recipient_node_id,
    senderNodeId: row.sender_node_id,
    content: row.content,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    sessionId: row.session_id,
    adapterId: row.adapter_id,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString()
  });
}

function toResponse(row: ResponseRow): AgentMessageResponse {
  return agentMessageResponseSchema.parse({
    id: row.id,
    requestMessageId: row.request_message_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    responderNodeId: row.responder_node_id,
    content: row.content,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    deliveryMessageId: row.delivery_message_id,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function parseDetail(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent message event detail is invalid");
  }
  return parsed as Readonly<Record<string, unknown>>;
}
