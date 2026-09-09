import { rm } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  AtomicWriteError,
  BACKUP_SUFFIX,
  isMissingFile,
  pruneOrphanTemporaries,
  readFileWithRecovery,
  writeFileAtomically,
  type RecoveredRead
} from "./atomic-file";

import {
  WORKSPACE_SCHEMA_VERSION,
  agentCatalogSchema,
  defaultAgentCatalog,
  createEmptyOperationalState,
  migrateOperationalState,
  migrateWorkspace,
  serializeWorkspace,
  type Workspace,
  type AgentCatalog,
  type WorkspaceOperationalState,
  type WorkspaceIndex,
  type WorkspaceSummary,
  workspaceOperationalStateSchema,
  workspaceIndexSchema
} from "@forgedeck/compazio-v2-domain";

const INDEX_FILE = "index.json";
const AGENT_CATALOG_FILE = "agents.json";

/** Told about every fallback read, so the app can inform the user without blocking the workspace. */
export type RecoveryReporter = (event: {
  readonly file: string;
  readonly source: "backup" | "orphan-temporary";
  readonly recoveredFrom: string;
  readonly reason: string;
}) => void;

export interface V2WorkspaceRepositoryOptions {
  readonly rootDirectory: string;
  readonly now?: () => string;
  readonly onRecovery?: RecoveryReporter;
}

export class WorkspacePersistenceError extends Error {
  public override readonly cause?: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WorkspacePersistenceError";
    this.cause = cause;
  }

  /**
   * Structured cause of the underlying filesystem failure: errno, code, syscall, source and
   * destination, attempts, duration and pid. Undefined when the failure was not a write.
   */
  public get diagnostics(): AtomicWriteError["diagnostics"] | undefined {
    let current: unknown = this.cause;
    while (current instanceof Error) {
      if (current instanceof AtomicWriteError) return current.diagnostics;
      current = (current as { cause?: unknown }).cause;
    }
    return undefined;
  }
}

/**
 * A self-contained, file-backed store for V2. It does not read, migrate or alter the legacy SQLite
 * store. Every workspace and the small index are validated before use and replaced atomically.
 */
export class V2WorkspaceRepository {
  private readonly rootDirectory: string;
  private readonly now: () => string;
  private readonly onRecovery: RecoveryReporter | undefined;
  /**
   * Orders multi-file transactions such as create (write workspace, then index). Exclusive access
   * to each individual file comes from the process-wide per-path lock in atomic-file.
   */
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(options: V2WorkspaceRepositoryOptions) {
    this.rootDirectory = options.rootDirectory;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onRecovery = options.onRecovery;
  }

  public async list(): Promise<{
    readonly workspaces: readonly WorkspaceSummary[];
    readonly lastOpenedWorkspaceId: string | null;
  }> {
    const index = await this.loadIndex();
    const summaries: WorkspaceSummary[] = [];
    for (const workspaceId of index.workspaceIds) {
      try {
        const workspace = await this.get(workspaceId);
        summaries.push({
          id: workspace.id,
          name: workspace.name,
          workingDirectory: workspace.workingDirectory,
          updatedAt: workspace.updatedAt
        });
      } catch (error: unknown) {
        if (error instanceof WorkspacePersistenceError) throw error;
        throw new WorkspacePersistenceError(`Unable to load workspace ${workspaceId}`, error);
      }
    }
    return { workspaces: summaries, lastOpenedWorkspaceId: index.lastOpenedWorkspaceId };
  }

  public async get(workspaceId: string): Promise<Workspace> {
    assertWorkspaceId(workspaceId);
    return this.readWorkspaceWithBackup(this.workspacePath(workspaceId));
  }

  public async create(workspace: Workspace): Promise<Workspace> {
    return this.mutate(async () => {
      const index = await this.loadIndex();
      if (index.workspaceIds.includes(workspace.id)) {
        throw new WorkspacePersistenceError(`Workspace already exists: ${workspace.id}`);
      }
      await this.writeWorkspace(workspace);
      await this.writeIndex({
        ...index,
        workspaceIds: [...index.workspaceIds, workspace.id],
        lastOpenedWorkspaceId: workspace.id,
        updatedAt: this.now()
      });
      return workspace;
    });
  }

  public async save(workspace: Workspace): Promise<Workspace> {
    return this.mutate(async () => {
      const index = await this.loadIndex();
      if (!index.workspaceIds.includes(workspace.id)) {
        throw new WorkspacePersistenceError(`Cannot save unknown workspace: ${workspace.id}`);
      }
      await this.writeWorkspace(workspace);
      return workspace;
    });
  }

  public async setLastOpened(workspaceId: string | null): Promise<void> {
    await this.mutate(async () => {
      const index = await this.loadIndex();
      if (workspaceId !== null && !index.workspaceIds.includes(workspaceId)) {
        throw new WorkspacePersistenceError(`Cannot open unknown workspace: ${workspaceId}`);
      }
      await this.writeIndex({
        ...index,
        lastOpenedWorkspaceId: workspaceId,
        updatedAt: this.now()
      });
    });
  }

  /**
   * Global V2-only agent metadata: presets, role library and safe installation cache.
   *
   * The read takes the same per-path lock as the write. That is the fix for the reproduced
   * production failure: a concurrent reader holding this file open is what made the replacing
   * rename fail with EPERM on Windows, which surfaced as "Atomic write failed for agents.json".
   */
  public async loadAgentCatalog(): Promise<AgentCatalog> {
    const path = this.agentCatalogPath();
    const recovered = await this.recoverRead(path, AGENT_CATALOG_FILE, {
      operation: "loadAgentCatalog",
      parse: (contents) => agentCatalogSchema.parse(JSON.parse(contents) as unknown),
      whenMissing: () => defaultAgentCatalog(this.now())
    });
    return recovered.value;
  }

  public async saveAgentCatalog(catalog: AgentCatalog): Promise<AgentCatalog> {
    const validated = agentCatalogSchema.parse(catalog);
    await this.write(this.agentCatalogPath(), JSON.stringify(validated, null, 2), {
      operation: "saveAgentCatalog",
      // Re-validating the exact bytes keeps a serialization defect from ever replacing a good file.
      validate: (contents) => void agentCatalogSchema.parse(JSON.parse(contents) as unknown),
      keepBackup: true
    });
    return validated;
  }

  /** Drops temporaries left by a process that died mid-write. Primary and backup are never touched. */
  public async pruneAbandonedTemporaries(): Promise<readonly string[]> {
    const removed: string[] = [];
    for (const path of [this.agentCatalogPath(), join(this.rootDirectory, INDEX_FILE)])
      removed.push(...(await pruneOrphanTemporaries(path)));
    return removed;
  }

  /**
   * Operational history is isolated from the canvas document. Small activity writes therefore do
   * not serialize terminal/note state or duplicate terminal output.
   */
  public async loadOperationalState(workspaceId: string): Promise<WorkspaceOperationalState> {
    assertWorkspaceId(workspaceId);
    const path = this.operationalPath(workspaceId);
    const recovered = await this.recoverRead(path, `operations/${workspaceId}.json`, {
      operation: "loadOperationalState",
      parse: (contents) => migrateOperationalState(JSON.parse(contents) as unknown, this.now()),
      whenMissing: () => createEmptyOperationalState(workspaceId, this.now())
    });
    return recovered.value;
  }

  public async saveOperationalState(
    state: WorkspaceOperationalState
  ): Promise<WorkspaceOperationalState> {
    return this.mutate(async () => {
      const validated = workspaceOperationalStateSchema.parse(state);
      const index = await this.loadIndex();
      if (!index.workspaceIds.includes(validated.workspaceId)) {
        throw new WorkspacePersistenceError(
          `Cannot save operations for unknown workspace: ${validated.workspaceId}`
        );
      }
      await this.write(
        this.operationalPath(validated.workspaceId),
        JSON.stringify(validated, null, 2),
        {
          operation: "saveOperationalState",
          validate: (contents) =>
            void workspaceOperationalStateSchema.parse(JSON.parse(contents) as unknown),
          keepBackup: true
        }
      );
      return validated;
    });
  }

  /** Removes V2 metadata only; the user's chosen working directory is never touched. */
  public async delete(workspaceId: string): Promise<void> {
    await this.mutate(async () => {
      assertWorkspaceId(workspaceId);
      const index = await this.loadIndex();
      if (!index.workspaceIds.includes(workspaceId)) return;

      // Delete data first. A crash before the index update leaves an index entry that resolves to no
      // file, never a deleted workspace that can be resurrected with stale content.
      await rm(this.workspacePath(workspaceId), { force: true });
      await rm(`${this.workspacePath(workspaceId)}${BACKUP_SUFFIX}`, { force: true });
      await rm(this.operationalPath(workspaceId), { force: true });
      await rm(`${this.operationalPath(workspaceId)}${BACKUP_SUFFIX}`, { force: true });
      await this.writeIndex({
        ...index,
        workspaceIds: index.workspaceIds.filter((id) => id !== workspaceId),
        lastOpenedWorkspaceId:
          index.lastOpenedWorkspaceId === workspaceId ? null : index.lastOpenedWorkspaceId,
        updatedAt: this.now()
      });
    });
  }

  private async loadIndex(): Promise<WorkspaceIndex> {
    const path = join(this.rootDirectory, INDEX_FILE);
    const recovered = await this.recoverRead(path, INDEX_FILE, {
      operation: "loadIndex",
      parse: (contents) => migrateIndex(JSON.parse(contents) as unknown, this.now()),
      whenMissing: () => this.emptyIndex()
    });
    return recovered.value;
  }

  private async readWorkspaceWithBackup(path: string): Promise<Workspace> {
    const recovered = await this.recoverRead(path, `workspaces/${basename(path)}`, {
      operation: "readWorkspace",
      parse: (contents) => migrateWorkspace(JSON.parse(contents) as unknown)
    });
    return recovered.value;
  }

  private async writeWorkspace(workspace: Workspace): Promise<void> {
    assertWorkspaceId(workspace.id);
    await this.write(this.workspacePath(workspace.id), serializeWorkspace(workspace), {
      operation: "writeWorkspace",
      validate: (contents) => void migrateWorkspace(JSON.parse(contents) as unknown),
      keepBackup: true
    });
  }

  private async writeIndex(index: WorkspaceIndex): Promise<void> {
    const validated = workspaceIndexSchema.parse(index);
    await this.write(join(this.rootDirectory, INDEX_FILE), JSON.stringify(validated, null, 2), {
      operation: "writeIndex",
      validate: (contents) => void workspaceIndexSchema.parse(JSON.parse(contents) as unknown),
      keepBackup: true
    });
  }

  /**
   * The single write path. Every file this repository owns goes through it, so no caller can
   * replace a file without the per-path lock, the Windows retry and the read-back confirmation.
   */
  private async write(
    path: string,
    contents: string,
    options: {
      readonly operation: string;
      readonly validate: (contents: string) => void;
      readonly keepBackup: boolean;
    }
  ): Promise<void> {
    try {
      await writeFileAtomically(path, contents, options);
    } catch (error: unknown) {
      // The friendly message stays; the structured cause is reachable through `diagnostics`.
      throw new WorkspacePersistenceError(`Atomic write failed for ${path}`, error);
    }
  }

  /** Reads through the same lock as writes, falling back to backup and then to a valid temporary. */
  private async recoverRead<T>(
    path: string,
    label: string,
    options: {
      readonly operation: string;
      readonly parse: (contents: string) => T;
      readonly whenMissing?: () => T;
    }
  ): Promise<RecoveredRead<T>> {
    let recovered: RecoveredRead<T>;
    try {
      recovered = await readFileWithRecovery(path, options);
    } catch (error: unknown) {
      if (isMissingFile(error)) throw error;
      throw new WorkspacePersistenceError(
        `The V2 file is invalid. The original file was preserved at ${path}.`,
        error
      );
    }
    if (recovered.source === "backup" || recovered.source === "orphan-temporary") {
      this.onRecovery?.({
        file: label,
        source: recovered.source,
        recoveredFrom: recovered.recoveredFrom ?? "",
        reason: recovered.reason ?? ""
      });
    }
    return recovered;
  }

  private agentCatalogPath(): string {
    return join(this.rootDirectory, AGENT_CATALOG_FILE);
  }

  private workspacePath(workspaceId: string): string {
    return join(this.rootDirectory, "workspaces", `${workspaceId}.json`);
  }

  private operationalPath(workspaceId: string): string {
    return join(this.rootDirectory, "operations", `${workspaceId}.json`);
  }

  private emptyIndex(): WorkspaceIndex {
    return {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceIds: [],
      lastOpenedWorkspaceId: null,
      updatedAt: this.now()
    };
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * The index only carries workspace summaries, so every earlier version upgrades by stamping the
 * current one. Enumerating the old versions individually meant each schema bump silently made
 * existing indexes unreadable; comparing against the current version keeps that from recurring.
 */
function migrateIndex(value: unknown, now: string): WorkspaceIndex {
  if (typeof value === "object" && value !== null && "schemaVersion" in value) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.schemaVersion === "number" &&
      Number.isInteger(record.schemaVersion) &&
      record.schemaVersion >= 1 &&
      record.schemaVersion < WORKSPACE_SCHEMA_VERSION
    ) {
      return workspaceIndexSchema.parse({
        ...record,
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        updatedAt: now
      });
    }
  }
  return workspaceIndexSchema.parse(value);
}

function assertWorkspaceId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new WorkspacePersistenceError("Invalid workspace id");
  }
}
