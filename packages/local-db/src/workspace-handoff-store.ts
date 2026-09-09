import Database from "better-sqlite3";

import { redactText } from "@forgedeck/logger";
import {
  canvasNodeDataSchema,
  edgeContractSchema,
  handoffApprovedContentSchema,
  handoffDraftContentSchema
} from "@forgedeck/schemas";
import type {
  CanvasHandoff,
  CanvasHandoffEvent,
  HandoffApprovedContent,
  WorkspaceArtifact
} from "@forgedeck/schemas";

import { SqliteCanvasHandoffRepository } from "./canvas-handoff-repository";
import { SqlitePolicyEngine } from "./policy-engine";

interface WorkspaceRow {
  readonly canvas_id: string;
  readonly project_id: string;
  readonly mission: string;
}

interface NodeRow {
  readonly id: string;
  readonly type: string;
  readonly data_json: string;
}

interface EdgeRow {
  readonly id: string;
  readonly target_node_id: string;
  readonly contract_json: string;
}

export interface CreateWorkspaceHandoffInput {
  readonly workspaceId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly summary: string;
  readonly artifact: WorkspaceArtifact | null;
  readonly createdByNodeId: string | null;
}

export interface ReviewWorkspaceHandoffInput {
  readonly workspaceId: string;
  readonly handoffId: string;
  readonly expectedRevision: number;
  readonly actedByNodeId: string | null;
}

export interface ApproveWorkspaceHandoffInput extends ReviewWorkspaceHandoffInput {
  readonly summary: string | null;
}

export interface RejectWorkspaceHandoffInput extends ReviewWorkspaceHandoffInput {
  readonly reason: string;
}

export class SqliteWorkspaceHandoffStore {
  private readonly sqlite: Database.Database;
  private readonly handoffs: SqliteCanvasHandoffRepository;
  private readonly policy: SqlitePolicyEngine;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.handoffs = new SqliteCanvasHandoffRepository(filename);
    this.policy = new SqlitePolicyEngine(filename);
  }

  public create(input: CreateWorkspaceHandoffInput): CanvasHandoff {
    if (input.summary.length > 8_000) throw new Error("Workspace handoff summary is too long");
    if (input.sourceNodeId === input.targetNodeId) {
      throw new Error("Workspace handoff source and target must differ");
    }
    this.policy.assertAllowed({
      workspaceId: input.workspaceId,
      actorNodeId: input.createdByNodeId,
      permission: "create_handoffs"
    });
    const workspace = this.requireWorkspace(input.workspaceId);
    const source = this.requireAgentNode(workspace.canvas_id, input.sourceNodeId, "source");
    const target = this.requireAgentNode(workspace.canvas_id, input.targetNodeId, "target");
    const edge = this.requireRoute(workspace.canvas_id, source.id, target.id);
    if (input.artifact !== null && input.artifact.workspaceId !== input.workspaceId) {
      throw new Error("Workspace handoff artifact does not belong to this workspace");
    }
    const mission = redactText(workspace.mission.trim());
    if (mission.length === 0)
      throw new Error("Write the workspace mission before creating a handoff");

    return this.handoffs.createDraft({
      canvasId: workspace.canvas_id,
      projectId: workspace.project_id,
      mission,
      source: source.snapshot,
      target: target.snapshot,
      edge,
      content: handoffDraftContentSchema.parse({
        summary: redactText(input.summary),
        evidence:
          input.artifact === null
            ? []
            : [
                {
                  label: `Artifact: ${redactText(input.artifact.filename)}`,
                  detail: `${input.artifact.id} · ${input.artifact.sha256} · ${input.artifact.relativePath}`
                }
              ]
      })
    });
  }

  /**
   * Prepares one reviewable handoff from the sole persisted handoff route. It deliberately stops
   * at `draft`: delivery still requires the existing manual review and terminal lifecycle.
   */
  public createWorkflowDraft(input: {
    readonly workspaceId: string;
    readonly sourceNodeId: string;
    readonly summary: string;
  }): CanvasHandoff {
    const workspace = this.requireWorkspace(input.workspaceId);
    const routes = (
      this.sqlite
        .prepare(
          `SELECT id, target_node_id, contract_json FROM canvas_edges
         WHERE canvas_id = ? AND source_node_id = ? ORDER BY id`
        )
        .all(workspace.canvas_id, input.sourceNodeId) as EdgeRow[]
    ).filter((route) => {
      const contract = edgeContractSchema.parse(JSON.parse(route.contract_json) as unknown);
      return contract.kind === "handoff";
    });
    if (routes.length !== 1) {
      throw new Error(
        routes.length === 0
          ? "Connect exactly one handoff route before preparing a workflow handoff"
          : "Workflow handoff route is ambiguous"
      );
    }
    const route = routes[0];
    if (route === undefined) throw new Error("Workflow handoff route was not found");
    return this.create({
      workspaceId: input.workspaceId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: route.target_node_id,
      summary: input.summary,
      artifact: null,
      createdByNodeId: input.sourceNodeId
    });
  }

  public list(workspaceId: string, limit = 50): readonly CanvasHandoff[] {
    const workspace = this.requireWorkspace(workspaceId);
    return this.handoffs.listByCanvas(workspace.canvas_id, limit);
  }

  public get(workspaceId: string, handoffId: string): CanvasHandoff {
    const workspace = this.requireWorkspace(workspaceId);
    const handoff = this.handoffs.get(handoffId);
    if (handoff === null || handoff.canvasId !== workspace.canvas_id) {
      throw new Error(`Workspace handoff not found: ${handoffId}`);
    }
    return handoff;
  }

  public listEvents(workspaceId: string, handoffId: string): readonly CanvasHandoffEvent[] {
    this.get(workspaceId, handoffId);
    return this.handoffs.listEvents(handoffId);
  }

  public approve(input: ApproveWorkspaceHandoffInput): CanvasHandoff {
    const handoff = this.get(input.workspaceId, input.handoffId);
    this.authorizeReview(input.workspaceId, input.actedByNodeId);
    const summary = input.summary === null ? handoff.content.summary : redactText(input.summary);
    const content: HandoffApprovedContent = handoffApprovedContentSchema.parse({
      ...handoff.content,
      summary
    });
    return this.handoffs.markReady(handoff.id, input.expectedRevision, content);
  }

  public reject(input: RejectWorkspaceHandoffInput): CanvasHandoff {
    const handoff = this.get(input.workspaceId, input.handoffId);
    this.authorizeReview(input.workspaceId, input.actedByNodeId);
    return this.handoffs.reject(handoff.id, input.expectedRevision, redactText(input.reason));
  }

  public cancel(input: ReviewWorkspaceHandoffInput): CanvasHandoff {
    const handoff = this.get(input.workspaceId, input.handoffId);
    this.authorizeReview(input.workspaceId, input.actedByNodeId);
    return this.handoffs.cancelDelivery(handoff.id, input.expectedRevision);
  }

  /** Retry only changes durable state; it never submits a terminal delivery. */
  public retry(input: ReviewWorkspaceHandoffInput): CanvasHandoff {
    const handoff = this.get(input.workspaceId, input.handoffId);
    this.authorizeReview(input.workspaceId, input.actedByNodeId);
    return this.handoffs.requestRetry(handoff.id, input.expectedRevision);
  }

  public close(): void {
    this.policy.close();
    this.handoffs.close();
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.sqlite
      .prepare(
        `SELECT w.canvas_id, w.project_id, c.mission
         FROM workspaces w JOIN canvases c ON c.id = w.canvas_id WHERE w.id = ?`
      )
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) throw new Error("Workspace handoff workspace was not found");
    return row;
  }

  private authorizeReview(workspaceId: string, nodeId: string | null): void {
    this.policy.assertAllowed({
      workspaceId,
      actorNodeId: nodeId,
      permission: "approve_deliveries"
    });
  }

  private requireAgentNode(
    canvasId: string,
    nodeId: string,
    role: "source" | "target"
  ): {
    readonly id: string;
    readonly snapshot: CanvasHandoff["source"];
  } {
    const node = this.requireNode(canvasId, nodeId);
    if (node.type !== "agent" && node.type !== "terminal") {
      throw new Error(`Workspace handoff ${role} must be an agent node`);
    }
    const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
    if (data.adapterId === undefined || data.adapterId === "shell") {
      throw new Error(`Workspace handoff ${role} must be an agent-capable terminal`);
    }
    if (data.role === undefined) {
      throw new Error(`Configure the role of the handoff ${role} before creating a handoff`);
    }
    return {
      id: node.id,
      snapshot: {
        nodeId: node.id,
        title: redactText(data.title),
        role: {
          name: redactText(data.role.name),
          responsibilities: redactText(data.role.responsibilities),
          constraints: redactText(data.role.constraints),
          expectedDeliverable: redactText(data.role.expectedDeliverable),
          completionCriteria: redactText(data.role.completionCriteria)
        }
      }
    };
  }

  private requireRoute(
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): CanvasHandoff["edge"] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, target_node_id, contract_json FROM canvas_edges
         WHERE canvas_id = ? AND source_node_id = ? AND target_node_id = ? ORDER BY id`
      )
      .all(canvasId, sourceNodeId, targetNodeId) as EdgeRow[];
    if (rows.length !== 1) {
      throw new Error(
        rows.length === 0
          ? "Connect the source to the target before creating a handoff"
          : "Workspace handoff route is ambiguous"
      );
    }
    const edge = rows[0];
    if (edge === undefined) throw new Error("Expected one workspace handoff route");
    const contract = edgeContractSchema.parse(JSON.parse(edge.contract_json) as unknown);
    return {
      edgeId: edge.id,
      contract: {
        ...contract,
        label: redactText(contract.label),
        handoffMode: "manual",
        ...(contract.sourceDeliverable === undefined
          ? {}
          : { sourceDeliverable: redactText(contract.sourceDeliverable) }),
        ...(contract.targetInstruction === undefined
          ? {}
          : { targetInstruction: redactText(contract.targetInstruction) })
      }
    };
  }

  private requireNode(canvasId: string, nodeId: string): NodeRow {
    const node = this.sqlite
      .prepare("SELECT id, type, data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
      .get(canvasId, nodeId) as NodeRow | undefined;
    if (node === undefined) throw new Error("Workspace handoff node was not found");
    return node;
  }
}
