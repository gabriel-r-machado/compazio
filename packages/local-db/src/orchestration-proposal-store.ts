import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { orchestrationProposalEventSchema, orchestrationProposalSchema } from "@forgedeck/schemas";
import type {
  AutonomyLevel,
  OrchestrationProposalDraft,
  OrchestrationProposal,
  OrchestrationProposalEvent,
  OrchestrationProposalEventType
} from "@forgedeck/schemas";

interface ProposalRow {
  readonly proposal_json: string;
  readonly revision: number;
  readonly created_by: string;
  readonly reviewed_by: string | null;
}

interface ProposalEventRow {
  readonly id: string;
  readonly proposal_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly actor: string;
  readonly details_json: string | null;
  readonly created_at: number;
}

export type CreateOrchestrationProposal = OrchestrationProposalDraft;

export interface UpdateOrchestrationProposal {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly draft: CreateOrchestrationProposal;
}

export interface ReviewOrchestrationProposal {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly expectedRevision: number;
}

/**
 * Local, proposal-only orchestration state. Approval is auditable metadata: execution remains
 * an explicit later action through the existing Compasso runtime.
 */
export class SqliteOrchestrationProposalStore {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public create(input: CreateOrchestrationProposal): OrchestrationProposal {
    this.requireWorkspace(input.workspaceId);
    const timestamp = this.now().toISOString();
    const proposal = orchestrationProposalSchema.parse({
      ...input,
      id: this.createId(),
      status: "draft",
      checksum: checksum(input),
      revision: 1,
      createdBy: "local-user",
      reviewedBy: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      approvedAt: null,
      rejectedAt: null
    });
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO orchestration_proposals
           (id, workspace_id, status, autonomy_level, proposal_json, checksum, revision, created_by, reviewed_by, created_at, updated_at, approved_at, rejected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)`
        )
        .run(
          proposal.id,
          proposal.workspaceId,
          proposal.status,
          proposal.autonomyLevel,
          JSON.stringify(proposal),
          proposal.checksum,
          proposal.revision,
          proposal.createdBy,
          Date.parse(proposal.createdAt),
          Date.parse(proposal.updatedAt)
        );
      this.recordEvent(proposal.id, "created", timestamp, "Proposal draft created");
    })();
    return proposal;
  }

  public get(workspaceId: string, proposalId: string): OrchestrationProposal {
    const row = this.sqlite
      .prepare(
        `SELECT proposal_json, revision, created_by, reviewed_by FROM orchestration_proposals
         WHERE id = ? AND workspace_id = ?`
      )
      .get(proposalId, workspaceId) as ProposalRow | undefined;
    if (row === undefined) throw new Error("Orchestration proposal was not found");
    return parseProposal(row);
  }

  public list(workspaceId: string, limit = 50): readonly OrchestrationProposal[] {
    this.requireWorkspace(workspaceId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Proposal limit is invalid");
    return (
      this.sqlite
        .prepare(
          `SELECT proposal_json, revision, created_by, reviewed_by FROM orchestration_proposals WHERE workspace_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`
        )
        .all(workspaceId, limit) as ProposalRow[]
    ).map(parseProposal);
  }

  public listEvents(
    workspaceId: string,
    proposalId: string
  ): readonly OrchestrationProposalEvent[] {
    this.get(workspaceId, proposalId);
    return (
      this.sqlite
        .prepare(
          `SELECT id, proposal_id, sequence, type, actor, details_json, created_at
           FROM orchestration_proposal_events WHERE proposal_id = ? ORDER BY sequence`
        )
        .all(proposalId) as ProposalEventRow[]
    ).map((row) =>
      orchestrationProposalEventSchema.parse({
        id: row.id,
        proposalId: row.proposal_id,
        sequence: row.sequence,
        type: row.type,
        actor: row.actor,
        details: row.details_json,
        createdAt: new Date(row.created_at).toISOString()
      })
    );
  }

  public updateDraft(input: UpdateOrchestrationProposal): OrchestrationProposal {
    const current = this.get(input.workspaceId, input.proposalId);
    if (current.status !== "draft") throw new Error("Only draft proposals can be edited");
    if (current.revision !== input.expectedRevision) {
      throw new Error("Orchestration proposal revision conflict");
    }
    if (input.draft.workspaceId !== input.workspaceId) {
      throw new Error("Orchestration proposal workspace cannot be changed");
    }
    const timestamp = this.now().toISOString();
    const next = orchestrationProposalSchema.parse({
      ...input.draft,
      id: current.id,
      status: "draft",
      checksum: checksum(input.draft),
      revision: current.revision + 1,
      createdBy: current.createdBy,
      reviewedBy: null,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      approvedAt: null,
      rejectedAt: null
    });
    return this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE orchestration_proposals
           SET autonomy_level = ?, proposal_json = ?, checksum = ?, revision = ?, reviewed_by = NULL, updated_at = ?, approved_at = NULL, rejected_at = NULL
           WHERE id = ? AND workspace_id = ? AND status = 'draft' AND revision = ?`
        )
        .run(
          next.autonomyLevel,
          JSON.stringify(next),
          next.checksum,
          next.revision,
          Date.parse(next.updatedAt),
          next.id,
          next.workspaceId,
          current.revision
        );
      if (result.changes !== 1) throw new Error("Orchestration proposal revision conflict");
      this.recordEvent(next.id, "updated", timestamp, `Draft revised to revision ${next.revision}`);
      return next;
    })();
  }

  public approve(input: ReviewOrchestrationProposal): OrchestrationProposal {
    return this.transition(input, "approved");
  }

  public reject(input: ReviewOrchestrationProposal): OrchestrationProposal {
    return this.transition(input, "rejected");
  }

  public close(): void {
    this.sqlite.close();
  }

  private transition(
    input: ReviewOrchestrationProposal,
    status: "approved" | "rejected"
  ): OrchestrationProposal {
    const current = this.get(input.workspaceId, input.proposalId);
    if (current.status !== "draft") throw new Error("Only draft proposals can be reviewed");
    if (current.revision !== input.expectedRevision) {
      throw new Error("Orchestration proposal revision conflict");
    }
    const timestamp = this.now().toISOString();
    const next = orchestrationProposalSchema.parse({
      ...current,
      status,
      revision: current.revision + 1,
      reviewedBy: "local-user",
      updatedAt: timestamp,
      approvedAt: status === "approved" ? timestamp : null,
      rejectedAt: status === "rejected" ? timestamp : null
    });
    return this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE orchestration_proposals
           SET status = ?, proposal_json = ?, revision = ?, reviewed_by = ?, updated_at = ?, approved_at = ?, rejected_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'draft' AND revision = ?`
        )
        .run(
          next.status,
          JSON.stringify(next),
          next.revision,
          next.reviewedBy,
          Date.parse(next.updatedAt),
          next.approvedAt === null ? null : Date.parse(next.approvedAt),
          next.rejectedAt === null ? null : Date.parse(next.rejectedAt),
          input.proposalId,
          input.workspaceId,
          current.revision
        );
      if (result.changes !== 1)
        throw new Error("Orchestration proposal review lost a concurrent race");
      this.recordEvent(next.id, status, timestamp, `Proposal ${status}`);
      return next;
    })();
  }

  private recordEvent(
    proposalId: string,
    type: OrchestrationProposalEventType,
    timestamp: string,
    details: string
  ): void {
    const sequence =
      (
        this.sqlite
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_proposal_events WHERE proposal_id = ?"
          )
          .get(proposalId) as { readonly sequence: number }
      ).sequence + 1;
    this.sqlite
      .prepare(
        `INSERT INTO orchestration_proposal_events
         (id, proposal_id, sequence, type, actor, details_json, created_at)
         VALUES (?, ?, ?, ?, 'local-user', ?, ?)`
      )
      .run(randomUUID(), proposalId, sequence, type, details, Date.parse(timestamp));
  }

  private requireWorkspace(workspaceId: string): void {
    const row = this.sqlite.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (row === undefined) throw new Error("Orchestration proposal workspace was not found");
  }
}

function checksum(input: CreateOrchestrationProposal): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function parseProposal(row: ProposalRow): OrchestrationProposal {
  return orchestrationProposalSchema.parse({
    ...(JSON.parse(row.proposal_json) as object),
    revision: row.revision,
    createdBy: row.created_by,
    reviewedBy: row.reviewed_by
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type { AutonomyLevel };
