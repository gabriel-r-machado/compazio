import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

/**
 * Preventive isolation for the read-only planning turn.
 *
 * Fingerprinting the workspace before and after an analysis DETECTS a mutation, but only after it already
 * happened. The planning agent is launched with editing capability, so detection is not enough: the real
 * project must never be reachable. This builds a disposable snapshot containing only what analysis needs,
 * the planning turn runs with its cwd there, and the real workspace is never in its allowed roots. Anything
 * the agent writes lands in the snapshot and dies with it.
 *
 * What is copied is an allowlist, never "everything except": manifests, the documents that describe the
 * project, and the shape of the tree. What is refused is refused twice — by the allowlist and by an
 * explicit secret-shaped-name check — so a credential cannot be copied even if it were also a manifest.
 */

/** Files worth copying by exact name: manifests and the documents that explain the project. */
const ALLOWED_FILENAMES: ReadonlySet<string> = new Set([
  "CLAUDE.md",
  "README.md",
  "AGENTS.md",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.package.json",
  ".gitignore"
]);

/** Inside a documentation directory, these extensions are analysis material. */
const ALLOWED_DOCUMENT_EXTENSIONS: readonly string[] = [".md", ".json", ".yaml", ".yml"];

/** Directories that describe the project and may be walked for documents. */
const DOCUMENT_DIRECTORIES: ReadonlySet<string> = new Set(["docs", "specs", ".claude"]);

/** Never walked: build output, dependencies, version control, managed staging. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "out-e2e",
  ".turbo",
  ".forgedeck",
  ".next",
  "coverage",
  ".cache",
  ".vscode",
  ".idea",
  "build"
]);

/**
 * Names that may hold a secret. Matched case-insensitively against the basename and refused outright, so a
 * file called `.env`, `credentials.json` or `id_rsa` is never copied no matter which rule would allow it.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /(^|[.\-_])secret/i,
  /(^|[.\-_])credential/i,
  /(^|[.\-_])password/i,
  /(^|[.\-_])token/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.aws$/i,
  /^\.ssh$/i,
  /^\.git-credentials$/i
];

/** Bounds, so a snapshot can never become an unbounded copy of a large repository. */
const MAX_DEPTH = 3;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 128 * 1024;

export interface PlanningSnapshot {
  /** Absolute path the planning turn must use as its cwd. Never the real workspace. */
  readonly path: string;
  /** Workspace-relative paths that were copied, for auditing what analysis could see. */
  readonly files: readonly string[];
  /** Removes the snapshot. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** Creates the disposable analysis copy. Callers must always dispose it, including on failure. */
export interface PlanningIsolation {
  create(workspaceRoot: string): Promise<PlanningSnapshot>;
}

export interface CreatePlanningSnapshotOptions {
  readonly workspaceRoot: string;
  /** Parent directory for the snapshot; defaults to the OS temp dir, always outside the workspace. */
  readonly snapshotParent?: string;
}

export async function createPlanningSnapshot(
  options: CreatePlanningSnapshotOptions
): Promise<PlanningSnapshot> {
  const parent = options.snapshotParent ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const snapshotPath = await mkdtemp(join(parent, "forgedeck-planning-"));
  const copied: string[] = [];
  try {
    await copyTree(options.workspaceRoot, snapshotPath, "", 0, copied);
  } catch (error: unknown) {
    // A snapshot that could not be built completely is removed rather than used half-populated.
    await rm(snapshotPath, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    path: snapshotPath,
    files: copied,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await rm(snapshotPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  };
}

async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  relativeDirectory: string,
  depth: number,
  copied: string[]
): Promise<void> {
  if (depth > MAX_DEPTH || copied.length >= MAX_FILES) return;
  const sourceDirectory = join(sourceRoot, relativeDirectory);
  let entries: { readonly name: string; readonly directory: boolean }[];
  try {
    entries = (await readdir(sourceDirectory, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory()
    }));
  } catch {
    return;
  }

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (copied.length >= MAX_FILES) return;
    // Refused first, so nothing below can re-admit a secret-shaped name.
    if (isSecretName(entry.name)) continue;
    const relativePath =
      relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.directory) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      // Only documentation directories are walked for their contents; other directories are entered
      // solely to reach nested manifests, which keeps the copy shallow and predictable.
      await copyTree(sourceRoot, targetRoot, relativePath, depth + 1, copied);
      continue;
    }
    if (!isAllowedFile(entry.name, relativeDirectory)) continue;
    const source = join(sourceRoot, relativePath);
    try {
      const info = await stat(source);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      const target = join(targetRoot, relativePath.split("/").join(sep));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      copied.push(relativePath);
    } catch {
      // A file that cannot be read is simply not offered to analysis.
    }
  }
}

function isAllowedFile(name: string, relativeDirectory: string): boolean {
  if (ALLOWED_FILENAMES.has(name)) return true;
  const topLevel = relativeDirectory.split("/")[0] ?? "";
  if (relativeDirectory.length === 0 || !DOCUMENT_DIRECTORIES.has(topLevel)) return false;
  return ALLOWED_DOCUMENT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** True when `candidate` is the workspace itself or anything inside it. Used to prove isolation. */
export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const relation = relative(workspaceRoot, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.includes(`..${sep}`));
}
