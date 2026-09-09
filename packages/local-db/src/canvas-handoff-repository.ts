import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  canTransitionCanvasHandoff,
  canvasHandoffEventSchema,
  canvasHandoffSchema,
  handoffApprovedContentSchema,
  handoffDraftContentSchema
} from "@forgedeck/schemas";
import type {
  CanvasHandoff,
  CanvasHandoffDeliveryAttempt,
  CanvasHandoffDeliveryAttemptStatus,
  CanvasHandoffEvent,
  CanvasHandoffEventType,
  CanvasHandoffStatus,
  HandoffApprovedContent,
  HandoffDraftContent,
  HandoffEdgeSnapshot,
  HandoffNodeSnapshot
} from "@forgedeck/schemas";

export interface CreateCanvasHandoffInput {
  readonly canvasId: string;
  readonly projectId: string;
  readonly mission: string;
  readonly source: HandoffNodeSnapshot;
  readonly target: HandoffNodeSnapshot;
  readonly edge: HandoffEdgeSnapshot;
  readonly content?: HandoffDraftContent;
}

interface HandoffRow {
  readonly id: string;
  readonly canvas_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly revision: number;
  readonly mission: string;
  readonly source_json: string;
  readonly target_json: string;
  readonly edge_json: string;
  readonly content_json: string;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly ready_at: number | null;
  readonly delivered_at: number | null;
}

interface HandoffEventRow {
  readonly id: string;
  readonly handoff_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly from_status: string | null;
  readonly to_status: string;
  readonly error: string | null;
  readonly delivery_attempt_id: string | null;
  readonly responsible: "system" | "local_user";
  readonly created_at: number;
}

interface HandoffAttemptRow {
  readonly id: string;
  readonly handoff_id: string;
  readonly sequence: number;
  readonly target_session_id: string | null;
  readonly adapter_id: string | null;
  readonly status: CanvasHandoffDeliveryAttemptStatus;
  readonly confirmation: "response_detected" | "manual_marked_sent" | null;
  readonly error: string | null;
  readonly responsible: "system" | "local_user";
  readonly created_at: number;
  readonly updated_at: number;
}

interface TransitionOptions {
  readonly expectedRevision: number;
  readonly from: CanvasHandoffStatus;
  readonly to: CanvasHandoffStatus;
  readonly eventType: CanvasHandoffEventType;
  readonly at?: Date;
  readonly error?: string | null;
  readonly content?: HandoffDraftContent;
  readonly deliveryAttemptId?: string | null;
  readonly responsible?: "system" | "local_user";
}

export class SqliteCanvasHandoffRepository {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly idFactory: () => string = randomUUID
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public createDraft(input: CreateCanvasHandoffInput, at = new Date()): CanvasHandoff {
    const id = this.idFactory();
    const content = handoffDraftContentSchema.parse(input.content ?? {});
    const record = canvasHandoffSchema.parse({
      id,
      canvasId: input.canvasId,
      projectId: input.projectId,
      status: "draft",
      revision: 1,
      mission: input.mission,
      source: input.source,
      target: input.target,
      edge: input.edge,
      content,
      error: null,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      readyAt: null,
      deliveredAt: null,
      deliveryAttempts: []
    });

    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO canvas_handoffs
             (id, canvas_id, project_id, status, revision, mission, source_json, target_json,
              edge_json, content_json, error, created_at, updated_at, ready_at, delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.canvasId,
          record.projectId,
          record.status,
          record.revision,
          record.mission,
          JSON.stringify(record.source),
          JSON.stringify(record.target),
          JSON.stringify(record.edge),
          JSON.stringify(record.content),
          null,
          at.getTime(),
          at.getTime(),
          null,
          null
        );
      this.insertEvent(record.id, "draft_created", null, "draft", null, null, "system", at);
    })();

    return record;
  }

  public get(handoffId: string): CanvasHandoff | null {
    const row = this.selectRow(handoffId);
    return row === undefined ? null : this.toHandoff(row);
  }

  public listByCanvas(canvasId: string, limit = 50): CanvasHandoff[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM canvas_handoffs
         WHERE canvas_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(canvasId, boundedLimit) as HandoffRow[];
    return rows.map((row) => this.toHandoff(row));
  }

  public listEvents(handoffId: string): CanvasHandoffEvent[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM canvas_handoff_events
         WHERE handoff_id = ?
         ORDER BY sequence ASC`
      )
      .all(handoffId) as HandoffEventRow[];
    return rows.map(toHandoffEvent);
  }

  public updateDraft(
    handoffId: string,
    expectedRevision: number,
    content: HandoffDraftContent,
    at = new Date()
  ): CanvasHandoff {
    return this.transition(handoffId, {
      expectedRevision,
      from: "draft",
      to: "draft",
      eventType: "draft_updated",
      content: handoffDraftContentSchema.parse(content),
      at
    });
  }

  public markReady(
    handoffId: string,
    expectedRevision: number,
    content: HandoffApprovedContent,
    at = new Date()
  ): CanvasHandoff {
    return this.transition(handoffId, {
      expectedRevision,
      from: "draft",
      to: "ready",
      eventType: "handoff_ready",
      content: handoffApprovedContentSchema.parse(content),
      at
    });
  }

  /** Rejection preserves the reviewed draft and records a distinct auditable decision. */
  public reject(
    handoffId: string,
    expectedRevision: number,
    reason: string,
    at = new Date()
  ): CanvasHandoff {
    if (reason.trim().length < 1 || reason.length > 2_000) {
      throw new Error("Canvas handoff rejection reason is invalid");
    }
    return this.transition(handoffId, {
      expectedRevision,
      from: "draft",
      to: "rejected",
      eventType: "handoff_rejected",
      error: reason.trim(),
      responsible: "local_user",
      at
    });
  }

  public beginDelivery(
    handoffId: string,
    expectedRevision: number,
    input: { readonly targetSessionId: string; readonly adapterId: string },
    at = new Date()
  ): CanvasHandoff {
    const attemptId = this.idFactory();
    return this.sqlite.transaction(() => {
      const sequence = this.nextAttemptSequence(handoffId);
      this.sqlite
        .prepare(
          `INSERT INTO canvas_handoff_delivery_attempts
             (id, handoff_id, sequence, target_session_id, adapter_id, status, confirmation,
              error, responsible, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          attemptId,
          handoffId,
          sequence,
          input.targetSessionId,
          input.adapterId,
          "submitting",
          null,
          null,
          "system",
          at.getTime(),
          at.getTime()
        );
      return this.transition(handoffId, {
        expectedRevision,
        from: "ready",
        to: "submitting",
        eventType: "delivery_attempt_started",
        deliveryAttemptId: attemptId,
        at
      });
    })();
  }

  public markWrittenToTerminal(
    handoffId: string,
    expectedRevision: number,
    deliveryAttemptId: string,
    at = new Date()
  ): CanvasHandoff {
    return this.transitionAttempt(handoffId, expectedRevision, deliveryAttemptId, {
      from: "submitting",
      to: "written_to_terminal",
      eventType: "written_to_terminal",
      attemptStatus: "written_to_terminal",
      at
    });
  }

  public markSubmittedToAgent(
    handoffId: string,
    expectedRevision: number,
    deliveryAttemptId: string,
    at = new Date()
  ): CanvasHandoff {
    return this.transitionAttempt(handoffId, expectedRevision, deliveryAttemptId, {
      from: "written_to_terminal",
      to: "submitted_to_agent",
      eventType: "submitted_to_agent",
      attemptStatus: "submitted_to_agent",
      at
    });
  }

  public markDelivered(
    handoffId: string,
    expectedRevision: number,
    deliveryAttemptId: string,
    at = new Date()
  ): CanvasHandoff {
    return this.transitionAttempt(handoffId, expectedRevision, deliveryAttemptId, {
      from: "submitted_to_agent",
      to: "delivered",
      eventType: "response_detected",
      attemptStatus: "response_detected",
      confirmation: "response_detected",
      at
    });
  }

  public markAwaitingDestination(
    handoffId: string,
    expectedRevision: number,
    error: string,
    at = new Date()
  ): CanvasHandoff {
    return this.transition(handoffId, {
      expectedRevision,
      from: "ready",
      to: "awaiting_destination",
      eventType: "destination_unavailable",
      error,
      at
    });
  }

  public markFailed(
    handoffId: string,
    expectedRevision: number,
    deliveryAttemptId: string | null,
    error: string,
    at = new Date()
  ): CanvasHandoff {
    const current = this.requireRow(handoffId);
    if (deliveryAttemptId === null) {
      return this.transition(handoffId, {
        expectedRevision,
        from: current.status as CanvasHandoffStatus,
        to: "failed",
        eventType: "delivery_failed",
        error,
        at
      });
    }
    return this.transitionAttempt(handoffId, expectedRevision, deliveryAttemptId, {
      from: current.status as CanvasHandoffStatus,
      to: "failed",
      eventType: "delivery_failed",
      attemptStatus: "failed",
      error,
      at
    });
  }

  public markDeliveryUnknown(
    handoffId: string,
    expectedRevision: number,
    deliveryAttemptId: string | null,
    error: string,
    at = new Date()
  ): CanvasHandoff {
    const current = this.requireRow(handoffId);
    if (deliveryAttemptId === null) {
      return this.transition(handoffId, {
        expectedRevision,
        from: current.status as CanvasHandoffStatus,
        to: "delivery_unknown",
        eventType: "delivery_unknown",
        error,
        at
      });
    }
    return this.transitionAttempt(handoffId, expectedRevision, deliveryAttemptId, {
      from: current.status as CanvasHandoffStatus,
      to: "delivery_unknown",
      eventType: "delivery_unknown",
      attemptStatus: "delivery_unknown",
      error,
      at
    });
  }

  public markSentManually(
    handoffId: string,
    expectedRevision: number,
    deliveryAttemptId: string,
    at = new Date()
  ): CanvasHandoff {
    return this.transitionAttempt(handoffId, expectedRevision, deliveryAttemptId, {
      from: "delivery_unknown",
      to: "delivered",
      eventType: "delivery_marked_sent",
      attemptStatus: "manually_marked_sent",
      confirmation: "manual_marked_sent",
      responsible: "local_user",
      at
    });
  }

  public cancelDelivery(
    handoffId: string,
    expectedRevision: number,
    at = new Date()
  ): CanvasHandoff {
    const current = this.requireRow(handoffId);
    if (
      current.status !== "ready" &&
      current.status !== "awaiting_destination" &&
      current.status !== "failed" &&
      current.status !== "delivery_unknown"
    ) {
      throw new Error(`Canvas handoff cannot cancel from ${current.status}`);
    }
    return this.sqlite.transaction(() => {
      const latestAttempt = this.latestAttempt(handoffId);
      this.transition(handoffId, {
        expectedRevision,
        from: current.status as CanvasHandoffStatus,
        to: "cancelled",
        eventType: "delivery_cancelled",
        deliveryAttemptId: latestAttempt?.id ?? null,
        responsible: "local_user",
        at
      });
      if (latestAttempt !== null) {
        this.updateAttempt(latestAttempt.id, "cancelled", null, null, "local_user", at);
      }
      return this.toHandoff(this.requireRow(handoffId));
    })();
  }

  public requestRetry(handoffId: string, expectedRevision: number, at = new Date()): CanvasHandoff {
    const current = this.requireRow(handoffId);
    if (
      current.status !== "failed" &&
      current.status !== "delivery_unknown" &&
      current.status !== "cancelled" &&
      current.status !== "awaiting_destination" &&
      current.status !== "rejected"
    ) {
      throw new Error(`Canvas handoff cannot retry from ${current.status}`);
    }
    return this.transition(handoffId, {
      expectedRevision,
      from: current.status,
      to: current.status === "rejected" ? "draft" : "ready",
      eventType: "retry_requested",
      error: null,
      at
    });
  }

  public recoverDeliveries(at = new Date()): number {
    const rows = this.sqlite
      .prepare(
        `SELECT id, revision FROM canvas_handoffs
         WHERE status IN ('delivering', 'submitting', 'written_to_terminal', 'submitted_to_agent')`
      )
      .all() as { readonly id: string; readonly revision: number }[];
    for (const row of rows) {
      const attempt = this.latestAttempt(row.id);
      this.transition(row.id, {
        expectedRevision: row.revision,
        from: this.requireRow(row.id).status as CanvasHandoffStatus,
        to: "delivery_unknown",
        eventType: "delivery_unknown",
        deliveryAttemptId: attempt?.id ?? null,
        error: "Delivery state is unknown after application restart",
        at
      });
      if (attempt !== null) {
        this.updateAttempt(attempt.id, "delivery_unknown", null, null, undefined, at);
      }
    }
    return rows.length;
  }

  public close(): void {
    this.sqlite.close();
  }

  private transitionAttempt(
    handoffId: string,
    expectedRevision: number,
    deliveryAttemptId: string,
    options: {
      readonly from: CanvasHandoffStatus;
      readonly to: CanvasHandoffStatus;
      readonly eventType: CanvasHandoffEventType;
      readonly attemptStatus: CanvasHandoffDeliveryAttemptStatus;
      readonly confirmation?: "response_detected" | "manual_marked_sent" | null;
      readonly error?: string | null;
      readonly responsible?: "system" | "local_user";
      readonly at: Date;
    }
  ): CanvasHandoff {
    return this.sqlite.transaction(() => {
      this.requireAttempt(deliveryAttemptId, handoffId);
      this.updateAttempt(
        deliveryAttemptId,
        options.attemptStatus,
        options.confirmation ?? null,
        options.error ?? null,
        options.responsible,
        options.at
      );
      return this.transition(handoffId, {
        expectedRevision,
        from: options.from,
        to: options.to,
        eventType: options.eventType,
        deliveryAttemptId,
        error: options.error ?? null,
        ...(options.responsible === undefined ? {} : { responsible: options.responsible }),
        at: options.at
      });
    })();
  }

  private transition(handoffId: string, options: TransitionOptions): CanvasHandoff {
    if (options.from !== options.to && !canTransitionCanvasHandoff(options.from, options.to)) {
      throw new Error(`Invalid canvas handoff transition: ${options.from} -> ${options.to}`);
    }
    const at = options.at ?? new Date();
    return this.sqlite.transaction(() => {
      const current = this.requireRow(handoffId);
      if (current.revision !== options.expectedRevision) {
        throw new Error(
          `Canvas handoff revision conflict: expected ${current.revision}, received ${options.expectedRevision}`
        );
      }
      if (current.status !== options.from) {
        throw new Error(
          `Canvas handoff state conflict: expected ${options.from}, found ${current.status}`
        );
      }
      const nextRevision = current.revision + 1;
      const contentJson =
        options.content === undefined ? current.content_json : JSON.stringify(options.content);
      const readyAt = options.to === "ready" ? at.getTime() : current.ready_at;
      const deliveredAt = options.to === "delivered" ? at.getTime() : current.delivered_at;
      const result = this.sqlite
        .prepare(
          `UPDATE canvas_handoffs
           SET status = ?, revision = ?, content_json = ?, error = ?, updated_at = ?,
               ready_at = ?, delivered_at = ?
           WHERE id = ? AND revision = ? AND status = ?`
        )
        .run(
          options.to,
          nextRevision,
          contentJson,
          options.error ?? null,
          at.getTime(),
          readyAt,
          deliveredAt,
          handoffId,
          options.expectedRevision,
          options.from
        );
      if (result.changes !== 1) {
        throw new Error("Canvas handoff update lost a concurrent race");
      }
      this.insertEvent(
        handoffId,
        options.eventType,
        options.from,
        options.to,
        options.error ?? null,
        options.deliveryAttemptId ?? null,
        options.responsible ?? "system",
        at
      );
      return this.toHandoff(this.requireRow(handoffId));
    })();
  }

  private insertEvent(
    handoffId: string,
    type: CanvasHandoffEventType,
    fromStatus: CanvasHandoffStatus | null,
    toStatus: CanvasHandoffStatus,
    error: string | null,
    deliveryAttemptId: string | null,
    responsible: "system" | "local_user",
    at: Date
  ): void {
    const sequenceRow = this.sqlite
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM canvas_handoff_events WHERE handoff_id = ?"
      )
      .get(handoffId) as { readonly sequence: number };
    this.sqlite
      .prepare(
        `INSERT INTO canvas_handoff_events
           (id, handoff_id, sequence, type, from_status, to_status, error, delivery_attempt_id,
            responsible, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.idFactory(),
        handoffId,
        sequenceRow.sequence,
        type,
        fromStatus,
        toStatus,
        error,
        deliveryAttemptId,
        responsible,
        at.getTime()
      );
  }

  private nextAttemptSequence(handoffId: string): number {
    const row = this.sqlite
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM canvas_handoff_delivery_attempts WHERE handoff_id = ?"
      )
      .get(handoffId) as { readonly sequence: number };
    return row.sequence;
  }

  private latestAttempt(handoffId: string): HandoffAttemptRow | null {
    return (
      (this.sqlite
        .prepare(
          `SELECT * FROM canvas_handoff_delivery_attempts
           WHERE handoff_id = ? ORDER BY sequence DESC LIMIT 1`
        )
        .get(handoffId) as HandoffAttemptRow | undefined) ?? null
    );
  }

  private listAttempts(handoffId: string): CanvasHandoffDeliveryAttempt[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM canvas_handoff_delivery_attempts
         WHERE handoff_id = ? ORDER BY sequence ASC`
      )
      .all(handoffId) as HandoffAttemptRow[];
    return rows.map(toHandoffAttempt);
  }

  private requireAttempt(attemptId: string, handoffId: string): HandoffAttemptRow {
    const row = this.sqlite
      .prepare("SELECT * FROM canvas_handoff_delivery_attempts WHERE id = ? AND handoff_id = ?")
      .get(attemptId, handoffId) as HandoffAttemptRow | undefined;
    if (row === undefined) throw new Error("Canvas handoff delivery attempt not found");
    return row;
  }

  private updateAttempt(
    attemptId: string,
    status: CanvasHandoffDeliveryAttemptStatus,
    confirmation: "response_detected" | "manual_marked_sent" | null,
    error: string | null,
    responsible: "system" | "local_user" | undefined,
    at: Date
  ): void {
    const result = this.sqlite
      .prepare(
        `UPDATE canvas_handoff_delivery_attempts
         SET status = ?, confirmation = ?, error = ?, responsible = COALESCE(?, responsible),
             updated_at = ? WHERE id = ?`
      )
      .run(status, confirmation, error, responsible, at.getTime(), attemptId);
    if (result.changes !== 1) throw new Error("Canvas handoff delivery attempt update was lost");
  }

  private toHandoff(row: HandoffRow): CanvasHandoff {
    return toHandoff(row, this.listAttempts(row.id));
  }

  private requireRow(handoffId: string): HandoffRow {
    const row = this.selectRow(handoffId);
    if (row === undefined) {
      throw new Error("Canvas handoff not found");
    }
    return row;
  }

  private selectRow(handoffId: string): HandoffRow | undefined {
    return this.sqlite.prepare("SELECT * FROM canvas_handoffs WHERE id = ?").get(handoffId) as
      HandoffRow | undefined;
  }
}

function toHandoff(
  row: HandoffRow,
  deliveryAttempts: readonly CanvasHandoffDeliveryAttempt[]
): CanvasHandoff {
  return canvasHandoffSchema.parse({
    id: row.id,
    canvasId: row.canvas_id,
    projectId: row.project_id,
    status: row.status,
    revision: row.revision,
    mission: row.mission,
    source: parseJson(row.source_json),
    target: parseJson(row.target_json),
    edge: parseJson(row.edge_json),
    content: parseJson(row.content_json),
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    readyAt: row.ready_at === null ? null : new Date(row.ready_at).toISOString(),
    deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at).toISOString(),
    deliveryAttempts
  });
}

function toHandoffEvent(row: HandoffEventRow): CanvasHandoffEvent {
  return canvasHandoffEventSchema.parse({
    id: row.id,
    handoffId: row.handoff_id,
    sequence: row.sequence,
    type: row.type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    error: row.error,
    deliveryAttemptId: row.delivery_attempt_id,
    responsible: row.responsible,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function toHandoffAttempt(row: HandoffAttemptRow): CanvasHandoffDeliveryAttempt {
  return {
    id: row.id,
    handoffId: row.handoff_id,
    sequence: row.sequence,
    targetSessionId: row.target_session_id,
    adapterId: row.adapter_id,
    status: row.status,
    confirmation: row.confirmation,
    error: row.error,
    responsible: row.responsible,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Stored canvas handoff JSON is invalid");
  }
}
