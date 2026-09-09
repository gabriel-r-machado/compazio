import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  agentLifecycleCanvasEventSchema,
  agentLifecycleCommandSchema,
  canvasNodeDataSchema,
  canvasNodeSchema,
  createAgentLifecycleCommandSchema
} from "@forgedeck/schemas";
import type {
  AgentPermission,
  AgentLifecycleCanvasEvent,
  AgentLifecycleCommand,
  AgentLifecycleEventType,
  CreateAgentLifecycleCommand
} from "@forgedeck/schemas";

import { SqlitePolicyEngine } from "./policy-engine";

interface CommandRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly canvas_id: string;
  readonly project_id: string;
  readonly target_node_id: string;
  readonly action: string;
  readonly role_json: string | null;
  readonly requested_by_node_id: string | null;
  readonly status: string;
  readonly idempotency_key: string;
  readonly session_id: string | null;
  readonly error_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface WorkspaceRow {
  readonly canvas_id: string;
  readonly project_id: string;
}

interface NodeRow {
  readonly id: string;
  readonly type: string;
  readonly position_x: number;
  readonly position_y: number;
  readonly width: number;
  readonly height: number;
  readonly data_json: string;
}

export interface SqliteAgentLifecycleStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

export interface AgentLifecycleTransition {
  readonly command: AgentLifecycleCommand;
}

/**
 * Durable queue for changing an agent that already exists on the canvas: closing its terminal, or
 * giving it a different responsibility.
 *
 * This store owns what is *recorded and projected* — the request, the canvas mutation and the audit
 * trail. It never touches a process: stopping and restarting an agent belongs to the desktop runtime,
 * which claims each command and reports back. Splitting it this way is what lets the CLI ask for a
 * dismissal from a short-lived process it cannot fulfil itself.
 */
export class SqliteAgentLifecycleStore {
  private readonly sqlite: Database.Database;
  private readonly policy: SqlitePolicyEngine;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqliteAgentLifecycleStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.policy = new SqlitePolicyEngine(filename);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public create(input: CreateAgentLifecycleCommand): AgentLifecycleCommand {
    const parsed = createAgentLifecycleCommandSchema.parse(input);
    this.policy.assertAllowed({
      workspaceId: parsed.workspaceId,
      actorNodeId: parsed.requestedByNodeId,
      permission: lifecyclePermission(parsed.action)
    });
    // An agent closing its own terminal would kill the very process waiting for the command to be
    // applied, leaving the request half-done and the caller with no way to learn what happened.
    if (parsed.requestedByNodeId !== null && parsed.requestedByNodeId === parsed.targetNodeId) {
      throw new Error("An agent cannot run a lifecycle command against its own terminal");
    }
    return this.sqlite.transaction(() => {
      const existing = this.findByIdempotencyKey(parsed.workspaceId, parsed.idempotencyKey);
      if (existing !== null) {
        if (
          existing.targetNodeId !== parsed.targetNodeId ||
          existing.action !== parsed.action ||
          existing.requestedByNodeId !== parsed.requestedByNodeId
        ) {
          throw new Error("Agent lifecycle idempotency key conflicts with another request");
        }
        return existing;
      }

      const workspace = this.requireWorkspace(parsed.workspaceId);
      this.requireAgentNode(workspace.canvas_id, parsed.targetNodeId);

      const id = this.createId();
      const timestamp = this.now().getTime();
      this.sqlite
        .prepare(
          `INSERT INTO agent_lifecycle_commands
           (id, workspace_id, canvas_id, project_id, target_node_id, action, role_json,
            requested_by_node_id, status, idempotency_key, session_id, error_code,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?)`
        )
        .run(
          id,
          parsed.workspaceId,
          workspace.canvas_id,
          workspace.project_id,
          parsed.targetNodeId,
          parsed.action,
          parsed.role === null ? null : JSON.stringify(parsed.role),
          parsed.requestedByNodeId,
          parsed.idempotencyKey,
          timestamp,
          timestamp
        );
      this.insertEvent(id, 1, "command_queued", {}, timestamp);
      return this.requireCommand(id);
    })();
  }

  /**
   * Takes the next queued command and records which session the runtime must act on, read at claim
   * time rather than at request time: the terminal may have been opened, closed or restarted while
   * the request sat in the queue.
   */
  public claimNext(projectId?: string): AgentLifecycleCommand | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT id, workspace_id, target_node_id FROM agent_lifecycle_commands
           WHERE status = 'queued' AND (? IS NULL OR project_id = ?)
           ORDER BY created_at, id LIMIT 1`
        )
        .get(projectId ?? null, projectId ?? null) as
        | { readonly id: string; readonly workspace_id: string; readonly target_node_id: string }
        | undefined;
      if (row === undefined) return null;
      const endpoint = this.sqlite
        .prepare(
          `SELECT session_id FROM agent_endpoints
           WHERE workspace_id = ? AND node_id = ? AND state = 'online'`
        )
        .get(row.workspace_id, row.target_node_id) as
        { readonly session_id: string | null } | undefined;
      const timestamp = this.now().getTime();
      const updated = this.sqlite
        .prepare(
          `UPDATE agent_lifecycle_commands SET status = 'applying', session_id = ?,
           error_code = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`
        )
        .run(endpoint?.session_id ?? null, timestamp, row.id);
      if (updated.changes !== 1) return null;
      this.insertEvent(row.id, this.nextEventSequence(row.id), "command_started", {}, timestamp);
      return this.requireCommand(row.id);
    })();
  }

  /**
   * Applies the canvas half of a claimed command. A removal deletes the node and every edge touching
   * it, so no connection is left pointing at an agent that no longer exists. A reassignment rewrites
   * only the role: position, size, name and connections are untouched, because the agent is the same
   * teammate with different instructions.
   */
  public apply(commandId: string): AgentLifecycleCanvasEvent {
    return this.sqlite.transaction(() => {
      const command = this.requireCommand(commandId);
      if (command.status !== "applying") {
        throw new Error("Agent lifecycle command is not in progress");
      }
      const timestamp = this.now().getTime();
      if (command.action === "remove") {
        this.sqlite
          .prepare(
            "DELETE FROM canvas_edges WHERE canvas_id = ? AND (source_node_id = ? OR target_node_id = ?)"
          )
          .run(command.canvasId, command.targetNodeId, command.targetNodeId);
        this.sqlite
          .prepare("DELETE FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
          .run(command.canvasId, command.targetNodeId);
        const revision = this.bumpCanvasRevision(command.canvasId, timestamp);
        this.insertEvent(
          command.id,
          this.nextEventSequence(command.id),
          "node_removed",
          { nodeId: command.targetNodeId },
          timestamp
        );
        return agentLifecycleCanvasEventSchema.parse({
          command,
          node: null,
          removedNodeId: command.targetNodeId,
          canvasRevision: revision
        });
      }

      if (command.action === "restart") {
        // Nothing on the canvas changes: the node, its role and its connections are exactly what
        // make this the same terminal coming back. Only the process is replaced.
        this.insertEvent(
          command.id,
          this.nextEventSequence(command.id),
          "agent_restarted",
          { nodeId: command.targetNodeId },
          timestamp
        );
        return agentLifecycleCanvasEventSchema.parse({
          command,
          node: this.readNode(command.canvasId, command.targetNodeId),
          removedNodeId: null,
          canvasRevision: this.currentCanvasRevision(command.canvasId)
        });
      }

      const node = this.requireAgentNode(command.canvasId, command.targetNodeId);
      const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
      this.sqlite
        .prepare("UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?")
        .run(
          JSON.stringify({ ...data, ...(command.role === null ? {} : { role: command.role }) }),
          command.canvasId,
          command.targetNodeId
        );
      const revision = this.bumpCanvasRevision(command.canvasId, timestamp);
      this.insertEvent(
        command.id,
        this.nextEventSequence(command.id),
        "role_assigned",
        { nodeId: command.targetNodeId },
        timestamp
      );
      return agentLifecycleCanvasEventSchema.parse({
        command,
        node: this.readNode(command.canvasId, command.targetNodeId),
        removedNodeId: null,
        canvasRevision: revision
      });
    })();
  }

  public markApplied(commandId: string): AgentLifecycleTransition {
    return this.transition(commandId, "applied", "command_applied", null);
  }

  public markFailed(commandId: string, errorCode: string): AgentLifecycleTransition {
    if (errorCode.length < 1 || errorCode.length > 160) {
      throw new Error("Agent lifecycle error code is invalid");
    }
    return this.transition(commandId, "failed", "command_failed", errorCode);
  }

  /**
   * A command claimed by a host that went away is never silently retried: applying it half-way and
   * then re-running it could close a terminal the user has since reopened. It is marked interrupted
   * so a person decides.
   */
  public recoverInterrupted(): number {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(
          "SELECT id FROM agent_lifecycle_commands WHERE status = 'applying' ORDER BY created_at"
        )
        .all() as { readonly id: string }[];
      for (const row of rows) {
        this.transitionWithin(row.id, "interrupted", "command_interrupted", "application_restart");
      }
      return rows.length;
    })();
  }

  public get(commandId: string): AgentLifecycleCommand | null {
    const row = this.sqlite
      .prepare("SELECT * FROM agent_lifecycle_commands WHERE id = ?")
      .get(commandId) as CommandRow | undefined;
    return row === undefined ? null : toCommand(row);
  }

  public list(workspaceId: string, limit = 50): readonly AgentLifecycleCommand[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Agent lifecycle list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM agent_lifecycle_commands WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, limit) as CommandRow[];
    return rows.map(toCommand);
  }

  public close(): void {
    this.policy.close();
    this.sqlite.close();
  }

  private transition(
    commandId: string,
    status: "applied" | "failed",
    eventType: AgentLifecycleEventType,
    errorCode: string | null
  ): AgentLifecycleTransition {
    return this.sqlite.transaction(() => {
      this.transitionWithin(commandId, status, eventType, errorCode);
      return { command: this.requireCommand(commandId) };
    })();
  }

  private transitionWithin(
    commandId: string,
    status: "applied" | "failed" | "interrupted",
    eventType: AgentLifecycleEventType,
    errorCode: string | null
  ): void {
    const timestamp = this.now().getTime();
    const updated = this.sqlite
      .prepare(
        `UPDATE agent_lifecycle_commands SET status = ?, error_code = ?, updated_at = ?
         WHERE id = ? AND status = 'applying'`
      )
      .run(status, errorCode, timestamp, commandId);
    if (updated.changes !== 1) {
      throw new Error("Agent lifecycle command is not in progress");
    }
    this.insertEvent(
      commandId,
      this.nextEventSequence(commandId),
      eventType,
      errorCode === null ? {} : { errorCode },
      timestamp
    );
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const workspace = this.sqlite
      .prepare("SELECT canvas_id, project_id FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (workspace === undefined) throw new Error("Agent lifecycle workspace was not found");
    return workspace;
  }

  private requireAgentNode(canvasId: string, nodeId: string): NodeRow {
    const node = this.sqlite
      .prepare(
        `SELECT id, type, position_x, position_y, width, height, data_json
         FROM canvas_nodes WHERE canvas_id = ? AND id = ?`
      )
      .get(canvasId, nodeId) as NodeRow | undefined;
    if (node === undefined) throw new Error("Agent lifecycle target was not found");
    if (node.type !== "agent" && node.type !== "terminal") {
      throw new Error("Agent lifecycle target must be an agent terminal");
    }
    return node;
  }

  private readNode(canvasId: string, nodeId: string) {
    const node = this.requireAgentNode(canvasId, nodeId);
    return canvasNodeSchema.parse({
      id: node.id,
      type: node.type,
      position: { x: node.position_x, y: node.position_y },
      width: node.width,
      height: node.height,
      data: canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown)
    });
  }

  private findByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string
  ): AgentLifecycleCommand | null {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM agent_lifecycle_commands WHERE workspace_id = ? AND idempotency_key = ?"
      )
      .get(workspaceId, idempotencyKey) as CommandRow | undefined;
    return row === undefined ? null : toCommand(row);
  }

  private requireCommand(commandId: string): AgentLifecycleCommand {
    const command = this.get(commandId);
    if (command === null) throw new Error("Agent lifecycle command was not found");
    return command;
  }

  private currentCanvasRevision(canvasId: string): number {
    return (
      this.sqlite.prepare("SELECT revision FROM canvases WHERE id = ?").get(canvasId) as {
        readonly revision: number;
      }
    ).revision;
  }

  private bumpCanvasRevision(canvasId: string, timestamp: number): number {
    this.sqlite
      .prepare("UPDATE canvases SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(timestamp, canvasId);
    return (
      this.sqlite.prepare("SELECT revision FROM canvases WHERE id = ?").get(canvasId) as {
        readonly revision: number;
      }
    ).revision;
  }

  private nextEventSequence(commandId: string): number {
    return (
      (
        this.sqlite
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_lifecycle_command_events WHERE command_id = ?"
          )
          .get(commandId) as { readonly sequence: number }
      ).sequence + 1
    );
  }

  private insertEvent(
    commandId: string,
    sequence: number,
    type: AgentLifecycleEventType,
    payload: Record<string, unknown>,
    timestamp: number
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO agent_lifecycle_command_events (id, command_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(this.createId(), commandId, sequence, type, JSON.stringify(payload), timestamp);
  }
}

/**
 * Restarting is grouped with reassigning rather than with removing: both end with the agent still on
 * the canvas doing its job, while removing takes a teammate away. Grouping restart with removal would
 * make "may restart a stuck agent" imply "may dismiss agents".
 */
function lifecyclePermission(action: AgentLifecycleCommand["action"]): AgentPermission {
  return action === "remove" ? "remove_agents" : "assign_roles";
}

function toCommand(row: CommandRow): AgentLifecycleCommand {
  return agentLifecycleCommandSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    canvasId: row.canvas_id,
    projectId: row.project_id,
    targetNodeId: row.target_node_id,
    action: row.action,
    role: row.role_json === null ? null : (JSON.parse(row.role_json) as unknown),
    requestedByNodeId: row.requested_by_node_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    sessionId: row.session_id,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  });
}
