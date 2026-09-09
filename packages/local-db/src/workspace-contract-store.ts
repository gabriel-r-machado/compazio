import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  artifactMemoryComparisonSchema,
  artifactMemorySchema,
  canvasNodeDataSchema,
  compareArtifactMemorySchema,
  createDeliveryContractSchema,
  deliveryContractSchema,
  setArtifactMemorySchema,
  restoreArtifactMemorySchema,
  verifyDeliveryContractSchema
} from "@forgedeck/schemas";
import type {
  ArtifactMemory,
  ArtifactMemoryComparison,
  ArtifactMemoryRelation,
  CompareArtifactMemory,
  CreateDeliveryContract,
  DeliveryContract,
  SetArtifactMemory,
  RestoreArtifactMemory,
  VerifyDeliveryContract
} from "@forgedeck/schemas";

interface WorkspaceRow {
  readonly canvas_id: string;
}

interface NodeRow {
  readonly type: string;
  readonly data_json: string;
}

interface ArtifactRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly source_relative_path: string;
  readonly sha256: string;
  readonly published_by_node_id: string | null;
}

interface ArtifactMemoryRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly artifact_id: string;
  readonly version: number;
  readonly origin: string;
  readonly sha256: string;
  readonly relationships_json: string;
  readonly relevance: string;
  readonly status: string;
  readonly restored_from_version: number | null;
  readonly created_by: string;
  readonly created_at: number;
}

interface DeliveryContractRow {
  readonly id: string;
  readonly contract_id: string;
  readonly workspace_id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly version: number;
  readonly inputs_json: string;
  readonly outputs_json: string;
  readonly completion_criteria_json: string;
  readonly declared_evidence_json: string;
  readonly verified_evidence_json: string;
  readonly state: string;
  readonly limits_json: string;
  readonly created_by: string;
  readonly created_at: number;
}

export interface SqliteWorkspaceContractStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

/** Durable delivery contracts and artifact metadata; all edits append a versioned record. */
export class SqliteWorkspaceContractStore {
  private readonly sqlite: Database.Database;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqliteWorkspaceContractStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  public getArtifactMemory(workspaceId: string, artifactId: string): ArtifactMemory {
    return this.sqlite.transaction(() => this.ensureArtifactMemory(workspaceId, artifactId))();
  }

  public setArtifactMemory(input: SetArtifactMemory): ArtifactMemory {
    const parsed = setArtifactMemorySchema.parse(input);
    return this.sqlite.transaction(() => {
      const current = this.ensureArtifactMemory(parsed.workspaceId, parsed.artifactId);
      for (const relationship of parsed.relationships) {
        if (relationship.artifactId === parsed.artifactId) {
          throw new Error("Artifact memory cannot reference itself");
        }
        this.requireArtifact(parsed.workspaceId, relationship.artifactId);
      }
      return this.insertArtifactMemory({
        ...current,
        id: this.createId(),
        version: current.version + 1,
        relationships: parsed.relationships,
        relevance: parsed.relevance,
        status: parsed.status,
        restoredFromVersion: null,
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
    })();
  }

  public listArtifactMemories(
    workspaceId: string,
    artifactId: string,
    limit = 50
  ): readonly ArtifactMemory[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Artifact memory list limit must be between 1 and 500");
    }
    this.requireArtifact(workspaceId, artifactId);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM artifact_memories WHERE workspace_id = ? AND artifact_id = ?
         ORDER BY version DESC LIMIT ?`
      )
      .all(workspaceId, artifactId, limit) as ArtifactMemoryRow[];
    return rows.map(toArtifactMemory);
  }

  public compareArtifactMemories(input: CompareArtifactMemory): ArtifactMemoryComparison {
    const parsed = compareArtifactMemorySchema.parse(input);
    return this.sqlite.transaction(() => {
      this.requireArtifact(parsed.workspaceId, parsed.artifactId);
      const base = this.requireArtifactMemoryRevision(
        parsed.workspaceId,
        parsed.artifactId,
        parsed.baseVersion
      );
      const target = this.requireArtifactMemoryRevision(
        parsed.workspaceId,
        parsed.artifactId,
        parsed.targetVersion
      );
      return artifactMemoryComparisonSchema.parse({
        workspaceId: parsed.workspaceId,
        artifactId: parsed.artifactId,
        baseVersion: base.version,
        targetVersion: target.version,
        addedRelationships: relationshipDifference(target.relationships, base.relationships),
        removedRelationships: relationshipDifference(base.relationships, target.relationships),
        relevance:
          base.relevance === target.relevance
            ? null
            : { from: base.relevance, to: target.relevance },
        status: base.status === target.status ? null : { from: base.status, to: target.status }
      });
    })();
  }

  /** Restores metadata by appending a new revision; artifact bytes are never changed. */
  public restoreArtifactMemory(input: RestoreArtifactMemory): ArtifactMemory {
    const parsed = restoreArtifactMemorySchema.parse(input);
    return this.sqlite.transaction(() => {
      const current = this.ensureArtifactMemory(parsed.workspaceId, parsed.artifactId);
      const source = this.requireArtifactMemoryRevision(
        parsed.workspaceId,
        parsed.artifactId,
        parsed.sourceVersion
      );
      if (sameArtifactMemoryState(current, source)) return current;
      return this.insertArtifactMemory({
        ...current,
        id: this.createId(),
        version: current.version + 1,
        relationships: source.relationships,
        relevance: source.relevance,
        status: source.status,
        restoredFromVersion: source.version,
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
    })();
  }

  public createDeliveryContract(input: CreateDeliveryContract): DeliveryContract {
    const parsed = createDeliveryContractSchema.parse(input);
    return this.sqlite.transaction(() => {
      const workspace = this.requireWorkspace(parsed.workspaceId);
      this.requireAgentNode(workspace.canvas_id, parsed.sourceNodeId, "source");
      this.requireAgentNode(workspace.canvas_id, parsed.targetNodeId, "target");
      const contractId = this.createId();
      return this.insertDeliveryContract({
        id: contractId,
        revisionId: this.createId(),
        workspaceId: parsed.workspaceId,
        sourceNodeId: parsed.sourceNodeId,
        targetNodeId: parsed.targetNodeId,
        version: 1,
        inputs: parsed.inputs,
        outputs: parsed.outputs,
        completionCriteria: parsed.completionCriteria,
        declaredEvidence: parsed.declaredEvidence,
        verifiedEvidence: [],
        state: "draft",
        limits: parsed.limits,
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
    })();
  }

  public getDeliveryContract(workspaceId: string, contractId: string): DeliveryContract {
    this.requireWorkspace(workspaceId);
    const row = this.sqlite
      .prepare(
        `SELECT * FROM delivery_contracts WHERE workspace_id = ? AND contract_id = ?
         ORDER BY version DESC LIMIT 1`
      )
      .get(workspaceId, contractId) as DeliveryContractRow | undefined;
    if (row === undefined) throw new Error(`Delivery contract not found: ${contractId}`);
    return toDeliveryContract(row);
  }

  public listDeliveryContracts(workspaceId: string, limit = 50): readonly DeliveryContract[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Delivery contract list limit must be between 1 and 500");
    }
    this.requireWorkspace(workspaceId);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM delivery_contracts WHERE workspace_id = ?
         ORDER BY contract_id, version DESC`
      )
      .all(workspaceId) as DeliveryContractRow[];
    const current: DeliveryContract[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.contract_id)) continue;
      current.push(toDeliveryContract(row));
      seen.add(row.contract_id);
      if (current.length >= limit) break;
    }
    return current;
  }

  public verifyDeliveryContract(input: VerifyDeliveryContract): DeliveryContract {
    const parsed = verifyDeliveryContractSchema.parse(input);
    return this.sqlite.transaction(() => {
      const current = this.getDeliveryContract(parsed.workspaceId, parsed.contractId);
      if (current.state === "verified" || current.state === "rejected") {
        throw new Error("Delivery contract is no longer eligible for verification");
      }
      return this.insertDeliveryContract({
        ...current,
        revisionId: this.createId(),
        version: current.version + 1,
        verifiedEvidence: parsed.verifiedEvidence,
        state: "verified",
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
    })();
  }

  public close(): void {
    this.sqlite.close();
  }

  private ensureArtifactMemory(workspaceId: string, artifactId: string): ArtifactMemory {
    const existing = this.currentArtifactMemory(workspaceId, artifactId);
    if (existing !== null) return existing;
    const artifact = this.requireArtifact(workspaceId, artifactId);
    return this.insertArtifactMemory({
      id: this.createId(),
      workspaceId,
      artifactId,
      version: 1,
      origin: artifact.source_relative_path,
      sha256: artifact.sha256,
      relationships: [],
      relevance: "relevant",
      status: "active",
      restoredFromVersion: null,
      createdBy: artifact.published_by_node_id ?? "local-user",
      createdAt: this.now().toISOString()
    });
  }

  private currentArtifactMemory(workspaceId: string, artifactId: string): ArtifactMemory | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM artifact_memories WHERE workspace_id = ? AND artifact_id = ?
         ORDER BY version DESC LIMIT 1`
      )
      .get(workspaceId, artifactId) as ArtifactMemoryRow | undefined;
    return row === undefined ? null : toArtifactMemory(row);
  }

  private requireArtifactMemoryRevision(
    workspaceId: string,
    artifactId: string,
    version: number
  ): ArtifactMemory {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM artifact_memories
         WHERE workspace_id = ? AND artifact_id = ? AND version = ?`
      )
      .get(workspaceId, artifactId, version) as ArtifactMemoryRow | undefined;
    if (row === undefined) throw new Error(`Artifact memory version not found: ${version}`);
    return toArtifactMemory(row);
  }

  private requireArtifact(workspaceId: string, artifactId: string): ArtifactRow {
    const row = this.sqlite
      .prepare(
        `SELECT id, workspace_id, source_relative_path, sha256, published_by_node_id
         FROM workspace_artifacts WHERE workspace_id = ? AND id = ?`
      )
      .get(workspaceId, artifactId) as ArtifactRow | undefined;
    if (row === undefined) throw new Error("Artifact memory artifact was not found");
    return row;
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.sqlite
      .prepare("SELECT canvas_id FROM workspaces WHERE id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) throw new Error("Workspace contract workspace was not found");
    return row;
  }

  private requireAgentNode(canvasId: string, nodeId: string, role: "source" | "target"): void {
    const row = this.sqlite
      .prepare("SELECT type, data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
      .get(canvasId, nodeId) as NodeRow | undefined;
    if (row === undefined || (row.type !== "agent" && row.type !== "terminal")) {
      throw new Error(`Delivery contract ${role} must be an agent node`);
    }
    const data = canvasNodeDataSchema.parse(JSON.parse(row.data_json) as unknown);
    if (data.adapterId === undefined || data.adapterId === "shell") {
      throw new Error(`Delivery contract ${role} is not an agent-capable node`);
    }
  }

  private insertArtifactMemory(value: ArtifactMemory): ArtifactMemory {
    const memory = artifactMemorySchema.parse(value);
    this.sqlite
      .prepare(
        `INSERT INTO artifact_memories
         (id, workspace_id, artifact_id, version, origin, sha256, relationships_json, relevance,
          status, restored_from_version, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memory.id,
        memory.workspaceId,
        memory.artifactId,
        memory.version,
        memory.origin,
        memory.sha256,
        JSON.stringify(memory.relationships),
        memory.relevance,
        memory.status,
        memory.restoredFromVersion,
        memory.createdBy,
        Date.parse(memory.createdAt)
      );
    return memory;
  }

  private insertDeliveryContract(value: DeliveryContract): DeliveryContract {
    const contract = deliveryContractSchema.parse(value);
    this.sqlite
      .prepare(
        `INSERT INTO delivery_contracts
         (id, contract_id, workspace_id, source_node_id, target_node_id, version, inputs_json,
          outputs_json, completion_criteria_json, declared_evidence_json, verified_evidence_json,
          state, limits_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        contract.revisionId,
        contract.id,
        contract.workspaceId,
        contract.sourceNodeId,
        contract.targetNodeId,
        contract.version,
        JSON.stringify(contract.inputs),
        JSON.stringify(contract.outputs),
        JSON.stringify(contract.completionCriteria),
        JSON.stringify(contract.declaredEvidence),
        JSON.stringify(contract.verifiedEvidence),
        contract.state,
        JSON.stringify(contract.limits),
        contract.createdBy,
        Date.parse(contract.createdAt)
      );
    return contract;
  }
}

function toArtifactMemory(row: ArtifactMemoryRow): ArtifactMemory {
  return artifactMemorySchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    version: row.version,
    origin: row.origin,
    sha256: row.sha256,
    relationships: parseJson(row.relationships_json, "Artifact memory relationships"),
    relevance: row.relevance,
    status: row.status,
    restoredFromVersion: row.restored_from_version,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function toDeliveryContract(row: DeliveryContractRow): DeliveryContract {
  return deliveryContractSchema.parse({
    id: row.contract_id,
    revisionId: row.id,
    workspaceId: row.workspace_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    version: row.version,
    inputs: parseJson(row.inputs_json, "Delivery contract inputs"),
    outputs: parseJson(row.outputs_json, "Delivery contract outputs"),
    completionCriteria: parseJson(row.completion_criteria_json, "Delivery contract criteria"),
    declaredEvidence: parseJson(row.declared_evidence_json, "Delivery contract declared evidence"),
    verifiedEvidence: parseJson(row.verified_evidence_json, "Delivery contract verified evidence"),
    state: row.state,
    limits: parseJson(row.limits_json, "Delivery contract limits"),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function relationshipDifference(
  source: readonly ArtifactMemoryRelation[],
  comparedWith: readonly ArtifactMemoryRelation[]
): ArtifactMemoryRelation[] {
  const comparison = new Set(comparedWith.map(relationshipKey));
  return source
    .filter((relationship) => !comparison.has(relationshipKey(relationship)))
    .sort(
      (left, right) =>
        left.artifactId.localeCompare(right.artifactId) || left.kind.localeCompare(right.kind)
    );
}

function relationshipKey(relationship: ArtifactMemoryRelation): string {
  return `${relationship.artifactId}:${relationship.kind}`;
}

function sameArtifactMemoryState(left: ArtifactMemory, right: ArtifactMemory): boolean {
  return (
    left.relevance === right.relevance &&
    left.status === right.status &&
    left.relationships.length === right.relationships.length &&
    relationshipDifference(left.relationships, right.relationships).length === 0
  );
}
