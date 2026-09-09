import Database from "better-sqlite3";

import {
  canvasNodeDataSchema,
  canvasSnapshotSchema,
  canvasViewportSchema,
  edgeContractSchema
} from "@forgedeck/schemas";
import type { CanvasSnapshot } from "@forgedeck/schemas";

interface CanvasRow {
  readonly id: string;
  readonly title: string;
  readonly mission: string;
  readonly creation_mode: string;
  readonly execution_profile: string;
  readonly revision: number;
  readonly viewport_json: string;
}

interface CanvasNodeRow {
  readonly id: string;
  readonly type: CanvasSnapshot["nodes"][number]["type"];
  readonly position_x: number;
  readonly position_y: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly z_index: number | null;
  readonly data_json: string;
}

interface CanvasEdgeRow {
  readonly id: string;
  readonly source_node_id: string;
  readonly target_node_id: string;
  readonly contract_json: string;
}

export interface SaveCanvasResult {
  readonly revision: number;
  readonly updatedAt: string;
}

export class SqliteCanvasRepository {
  private readonly sqlite: Database.Database;

  public constructor(filename: string) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  public load(canvasId: string): CanvasSnapshot | null {
    const canvas = this.sqlite
      .prepare(
        "SELECT id, title, mission, creation_mode, execution_profile, revision, viewport_json FROM canvases WHERE id = ?"
      )
      .get(canvasId) as CanvasRow | undefined;
    if (canvas === undefined) {
      return null;
    }
    const nodes = this.sqlite
      .prepare(
        "SELECT id, type, position_x, position_y, width, height, z_index, data_json FROM canvas_nodes WHERE canvas_id = ? ORDER BY rowid"
      )
      .all(canvasId) as CanvasNodeRow[];
    const edges = this.sqlite
      .prepare(
        "SELECT id, source_node_id, target_node_id, contract_json FROM canvas_edges WHERE canvas_id = ? ORDER BY rowid"
      )
      .all(canvasId) as CanvasEdgeRow[];

    return canvasSnapshotSchema.parse({
      id: canvas.id,
      title: canvas.title,
      ...(canvas.mission === "" ? {} : { mission: canvas.mission }),
      creationMode: canvas.creation_mode,
      executionProfile: canvas.execution_profile,
      revision: canvas.revision,
      viewport: canvasViewportSchema.parse(parseJson(canvas.viewport_json)),
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { x: node.position_x, y: node.position_y },
        ...(node.width === null ? {} : { width: node.width }),
        ...(node.height === null ? {} : { height: node.height }),
        ...(node.z_index === null ? {} : { zIndex: node.z_index }),
        data: canvasNodeDataSchema.parse(parseJson(node.data_json))
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        contract: edgeContractSchema.parse(parseJson(edge.contract_json))
      }))
    });
  }

  public save(input: CanvasSnapshot): SaveCanvasResult {
    const snapshot = canvasSnapshotSchema.parse(input);
    const now = new Date();
    const transaction = this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare("SELECT revision FROM canvases WHERE id = ?")
        .get(snapshot.id) as { readonly revision: number } | undefined;
      if (existing === undefined && snapshot.revision !== 0) {
        throw new Error("Canvas revision conflict: new canvas must start at revision 0");
      }
      if (existing !== undefined && existing.revision !== snapshot.revision) {
        throw new Error(
          `Canvas revision conflict: expected ${existing.revision}, received ${snapshot.revision}`
        );
      }
      const nextRevision = snapshot.revision + 1;
      this.sqlite
        .prepare(
          `INSERT INTO canvases (id, title, mission, creation_mode, execution_profile, revision, viewport_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             mission = excluded.mission,
             creation_mode = excluded.creation_mode,
             execution_profile = excluded.execution_profile,
             revision = excluded.revision,
             viewport_json = excluded.viewport_json,
             updated_at = excluded.updated_at`
        )
        .run(
          snapshot.id,
          snapshot.title,
          snapshot.mission ?? "",
          snapshot.creationMode,
          snapshot.executionProfile,
          nextRevision,
          JSON.stringify(snapshot.viewport),
          now.getTime(),
          now.getTime()
        );
      this.sqlite.prepare("DELETE FROM canvas_edges WHERE canvas_id = ?").run(snapshot.id);
      this.sqlite.prepare("DELETE FROM canvas_nodes WHERE canvas_id = ?").run(snapshot.id);

      const insertNode = this.sqlite.prepare(
        `INSERT INTO canvas_nodes
          (canvas_id, id, type, position_x, position_y, width, height, z_index, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const node of snapshot.nodes) {
        insertNode.run(
          snapshot.id,
          node.id,
          node.type,
          node.position.x,
          node.position.y,
          node.width ?? null,
          node.height ?? null,
          node.zIndex ?? null,
          JSON.stringify(node.data)
        );
      }
      const insertEdge = this.sqlite.prepare(
        `INSERT INTO canvas_edges
          (canvas_id, id, source_node_id, target_node_id, contract_json)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const edge of snapshot.edges) {
        insertEdge.run(
          snapshot.id,
          edge.id,
          edge.source,
          edge.target,
          JSON.stringify(edge.contract)
        );
      }
      return nextRevision;
    });

    return { revision: transaction(), updatedAt: now.toISOString() };
  }

  public close(): void {
    this.sqlite.close();
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Stored canvas JSON is invalid");
  }
}
