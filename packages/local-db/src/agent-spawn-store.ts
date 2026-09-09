import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  agentSpawnCanvasEventSchema,
  agentSpawnEventTypeSchema,
  agentSpawnSchema,
  canvasNodeDataSchema,
  canvasNodeSchema,
  createAgentSpawnSchema
} from "@forgedeck/schemas";
import type {
  AgentSpawn,
  AgentSpawnCanvasEvent,
  AgentSpawnEventType,
  CanvasNode,
  CreateAgentSpawn
} from "@forgedeck/schemas";

import { SqlitePolicyEngine } from "./policy-engine";

interface SpawnRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly canvas_id: string;
  readonly project_id: string;
  readonly node_id: string;
  readonly adapter_id: string;
  readonly role_name: string;
  readonly name: string;
  readonly requested_by_node_id: string | null;
  readonly status: string;
  readonly idempotency_key: string;
  readonly attempt: number;
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
  readonly width: number | null;
  readonly height: number | null;
  readonly data_json: string;
}

export interface AgentSpawnEvent {
  readonly sequence: number;
  readonly type: AgentSpawnEventType;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AgentSpawnTransition {
  readonly spawn: AgentSpawn;
  readonly canvasEvent: AgentSpawnCanvasEvent | null;
}

export interface SqliteAgentSpawnStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

export class SqliteAgentSpawnStore {
  private readonly sqlite: Database.Database;
  private readonly policy: SqlitePolicyEngine;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqliteAgentSpawnStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.policy = new SqlitePolicyEngine(filename);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public create(input: CreateAgentSpawn): AgentSpawn {
    const parsed = createAgentSpawnSchema.parse(input);
    this.policy.assertAllowed({
      workspaceId: parsed.workspaceId,
      actorNodeId: parsed.requestedByNodeId,
      permission: "create_agents"
    });
    return this.sqlite.transaction(() => {
      const existing = this.findByIdempotencyKey(parsed.workspaceId, parsed.idempotencyKey);
      if (existing !== null) {
        if (
          existing.adapterId !== parsed.adapterId ||
          existing.roleName !== parsed.roleName ||
          existing.name !== parsed.name ||
          existing.requestedByNodeId !== parsed.requestedByNodeId
        ) {
          throw new Error("Agent spawn idempotency key conflicts with another request");
        }
        return existing;
      }

      const workspace = this.requireWorkspace(parsed.workspaceId);
      this.assertNameAvailable(parsed.workspaceId, workspace.canvas_id, parsed.name);

      const id = this.createId();
      const nodeId = `agent-${this.createId()}`;
      const timestamp = this.now().getTime();
      this.sqlite
        .prepare(
          `INSERT INTO agent_spawns
           (id, workspace_id, canvas_id, project_id, node_id, adapter_id, role_name, name,
            normalized_name, requested_by_node_id, status, idempotency_key, attempt, session_id,
            error_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, NULL, ?, ?)`
        )
        .run(
          id,
          parsed.workspaceId,
          workspace.canvas_id,
          workspace.project_id,
          nodeId,
          parsed.adapterId,
          parsed.roleName,
          parsed.name,
          normalizeName(parsed.name),
          parsed.requestedByNodeId,
          parsed.idempotencyKey,
          timestamp,
          timestamp
        );
      this.insertEvent(id, 1, "spawn_queued", {}, timestamp);
      return this.requireSpawn(id);
    })();
  }

  public list(workspaceId: string, limit = 50): readonly AgentSpawn[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Agent spawn list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM agent_spawns
         WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, limit) as SpawnRow[];
    return rows.map(toSpawn);
  }

  public get(spawnId: string): AgentSpawn | null {
    const row = this.sqlite.prepare("SELECT * FROM agent_spawns WHERE id = ?").get(spawnId) as
      SpawnRow | undefined;
    return row === undefined ? null : toSpawn(row);
  }

  /** Requeues only a known failed or interrupted launch after an explicit manual request. */
  public retry(spawnId: string, requestedByNodeId: string | null = null): AgentSpawn {
    const current = this.requireSpawn(spawnId);
    this.policy.assertAllowed({
      workspaceId: current.workspaceId,
      actorNodeId: requestedByNodeId,
      permission: "create_agents"
    });
    return this.sqlite.transaction(() => {
      const before = this.requireSpawn(spawnId);
      if (before.status !== "failed" && before.status !== "interrupted") {
        throw new Error("Agent spawn is not eligible for manual retry");
      }
      const timestamp = this.now().getTime();
      const updated = this.sqlite
        .prepare(
          `UPDATE agent_spawns
           SET status = 'queued', session_id = NULL, error_code = NULL, updated_at = ?
           WHERE id = ? AND status IN ('failed', 'interrupted')`
        )
        .run(timestamp, spawnId);
      if (updated.changes !== 1)
        throw new Error("Agent spawn is no longer eligible for manual retry");
      this.insertEvent(
        spawnId,
        this.nextEventSequence(spawnId),
        "spawn_retry_requested",
        { previousStatus: before.status },
        timestamp
      );
      return this.requireSpawn(spawnId);
    })();
  }

  public claimNext(projectId?: string): AgentSpawn | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT id FROM agent_spawns
           WHERE status = 'queued' AND (? IS NULL OR project_id = ?)
           ORDER BY created_at, id LIMIT 1`
        )
        .get(projectId ?? null, projectId ?? null) as { readonly id: string } | undefined;
      if (row === undefined) return null;
      const timestamp = this.now().getTime();
      const updated = this.sqlite
        .prepare(
          `UPDATE agent_spawns SET status = 'spawning', attempt = attempt + 1,
           error_code = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`
        )
        .run(timestamp, row.id);
      if (updated.changes !== 1) return null;
      this.insertEvent(row.id, this.nextEventSequence(row.id), "spawn_started", {}, timestamp);
      return this.requireSpawn(row.id);
    })();
  }

  public materializeNode(spawnId: string): AgentSpawnCanvasEvent {
    return this.sqlite.transaction(() => {
      const spawn = this.requireSpawn(spawnId);
      if (spawn.status !== "spawning") throw new Error("Agent spawn is not in progress");
      const existing = this.findNode(spawn.canvasId, spawn.nodeId);
      if (existing === null) {
        const count = (
          this.sqlite
            .prepare("SELECT COUNT(*) AS count FROM canvas_nodes WHERE canvas_id = ?")
            .get(spawn.canvasId) as { readonly count: number }
        ).count;
        const position = spawnPosition(count);
        this.sqlite
          .prepare(
            `INSERT INTO canvas_nodes
             (canvas_id, id, type, position_x, position_y, width, height, data_json)
             VALUES (?, ?, 'agent', ?, ?, 560, 380, ?)`
          )
          .run(
            spawn.canvasId,
            spawn.nodeId,
            position.x,
            position.y,
            JSON.stringify(spawnNodeData(spawn, "starting"))
          );
        const timestamp = this.now().getTime();
        this.bumpCanvasRevision(spawn.canvasId, timestamp);
        this.insertEvent(
          spawn.id,
          this.nextEventSequence(spawn.id),
          "node_created",
          { nodeId: spawn.nodeId },
          timestamp
        );
      } else {
        const data = canvasNodeDataSchema.parse(JSON.parse(existing.data_json) as unknown);
        if (data.state !== "starting") {
          const timestamp = this.now().getTime();
          this.sqlite
            .prepare(`UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?`)
            .run(JSON.stringify({ ...data, state: "starting" }), spawn.canvasId, spawn.nodeId);
          this.bumpCanvasRevision(spawn.canvasId, timestamp);
          this.insertEvent(
            spawn.id,
            this.nextEventSequence(spawn.id),
            "node_restarted",
            { nodeId: spawn.nodeId },
            timestamp
          );
        }
      }
      return this.requireCanvasEvent(spawn.id);
    })();
  }

  public markRunning(spawnId: string, sessionId: string): AgentSpawnTransition {
    return this.transition(spawnId, "running", "agent_running", sessionId, null, "running");
  }

  public markFailed(spawnId: string, errorCode: string): AgentSpawnTransition {
    if (errorCode.length < 1 || errorCode.length > 160) {
      throw new Error("Agent spawn error code is invalid");
    }
    return this.transition(spawnId, "failed", "spawn_failed", null, errorCode, "failed");
  }

  public recoverInterrupted(): number {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare("SELECT id FROM agent_spawns WHERE status = 'spawning' ORDER BY created_at")
        .all() as { readonly id: string }[];
      for (const row of rows) {
        this.transition(
          row.id,
          "interrupted",
          "spawn_interrupted",
          null,
          "application_restart",
          "disconnected"
        );
      }
      return rows.length;
    })();
  }

  public listEvents(spawnId: string): readonly AgentSpawnEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT sequence, type, detail_json, created_at
         FROM agent_spawn_events WHERE spawn_id = ? ORDER BY sequence`
      )
      .all(spawnId) as {
      readonly sequence: number;
      readonly type: string;
      readonly detail_json: string;
      readonly created_at: number;
    }[];
    return rows.map((row) => ({
      sequence: row.sequence,
      type: agentSpawnEventTypeSchema.parse(row.type),
      detail: parseDetail(row.detail_json),
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  public close(): void {
    this.policy.close();
    this.sqlite.close();
  }

  private transition(
    spawnId: string,
    status: "running" | "failed" | "interrupted",
    eventType: "agent_running" | "spawn_failed" | "spawn_interrupted",
    sessionId: string | null,
    errorCode: string | null,
    nodeState: "running" | "failed" | "disconnected"
  ): AgentSpawnTransition {
    return this.sqlite.transaction(() => {
      const before = this.requireSpawn(spawnId);
      if (before.status !== "spawning") throw new Error("Agent spawn is not in progress");
      const timestamp = this.now().getTime();
      this.sqlite
        .prepare(
          `UPDATE agent_spawns SET status = ?, session_id = ?, error_code = ?, updated_at = ?
           WHERE id = ? AND status = 'spawning'`
        )
        .run(status, sessionId, errorCode, timestamp, spawnId);

      const node = this.findNode(before.canvasId, before.nodeId);
      let canvasEvent: AgentSpawnCanvasEvent | null = null;
      if (node !== null) {
        const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
        this.sqlite
          .prepare(`UPDATE canvas_nodes SET data_json = ? WHERE canvas_id = ? AND id = ?`)
          .run(JSON.stringify({ ...data, state: nodeState }), before.canvasId, before.nodeId);
        this.bumpCanvasRevision(before.canvasId, timestamp);
      }
      this.insertEvent(
        spawnId,
        this.nextEventSequence(spawnId),
        eventType,
        errorCode === null ? { sessionId } : { errorCode },
        timestamp
      );
      const spawn = this.requireSpawn(spawnId);
      if (node !== null) canvasEvent = this.requireCanvasEvent(spawnId);
      return { spawn, canvasEvent };
    })();
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.sqlite
      .prepare("SELECT canvas_id, project_id FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) throw new Error("Agent spawn workspace was not found");
    return row;
  }

  private assertNameAvailable(workspaceId: string, canvasId: string, name: string): void {
    const normalized = normalizeName(name);
    const reserved = this.sqlite
      .prepare("SELECT id FROM agent_spawns WHERE workspace_id = ? AND normalized_name = ?")
      .get(workspaceId, normalized);
    if (reserved !== undefined) throw new Error(`Agent name is already in use: ${name}`);
    const rows = this.sqlite
      .prepare(
        `SELECT data_json FROM canvas_nodes
         WHERE canvas_id = ? AND type IN ('agent', 'terminal')`
      )
      .all(canvasId) as { readonly data_json: string }[];
    if (
      rows.some((row) => {
        const data = canvasNodeDataSchema.parse(JSON.parse(row.data_json) as unknown);
        return normalizeName(data.title) === normalized;
      })
    ) {
      throw new Error(`Agent name is already in use: ${name}`);
    }
  }

  private findByIdempotencyKey(workspaceId: string, key: string): AgentSpawn | null {
    const row = this.sqlite
      .prepare("SELECT * FROM agent_spawns WHERE workspace_id = ? AND idempotency_key = ?")
      .get(workspaceId, key) as SpawnRow | undefined;
    return row === undefined ? null : toSpawn(row);
  }

  private requireSpawn(spawnId: string): AgentSpawn {
    const row = this.sqlite.prepare("SELECT * FROM agent_spawns WHERE id = ?").get(spawnId) as
      SpawnRow | undefined;
    if (row === undefined) throw new Error("Agent spawn was not found");
    return toSpawn(row);
  }

  private findNode(canvasId: string, nodeId: string): NodeRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, type, position_x, position_y, width, height, data_json
         FROM canvas_nodes WHERE canvas_id = ? AND id = ?`
      )
      .get(canvasId, nodeId) as NodeRow | undefined;
    return row ?? null;
  }

  private requireCanvasEvent(spawnId: string): AgentSpawnCanvasEvent {
    const spawn = this.requireSpawn(spawnId);
    const row = this.findNode(spawn.canvasId, spawn.nodeId);
    if (row === null) throw new Error("Spawned agent canvas node was not found");
    const canvas = this.sqlite
      .prepare("SELECT revision FROM canvases WHERE id = ?")
      .get(spawn.canvasId) as { readonly revision: number } | undefined;
    if (canvas === undefined) throw new Error("Spawned agent canvas was not found");
    return agentSpawnCanvasEventSchema.parse({
      spawn,
      node: toCanvasNode(row),
      canvasRevision: canvas.revision
    });
  }

  private bumpCanvasRevision(canvasId: string, timestamp: number): void {
    const updated = this.sqlite
      .prepare("UPDATE canvases SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(timestamp, canvasId);
    if (updated.changes !== 1) throw new Error("Agent spawn canvas was not found");
  }

  private nextEventSequence(spawnId: string): number {
    return (
      this.sqlite
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM agent_spawn_events WHERE spawn_id = ?`
        )
        .get(spawnId) as { readonly sequence: number }
    ).sequence;
  }

  private insertEvent(
    spawnId: string,
    sequence: number,
    type: AgentSpawnEventType,
    detail: Readonly<Record<string, unknown>>,
    timestamp: number
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO agent_spawn_events
         (id, spawn_id, sequence, type, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(this.createId(), spawnId, sequence, type, JSON.stringify(detail), timestamp);
  }
}

function spawnNodeData(
  spawn: AgentSpawn,
  state: "starting"
): ReturnType<typeof canvasNodeDataSchema.parse> {
  return canvasNodeDataSchema.parse({
    title: spawn.name,
    state,
    summary: `Agente ${spawn.roleName} criado pela CLI do Compasso.`,
    adapterId: spawn.adapterId,
    role: {
      name: spawn.roleName,
      responsibilities: "",
      constraints: "",
      expectedDeliverable: "",
      completionCriteria: ""
    },
    retryMaxAttempts: 1,
    permissions: []
  });
}

function spawnPosition(count: number): { readonly x: number; readonly y: number } {
  return { x: 160 + (count % 3) * 600, y: 140 + Math.floor(count / 3) * 420 };
}

function toCanvasNode(row: NodeRow): CanvasNode {
  return canvasNodeSchema.parse({
    id: row.id,
    type: row.type,
    position: { x: row.position_x, y: row.position_y },
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    data: JSON.parse(row.data_json) as unknown
  });
}

function toSpawn(row: SpawnRow): AgentSpawn {
  return agentSpawnSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    canvasId: row.canvas_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    adapterId: row.adapter_id,
    roleName: row.role_name,
    name: row.name,
    requestedByNodeId: row.requested_by_node_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    sessionId: row.session_id,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  });
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function parseDetail(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent spawn event detail is invalid");
  }
  return parsed as Readonly<Record<string, unknown>>;
}
