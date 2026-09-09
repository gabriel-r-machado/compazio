import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  canvasNodeDataSchema,
  edgeContractSchema,
  workspaceConnectionCanvasEventSchema,
  workspaceConnectionCreatableTypeSchema,
  workspaceConnectionEventTypeSchema,
  workspaceConnectionTypeSchema
} from "@forgedeck/schemas";
import type {
  CanvasConnectionNode,
  CanvasEdge,
  EdgeContract,
  WorkspaceCanvasConnection,
  WorkspaceConnectionCanvasEvent,
  WorkspaceConnectionCreatableType,
  WorkspaceConnectionEventType,
  WorkspaceConnectionType
} from "@forgedeck/schemas";

import { SqlitePolicyEngine } from "./policy-engine";

interface WorkspaceRow {
  readonly canvas_id: string;
}

interface CanvasRow {
  readonly revision: number;
  readonly updated_at: number;
}

interface NodeRow {
  readonly id: string;
  readonly type: string;
  readonly data_json: string;
}

interface EdgeRow {
  readonly id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly contract_json: string;
}

interface EventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly canvas_id: string;
  readonly edge_id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly contract_json: string;
  readonly event_type: string;
  readonly actor_node_id: string | null;
  readonly canvas_revision: number;
  readonly created_at: number;
}

interface CreationAuditRow {
  readonly actor_node_id: string | null;
  readonly canvas_revision: number;
  readonly created_at: number;
}

export interface CreateWorkspaceConnectionInput {
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly type: WorkspaceConnectionCreatableType;
  readonly label: string | null;
  readonly createdByNodeId: string | null;
  readonly idempotencyKey: string;
  readonly expectedCanvasRevision: number | null;
}

export interface RemoveWorkspaceConnectionInput {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly removedByNodeId: string | null;
  readonly idempotencyKey: string;
  readonly expectedCanvasRevision: number | null;
}

/** @deprecated Use CreateWorkspaceConnectionInput with type: "context". */
export interface ConnectWorkspaceContextInput {
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly connectedByNodeId: string | null;
  readonly idempotencyKey: string;
}

/**
 * Repository and application service for canvas edges. `canvas_edges` is the sole connection model;
 * this store only adds audited CLI mutations and durable renderer projections around those same rows.
 */
export class SqliteWorkspaceConnectionStore {
  private readonly sqlite: Database.Database;
  private readonly policy: SqlitePolicyEngine;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(
    filename: string,
    options: { readonly createId?: () => string; readonly now?: () => Date } = {}
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.policy = new SqlitePolicyEngine(filename);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public create(input: CreateWorkspaceConnectionInput): WorkspaceConnectionCanvasEvent {
    validateCreateInput(input);
    this.policy.assertAllowed({
      workspaceId: input.workspaceId,
      actorNodeId: input.createdByNodeId,
      permission: "connect_context"
    });
    return this.sqlite.transaction(() => this.createInTransaction(input))();
  }

  /** Retains the old local API while persisting the generic context edge model. */
  public connect(input: ConnectWorkspaceContextInput): WorkspaceConnectionCanvasEvent {
    return this.create({
      workspaceId: input.workspaceId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      type: "context",
      label: "Context",
      createdByNodeId: input.connectedByNodeId,
      idempotencyKey: input.idempotencyKey,
      expectedCanvasRevision: null
    });
  }

  public list(workspaceId: string, limit = 500): readonly WorkspaceCanvasConnection[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) {
      throw new Error("Workspace connection list limit must be between 1 and 2000");
    }
    const workspace = this.requireWorkspace(workspaceId);
    const canvas = this.requireCanvas(workspace.canvas_id);
    const edges = this.sqlite
      .prepare(
        `SELECT id, source_node_id, target_node_id, contract_json
         FROM canvas_edges WHERE canvas_id = ? ORDER BY rowid LIMIT ?`
      )
      .all(workspace.canvas_id, limit) as EdgeRow[];
    return edges.map((edge) => this.toConnection(workspace.canvas_id, edge, canvas));
  }

  public show(workspaceId: string, connectionId: string): WorkspaceCanvasConnection {
    const workspace = this.requireWorkspace(workspaceId);
    const edge = this.findEdge(workspace.canvas_id, connectionId);
    if (edge === null) throw new Error(`Workspace connection not found: ${connectionId}`);
    return this.toConnection(workspace.canvas_id, edge, this.requireCanvas(workspace.canvas_id));
  }

  public remove(input: RemoveWorkspaceConnectionInput): WorkspaceConnectionCanvasEvent {
    validateRemoveInput(input);
    this.policy.assertAllowed({
      workspaceId: input.workspaceId,
      actorNodeId: input.removedByNodeId,
      permission: "connect_context"
    });
    return this.sqlite.transaction(() => this.removeInTransaction(input))();
  }

  public resolveNode(workspaceId: string, reference: string): CanvasConnectionNode {
    const workspace = this.requireWorkspace(workspaceId);
    const nodes = this.sqlite
      .prepare(
        `SELECT id, type, data_json FROM canvas_nodes
         WHERE canvas_id = ? ORDER BY rowid`
      )
      .all(workspace.canvas_id) as NodeRow[];
    const matches = nodes.filter((node) => {
      const data = canvasNodeDataSchema.parse(parseJson(node.data_json));
      return node.id === reference || equalsFold(data.title, reference);
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Canvas entity not found: ${reference}`
          : `Canvas entity is ambiguous: ${reference}; use its ID`
      );
    }
    const node = requireFirst(matches);
    const data = canvasNodeDataSchema.parse(parseJson(node.data_json));
    return { nodeId: node.id, title: data.title, type: node.type };
  }

  public claimNextCanvasEvent(): WorkspaceConnectionCanvasEvent | null {
    return this.sqlite.transaction(() => {
      const event = this.sqlite
        .prepare(
          `SELECT id, workspace_id, canvas_id, edge_id, source_node_id, target_node_id,
                  contract_json, event_type, actor_node_id, canvas_revision, created_at
           FROM workspace_connection_events
           WHERE projection_state = 'queued' ORDER BY created_at, id LIMIT 1`
        )
        .get() as EventRow | undefined;
      if (event === undefined) return null;
      const result = this.sqlite
        .prepare(
          `UPDATE workspace_connection_events SET projection_state = 'delivering'
           WHERE id = ? AND projection_state = 'queued'`
        )
        .run(event.id);
      return result.changes === 1 ? this.toCanvasEvent(event) : null;
    })();
  }

  public markCanvasEventPublished(eventId: string): void {
    const result = this.sqlite
      .prepare(
        `UPDATE workspace_connection_events SET projection_state = 'published'
         WHERE id = ? AND projection_state = 'delivering'`
      )
      .run(eventId);
    if (result.changes !== 1) throw new Error("Workspace connection event is not being delivered");
  }

  public recoverProjectionDeliveries(): number {
    return this.sqlite
      .prepare(
        `UPDATE workspace_connection_events SET projection_state = 'queued'
         WHERE projection_state = 'delivering'`
      )
      .run().changes;
  }

  public close(): void {
    this.policy.close();
    this.sqlite.close();
  }

  private createInTransaction(
    input: CreateWorkspaceConnectionInput
  ): WorkspaceConnectionCanvasEvent {
    const previous = this.findEventByIdempotency(input.workspaceId, input.idempotencyKey);
    if (previous !== null) {
      this.assertMatchingCreateEvent(previous, input);
      return this.toCanvasEvent(previous);
    }

    const workspace = this.requireWorkspace(input.workspaceId);
    const canvas = this.requireCanvas(workspace.canvas_id);
    this.requireExpectedRevision(canvas, input.expectedCanvasRevision);
    this.requireNode(workspace.canvas_id, input.sourceNodeId, "source");
    this.requireNode(workspace.canvas_id, input.targetNodeId, "target");
    if (input.sourceNodeId === input.targetNodeId) {
      throw new Error("Workspace connection source and target must differ");
    }
    if (input.type === "context") {
      this.requireContextRoute(
        input.workspaceId,
        workspace.canvas_id,
        input.sourceNodeId,
        input.targetNodeId
      );
    }
    // An agent may only grant context to itself — it cannot widen what another agent can read. That
    // rule is about agents; wiring one note behind another grants nobody anything new, since the
    // chain still only reaches whoever the anchor note is already connected to.
    if (
      input.createdByNodeId !== null &&
      input.type === "context" &&
      this.requireNode(workspace.canvas_id, input.targetNodeId, "target").type !== "note" &&
      input.createdByNodeId !== input.targetNodeId
    ) {
      throw new Error("An agent can only connect context to itself");
    }

    const existing = this.findConnectionByRoute(
      workspace.canvas_id,
      input.sourceNodeId,
      input.targetNodeId,
      input.type
    );
    if (existing !== null) {
      return this.toExistingConnectionEvent(
        input.workspaceId,
        workspace.canvas_id,
        existing,
        canvas
      );
    }
    if (requiresDag(input.type)) {
      this.requireNoWorkflowCycle(workspace.canvas_id, input.sourceNodeId, input.targetNodeId);
    }

    const edge = this.insertEdge(
      workspace.canvas_id,
      input.sourceNodeId,
      input.targetNodeId,
      input.type,
      input.label
    );
    const timestamp = this.now().getTime();
    const canvasRevision = this.bumpCanvasRevision(workspace.canvas_id, timestamp);
    const event = this.insertEvent({
      workspaceId: input.workspaceId,
      canvasId: workspace.canvas_id,
      edge,
      eventType: "connection_created",
      actorNodeId: input.createdByNodeId,
      canvasRevision,
      idempotencyKey: input.idempotencyKey,
      timestamp
    });
    return this.toCanvasEvent(event);
  }

  private removeInTransaction(
    input: RemoveWorkspaceConnectionInput
  ): WorkspaceConnectionCanvasEvent {
    const previous = this.findEventByIdempotency(input.workspaceId, input.idempotencyKey);
    if (previous !== null) {
      if (
        workspaceConnectionEventTypeSchema.parse(previous.event_type) !== "connection_removed" ||
        previous.edge_id !== input.connectionId ||
        previous.actor_node_id !== input.removedByNodeId
      ) {
        throw new Error("Workspace connection idempotency key conflicts with another mutation");
      }
      return this.toCanvasEvent(previous);
    }

    const workspace = this.requireWorkspace(input.workspaceId);
    const canvas = this.requireCanvas(workspace.canvas_id);
    this.requireExpectedRevision(canvas, input.expectedCanvasRevision);
    const edge = this.findEdge(workspace.canvas_id, input.connectionId);
    if (edge === null) throw new Error(`Workspace connection not found: ${input.connectionId}`);
    const connection = this.toConnection(workspace.canvas_id, edge, canvas);
    if (
      input.removedByNodeId !== null &&
      connection.type === "context" &&
      input.removedByNodeId !== connection.targetNodeId
    ) {
      throw new Error("An agent can only remove context connected to itself");
    }

    this.sqlite
      .prepare("DELETE FROM canvas_edges WHERE canvas_id = ? AND id = ?")
      .run(workspace.canvas_id, edge.id);
    const timestamp = this.now().getTime();
    const canvasRevision = this.bumpCanvasRevision(workspace.canvas_id, timestamp);
    const event = this.insertEvent({
      workspaceId: input.workspaceId,
      canvasId: workspace.canvas_id,
      edge,
      eventType: "connection_removed",
      actorNodeId: input.removedByNodeId,
      canvasRevision,
      idempotencyKey: input.idempotencyKey,
      timestamp
    });
    return this.toCanvasEvent(event);
  }

  private insertEdge(
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string,
    type: WorkspaceConnectionCreatableType,
    label: string | null
  ): EdgeRow {
    const edge: EdgeRow = {
      id: `edge-${this.createId()}`,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      contract_json: JSON.stringify(
        edgeContractSchema.parse({
          schemaVersion: "1.0",
          kind: type,
          label: label ?? defaultLabel(type),
          requiredEvidenceTypes: []
        })
      )
    };
    this.sqlite
      .prepare(
        `INSERT INTO canvas_edges (canvas_id, id, source_node_id, target_node_id, contract_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(canvasId, edge.id, edge.source_node_id, edge.target_node_id, edge.contract_json);
    return edge;
  }

  private insertEvent(input: {
    readonly workspaceId: string;
    readonly canvasId: string;
    readonly edge: EdgeRow;
    readonly eventType: WorkspaceConnectionEventType;
    readonly actorNodeId: string | null;
    readonly canvasRevision: number;
    readonly idempotencyKey: string;
    readonly timestamp: number;
  }): EventRow {
    const event: EventRow = {
      id: this.createId(),
      workspace_id: input.workspaceId,
      canvas_id: input.canvasId,
      edge_id: input.edge.id,
      source_node_id: input.edge.source_node_id,
      target_node_id: input.edge.target_node_id,
      contract_json: input.edge.contract_json,
      event_type: input.eventType,
      actor_node_id: input.actorNodeId,
      canvas_revision: input.canvasRevision,
      created_at: input.timestamp
    };
    this.sqlite
      .prepare(
        `INSERT INTO workspace_connection_events
         (id, workspace_id, canvas_id, edge_id, source_node_id, target_node_id, contract_json,
          event_type, actor_node_id, canvas_revision, idempotency_key, projection_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(
        event.id,
        event.workspace_id,
        event.canvas_id,
        event.edge_id,
        event.source_node_id,
        event.target_node_id,
        event.contract_json,
        event.event_type,
        event.actor_node_id,
        event.canvas_revision,
        input.idempotencyKey,
        event.created_at
      );
    return event;
  }

  private findEventByIdempotency(workspaceId: string, idempotencyKey: string): EventRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, workspace_id, canvas_id, edge_id, source_node_id, target_node_id,
                contract_json, event_type, actor_node_id, canvas_revision, created_at
         FROM workspace_connection_events WHERE workspace_id = ? AND idempotency_key = ?`
      )
      .get(workspaceId, idempotencyKey) as EventRow | undefined;
    return row ?? null;
  }

  private findEdge(canvasId: string, edgeId: string): EdgeRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, source_node_id, target_node_id, contract_json
         FROM canvas_edges WHERE canvas_id = ? AND id = ?`
      )
      .get(canvasId, edgeId) as EdgeRow | undefined;
    return row ?? null;
  }

  private findConnectionByRoute(
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string,
    type: WorkspaceConnectionCreatableType
  ): EdgeRow | null {
    const rows = this.sqlite
      .prepare(
        `SELECT id, source_node_id, target_node_id, contract_json
         FROM canvas_edges WHERE canvas_id = ? AND source_node_id = ? AND target_node_id = ?`
      )
      .all(canvasId, sourceNodeId, targetNodeId) as EdgeRow[];
    return rows.find((edge) => connectionType(edge) === type) ?? null;
  }

  private findCreationAudit(canvasId: string, edgeId: string): CreationAuditRow | null {
    const row = this.sqlite
      .prepare(
        `SELECT actor_node_id, canvas_revision, created_at
         FROM workspace_connection_events
         WHERE canvas_id = ? AND edge_id = ? AND event_type = 'connection_created'
         ORDER BY created_at, id LIMIT 1`
      )
      .get(canvasId, edgeId) as CreationAuditRow | undefined;
    return row ?? null;
  }

  private toExistingConnectionEvent(
    workspaceId: string,
    canvasId: string,
    edge: EdgeRow,
    canvas: CanvasRow
  ): WorkspaceConnectionCanvasEvent {
    const creation = this.sqlite
      .prepare(
        `SELECT id, workspace_id, canvas_id, edge_id, source_node_id, target_node_id,
                contract_json, event_type, actor_node_id, canvas_revision, created_at
         FROM workspace_connection_events
         WHERE workspace_id = ? AND canvas_id = ? AND edge_id = ?
           AND event_type = 'connection_created'
         ORDER BY created_at, id LIMIT 1`
      )
      .get(workspaceId, canvasId, edge.id) as EventRow | undefined;
    if (creation !== undefined) return this.toCanvasEvent(creation);
    return workspaceConnectionCanvasEventSchema.parse({
      id: `existing-${edge.id}`,
      type: "connection_created",
      workspaceId,
      canvasId,
      connection: this.toConnection(canvasId, edge, canvas),
      edge: toCanvasEdge(edge),
      actorNodeId: null,
      canvasRevision: canvas.revision
    });
  }

  private toConnection(
    canvasId: string,
    edge: EdgeRow,
    canvas: CanvasRow
  ): WorkspaceCanvasConnection {
    const audit = this.findCreationAudit(canvasId, edge.id);
    const contract = edgeContractSchema.parse(parseJson(edge.contract_json));
    return {
      connectionId: edge.id,
      canvasId,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      type: workspaceConnectionTypeSchema.parse(contract.kind),
      permission: "connect_context",
      label: contract.label.length === 0 ? null : contract.label,
      createdBy: audit?.actor_node_id ?? null,
      createdAt: new Date(audit?.created_at ?? canvas.updated_at).toISOString(),
      revision: audit?.canvas_revision ?? canvas.revision
    };
  }

  private toCanvasEvent(event: EventRow): WorkspaceConnectionCanvasEvent {
    const edge: EdgeRow = {
      id: event.edge_id,
      source_node_id: event.source_node_id,
      target_node_id: event.target_node_id,
      contract_json: event.contract_json
    };
    const fallbackCanvas: CanvasRow = {
      revision: event.canvas_revision,
      updated_at: event.created_at
    };
    return workspaceConnectionCanvasEventSchema.parse({
      id: event.id,
      type: workspaceConnectionEventTypeSchema.parse(event.event_type),
      workspaceId: event.workspace_id,
      canvasId: event.canvas_id,
      connection: this.toConnection(event.canvas_id, edge, fallbackCanvas),
      edge: toCanvasEdge(edge),
      actorNodeId: event.actor_node_id,
      canvasRevision: event.canvas_revision
    });
  }

  private assertMatchingCreateEvent(event: EventRow, input: CreateWorkspaceConnectionInput): void {
    if (
      workspaceConnectionEventTypeSchema.parse(event.event_type) !== "connection_created" ||
      event.source_node_id !== input.sourceNodeId ||
      event.target_node_id !== input.targetNodeId ||
      connectionType({
        id: event.edge_id,
        source_node_id: event.source_node_id,
        target_node_id: event.target_node_id,
        contract_json: event.contract_json
      }) !== input.type ||
      edgeContractSchema.parse(parseJson(event.contract_json)).label !==
        (input.label ?? defaultLabel(input.type)) ||
      event.actor_node_id !== input.createdByNodeId
    ) {
      throw new Error("Workspace connection idempotency key conflicts with another mutation");
    }
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const workspace = this.sqlite
      .prepare("SELECT canvas_id FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (workspace === undefined) throw new Error("Workspace connection workspace was not found");
    return workspace;
  }

  private requireCanvas(canvasId: string): CanvasRow {
    const canvas = this.sqlite
      .prepare("SELECT revision, updated_at FROM canvases WHERE id = ?")
      .get(canvasId) as CanvasRow | undefined;
    if (canvas === undefined) throw new Error("Workspace connection canvas was not found");
    return canvas;
  }

  private requireExpectedRevision(canvas: CanvasRow, expectedRevision: number | null): void {
    if (expectedRevision !== null && expectedRevision !== canvas.revision) {
      throw new Error(
        `Canvas revision conflict: expected ${canvas.revision}, received ${expectedRevision}`
      );
    }
  }

  private requireNode(canvasId: string, nodeId: string, role: "source" | "target"): NodeRow {
    const node = this.sqlite
      .prepare("SELECT id, type, data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
      .get(canvasId, nodeId) as NodeRow | undefined;
    if (node === undefined) throw new Error(`Workspace connection ${role} was not found`);
    return node;
  }

  private requireContextRoute(
    workspaceId: string,
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): void {
    const source = this.requireNode(canvasId, sourceNodeId, "source");
    if (source.type === "artifact") {
      const data = canvasNodeDataSchema.parse(parseJson(source.data_json));
      if (data.artifact === undefined) {
        throw new Error("Workspace artifact context source is incomplete");
      }
      this.requirePublishedArtifact(workspaceId, data.artifact);
    } else if (source.type !== "note") {
      throw new Error("Workspace context source must be a note or artifact node");
    }
    // A context edge may end on an agent, or on another note. The second shape is what lets a person
    // organise material as a tree and connect only its root to an agent, instead of wiring every leaf
    // to every terminal; the resolver walks the chain from the agent outwards.
    const target = this.requireNode(canvasId, targetNodeId, "target");
    if (target.type !== "note") {
      this.requireAgentNode(canvasId, targetNodeId, "target");
    }
  }

  private requirePublishedArtifact(
    workspaceId: string,
    artifact: NonNullable<ReturnType<typeof canvasNodeDataSchema.parse>["artifact"]>
  ): void {
    const row = this.sqlite
      .prepare(
        `SELECT kind, relative_path, filename, sha256, byte_size, media_type
         FROM workspace_artifacts WHERE workspace_id = ? AND id = ?`
      )
      .get(workspaceId, artifact.artifactId) as
      | {
          readonly kind: string;
          readonly relative_path: string;
          readonly filename: string;
          readonly sha256: string;
          readonly byte_size: number;
          readonly media_type: string;
        }
      | undefined;
    if (
      row === undefined ||
      row.kind !== artifact.kind ||
      row.relative_path !== artifact.relativePath ||
      row.filename !== artifact.filename ||
      row.sha256 !== artifact.sha256 ||
      row.byte_size !== artifact.byteSize ||
      row.media_type !== artifact.mediaType
    ) {
      throw new Error("Workspace artifact context source is not a published immutable artifact");
    }
  }

  private requireAgentNode(
    canvasId: string,
    nodeId: string,
    role: "target" | "requester"
  ): ReturnType<typeof canvasNodeDataSchema.parse> {
    const node = this.requireNode(canvasId, nodeId, role === "target" ? "target" : "source");
    if (node.type !== "agent" && node.type !== "terminal") {
      throw new Error(`Workspace connection ${role} must be an agent node`);
    }
    const data = canvasNodeDataSchema.parse(parseJson(node.data_json));
    if (data.adapterId === undefined || data.adapterId === "shell") {
      throw new Error(`Workspace connection ${role} is not an agent-capable terminal`);
    }
    return data;
  }

  private requireNoWorkflowCycle(
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): void {
    const edges = this.sqlite
      .prepare(
        "SELECT id, source_node_id, target_node_id, contract_json FROM canvas_edges WHERE canvas_id = ?"
      )
      .all(canvasId) as EdgeRow[];
    const workflowEdges = edges.filter((edge) => requiresDag(connectionType(edge)));
    const queue = [targetNodeId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      if (current === sourceNodeId) {
        throw new Error("Workspace connection would create a workflow cycle");
      }
      visited.add(current);
      workflowEdges
        .filter((edge) => edge.source_node_id === current)
        .forEach((edge) => queue.push(edge.target_node_id));
    }
  }

  private bumpCanvasRevision(canvasId: string, timestamp: number): number {
    const result = this.sqlite
      .prepare("UPDATE canvases SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(timestamp, canvasId);
    if (result.changes !== 1) throw new Error("Workspace connection canvas was not found");
    return this.requireCanvas(canvasId).revision;
  }
}

function validateCreateInput(input: CreateWorkspaceConnectionInput): void {
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
    throw new Error("Workspace connection idempotency key is invalid");
  }
  workspaceConnectionCreatableTypeSchema.parse(input.type);
  if (input.label !== null && (input.label.length < 1 || input.label.length > 160)) {
    throw new Error("Workspace connection label is invalid");
  }
  if (
    input.expectedCanvasRevision !== null &&
    (!Number.isInteger(input.expectedCanvasRevision) || input.expectedCanvasRevision < 0)
  ) {
    throw new Error("Workspace connection expected revision is invalid");
  }
}

function validateRemoveInput(input: RemoveWorkspaceConnectionInput): void {
  if (input.connectionId.length < 1 || input.connectionId.length > 160) {
    throw new Error("Workspace connection id is invalid");
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
    throw new Error("Workspace connection idempotency key is invalid");
  }
  if (
    input.expectedCanvasRevision !== null &&
    (!Number.isInteger(input.expectedCanvasRevision) || input.expectedCanvasRevision < 0)
  ) {
    throw new Error("Workspace connection expected revision is invalid");
  }
}

function connectionType(edge: EdgeRow): WorkspaceConnectionType {
  return workspaceConnectionTypeSchema.parse(
    edgeContractSchema.parse(parseJson(edge.contract_json)).kind
  );
}

function requiresDag(type: WorkspaceConnectionType): boolean {
  return type === "dependency" || type === "handoff";
}

function defaultLabel(type: WorkspaceConnectionCreatableType): string {
  switch (type) {
    case "context":
      return "Context";
    case "handoff":
      return "Handoff";
    case "dependency":
      return "depends on";
  }
}

function toCanvasEdge(edge: EdgeRow): CanvasEdge {
  return {
    id: edge.id,
    source: edge.source_node_id,
    target: edge.target_node_id,
    contract: edgeContractSchema.parse(parseJson(edge.contract_json)) as EdgeContract
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Stored workspace connection JSON is invalid");
  }
}

function equalsFold(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function requireFirst<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected one canvas entity");
  return value;
}
