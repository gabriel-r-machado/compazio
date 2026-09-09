import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  canvasNodeDataSchema,
  policyAuthorizationRequestSchema,
  policyDecisionSchema
} from "@forgedeck/schemas";
import type {
  AgentPermission,
  PolicyAuthorizationRequest,
  PolicyDecision,
  PolicyDecisionOutcome,
  PolicyDecisionReason
} from "@forgedeck/schemas";

interface WorkspaceRow {
  readonly canvas_id: string;
}

interface NodeRow {
  readonly type: string;
  readonly data_json: string;
}

interface DecisionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly canvas_id: string | null;
  readonly actor_node_id: string | null;
  readonly permission: string;
  readonly outcome: string;
  readonly reason: string;
  readonly created_at: number;
}

export interface SqlitePolicyEngineOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

/** A single deny-by-default authorization decision point for local agent actions. */
export class SqlitePolicyEngine {
  private readonly sqlite: Database.Database;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqlitePolicyEngineOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Writes an immutable decision for both allows and denies before returning control.
   * A null actor represents the authenticated local user; agents never receive an
   * operation that edits their own permission metadata.
   */
  public assertAllowed(input: PolicyAuthorizationRequest): PolicyDecision {
    const request = policyAuthorizationRequestSchema.parse(input);
    const workspace = this.sqlite
      .prepare("SELECT canvas_id FROM workspaces WHERE id = ?")
      .get(request.workspaceId) as WorkspaceRow | undefined;

    let outcome: PolicyDecisionOutcome = "denied";
    let reason: PolicyDecisionReason = "workspace_not_found";
    const canvasId: string | null = workspace?.canvas_id ?? null;

    if (workspace !== undefined && request.actorNodeId === null) {
      outcome = "allowed";
      reason = "local_user";
    } else if (workspace !== undefined && request.actorNodeId !== null) {
      const node = this.sqlite
        .prepare("SELECT type, data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
        .get(workspace.canvas_id, request.actorNodeId) as NodeRow | undefined;
      if (node === undefined || (node.type !== "agent" && node.type !== "terminal")) {
        reason = "actor_not_found";
      } else {
        const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
        if (data.adapterId === undefined || data.adapterId === "shell") {
          reason = "actor_not_agent_capable";
        } else if (data.permissions.includes(request.permission)) {
          outcome = "allowed";
          reason = "permission_granted";
        } else {
          reason = "permission_missing";
        }
      }
    }

    const decision = this.insertDecision({
      workspaceId: request.workspaceId,
      canvasId,
      actorNodeId: request.actorNodeId,
      permission: request.permission,
      outcome,
      reason
    });
    if (outcome === "denied") throw new PolicyDeniedError(request.permission, reason);
    return decision;
  }

  public list(workspaceId: string, limit = 100): readonly PolicyDecision[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Policy decision list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT id, workspace_id, canvas_id, actor_node_id, permission, outcome, reason, created_at
         FROM policy_decisions WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, limit) as DecisionRow[];
    return rows.map(toPolicyDecision);
  }

  public close(): void {
    this.sqlite.close();
  }

  private insertDecision(input: {
    readonly workspaceId: string;
    readonly canvasId: string | null;
    readonly actorNodeId: string | null;
    readonly permission: AgentPermission;
    readonly outcome: PolicyDecisionOutcome;
    readonly reason: PolicyDecisionReason;
  }): PolicyDecision {
    const id = this.createId();
    const createdAt = this.now().getTime();
    this.sqlite
      .prepare(
        `INSERT INTO policy_decisions
         (id, workspace_id, canvas_id, actor_node_id, permission, outcome, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.workspaceId,
        input.canvasId,
        input.actorNodeId,
        input.permission,
        input.outcome,
        input.reason,
        createdAt
      );
    return toPolicyDecision({
      id,
      workspace_id: input.workspaceId,
      canvas_id: input.canvasId,
      actor_node_id: input.actorNodeId,
      permission: input.permission,
      outcome: input.outcome,
      reason: input.reason,
      created_at: createdAt
    });
  }
}

export class PolicyDeniedError extends Error {
  public constructor(
    readonly permission: AgentPermission,
    readonly reason: PolicyDecisionReason
  ) {
    super(`Permission denied: ${permission} permission is required`);
    this.name = "PolicyDeniedError";
  }
}

function toPolicyDecision(row: DecisionRow): PolicyDecision {
  return policyDecisionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    canvasId: row.canvas_id,
    actorNodeId: row.actor_node_id,
    permission: row.permission,
    outcome: row.outcome,
    reason: row.reason,
    createdAt: new Date(row.created_at).toISOString()
  });
}
