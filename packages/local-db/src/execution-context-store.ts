import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  buildExecutionContextSchema,
  createExecutionCheckpointSchema,
  effectiveExecutionContextSchema,
  executionCheckpointSchema,
  executionContextSnapshotSchema
} from "@forgedeck/schemas";
import type {
  BuildExecutionContext,
  CreateExecutionCheckpoint,
  EffectiveExecutionContext,
  ExecutionCheckpoint,
  ExecutionContextSnapshot
} from "@forgedeck/schemas";

import { SqliteWorkspaceContextStore } from "./workspace-context-store";
import { SqliteWorkspaceContractStore } from "./workspace-contract-store";
import { SqliteWorkspaceGovernanceStore } from "./workspace-governance-store";
import { SqliteWorkspaceHandoffStore } from "./workspace-handoff-store";
import { SqliteContextSelectionStore } from "./context-selection-store";

interface CheckpointRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly agent_node_id: string;
  readonly type: string;
  readonly task: string;
  readonly contract_id: string | null;
  readonly snapshot_id: string;
  readonly created_by: string;
  readonly created_at: number;
}

interface SnapshotRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly agent_node_id: string;
  readonly task: string;
  readonly contract_id: string | null;
  readonly payload_json: string;
  readonly sha256: string;
  readonly created_at: number;
}

export interface SqliteExecutionContextStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

/**
 * Builds the complete local context pack and persists only immutable checkpoints.
 * It does not run an agent or open a terminal; the scheduler will consume these records later.
 */
export class SqliteExecutionContextStore {
  private readonly sqlite: Database.Database;
  private readonly contexts: SqliteWorkspaceContextStore;
  private readonly contracts: SqliteWorkspaceContractStore;
  private readonly governance: SqliteWorkspaceGovernanceStore;
  private readonly handoffs: SqliteWorkspaceHandoffStore;
  private readonly selections: SqliteContextSelectionStore;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqliteExecutionContextStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.contexts = new SqliteWorkspaceContextStore(filename);
    this.contracts = new SqliteWorkspaceContractStore(filename, options);
    this.governance = new SqliteWorkspaceGovernanceStore(filename, options);
    this.handoffs = new SqliteWorkspaceHandoffStore(filename);
    this.selections = new SqliteContextSelectionStore(filename, options);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public build(input: BuildExecutionContext): EffectiveExecutionContext {
    const parsed = buildExecutionContextSchema.parse(input);
    const profile = this.governance.getAgentProfile(parsed.workspaceId, parsed.agentNodeId);
    const mission = this.governance.getMission(parsed.workspaceId);
    const memory = this.governance.getWorkspaceMemory(parsed.workspaceId);
    const directContext = this.contexts.resolve({
      workspaceId: parsed.workspaceId,
      agentNodeId: parsed.agentNodeId,
      requesterNodeId: null,
      includeNever: true
    });
    const artifactMemories = directContext.sources.flatMap((source) =>
      source.artifact === undefined
        ? []
        : [this.contracts.getArtifactMemory(parsed.workspaceId, source.artifact.id)]
    );
    const selection = this.selections.select({
      workspaceId: parsed.workspaceId,
      agentNodeId: parsed.agentNodeId,
      mode: parsed.contextMode,
      context: directContext,
      artifactMemories
    });
    const includedSourceIds = new Set(selection.includedSourceNodeIds);
    const connectedContext = {
      ...directContext,
      sources: directContext.sources.filter((source) => includedSourceIds.has(source.nodeId))
    };
    const deliveryContract =
      parsed.contractId === null
        ? null
        : this.contracts.getDeliveryContract(parsed.workspaceId, parsed.contractId);
    if (deliveryContract !== null && deliveryContract.targetNodeId !== parsed.agentNodeId) {
      throw new Error("Delivery contract target must match the context agent");
    }
    const previousHandoff =
      this.handoffs
        .list(parsed.workspaceId, 200)
        .find(
          (handoff) =>
            handoff.target.nodeId === parsed.agentNodeId && handoff.status === "delivered"
        ) ?? null;

    return effectiveExecutionContextSchema.parse({
      workspaceId: parsed.workspaceId,
      agentNodeId: parsed.agentNodeId,
      task: parsed.task,
      profile,
      mission,
      memory,
      connectedContext,
      artifactMemories,
      previousHandoff,
      deliveryContract,
      contextSelection: selection.snapshot
    });
  }

  public checkpoint(input: CreateExecutionCheckpoint): ExecutionCheckpoint {
    const parsed = createExecutionCheckpointSchema.parse(input);
    const context = this.build({
      workspaceId: parsed.workspaceId,
      agentNodeId: parsed.agentNodeId,
      task: parsed.task,
      contractId: parsed.contractId,
      contextMode: parsed.contextMode
    });
    const timestamp = this.now();
    const snapshot: ExecutionContextSnapshot = executionContextSnapshotSchema.parse({
      id: this.createId(),
      context,
      sha256: hashExecutionContext(context),
      createdAt: timestamp.toISOString()
    });
    const checkpointId = this.createId();
    return this.sqlite.transaction(() => {
      this.insertSnapshot(snapshot);
      this.sqlite
        .prepare(
          `INSERT INTO execution_checkpoints
           (id, workspace_id, agent_node_id, type, task, contract_id, snapshot_id, created_by,
            created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'local-user', ?)`
        )
        .run(
          checkpointId,
          parsed.workspaceId,
          parsed.agentNodeId,
          parsed.type,
          parsed.task,
          parsed.contractId,
          snapshot.id,
          timestamp.getTime()
        );
      return this.toCheckpoint(this.requireCheckpoint(checkpointId), snapshot);
    })();
  }

  public getCheckpoint(workspaceId: string, checkpointId: string): ExecutionCheckpoint {
    const row = this.requireCheckpoint(checkpointId);
    if (row.workspace_id !== workspaceId) throw new Error("Execution checkpoint was not found");
    return this.toCheckpoint(row, this.requireSnapshot(row.snapshot_id));
  }

  public listCheckpoints(
    workspaceId: string,
    agentNodeId: string | null = null,
    limit = 50
  ): readonly ExecutionCheckpoint[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Execution checkpoint list limit must be between 1 and 500");
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM execution_checkpoints
         WHERE workspace_id = ? AND (? IS NULL OR agent_node_id = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(workspaceId, agentNodeId, agentNodeId, limit) as CheckpointRow[];
    return rows.map((row) => this.toCheckpoint(row, this.requireSnapshot(row.snapshot_id)));
  }

  public close(): void {
    this.contexts.close();
    this.contracts.close();
    this.governance.close();
    this.handoffs.close();
    this.selections.close();
    this.sqlite.close();
  }

  private insertSnapshot(snapshot: ExecutionContextSnapshot): void {
    this.sqlite
      .prepare(
        `INSERT INTO execution_context_snapshots
         (id, workspace_id, agent_node_id, task, contract_id, payload_json, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.context.workspaceId,
        snapshot.context.agentNodeId,
        snapshot.context.task,
        snapshot.context.deliveryContract?.id ?? null,
        JSON.stringify(snapshot.context),
        snapshot.sha256,
        Date.parse(snapshot.createdAt)
      );
  }

  private requireCheckpoint(checkpointId: string): CheckpointRow {
    const row = this.sqlite
      .prepare("SELECT * FROM execution_checkpoints WHERE id = ?")
      .get(checkpointId) as CheckpointRow | undefined;
    if (row === undefined) throw new Error("Execution checkpoint was not found");
    return row;
  }

  private requireSnapshot(snapshotId: string): ExecutionContextSnapshot {
    const row = this.sqlite
      .prepare("SELECT * FROM execution_context_snapshots WHERE id = ?")
      .get(snapshotId) as SnapshotRow | undefined;
    if (row === undefined) throw new Error("Execution context snapshot was not found");
    const context = effectiveExecutionContextSchema.parse(
      parseJson(row.payload_json, "Execution context")
    );
    if (
      context.workspaceId !== row.workspace_id ||
      context.agentNodeId !== row.agent_node_id ||
      context.task !== row.task ||
      context.deliveryContract?.id !== row.contract_id ||
      hashExecutionContext(context) !== row.sha256
    ) {
      throw new Error("Execution context snapshot integrity check failed");
    }
    return executionContextSnapshotSchema.parse({
      id: row.id,
      context,
      sha256: row.sha256,
      createdAt: new Date(row.created_at).toISOString()
    });
  }

  private toCheckpoint(
    row: CheckpointRow,
    snapshot: ExecutionContextSnapshot
  ): ExecutionCheckpoint {
    return executionCheckpointSchema.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      agentNodeId: row.agent_node_id,
      type: row.type,
      task: row.task,
      contractId: row.contract_id,
      snapshot,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at).toISOString()
    });
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function hashExecutionContext(context: EffectiveExecutionContext): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}
