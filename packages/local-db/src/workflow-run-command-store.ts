import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { contextSelectionModeSchema, orchestrationProposalSchema } from "@forgedeck/schemas";
import type { ContextSelectionMode } from "@forgedeck/schemas";

export const workflowRunCommandActions = [
  "start",
  "pause",
  "resume",
  "cancel",
  "retry",
  "alternative",
  "approve",
  "reject"
] as const;
export type WorkflowRunCommandAction = (typeof workflowRunCommandActions)[number];

export const workflowRunCommandStatuses = ["queued", "applying", "applied", "failed"] as const;
export type WorkflowRunCommandStatus = (typeof workflowRunCommandStatuses)[number];
export const workflowRunRetryScopes = ["run", "node", "dependents"] as const;
export type WorkflowRunRetryScope = (typeof workflowRunRetryScopes)[number];

export interface WorkflowRunCommand {
  readonly id: string;
  readonly action: WorkflowRunCommandAction;
  readonly status: WorkflowRunCommandStatus;
  readonly runId: string | null;
  readonly workspaceId: string | null;
  readonly agentNodeId: string | null;
  readonly task: string | null;
  readonly contractId: string | null;
  readonly nodeId: string | null;
  readonly retryScope: WorkflowRunRetryScope;
  readonly alternativeLabel: string | null;
  readonly templateId: string | null;
  readonly contextMode?: ContextSelectionMode | null | undefined;
  readonly dryRun: boolean | null;
  readonly decisionNote: string | null;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly appliedAt: string | null;
  readonly resultRunId: string | null;
  readonly errorCode: string | null;
}

interface CommandRow {
  readonly id: string;
  readonly action: string;
  readonly status: string;
  readonly run_id: string | null;
  readonly workspace_id: string | null;
  readonly agent_node_id: string | null;
  readonly task: string | null;
  readonly contract_id: string | null;
  readonly node_id: string | null;
  readonly retry_scope: string | null;
  readonly alternative_label: string | null;
  readonly template_id: string | null;
  readonly context_mode: string | null;
  readonly dry_run: number | null;
  readonly decision_note: string | null;
  readonly requested_by: string;
  readonly created_at: number;
  readonly applied_at: number | null;
  readonly result_run_id: string | null;
  readonly error_code: string | null;
}

interface ProposalRow {
  readonly id: string;
  readonly proposal_json: string;
}

/**
 * Durable manual workflow controls. Requests contain only stable identifiers and a short review
 * note; executable paths, command lines, working directories and workflow JSON never cross this
 * boundary.
 */
export class SqliteWorkflowRunCommandStore {
  private readonly sqlite: Database.Database;

  public constructor(
    filename: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public requestStart(input: {
    readonly templateId: string;
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly task: string;
    readonly contractId?: string;
    readonly contextMode?: ContextSelectionMode;
    readonly dryRun: boolean;
    readonly requestedBy?: string;
    /** An approved proposal can materialize at most one durable command. */
    readonly proposalId?: string;
  }): WorkflowRunCommand {
    if (!/^[a-z0-9-]+$/.test(input.templateId)) {
      throw new Error("Workflow template id is invalid");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(input.workspaceId)) {
      throw new Error("Workflow workspace id is invalid");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(input.agentNodeId)) {
      throw new Error("Workflow agent id is invalid");
    }
    if (input.task.trim().length < 1 || input.task.length > 20_000) {
      throw new Error("Workflow task is invalid");
    }
    if (input.contractId !== undefined && !isUuid(input.contractId)) {
      throw new Error("Workflow contract id is invalid");
    }
    const contextMode = contextSelectionModeSchema.parse(input.contextMode ?? "full");
    if (input.proposalId !== undefined && !isUuid(input.proposalId)) {
      throw new Error("Orchestration proposal id is invalid");
    }
    return this.request({
      action: "start",
      templateId: input.templateId,
      workspaceId: input.workspaceId,
      agentNodeId: input.agentNodeId,
      task: input.task?.trim(),
      contractId: input.contractId,
      contextMode,
      dryRun: input.dryRun,
      requestedBy: input.requestedBy,
      proposalId: input.proposalId
    });
  }

  /** Returns the one command materialized from a proposal, scoped to its workspace. */
  public getForProposal(workspaceId: string, proposalId: string): WorkflowRunCommand | null {
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
      throw new Error("Workflow workspace id is invalid");
    }
    if (!isUuid(proposalId)) throw new Error("Orchestration proposal id is invalid");
    const row = this.sqlite
      .prepare(
        `SELECT command.* FROM orchestration_proposal_executions execution
         JOIN orchestration_proposals proposal ON proposal.id = execution.proposal_id
         JOIN workflow_run_commands command ON command.id = execution.workflow_command_id
         WHERE execution.proposal_id = ? AND proposal.workspace_id = ?`
      )
      .get(proposalId, workspaceId) as CommandRow | undefined;
    return row === undefined ? null : toCommand(row);
  }

  public requestControl(input: {
    readonly action: Exclude<WorkflowRunCommandAction, "start">;
    readonly runId: string;
    readonly nodeId?: string;
    readonly retryScope?: WorkflowRunRetryScope;
    readonly alternativeLabel?: string;
    readonly decisionNote?: string;
    readonly requestedBy?: string;
  }): WorkflowRunCommand {
    if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) {
      throw new Error("Workflow run id is invalid");
    }
    if ((input.action === "approve" || input.action === "reject") && input.nodeId === undefined) {
      throw new Error("Approval controls require a workflow node id");
    }
    if (input.nodeId !== undefined && !/^[A-Za-z0-9_-]+$/.test(input.nodeId)) {
      throw new Error("Workflow node id is invalid");
    }
    if (
      input.retryScope !== undefined &&
      input.action !== "retry" &&
      input.action !== "alternative"
    ) {
      throw new Error("Retry scope is only supported by retry controls");
    }
    if (input.alternativeLabel !== undefined && input.action !== "alternative") {
      throw new Error("Alternative label is only supported by alternative controls");
    }
    const retryScope =
      input.retryScope ??
      (input.action === "alternative" ? "dependents" : input.nodeId === undefined ? "run" : "node");
    if (
      (input.action === "retry" || input.action === "alternative") &&
      retryScope !== "run" &&
      input.nodeId === undefined
    ) {
      throw new Error("Selective retry controls require a workflow node id");
    }
    if (input.action === "alternative" && retryScope !== "dependents") {
      throw new Error("Workflow alternatives rerun dependent nodes");
    }
    if (
      input.action !== "retry" &&
      input.action !== "alternative" &&
      input.nodeId !== undefined &&
      input.action !== "approve" &&
      input.action !== "reject"
    ) {
      throw new Error("Workflow node id is only supported by retry and approval controls");
    }
    const alternativeLabel = input.alternativeLabel?.trim() ?? null;
    if (alternativeLabel !== null && alternativeLabel.length > 120) {
      throw new Error("Workflow alternative label is invalid");
    }
    const note = input.decisionNote?.trim() ?? "";
    if (note.length > 2_000) throw new Error("Workflow review note is too long");
    return this.request({
      action: input.action,
      runId: input.runId,
      nodeId: input.nodeId,
      retryScope,
      alternativeLabel,
      decisionNote: note.length === 0 ? null : note,
      requestedBy: input.requestedBy
    });
  }

  public get(commandId: string): WorkflowRunCommand | null {
    const row = this.sqlite
      .prepare("SELECT * FROM workflow_run_commands WHERE id = ?")
      .get(commandId) as CommandRow | undefined;
    return row === undefined ? null : toCommand(row);
  }

  public claimNext(): WorkflowRunCommand | null {
    const transaction = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT * FROM workflow_run_commands
           WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`
        )
        .get() as CommandRow | undefined;
      if (row === undefined) return null;
      const result = this.sqlite
        .prepare(
          "UPDATE workflow_run_commands SET status = 'applying' WHERE id = ? AND status = 'queued'"
        )
        .run(row.id);
      if (result.changes !== 1) return null;
      const claimed = toCommand({ ...row, status: "applying" });
      this.insertEvent(claimed, "applying", "desktop-runtime", null);
      return claimed;
    });
    return transaction();
  }

  public markApplied(command: WorkflowRunCommand, resultRunId: string | null): WorkflowRunCommand {
    const transaction = this.sqlite.transaction(() => {
      const appliedAt = this.now().getTime();
      const result = this.sqlite
        .prepare(
          `UPDATE workflow_run_commands
           SET status = 'applied', applied_at = ?, result_run_id = ?, error_code = NULL
           WHERE id = ? AND status = 'applying'`
        )
        .run(appliedAt, resultRunId, command.id);
      if (result.changes !== 1) throw new Error("Workflow run command is no longer applying");
      const applied = {
        ...command,
        status: "applied" as const,
        appliedAt: new Date(appliedAt).toISOString(),
        resultRunId,
        errorCode: null
      };
      this.insertEvent(applied, "applied", "desktop-runtime", null);
      return applied;
    });
    return transaction();
  }

  public markFailed(command: WorkflowRunCommand, errorCode: string): void {
    const safeCode = /^[a-z0-9_]{1,80}$/.test(errorCode) ? errorCode : "workflow_control_failed";
    const transaction = this.sqlite.transaction(() => {
      const appliedAt = this.now().getTime();
      const result = this.sqlite
        .prepare(
          `UPDATE workflow_run_commands
           SET status = 'failed', applied_at = ?, error_code = ?
           WHERE id = ? AND status = 'applying'`
        )
        .run(appliedAt, safeCode, command.id);
      if (result.changes !== 1) return;
      this.insertEvent(command, "failed", "desktop-runtime", safeCode);
    });
    transaction();
  }

  /** Never replays a command after a host crash; a human must submit a new, auditable request. */
  public recoverInterrupted(): number {
    const transaction = this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare("SELECT * FROM workflow_run_commands WHERE status = 'applying'")
        .all() as CommandRow[];
      for (const row of rows) {
        const command = toCommand(row);
        this.sqlite
          .prepare(
            `UPDATE workflow_run_commands
             SET status = 'failed', applied_at = ?, error_code = 'application_restart'
             WHERE id = ? AND status = 'applying'`
          )
          .run(this.now().getTime(), command.id);
        this.insertEvent(command, "failed", "desktop-runtime", "application_restart");
      }
      return rows.length;
    });
    return transaction();
  }

  public close(): void {
    this.sqlite.close();
  }

  private request(input: {
    readonly action: WorkflowRunCommandAction;
    readonly runId?: string | undefined;
    readonly workspaceId?: string | undefined;
    readonly agentNodeId?: string | undefined;
    readonly task?: string | undefined;
    readonly contractId?: string | undefined;
    readonly nodeId?: string | undefined;
    readonly retryScope?: WorkflowRunRetryScope | undefined;
    readonly alternativeLabel?: string | null | undefined;
    readonly templateId?: string | undefined;
    readonly contextMode?: ContextSelectionMode | undefined;
    readonly dryRun?: boolean | undefined;
    readonly decisionNote?: string | null | undefined;
    readonly requestedBy?: string | undefined;
    readonly proposalId?: string | undefined;
  }): WorkflowRunCommand {
    const createdAt = this.now();
    const command: WorkflowRunCommand = {
      id: randomUUID(),
      action: input.action,
      status: "queued",
      runId: input.runId ?? null,
      workspaceId: input.workspaceId ?? null,
      agentNodeId: input.agentNodeId ?? null,
      task: input.task ?? null,
      contractId: input.contractId ?? null,
      nodeId: input.nodeId ?? null,
      retryScope: input.retryScope ?? "run",
      alternativeLabel: input.alternativeLabel ?? null,
      templateId: input.templateId ?? null,
      contextMode: input.contextMode ?? null,
      dryRun: input.dryRun ?? null,
      decisionNote: input.decisionNote ?? null,
      requestedBy: input.requestedBy ?? "compasso-cli",
      createdAt: createdAt.toISOString(),
      appliedAt: null,
      resultRunId: null,
      errorCode: null
    };
    const transaction = this.sqlite.transaction(() => {
      if (input.proposalId !== undefined) {
        if (command.workspaceId === null) throw new Error("Workflow workspace id is invalid");
        const existing = this.getForProposal(command.workspaceId, input.proposalId);
        if (existing !== null) return existing;
        const proposal = this.sqlite
          .prepare(
            `SELECT id, proposal_json FROM orchestration_proposals
             WHERE id = ? AND workspace_id = ? AND status = 'approved'`
          )
          .get(input.proposalId, command.workspaceId) as ProposalRow | undefined;
        if (proposal === undefined) throw new Error("Orchestration proposal is not approved");
        const approved = orchestrationProposalSchema.parse(
          JSON.parse(proposal.proposal_json) as unknown
        );
        if (
          approved.workflowTemplateId !== command.templateId ||
          approved.executionAgentNodeId !== command.agentNodeId ||
          approved.objective !== command.task ||
          command.dryRun !== false
        ) {
          throw new Error("Workflow command does not match the approved proposal");
        }
      }
      this.sqlite
        .prepare(
          `INSERT INTO workflow_run_commands
           (id, action, status, run_id, workspace_id, agent_node_id, task, contract_id, node_id, template_id, context_mode, dry_run, decision_note,
            retry_scope, alternative_label, requested_by, created_at, applied_at, result_run_id, error_code)
           VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
        )
        .run(
          command.id,
          command.action,
          command.runId,
          command.workspaceId,
          command.agentNodeId,
          command.task,
          command.contractId,
          command.nodeId,
          command.templateId,
          command.contextMode,
          command.dryRun === null ? null : command.dryRun ? 1 : 0,
          command.decisionNote,
          command.retryScope,
          command.alternativeLabel,
          command.requestedBy,
          createdAt.getTime()
        );
      if (input.proposalId !== undefined) {
        this.sqlite
          .prepare(
            `INSERT INTO orchestration_proposal_executions
             (proposal_id, workflow_command_id, created_at) VALUES (?, ?, ?)`
          )
          .run(input.proposalId, command.id, createdAt.getTime());
        this.recordProposalExecutionEvent(input.proposalId, command.id, createdAt.getTime());
      }
      this.insertEvent(command, "requested", command.requestedBy, null);
      return command;
    });
    return transaction();
  }

  private insertEvent(
    command: Pick<WorkflowRunCommand, "id" | "action">,
    outcome: "requested" | "applying" | "applied" | "failed",
    actor: string,
    errorCode: string | null
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO workflow_run_command_events
         (id, command_id, action, outcome, actor, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        command.id,
        command.action,
        outcome,
        actor,
        errorCode,
        this.now().getTime()
      );
  }

  private recordProposalExecutionEvent(
    proposalId: string,
    commandId: string,
    createdAt: number
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
         VALUES (?, ?, ?, 'execution_requested', 'local-user', ?, ?)`
      )
      .run(
        randomUUID(),
        proposalId,
        sequence,
        `Workflow command requested: ${commandId}`,
        createdAt
      );
  }
}

function toCommand(row: CommandRow): WorkflowRunCommand {
  return {
    id: row.id,
    action: parseAction(row.action),
    status: parseStatus(row.status),
    runId: row.run_id,
    workspaceId: row.workspace_id,
    agentNodeId: row.agent_node_id,
    task: row.task,
    contractId: row.contract_id,
    nodeId: row.node_id,
    retryScope: workflowRunRetryScopes.includes(row.retry_scope as WorkflowRunRetryScope)
      ? (row.retry_scope as WorkflowRunRetryScope)
      : "run",
    alternativeLabel: row.alternative_label,
    templateId: row.template_id,
    contextMode:
      row.context_mode === null ? null : contextSelectionModeSchema.parse(row.context_mode),
    dryRun: row.dry_run === null ? null : row.dry_run === 1,
    decisionNote: row.decision_note,
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
    appliedAt: row.applied_at === null ? null : new Date(row.applied_at).toISOString(),
    resultRunId: row.result_run_id,
    errorCode: row.error_code
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseAction(value: string): WorkflowRunCommandAction {
  const action = workflowRunCommandActions.find((candidate) => candidate === value);
  if (action === undefined) throw new Error("Invalid persisted workflow run command action");
  return action;
}

function parseStatus(value: string): WorkflowRunCommandStatus {
  const status = workflowRunCommandStatuses.find((candidate) => candidate === value);
  if (status === undefined) throw new Error("Invalid persisted workflow run command status");
  return status;
}
