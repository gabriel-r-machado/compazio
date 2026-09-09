import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  autonomyActorSchema,
  autonomyConfigSchema,
  autonomyRuntimeStateSchema,
  evaluateAutonomyDecision,
  recordedAutonomyDecisionSchema,
  shouldTerminateIdleAgent
} from "@forgedeck/schemas";
import type {
  AutonomyActionKind,
  AutonomyConfig,
  AutonomyDecision,
  AutonomyRuntimeState,
  RecordedAutonomyDecision
} from "@forgedeck/schemas";

export type { RecordedAutonomyDecision };

export interface AssessAutonomyActionInput {
  readonly workspaceId: string;
  readonly runId?: string | null;
  readonly proposalId?: string | null;
  /** Who proposed the automatic action: an agent node id or the literal "runtime". */
  readonly actor: string;
  readonly action: AutonomyActionKind;
  readonly config: AutonomyConfig;
  readonly state: AutonomyRuntimeState;
}

interface DecisionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly proposal_id: string | null;
  readonly actor: string;
  readonly action: string;
  readonly outcome: string;
  readonly rule: string;
  readonly context_json: string;
  readonly created_at: number;
}

/**
 * Durable decision point for supervised autonomy (batch E4). Every automatic action is assessed by
 * the deterministic guardrail with the persisted kill switch merged in, and both allows and stops
 * are recorded immutably before control returns — silent automatic actions cannot exist. The store
 * never executes anything itself.
 */
export class SqliteSupervisedAutonomyStore {
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

  /**
   * Evaluates one proposed automatic action and records the decision. The persisted kill switch
   * always overrides the caller-provided state so a stale in-memory snapshot can never bypass an
   * engaged global interrupt.
   */
  public assess(input: AssessAutonomyActionInput): RecordedAutonomyDecision {
    this.requireWorkspace(input.workspaceId);
    const config = autonomyConfigSchema.parse(input.config);
    const state = autonomyRuntimeStateSchema.parse({
      ...input.state,
      killSwitchEngaged:
        this.isKillSwitchEngaged(input.workspaceId) ||
        autonomyRuntimeStateSchema.parse(input.state).killSwitchEngaged
    });
    const decision: AutonomyDecision = evaluateAutonomyDecision(config, state, input.action);
    const record = recordedAutonomyDecisionSchema.parse({
      id: this.createId(),
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      proposalId: input.proposalId ?? null,
      actor: autonomyActorSchema.parse(input.actor),
      action: input.action,
      outcome: decision.outcome,
      rule: decision.rule,
      context: { config, state },
      createdAt: this.now().toISOString()
    });
    this.sqlite
      .prepare(
        `INSERT INTO autonomy_decisions
         (id, workspace_id, run_id, proposal_id, actor, action, outcome, rule, context_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.workspaceId,
        record.runId,
        record.proposalId,
        record.actor,
        record.action,
        record.outcome,
        record.rule,
        JSON.stringify(record.context),
        Date.parse(record.createdAt)
      );
    return record;
  }

  public listDecisions(workspaceId: string, limit = 100): readonly RecordedAutonomyDecision[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Autonomy decision list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT id, workspace_id, run_id, proposal_id, actor, action, outcome, rule, context_json, created_at
         FROM autonomy_decisions WHERE workspace_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, limit) as DecisionRow[];
    return rows.map(toRecordedDecision);
  }

  /**
   * The idle-termination loop: returns the node ids whose agent has been idle past the configured
   * budget AND whose termination the guardrail authorizes, recording one auditable
   * terminate_idle_agent decision per idle agent. It stays consistent with evaluateAutonomyDecision:
   * an engaged kill switch stops the loop (the durable interrupt drives its own full shutdown), so
   * the idle loop never acts behind it.
   */
  public sweepIdleAgents(input: {
    readonly workspaceId: string;
    readonly runId?: string | null;
    readonly config: AutonomyConfig;
    readonly agents: readonly { readonly nodeId: string; readonly idleMinutes: number }[];
  }): readonly string[] {
    this.requireWorkspace(input.workspaceId);
    const config = autonomyConfigSchema.parse(input.config);
    const terminated: string[] = [];
    for (const agent of input.agents) {
      if (!shouldTerminateIdleAgent(config, agent.idleMinutes)) continue;
      const decision = this.assess({
        workspaceId: input.workspaceId,
        runId: input.runId ?? null,
        proposalId: null,
        actor: agent.nodeId,
        action: "terminate_idle_agent",
        config,
        state: { idleMinutes: agent.idleMinutes }
      });
      if (decision.outcome === "allow") terminated.push(agent.nodeId);
    }
    return terminated;
  }

  /** Engages the durable global interrupt. Idempotent; records who engaged it. */
  public engageKillSwitch(workspaceId: string, engagedBy = "local-user"): void {
    this.requireWorkspace(workspaceId);
    this.sqlite
      .prepare(
        `INSERT INTO autonomy_controls (workspace_id, kill_switch, engaged_by, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(workspace_id)
         DO UPDATE SET kill_switch = 1, engaged_by = excluded.engaged_by, updated_at = excluded.updated_at`
      )
      .run(workspaceId, autonomyActorSchema.parse(engagedBy), this.now().getTime());
  }

  /** Releasing the interrupt is an explicit human action; nothing resumes automatically. */
  public releaseKillSwitch(workspaceId: string): void {
    this.requireWorkspace(workspaceId);
    this.sqlite
      .prepare(
        `INSERT INTO autonomy_controls (workspace_id, kill_switch, engaged_by, updated_at)
         VALUES (?, 0, NULL, ?)
         ON CONFLICT(workspace_id)
         DO UPDATE SET kill_switch = 0, engaged_by = NULL, updated_at = excluded.updated_at`
      )
      .run(workspaceId, this.now().getTime());
  }

  public isKillSwitchEngaged(workspaceId: string): boolean {
    const row = this.sqlite
      .prepare("SELECT kill_switch FROM autonomy_controls WHERE workspace_id = ?")
      .get(workspaceId) as { readonly kill_switch: number } | undefined;
    return row !== undefined && row.kill_switch === 1;
  }

  public close(): void {
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): void {
    const row = this.sqlite.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as
      { readonly id: string } | undefined;
    if (row === undefined) throw new Error("Supervised autonomy workspace was not found");
  }
}

function toRecordedDecision(row: DecisionRow): RecordedAutonomyDecision {
  return recordedAutonomyDecisionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    proposalId: row.proposal_id,
    actor: row.actor,
    action: row.action,
    outcome: row.outcome,
    rule: row.rule,
    context: JSON.parse(row.context_json) as unknown,
    createdAt: new Date(row.created_at).toISOString()
  });
}
