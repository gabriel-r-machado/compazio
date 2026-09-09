import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { STAGING_IGNORE_CONTENTS } from "@forgedeck/local-db";
import {
  ORCHESTRATOR_GLOBAL_LIMITS,
  buildOrchestratorTeamInstructions,
  grantsTeamOrchestration
} from "@forgedeck/orchestration";
import { spawnAgentAdapterIdSchema } from "@forgedeck/schemas";
import type { WorkspaceAgentContext } from "@forgedeck/schemas";

/**
 * The subset of `SqliteWorkspaceContextStore` this module needs. Kept as an interface so
 * terminal-ipc tests can supply a fake instead of a real SQLite-backed store.
 */
export interface TerminalContextStore {
  resolve(input: {
    readonly workspaceId: string;
    readonly agentNodeId: string;
    readonly requesterNodeId: string | null;
  }): WorkspaceAgentContext;
}

export interface StageTerminalContextInput {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly contextStore: TerminalContextStore;
}

export interface StagedNote {
  readonly nodeId: string;
  readonly title: string;
  readonly content: string;
}

export interface StagedLink {
  readonly nodeId: string;
  readonly title: string;
  readonly url: string;
}

export interface StagedAttachment {
  readonly nodeId: string;
  readonly title: string;
  readonly filename: string;
  /** Absolute path inside `<project>/.compazio/runs/<sessionId>/inputs`. */
  readonly stagedPath: string;
  readonly mediaType?: string;
}

export interface StagedTerminalContext {
  readonly ok: true;
  readonly sessionId: string;
  /** The canvas node this session belongs to, so an orchestrator can address itself in `--from`. */
  readonly nodeId: string;
  readonly mission: string;
  /** Structural permissions granted to this node. Decides whether team instructions are included. */
  readonly permissions: readonly string[];
  /** The responsibility this terminal was given on the canvas, when it has one. */
  readonly role?: WorkspaceAgentContext["role"];
  readonly notes: readonly StagedNote[];
  readonly links: readonly StagedLink[];
  readonly attachments: readonly StagedAttachment[];
  readonly inputsDirectory: string;
  readonly manifestPath: string;
}

export interface TerminalContextUnavailable {
  readonly ok: false;
  /** Human-readable, names the specific material that could not be staged. */
  readonly reason: string;
}

/**
 * Resolves everything connected into a terminal node (notes, links, attachments, upstream
 * terminals) and materializes stageable bytes into `<project>/.compazio/runs/<sessionId>/inputs`
 * before the process starts. `file`/`folder` sources with no inline content and no published
 * artifact have no bytes anywhere in the current data model (local file/folder paths are
 * intentionally never stored on a canvas node — see ADR 039) — those block staging instead of
 * silently starting a session that still can't see the material.
 */
export function stageTerminalContext(
  input: StageTerminalContextInput
): StagedTerminalContext | TerminalContextUnavailable {
  const context = input.contextStore.resolve({
    workspaceId: input.workspaceId,
    agentNodeId: input.nodeId,
    requesterNodeId: null
  });

  const notes: StagedNote[] = [];
  const links: StagedLink[] = [];
  const pendingFiles: {
    readonly nodeId: string;
    readonly title: string;
    readonly filename: string;
    readonly mediaType?: string;
    readonly write: (targetPath: string) => void;
  }[] = [];
  const unavailable: string[] = [];

  for (const source of context.sources) {
    switch (source.kind) {
      case "note":
      case "text":
      case "drawing":
      case "page": {
        if (source.content !== undefined && source.content.trim().length > 0) {
          notes.push({ nodeId: source.nodeId, title: source.title, content: source.content });
        }
        break;
      }
      case "link": {
        if (source.reference?.url !== undefined) {
          links.push({ nodeId: source.nodeId, title: source.title, url: source.reference.url });
        }
        break;
      }
      case "artifact": {
        if (source.artifact === undefined) {
          unavailable.push(`${source.title} (artefato sem arquivo publicado)`);
          break;
        }
        const artifact = source.artifact;
        const sourcePath = join(input.projectRoot, artifact.relativePath);
        if (!existsSync(sourcePath)) {
          unavailable.push(`${source.title} (arquivo do artefato não existe mais em disco)`);
          break;
        }
        pendingFiles.push({
          nodeId: source.nodeId,
          title: source.title,
          filename: artifact.filename,
          mediaType: artifact.mediaType,
          write: (targetPath) => copyFileSync(sourcePath, targetPath)
        });
        break;
      }
      case "image": {
        const dataUri = source.reference?.previewDataUri;
        if (dataUri === undefined) {
          unavailable.push(`${source.title} (imagem sem bytes disponíveis)`);
          break;
        }
        const decoded = decodeDataUri(dataUri);
        pendingFiles.push({
          nodeId: source.nodeId,
          title: source.title,
          filename: source.reference?.filename ?? `${sanitizeBaseName(source.title)}.png`,
          mediaType: source.reference?.mediaType ?? decoded.mediaType,
          write: (targetPath) => writeFileSync(targetPath, decoded.buffer)
        });
        break;
      }
      case "file":
      case "folder": {
        unavailable.push(`${source.title} (sem conteúdo disponível — publique como artefato)`);
        break;
      }
    }
  }

  if (unavailable.length > 0) {
    return {
      ok: false,
      reason: `Materiais indisponíveis: ${unavailable.join(", ")}`
    };
  }

  const runDirectory = terminalContextDirectory(input.projectRoot, input.sessionId);
  const inputsDirectory = join(runDirectory, "inputs");
  try {
    mkdirSync(inputsDirectory, { recursive: true });
    protectStagingRoot(input.projectRoot);
    const attachments: StagedAttachment[] = [];
    const usedNames = new Set<string>();
    for (const pending of pendingFiles) {
      const filename = uniqueFilename(usedNames, sanitizeFilename(pending.filename));
      const targetPath = join(inputsDirectory, filename);
      if (!isPathInside(inputsDirectory, targetPath)) {
        throw new Error("Staged attachment target escapes the inputs directory");
      }
      pending.write(targetPath);
      attachments.push({
        nodeId: pending.nodeId,
        title: pending.title,
        filename,
        stagedPath: targetPath,
        ...(pending.mediaType === undefined ? {} : { mediaType: pending.mediaType })
      });
    }

    const manifestPath = join(runDirectory, "context-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          sessionId: input.sessionId,
          nodeId: input.nodeId,
          mission: context.mission,
          notes: notes.map((note) => ({ nodeId: note.nodeId, title: note.title })),
          links,
          attachments: attachments.map((attachment) => ({
            nodeId: attachment.nodeId,
            title: attachment.title,
            filename: attachment.filename,
            stagedPath: attachment.stagedPath,
            mediaType: attachment.mediaType ?? null
          }))
        },
        null,
        2
      ),
      "utf8"
    );

    return {
      ok: true,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      mission: context.mission,
      permissions: context.permissions,
      ...(context.role === undefined ? {} : { role: context.role }),
      notes,
      links,
      attachments,
      inputsDirectory,
      manifestPath
    };
  } catch (error: unknown) {
    rmSync(runDirectory, { force: true, recursive: true });
    throw error;
  }
}

/** Absolute directory that holds one session's staged inputs and its manifest. */
export function terminalContextDirectory(projectRoot: string, sessionId: string): string {
  return join(stagingRoot(projectRoot), "runs", sessionId);
}

/**
 * Drops one session's staged inputs once that session can no longer read them. Copies of a user's
 * notes and attachments must not outlive the process they were staged for, so this runs on every
 * terminal state — succeeded, failed, cancelled or interrupted. Calling it for a session that never
 * staged anything is a no-op.
 */
export function releaseTerminalContext(input: {
  readonly projectRoot: string;
  readonly sessionId: string;
}): void {
  rmSync(terminalContextDirectory(input.projectRoot, input.sessionId), {
    force: true,
    recursive: true
  });
  pruneEmptyStagingDirectories(input.projectRoot);
}

/**
 * Removes staged directories that no live session owns. A crash or a kill leaves the owning process
 * no chance to release its own staging, so the host sweeps at startup — the same audited recovery
 * shape used for stale leases and interrupted sessions. Returns how many directories were removed.
 */
export function sweepTerminalContexts(input: {
  readonly projectRoot: string;
  readonly activeSessionIds: readonly string[];
}): number {
  const runsDirectory = join(stagingRoot(input.projectRoot), "runs");
  if (!existsSync(runsDirectory)) {
    return 0;
  }
  const active = new Set(input.activeSessionIds);
  let removed = 0;
  for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || active.has(entry.name)) {
      continue;
    }
    rmSync(join(runsDirectory, entry.name), { force: true, recursive: true });
    removed += 1;
  }
  pruneEmptyStagingDirectories(input.projectRoot);
  return removed;
}

function stagingRoot(projectRoot: string): string {
  return join(projectRoot, ".compazio");
}

/**
 * Keeps staged material out of the user's version control. The staging root lives inside their
 * project, so an ignore file written next to it protects every project without the product editing
 * a file the user owns. An existing file is never overwritten.
 */
function protectStagingRoot(projectRoot: string): void {
  const ignorePath = join(stagingRoot(projectRoot), ".gitignore");
  if (existsSync(ignorePath)) {
    return;
  }
  writeFileSync(ignorePath, STAGING_IGNORE_CONTENTS, "utf8");
}

/** Leaves no empty `runs/` or `.compazio/` behind, without disturbing a directory still in use. */
function pruneEmptyStagingDirectories(projectRoot: string): void {
  const root = stagingRoot(projectRoot);
  removeDirectoryIfEmpty(join(root, "runs"));
  // The staging root also holds the ignore file, which alone must not keep the directory alive.
  if (existsSync(root)) {
    const remaining = readdirSync(root);
    if (remaining.length === 1 && remaining[0] === ".gitignore") {
      rmSync(join(root, ".gitignore"), { force: true });
      removeDirectoryIfEmpty(root);
    }
  }
}

function removeDirectoryIfEmpty(directory: string): void {
  try {
    rmdirSync(directory);
  } catch {
    // Not empty, already gone, or in use by another part of the product: leave it alone.
  }
}

/**
 * Builds the text typed into the terminal's PTY right after the process spawns. There is no
 * terminal -> terminal raw-output passthrough here by design: per this repo's local-first
 * principles, raw terminal output is observability, not a protocol or a deliverable. A real
 * deliverable between terminals is a published artifact connected like any other material, and
 * flows through the `artifact` branch above like any other attachment.
 */
export function buildTerminalContextPrompt(staged: StagedTerminalContext): string {
  const lines: string[] = [
    "== Compazio Context ==",
    staged.mission.length > 0 ? `Missão: ${staged.mission}` : "Missão: (nenhuma definida)",
    `Notas: ${staged.notes.length}`,
    `Anexos: ${staged.attachments.length}`,
    `Workspace: ${staged.inputsDirectory}`,
    ""
  ];

  // The responsibility comes before the materials: what the agent is here to do frames how it reads
  // everything below. A terminal without a role says nothing rather than inventing one.
  if (staged.role !== undefined) {
    lines.push(
      `## Seu papel: ${staged.role.name}`,
      ...describeRoleField("Responsabilidades", staged.role.responsibilities),
      ...describeRoleField("Restrições", staged.role.constraints),
      ...describeRoleField("Entrega esperada", staged.role.expectedDeliverable),
      ...describeRoleField("Critério de conclusão", staged.role.completionCriteria),
      ""
    );
  }

  if (staged.notes.length > 0) {
    lines.push("## Notas conectadas");
    for (const note of staged.notes) {
      lines.push(`### ${note.title}`, note.content, "");
    }
  }

  if (staged.attachments.length > 0) {
    lines.push("## Anexos disponíveis (já copiados para este workspace)");
    for (const attachment of staged.attachments) {
      lines.push(`- ${attachment.title}: ${attachment.stagedPath}`);
    }
    lines.push("");
  }

  if (staged.links.length > 0) {
    lines.push("## Links conectados");
    for (const link of staged.links) {
      lines.push(`- ${link.title}: ${link.url}`);
    }
    lines.push("");
  }

  lines.push(
    "Leia os materiais acima antes de perguntar por eles — os anexos já estão nos caminhos",
    "listados e as notas já estão com o conteúdo completo acima. Não peça para reenviar nada disso."
  );

  // The team surface comes last, after the agent knows who it is and what it is holding. It is only
  // included for a node that actually holds `create_agents`: telling an agent to recruit when the
  // Policy Engine will deny every attempt produces a terminal that argues with itself.
  if (grantsTeamOrchestration(staged.permissions)) {
    lines.push(
      "",
      buildOrchestratorTeamInstructions({
        selfNodeId: staged.nodeId,
        usableRuntimeIds: [...spawnAgentAdapterIdSchema.options],
        maxSpawnedAgents: ORCHESTRATOR_GLOBAL_LIMITS.maxSpawnedAgents,
        maxConcurrentAgents: ORCHESTRATOR_GLOBAL_LIMITS.maxConcurrentAgents
      })
    );
  }

  return lines.join("\n");
}

/** An empty role field is left out entirely, so the prompt never shows a labelled blank. */
function describeRoleField(label: string, value: string): readonly string[] {
  return value.trim().length === 0 ? [] : [`${label}: ${value}`];
}

function decodeDataUri(dataUri: string): { readonly mediaType: string; readonly buffer: Buffer } {
  const match = /^data:(?<mediaType>[^;,]+);base64,(?<encoded>[\s\S]+)$/.exec(dataUri);
  const mediaType = match?.groups?.mediaType;
  const encoded = match?.groups?.encoded;
  if (mediaType === undefined || encoded === undefined) {
    throw new Error("Invalid inline image data URI");
  }
  return { mediaType, buffer: Buffer.from(encoded, "base64") };
}

function sanitizeBaseName(title: string): string {
  const cleaned = title.replace(/[^\p{L}\p{N}\-_. ]/gu, "").trim();
  return cleaned.length > 0 ? cleaned : "material";
}

function sanitizeFilename(filename: string): string {
  // Keep letters (incl. accented), digits and common punctuation; strip path separators and any
  // parent-directory segment so a crafted node title/filename can never traverse out of the
  // staging directory.
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const cleaned = base.replace(/[^\p{L}\p{N}\-_. ]/gu, "_").trim();
  return cleaned.length > 0 ? cleaned : "material";
}

function uniqueFilename(used: Set<string>, filename: string): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const dotIndex = filename.lastIndexOf(".");
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : "";
  let attempt = 2;
  let candidate = `${stem}-${attempt}${extension}`;
  while (used.has(candidate)) {
    attempt += 1;
    candidate = `${stem}-${attempt}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}
