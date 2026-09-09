import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  agentProfileSchema,
  missionSchema,
  setMissionSchema,
  setWorkspaceMemorySchema,
  workspaceMemorySchema
} from "@forgedeck/schemas";
import type {
  AgentProfile,
  Mission,
  SetMission,
  SetWorkspaceMemory,
  WorkspaceMemory
} from "@forgedeck/schemas";
import { canvasNodeDataSchema } from "@forgedeck/schemas";

interface WorkspaceRow {
  readonly canvas_id: string;
  readonly mission: string;
}

interface NodeRow {
  readonly type: string;
  readonly data_json: string;
}

interface AgentProfileRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly node_id: string;
  readonly version: number;
  readonly identity: string;
  readonly adapter_id: string;
  readonly responsibilities: string;
  readonly limits: string;
  readonly capabilities_json: string;
  readonly expected_deliverables_json: string;
  readonly created_by: string;
  readonly created_at: number;
}

interface MissionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly version: number;
  readonly objective: string;
  readonly scope_json: string;
  readonly decisions_json: string;
  readonly constraints_json: string;
  readonly progress: string;
  readonly blockers_json: string;
  readonly created_by: string;
  readonly created_at: number;
}

interface WorkspaceMemoryRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly version: number;
  readonly stack_json: string;
  readonly architecture: string;
  readonly patterns_json: string;
  readonly commands_json: string;
  readonly conventions_json: string;
  readonly technical_decisions_json: string;
  readonly created_by: string;
  readonly created_at: number;
}

export interface SqliteWorkspaceGovernanceStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

/**
 * Stores append-only identity, mission and workspace-memory packs used by later execution context.
 * It intentionally exposes no agent actor or permission mutation path: profiles mirror canvas roles.
 */
export class SqliteWorkspaceGovernanceStore {
  private readonly sqlite: Database.Database;
  private readonly createId: () => string;
  private readonly now: () => Date;

  public constructor(filename: string, options: SqliteWorkspaceGovernanceStoreOptions = {}) {
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /** Returns a versioned snapshot of the canvas role, appending only when that role has changed. */
  public getAgentProfile(workspaceId: string, nodeId: string): AgentProfile {
    return this.sqlite.transaction(() => {
      const workspace = this.requireWorkspace(workspaceId);
      const profile = this.profileFromCanvas(workspace, workspaceId, nodeId);
      const current = this.currentProfile(workspaceId, nodeId);
      if (current !== null && sameProfile(current, profile)) return current;
      return this.insertProfile({
        ...profile,
        id: this.createId(),
        version: (current?.version ?? 0) + 1,
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
    })();
  }

  public listAgentProfiles(
    workspaceId: string,
    nodeId: string,
    limit = 50
  ): readonly AgentProfile[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Agent profile list limit must be between 1 and 500");
    }
    this.requireWorkspace(workspaceId);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM agent_profiles WHERE workspace_id = ? AND node_id = ?
         ORDER BY version DESC LIMIT ?`
      )
      .all(workspaceId, nodeId, limit) as AgentProfileRow[];
    return rows.map(toAgentProfile);
  }

  /** Returns the active mission, materializing a new immutable version when the canvas objective changed. */
  public getMission(workspaceId: string): Mission | null {
    return this.sqlite.transaction(() => {
      const workspace = this.requireWorkspace(workspaceId);
      const objective = workspace.mission.trim();
      if (objective.length === 0) return null;
      const current = this.currentMission(workspaceId);
      if (current !== null && current.objective === objective) return current;
      return this.insertMission({
        id: this.createId(),
        workspaceId,
        version: (current?.version ?? 0) + 1,
        objective,
        scope: current?.scope ?? [],
        decisions: current?.decisions ?? [],
        constraints: current?.constraints ?? [],
        progress: current?.progress ?? "",
        blockers: current?.blockers ?? [],
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
    })();
  }

  /** Updates the compatibility canvas field and creates an immutable detailed mission version. */
  public setMission(input: SetMission): Mission {
    const parsed = setMissionSchema.parse(input);
    return this.sqlite.transaction(() => {
      const workspace = this.requireWorkspace(parsed.workspaceId);
      const current = this.currentMission(parsed.workspaceId);
      const timestamp = this.now();
      const result = this.sqlite
        .prepare(
          `UPDATE canvases SET mission = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(parsed.objective, timestamp.getTime(), workspace.canvas_id);
      if (result.changes !== 1) throw new Error("Workspace mission canvas was not found");
      return this.insertMission({
        id: this.createId(),
        workspaceId: parsed.workspaceId,
        version: (current?.version ?? 0) + 1,
        objective: parsed.objective,
        scope: parsed.scope,
        decisions: parsed.decisions,
        constraints: parsed.constraints,
        progress: parsed.progress,
        blockers: parsed.blockers,
        createdBy: "local-user",
        createdAt: timestamp.toISOString()
      });
    })();
  }

  public listMissions(workspaceId: string, limit = 50): readonly Mission[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Mission list limit must be between 1 and 500");
    }
    this.requireWorkspace(workspaceId);
    const rows = this.sqlite
      .prepare("SELECT * FROM missions WHERE workspace_id = ? ORDER BY version DESC LIMIT ?")
      .all(workspaceId, limit) as MissionRow[];
    return rows.map(toMission);
  }

  public getWorkspaceMemory(workspaceId: string): WorkspaceMemory | null {
    this.requireWorkspace(workspaceId);
    return this.currentMemory(workspaceId);
  }

  /** Appends a new workspace-memory version instead of mutating historical execution context. */
  public setWorkspaceMemory(input: SetWorkspaceMemory): WorkspaceMemory {
    const parsed = setWorkspaceMemorySchema.parse(input);
    return this.sqlite.transaction(() => {
      this.requireWorkspace(parsed.workspaceId);
      const current = this.currentMemory(parsed.workspaceId);
      return this.insertMemory({
        id: this.createId(),
        workspaceId: parsed.workspaceId,
        version: (current?.version ?? 0) + 1,
        stack: parsed.stack,
        architecture: parsed.architecture,
        patterns: parsed.patterns,
        commands: parsed.commands,
        conventions: parsed.conventions,
        technicalDecisions: parsed.technicalDecisions,
        createdBy: "local-user",
        createdAt: this.now().toISOString()
      });
    })();
  }

  public listWorkspaceMemories(workspaceId: string, limit = 50): readonly WorkspaceMemory[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Workspace memory list limit must be between 1 and 500");
    }
    this.requireWorkspace(workspaceId);
    const rows = this.sqlite
      .prepare(
        "SELECT * FROM workspace_memories WHERE workspace_id = ? ORDER BY version DESC LIMIT ?"
      )
      .all(workspaceId, limit) as WorkspaceMemoryRow[];
    return rows.map(toWorkspaceMemory);
  }

  public close(): void {
    this.sqlite.close();
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const row = this.sqlite
      .prepare(
        `SELECT w.canvas_id, c.mission
         FROM workspaces w JOIN canvases c ON c.id = w.canvas_id WHERE w.id = ?`
      )
      .get(workspaceId) as WorkspaceRow | undefined;
    if (row === undefined) throw new Error("Workspace governance workspace was not found");
    return row;
  }

  private profileFromCanvas(
    workspace: WorkspaceRow,
    workspaceId: string,
    nodeId: string
  ): Omit<AgentProfile, "id" | "version" | "createdBy" | "createdAt"> {
    const node = this.sqlite
      .prepare("SELECT type, data_json FROM canvas_nodes WHERE canvas_id = ? AND id = ?")
      .get(workspace.canvas_id, nodeId) as NodeRow | undefined;
    if (node === undefined || (node.type !== "agent" && node.type !== "terminal")) {
      throw new Error("Agent profile canvas agent was not found");
    }
    const data = canvasNodeDataSchema.parse(JSON.parse(node.data_json) as unknown);
    if (data.adapterId === undefined || data.adapterId === "shell") {
      throw new Error("Agent profile requires an agent-capable canvas node");
    }
    if (data.role === undefined)
      throw new Error("Configure the agent role before creating its profile");
    return {
      workspaceId,
      nodeId,
      identity: data.title,
      adapterId: data.adapterId,
      responsibilities: data.role.responsibilities,
      limits: data.role.constraints,
      capabilities: data.permissions.filter((permission) => permission.trim().length > 0),
      expectedDeliverables:
        data.role.expectedDeliverable.trim().length === 0 ? [] : [data.role.expectedDeliverable]
    };
  }

  private currentProfile(workspaceId: string, nodeId: string): AgentProfile | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM agent_profiles WHERE workspace_id = ? AND node_id = ?
         ORDER BY version DESC LIMIT 1`
      )
      .get(workspaceId, nodeId) as AgentProfileRow | undefined;
    return row === undefined ? null : toAgentProfile(row);
  }

  private currentMission(workspaceId: string): Mission | null {
    const row = this.sqlite
      .prepare("SELECT * FROM missions WHERE workspace_id = ? ORDER BY version DESC LIMIT 1")
      .get(workspaceId) as MissionRow | undefined;
    return row === undefined ? null : toMission(row);
  }

  private currentMemory(workspaceId: string): WorkspaceMemory | null {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM workspace_memories WHERE workspace_id = ? ORDER BY version DESC LIMIT 1"
      )
      .get(workspaceId) as WorkspaceMemoryRow | undefined;
    return row === undefined ? null : toWorkspaceMemory(row);
  }

  private insertProfile(value: AgentProfile): AgentProfile {
    const profile = agentProfileSchema.parse(value);
    this.sqlite
      .prepare(
        `INSERT INTO agent_profiles
         (id, workspace_id, node_id, version, identity, adapter_id, responsibilities, limits,
          capabilities_json, expected_deliverables_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profile.id,
        profile.workspaceId,
        profile.nodeId,
        profile.version,
        profile.identity,
        profile.adapterId,
        profile.responsibilities,
        profile.limits,
        JSON.stringify(profile.capabilities),
        JSON.stringify(profile.expectedDeliverables),
        profile.createdBy,
        Date.parse(profile.createdAt)
      );
    return profile;
  }

  private insertMission(value: Mission): Mission {
    const mission = missionSchema.parse(value);
    this.sqlite
      .prepare(
        `INSERT INTO missions
         (id, workspace_id, version, objective, scope_json, decisions_json, constraints_json,
          progress, blockers_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mission.id,
        mission.workspaceId,
        mission.version,
        mission.objective,
        JSON.stringify(mission.scope),
        JSON.stringify(mission.decisions),
        JSON.stringify(mission.constraints),
        mission.progress,
        JSON.stringify(mission.blockers),
        mission.createdBy,
        Date.parse(mission.createdAt)
      );
    return mission;
  }

  private insertMemory(value: WorkspaceMemory): WorkspaceMemory {
    const memory = workspaceMemorySchema.parse(value);
    this.sqlite
      .prepare(
        `INSERT INTO workspace_memories
         (id, workspace_id, version, stack_json, architecture, patterns_json, commands_json,
          conventions_json, technical_decisions_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memory.id,
        memory.workspaceId,
        memory.version,
        JSON.stringify(memory.stack),
        memory.architecture,
        JSON.stringify(memory.patterns),
        JSON.stringify(memory.commands),
        JSON.stringify(memory.conventions),
        JSON.stringify(memory.technicalDecisions),
        memory.createdBy,
        Date.parse(memory.createdAt)
      );
    return memory;
  }
}

function sameProfile(
  current: AgentProfile,
  candidate: Omit<AgentProfile, "id" | "version" | "createdBy" | "createdAt">
): boolean {
  return (
    current.identity === candidate.identity &&
    current.adapterId === candidate.adapterId &&
    current.responsibilities === candidate.responsibilities &&
    current.limits === candidate.limits &&
    JSON.stringify(current.capabilities) === JSON.stringify(candidate.capabilities) &&
    JSON.stringify(current.expectedDeliverables) === JSON.stringify(candidate.expectedDeliverables)
  );
}

function toAgentProfile(row: AgentProfileRow): AgentProfile {
  return agentProfileSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    version: row.version,
    identity: row.identity,
    adapterId: row.adapter_id,
    responsibilities: row.responsibilities,
    limits: row.limits,
    capabilities: parseStringList(row.capabilities_json, "Agent profile capabilities"),
    expectedDeliverables: parseStringList(
      row.expected_deliverables_json,
      "Agent profile expected deliverables"
    ),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function toMission(row: MissionRow): Mission {
  return missionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    objective: row.objective,
    scope: parseStringList(row.scope_json, "Mission scope"),
    decisions: parseStringList(row.decisions_json, "Mission decisions"),
    constraints: parseStringList(row.constraints_json, "Mission constraints"),
    progress: row.progress,
    blockers: parseStringList(row.blockers_json, "Mission blockers"),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function toWorkspaceMemory(row: WorkspaceMemoryRow): WorkspaceMemory {
  return workspaceMemorySchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    stack: parseStringList(row.stack_json, "Workspace memory stack"),
    architecture: row.architecture,
    patterns: parseStringList(row.patterns_json, "Workspace memory patterns"),
    commands: parseStringList(row.commands_json, "Workspace memory commands"),
    conventions: parseStringList(row.conventions_json, "Workspace memory conventions"),
    technicalDecisions: parseStringList(
      row.technical_decisions_json,
      "Workspace memory technical decisions"
    ),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  });
}

function parseStringList(value: string, label: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}
