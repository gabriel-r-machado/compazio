import Database from "better-sqlite3";

import { redactValue } from "@forgedeck/logger";
import {
  artifactReferenceSchema,
  evidenceSchema,
  permissionMapSchema,
  workflowSchema
} from "@forgedeck/workflow";
import type { ArtifactReference, Evidence, PermissionMap, Workflow } from "@forgedeck/workflow";
import { workflowRunExecutionContextSchema } from "@forgedeck/schemas";
import type {
  NodeRunSnapshot,
  RunEvent,
  RunEventType,
  RunState,
  RunStore,
  WorkflowRunSnapshot
} from "@forgedeck/orchestration";

const maximumEventPayloadBytes = 64 * 1024;

const runStates = new Set<RunState>([
  "created",
  "running",
  "paused",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted"
]);

const nodeRunStates = new Set<NodeRunSnapshot["state"]>([
  "pending",
  "ready",
  "starting",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped"
]);

const runEventTypes = new Set<RunEventType>([
  "run.created",
  "run.started",
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "node.ready",
  "node.started",
  "node.waiting",
  "node.blocked",
  "node.succeeded",
  "node.failed",
  "node.cancelled",
  "node.retry_scheduled",
  "approval.requested",
  "approval.resolved",
  "artifact.created",
  "handoff.created",
  "report.created"
]);

interface WorkflowRunRow {
  readonly id: string;
  readonly workflow_id: string;
  readonly workflow_version: string;
  readonly workflow_hash: string;
  readonly input_hash: string;
  readonly workflow_snapshot_json: string;
  readonly effective_permissions_json: string;
  readonly state: string;
  readonly dry_run: number;
  readonly concurrency: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly retry_of_run_id: string | null;
  readonly retry_node_id: string | null;
  readonly retry_scope: string | null;
  readonly alternative_group_id: string | null;
  readonly alternative_label: string | null;
  readonly execution_context_json: string | null;
  readonly report_artifact_id: string | null;
}

interface WorkflowNodeRunRow {
  readonly id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly state: string;
  readonly attempt: number;
  readonly input_hash: string;
  readonly idempotency_key: string;
  readonly evidence_json: string;
  readonly failure_reason: NodeRunSnapshot["failureReason"];
}

interface RunEventRow {
  readonly id: string;
  readonly run_id: string;
  readonly node_run_id: string | null;
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: number;
  readonly schema_version: string;
  readonly payload_json: string;
}

export interface WorkflowRunListInput {
  readonly state?: RunState;
  readonly limit?: number;
}

export class SqliteWorkflowRunStore implements RunStore {
  private readonly sqlite: Database.Database;
  private readonly eventListeners = new Set<(event: RunEvent) => void>();
  private closed = false;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public async createRun(
    snapshot: WorkflowRunSnapshot,
    workflow: Workflow,
    event: RunEvent
  ): Promise<void> {
    this.requireOpen();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO workflow_definitions
            (id, version, name, definition_json, definition_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          workflow.id,
          workflow.schema_version,
          workflow.name,
          JSON.stringify(workflow),
          snapshot.workflowHash,
          Date.now()
        );
      this.insertRun(snapshot, workflow);
      this.insertEvent(event);
    })();
    this.publish(event);
  }

  public async saveRun(snapshot: WorkflowRunSnapshot): Promise<void> {
    this.requireOpen();
    this.updateRun(snapshot);
  }

  public async saveRunWithEvent(snapshot: WorkflowRunSnapshot, event: RunEvent): Promise<void> {
    this.requireOpen();
    this.sqlite.transaction(() => {
      this.updateRun(snapshot);
      this.insertEvent(event);
    })();
    this.publish(event);
  }

  public async saveNodeRun(snapshot: NodeRunSnapshot): Promise<void> {
    this.requireOpen();
    this.upsertNodeRun(snapshot);
  }

  public async saveNodeRunWithEvent(snapshot: NodeRunSnapshot, event: RunEvent): Promise<void> {
    this.requireOpen();
    this.sqlite.transaction(() => {
      this.upsertNodeRun(snapshot);
      this.insertEvent(event);
    })();
    this.publish(event);
  }

  public async appendEvent(event: RunEvent): Promise<void> {
    this.requireOpen();
    this.sqlite.transaction(() => this.insertEvent(event))();
    this.publish(event);
  }

  public recoverInterruptedRuns(at = new Date()): number {
    this.requireOpen();
    const events: RunEvent[] = [];
    const recovered = this.sqlite.transaction(() => {
      const recoverableRuns = this.sqlite
        .prepare(
          `SELECT id FROM workflow_runs
           WHERE state IN ('created', 'running', 'paused', 'waiting')
           ORDER BY id ASC`
        )
        .all() as readonly { readonly id: string }[];
      const result = this.sqlite
        .prepare(
          `UPDATE workflow_runs
           SET state = 'interrupted', ended_at = ?, updated_at = ?
           WHERE state IN ('created', 'running', 'paused', 'waiting')`
        )
        .run(at.getTime(), at.getTime());
      this.sqlite
        .prepare(
          `UPDATE workflow_node_runs
           SET state = 'interrupted', failure_reason = 'unknown_error', updated_at = ?
           WHERE state IN ('ready', 'starting', 'running', 'waiting')`
        )
        .run(at.getTime());
      for (const run of recoverableRuns) {
        const lastSequence = this.sqlite
          .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?")
          .get(run.id) as { readonly sequence: number };
        const event: RunEvent = {
          id: `recovery-${run.id}-${at.getTime()}`,
          runId: run.id,
          nodeRunId: null,
          type: "run.interrupted",
          timestamp: at.toISOString(),
          schemaVersion: "1.0",
          sequence: lastSequence.sequence + 1,
          payload: { reason: "runtime_restart" }
        };
        this.insertEvent(event);
        events.push(event);
      }
      return result.changes;
    })();
    for (const event of events) this.publish(event);
    return recovered;
  }

  /** Subscribes the desktop host to committed transitions without exposing database access. */
  public subscribe(listener: (event: RunEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public getEventPayloads(runId: string): readonly string[] {
    const rows = this.sqlite
      .prepare("SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as { readonly payload_json: string }[];
    return rows.map((row) => row.payload_json);
  }

  /** Reads the immutable persisted snapshot; this never exposes database internals to callers. */
  public get(runId: string): WorkflowRunSnapshot | null {
    const row = this.sqlite.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as
      WorkflowRunRow | undefined;
    return row === undefined ? null : this.toRunSnapshot(row);
  }

  /** Returns the validated persisted definition only to the desktop scheduler for a manual retry. */
  public getWorkflow(runId: string): Workflow | null {
    const row = this.sqlite
      .prepare("SELECT workflow_snapshot_json FROM workflow_runs WHERE id = ?")
      .get(runId) as { readonly workflow_snapshot_json: string } | undefined;
    if (row === undefined) return null;
    return workflowSchema.parse(parseJson(row.workflow_snapshot_json, "workflow snapshot"));
  }

  public list(input: WorkflowRunListInput = {}): readonly WorkflowRunSnapshot[] {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Workflow run list limit must be between 1 and 500");
    }
    if (input.state !== undefined && !runStates.has(input.state)) {
      throw new Error("Workflow run state is invalid");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM workflow_runs WHERE (? IS NULL OR state = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(input.state ?? null, input.state ?? null, limit) as WorkflowRunRow[];
    return rows.map((row) => this.toRunSnapshot(row));
  }

  /** Lists only manually created alternatives from one source run/node without exposing workflow internals. */
  public listAlternatives(sourceRunId: string, nodeId: string): readonly WorkflowRunSnapshot[] {
    if (!isSafeId(sourceRunId) || !isSafeId(nodeId)) {
      throw new Error("Workflow alternative reference is invalid");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM workflow_runs WHERE alternative_group_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(alternativeGroupId(sourceRunId, nodeId)) as WorkflowRunRow[];
    return rows.map((row) => this.toRunSnapshot(row));
  }

  public listEvents(runId: string, limit = 500): readonly RunEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) {
      throw new Error("Workflow run event limit must be between 1 and 2000");
    }
    if (this.get(runId) === null) throw new Error("Workflow run was not found");
    const rows = this.sqlite
      .prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?`)
      .all(runId, limit) as RunEventRow[];
    return rows.map(toRunEvent);
  }

  /** Idempotent. Once closed the store refuses every write, so a late transition fails loudly
   * instead of being lost against a closed database. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.eventListeners.clear();
    this.sqlite.close();
  }

  public isClosed(): boolean {
    return this.closed;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Workflow run store is closed");
  }

  private insertRun(snapshot: WorkflowRunSnapshot, workflow: Workflow): void {
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO workflow_runs
          (id, workflow_id, workflow_version, workflow_hash, input_hash,
           workflow_snapshot_json, effective_permissions_json, state, dry_run,
           concurrency, started_at, ended_at, retry_of_run_id, retry_node_id, retry_scope,
           alternative_group_id, alternative_label, execution_context_json, report_artifact_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.workflowId,
        snapshot.workflowVersion,
        snapshot.workflowHash,
        snapshot.inputHash,
        JSON.stringify(workflow),
        JSON.stringify(snapshot.effectivePermissions),
        snapshot.state,
        snapshot.dryRun ? 1 : 0,
        snapshot.concurrency,
        toMilliseconds(snapshot.startedAt),
        toMilliseconds(snapshot.endedAt),
        snapshot.lineage?.sourceRunId ?? null,
        snapshot.lineage?.nodeId ?? null,
        snapshot.lineage?.scope ?? null,
        snapshot.lineage?.alternativeGroupId ?? null,
        snapshot.lineage?.alternativeLabel ?? null,
        serializeExecutionContext(snapshot.executionContext ?? null),
        snapshot.reportArtifact?.id ?? null,
        now,
        now
      );
  }

  private updateRun(snapshot: WorkflowRunSnapshot): void {
    this.sqlite
      .prepare(
        `UPDATE workflow_runs SET
          state = ?, started_at = ?, ended_at = ?, execution_context_json = ?,
          report_artifact_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        snapshot.state,
        toMilliseconds(snapshot.startedAt),
        toMilliseconds(snapshot.endedAt),
        serializeExecutionContext(snapshot.executionContext ?? null),
        snapshot.reportArtifact?.id ?? null,
        Date.now(),
        snapshot.id
      );
  }

  private upsertNodeRun(snapshot: NodeRunSnapshot): void {
    this.sqlite
      .prepare(
        `INSERT INTO workflow_node_runs
          (id, run_id, node_id, state, attempt, input_hash, idempotency_key,
           evidence_json, failure_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           attempt = excluded.attempt,
           input_hash = excluded.input_hash,
           idempotency_key = excluded.idempotency_key,
           evidence_json = excluded.evidence_json,
           failure_reason = excluded.failure_reason,
           updated_at = excluded.updated_at`
      )
      .run(
        snapshot.id,
        snapshot.runId,
        snapshot.nodeId,
        snapshot.state,
        snapshot.attempt,
        snapshot.inputHash,
        snapshot.idempotencyKey,
        JSON.stringify(redactValue(snapshot.evidence)),
        snapshot.failureReason,
        Date.now()
      );
  }

  private insertEvent(event: RunEvent): void {
    this.sqlite
      .prepare(
        `INSERT INTO run_events
          (id, run_id, node_run_id, sequence, type, timestamp, schema_version, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.runId,
        event.nodeRunId,
        event.sequence,
        event.type,
        new Date(event.timestamp).getTime(),
        event.schemaVersion,
        serializeEventPayload(event.payload)
      );

    if (event.type === "approval.requested" && event.nodeRunId !== null) {
      this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO approvals
            (id, run_id, node_run_id, state, requested_at)
           VALUES (?, ?, ?, 'pending', ?)`
        )
        .run(`approval-${event.nodeRunId}`, event.runId, event.nodeRunId, Date.now());
    }
    if (event.type === "approval.resolved" && event.nodeRunId !== null) {
      this.sqlite
        .prepare(
          `UPDATE approvals SET state = ?, decision_note = ?, resolved_at = ?
           WHERE run_id = ? AND node_run_id = ? AND state = 'pending'`
        )
        .run(
          event.payload.approved === true ? "approved" : "denied",
          typeof event.payload.note === "string" ? event.payload.note : "",
          Date.now(),
          event.runId,
          event.nodeRunId
        );
    }
  }

  private publish(event: RunEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // The durable event was committed; an observer failure must not affect the scheduler.
      }
    }
  }

  private toRunSnapshot(row: WorkflowRunRow): WorkflowRunSnapshot {
    const nodes = this.sqlite
      .prepare("SELECT * FROM workflow_node_runs WHERE run_id = ? ORDER BY node_id ASC")
      .all(row.id) as WorkflowNodeRunRow[];
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowVersion: row.workflow_version,
      workflowHash: row.workflow_hash,
      inputHash: row.input_hash,
      effectivePermissions: permissionMapSchema.parse(
        parseJson(row.effective_permissions_json, "Workflow run permissions")
      ) as PermissionMap,
      state: requireRunState(row.state),
      dryRun: row.dry_run === 1,
      concurrency: row.concurrency,
      startedAt: toIsoTimestamp(row.started_at),
      endedAt: toIsoTimestamp(row.ended_at),
      lineage: parseLineage(row),
      executionContext: parseExecutionContext(row.execution_context_json) ?? null,
      nodeRuns: nodes.map(toNodeRunSnapshot),
      reportArtifact: this.getReportArtifact(row.report_artifact_id)
    };
  }

  private getReportArtifact(artifactId: string | null): ArtifactReference | null {
    if (artifactId === null) return null;
    const row = this.sqlite
      .prepare(`SELECT id, type, relative_path, sha256, media_type FROM artifacts WHERE id = ?`)
      .get(artifactId) as
      | {
          readonly id: string;
          readonly type: string;
          readonly relative_path: string;
          readonly sha256: string;
          readonly media_type: string;
        }
      | undefined;
    if (row === undefined) throw new Error("Workflow run report artifact was not found");
    return artifactReferenceSchema.parse(row);
  }
}

function parseLineage(row: WorkflowRunRow): Exclude<WorkflowRunSnapshot["lineage"], undefined> {
  if (row.retry_of_run_id === null) return null;
  if (!isSafeId(row.retry_of_run_id)) throw new Error("Workflow run lineage is invalid");
  if (row.retry_node_id !== null && !isSafeId(row.retry_node_id)) {
    throw new Error("Workflow run lineage is invalid");
  }
  if (row.retry_scope !== "run" && row.retry_scope !== "node" && row.retry_scope !== "dependents") {
    throw new Error("Workflow run lineage is invalid");
  }
  if (
    row.alternative_group_id !== null &&
    !/^alternative:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(row.alternative_group_id)
  ) {
    throw new Error("Workflow alternative group is invalid");
  }
  if (
    row.alternative_label !== null &&
    (row.alternative_label.length < 1 || row.alternative_label.length > 120)
  ) {
    throw new Error("Workflow alternative label is invalid");
  }
  return {
    sourceRunId: row.retry_of_run_id,
    nodeId: row.retry_node_id,
    scope: row.retry_scope,
    alternativeGroupId: row.alternative_group_id,
    alternativeLabel: row.alternative_label
  };
}

function alternativeGroupId(sourceRunId: string, nodeId: string): string {
  return `alternative:${sourceRunId}:${nodeId}`;
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function serializeExecutionContext(value: WorkflowRunSnapshot["executionContext"]): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseExecutionContext(value: string | null): WorkflowRunSnapshot["executionContext"] {
  if (value === null) return null;
  return workflowRunExecutionContextSchema.parse(
    parseJson(value, "Workflow run execution context")
  );
}

function serializeEventPayload(payload: Readonly<Record<string, unknown>>): string {
  const serialized = JSON.stringify(redactValue(payload));
  if (Buffer.byteLength(serialized, "utf8") <= maximumEventPayloadBytes) {
    return serialized;
  }
  return JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(serialized, "utf8") });
}

function toMilliseconds(value: string | null): number | null {
  return value === null ? null : new Date(value).getTime();
}

function toNodeRunSnapshot(row: WorkflowNodeRunRow): NodeRunSnapshot {
  if (!nodeRunStates.has(row.state as NodeRunSnapshot["state"])) {
    throw new Error("Workflow node run state is invalid");
  }
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    state: row.state as NodeRunSnapshot["state"],
    attempt: row.attempt,
    inputHash: row.input_hash,
    idempotencyKey: row.idempotency_key,
    evidence: parseEvidence(row.evidence_json),
    failureReason: row.failure_reason
  };
}

function toRunEvent(row: RunEventRow): RunEvent {
  if (!runEventTypes.has(row.type as RunEventType) || row.schema_version !== "1.0") {
    throw new Error("Workflow run event is invalid");
  }
  const payload = parseJson(row.payload_json, "Workflow run event payload");
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Workflow run event payload is invalid");
  }
  return {
    id: row.id,
    runId: row.run_id,
    nodeRunId: row.node_run_id,
    sequence: row.sequence,
    type: row.type as RunEventType,
    timestamp: new Date(row.timestamp).toISOString(),
    schemaVersion: "1.0",
    payload: payload as Readonly<Record<string, unknown>>
  };
}

function parseEvidence(value: string): readonly Evidence[] {
  const parsed = parseJson(value, "Workflow node evidence");
  if (!Array.isArray(parsed)) throw new Error("Workflow node evidence is invalid");
  return parsed.map((item) => evidenceSchema.parse(item));
}

function requireRunState(value: string): RunState {
  if (!runStates.has(value as RunState)) throw new Error("Workflow run state is invalid");
  return value as RunState;
}

function toIsoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}
