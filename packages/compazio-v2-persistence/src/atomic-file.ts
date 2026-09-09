import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const BACKUP_SUFFIX = ".bak";
const TEMPORARY_SUFFIX = ".tmp";
/** Windows contention is transient. Three attempts with a short progressive delay, then it is real. */
const TRANSIENT_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [25, 75, 150] as const;
/** A temporary file older than this was left by a process that is no longer running. */
const ORPHAN_TEMPORARY_AGE_MS = 60_000;

/**
 * Windows refuses to rename onto a destination that any process still holds open, and refuses to
 * open a file another process is scanning. Those three codes mean "try again in a moment"; every
 * other code is a real failure that retrying would only delay.
 */
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Never retried: repeating them cannot succeed and would only postpone the error. */
const PERMANENT_CODES = new Set(["ENOSPC", "EROFS", "EDQUOT", "EFBIG", "EINVAL", "ENAMETOOLONG"]);

export interface PersistenceDiagnostics {
  readonly operation: string;
  /** Absolute destination, as written. Callers sanitize before showing or exporting it. */
  readonly destination: string;
  readonly temporaryPath?: string;
  readonly errno?: number;
  readonly code?: string;
  readonly syscall?: string;
  /** Path reported by the failing syscall, which is the source of a rename. */
  readonly sourcePath?: string;
  readonly attempts: number;
  readonly durationMs: number;
  readonly pid: number;
  readonly retriable: boolean;
  readonly concurrentOperation?: string;
}

export class AtomicWriteError extends Error {
  public constructor(
    message: string,
    public readonly diagnostics: PersistenceDiagnostics,
    public override readonly cause?: unknown
  ) {
    super(message);
    this.name = "AtomicWriteError";
  }
}

/**
 * Process-wide exclusive access keyed by absolute path.
 *
 * Module scope on purpose: every V2WorkspaceRepository instance in the process shares it, so two
 * repositories built over the same root cannot interleave. Reads take the same lock as writes —
 * that is the whole point. A reader holding an open handle is exactly what makes the rename fail
 * with EPERM on Windows, which is the reproduced production failure for agents.json.
 */
const pathLocks = new Map<string, Promise<unknown>>();
/** What currently owns each lock, so a failure can name the operation it collided with. */
const pathOwners = new Map<string, string>();

export function lockKey(path: string): string {
  return resolve(path).toLowerCase();
}

/** Runs `operation` with exclusive access to `path`. Queued per path, never per instance. */
export async function withPathLock<T>(
  path: string,
  label: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = lockKey(path);
  const previous = pathLocks.get(key) ?? Promise.resolve();
  const run = previous
    .then(
      () => undefined,
      () => undefined
    )
    .then(async () => {
      pathOwners.set(key, label);
      try {
        return await operation();
      } finally {
        pathOwners.delete(key);
      }
    });
  pathLocks.set(key, run);
  try {
    return await run;
  } finally {
    // Only the last queued operation clears the slot, so an earlier finisher cannot free a path
    // another operation is still waiting on.
    if (pathLocks.get(key) === run) pathLocks.delete(key);
  }
}

/** The operation currently holding a path, used to describe a collision in diagnostics. */
export function currentPathOwner(path: string): string | undefined {
  return pathOwners.get(lockKey(path));
}

export interface AtomicWriteOptions {
  /** Named in diagnostics, e.g. "saveAgentCatalog". */
  readonly operation: string;
  /**
   * Rejects content that must never reach disk. Throwing here aborts before any file is touched
   * and is never retried: invalid content cannot become valid by trying again.
   */
  readonly validate?: (contents: string) => void;
  /** Keeps one previous valid copy at `<path>.bak`. */
  readonly keepBackup?: boolean;
}

/**
 * Replaces `path` with `contents`, or leaves the previous file untouched.
 *
 * The caller must already hold the path lock — {@link writeFileAtomically} takes it. The sequence
 * is: ensure directory, snapshot the previous content, refresh the single backup, write a unique
 * temporary in the same directory, fsync, replace the destination, read it back to confirm, and
 * drop the temporary.
 */
async function writeLocked(
  path: string,
  contents: string,
  options: AtomicWriteOptions
): Promise<void> {
  const started = Date.now();
  let attempts = 0;
  const temporaryPath = `${path}.${randomUUID()}${TEMPORARY_SUFFIX}`;

  const fail = (error: unknown, stage: string): never => {
    const errno = error as NodeJS.ErrnoException;
    throw new AtomicWriteError(
      `Atomic write failed for ${path} during ${stage}`,
      {
        operation: options.operation,
        destination: path,
        temporaryPath,
        ...(errno.errno === undefined ? {} : { errno: errno.errno }),
        ...(errno.code === undefined ? {} : { code: errno.code }),
        ...(errno.syscall === undefined ? {} : { syscall: errno.syscall }),
        ...(errno.path === undefined ? {} : { sourcePath: errno.path }),
        attempts,
        durationMs: Date.now() - started,
        pid: process.pid,
        retriable: isTransient(error),
        ...(currentPathOwner(path) === undefined
          ? {}
          : { concurrentOperation: currentPathOwner(path) as string })
      },
      error
    );
  };

  // Invalid content is rejected before anything on disk is touched, and is never retried.
  options.validate?.(contents);

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    fail(error, "mkdir");
  }

  // Read inside the lock: no other reader or writer can hold the destination open right now.
  const previous = await readIfPresent(path);

  if (options.keepBackup === true && previous !== null) {
    try {
      // A plain overwrite, not a rename: the destination still holds the only valid copy at this
      // point, so a failure here aborts before anything is replaced.
      await withTransientRetry(
        () => writeFile(`${path}${BACKUP_SUFFIX}`, previous, "utf8"),
        (count) => {
          attempts = count;
        }
      );
    } catch (error) {
      fail(error, "backup");
    }
  }

  try {
    const handle = await open(temporaryPath, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    fail(error, "write-temporary");
  }

  try {
    await withTransientRetry(
      () => rename(temporaryPath, path),
      (count) => {
        attempts = count;
      }
    );
  } catch (error) {
    await rm(temporaryPath, { force: true });
    fail(error, "replace");
  }

  // The Electron smoke can stop the process at the only meaningful post-replace boundary: the
  // new destination has been installed but its read-back confirmation and normal cleanup have not
  // run yet. This is deliberately unavailable outside the isolated smoke harness.
  await pauseAfterReplaceForSmoke(options.operation, contents);

  try {
    const confirmed = await readFile(path, "utf8");
    if (confirmed !== contents) {
      throw new Error("the file on disk does not match what was written");
    }
  } catch (error) {
    fail(error, "confirm");
  }

  await rm(temporaryPath, { force: true });
}

/** Takes the path lock and writes atomically. This is the only supported way to replace a file. */
export function writeFileAtomically(
  path: string,
  contents: string,
  options: AtomicWriteOptions
): Promise<void> {
  return withPathLock(path, options.operation, () => writeLocked(path, contents, options));
}

/** Takes the path lock and reads, so no read can hold a handle while a replace is in flight. */
export function readFileLocked(path: string, operation: string): Promise<string> {
  return withPathLock(path, operation, () => readFile(path, "utf8"));
}

export interface RecoveredRead<T> {
  readonly value: T;
  /** Which copy answered. `primary` is the healthy path. */
  readonly source: "primary" | "backup" | "orphan-temporary" | "empty";
  /** Set when a fallback was used, so the app can tell the user what happened. */
  readonly recoveredFrom?: string;
  readonly reason?: string;
}

export interface RecoverOptions<T> {
  readonly operation: string;
  /** Parses and validates. Throwing means this copy is unusable and the next one is tried. */
  readonly parse: (contents: string) => T;
  /** Used only when no copy on disk is usable. Omit to make a missing file an error. */
  readonly whenMissing?: () => T;
}

/**
 * Reads `path`, falling back to the single backup and then to a complete abandoned temporary.
 *
 * A temporary is only ever considered when neither the primary nor the backup parses, so a valid
 * file is never replaced by an older temporary. Nothing is deleted along the way.
 */
export async function readFileWithRecovery<T>(
  path: string,
  options: RecoverOptions<T>
): Promise<RecoveredRead<T>> {
  return withPathLock(path, options.operation, async () => {
    let primaryReason: string | undefined;
    const primary = await readIfPresent(path);
    if (primary !== null) {
      try {
        return { value: options.parse(primary), source: "primary" as const };
      } catch (error) {
        // Falls through to the backup. The unreadable primary stays on disk untouched.
        primaryReason = describe(error);
      }
    }

    const backup = await readIfPresent(`${path}${BACKUP_SUFFIX}`);
    if (backup !== null) {
      try {
        return {
          value: options.parse(backup),
          source: "backup" as const,
          recoveredFrom: `${basename(path)}${BACKUP_SUFFIX}`,
          reason: primaryReason ?? "o arquivo principal estava ausente"
        };
      } catch {
        // Falls through to an abandoned temporary.
      }
    }

    const orphan = await newestCompleteTemporary(path, options.parse);
    if (orphan !== null) {
      return {
        value: orphan.value,
        source: "orphan-temporary" as const,
        recoveredFrom: basename(orphan.path),
        reason: primaryReason ?? "o arquivo principal e o backup estavam ausentes ou inválidos"
      };
    }

    if (primary === null && backup === null && options.whenMissing !== undefined) {
      return { value: options.whenMissing(), source: "empty" as const };
    }
    throw new AtomicWriteError(
      `No readable copy of ${path}`,
      {
        operation: options.operation,
        destination: path,
        attempts: 1,
        durationMs: 0,
        pid: process.pid,
        retriable: false
      },
      primaryReason
    );
  });
}

/**
 * The newest temporary next to `path` that is complete and parses. A temporary still being written
 * by a live process is skipped by requiring it to be older than {@link ORPHAN_TEMPORARY_AGE_MS}.
 */
async function newestCompleteTemporary<T>(
  path: string,
  parse: (contents: string) => T
): Promise<{ readonly value: T; readonly path: string } | null> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(TEMPORARY_SUFFIX))
    .map((entry) => join(directory, entry));
  const dated: { path: string; modifiedAt: number }[] = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (Date.now() - info.mtimeMs < ORPHAN_TEMPORARY_AGE_MS) continue;
      dated.push({ path: candidate, modifiedAt: info.mtimeMs });
    } catch {
      // A temporary that vanished between readdir and stat was cleaned up by its owner.
    }
  }
  dated.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of dated) {
    const contents = await readIfPresent(candidate.path);
    if (contents === null) continue;
    try {
      return { value: parse(contents), path: candidate.path };
    } catch {
      // An incomplete temporary is simply not a candidate; it is left on disk.
    }
  }
  return null;
}

/** Removes temporaries that are old enough to have no live owner. Never touches primary or backup. */
export async function pruneOrphanTemporaries(path: string): Promise<readonly string[]> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(TEMPORARY_SUFFIX)) continue;
    const candidate = join(directory, entry);
    try {
      const info = await stat(candidate);
      if (Date.now() - info.mtimeMs < ORPHAN_TEMPORARY_AGE_MS) continue;
      await rm(candidate, { force: true });
      removed.push(entry);
    } catch {
      // Losing the race to delete a temporary is not a failure.
    }
  }
  return removed;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/**
 * Runs a filesystem step, retrying only transient Windows contention. Exported so the retry policy
 * itself — how many attempts, which codes, how long — is testable without stubbing `node:fs`.
 */
export async function withTransientRetry(
  operation: () => Promise<void>,
  recordAttempts: (count: number) => void = () => undefined
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
    recordAttempts(attempt);
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === TRANSIENT_ATTEMPTS) throw error;
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? 150);
    }
  }
  throw lastError;
}

export function isTransient(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = String((error as NodeJS.ErrnoException).code);
  if (PERMANENT_CODES.has(code)) return false;
  return TRANSIENT_CODES.has(code);
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const smokeReplaceCounts = new Map<string, number>();

async function pauseAfterReplaceForSmoke(operation: string, contents: string): Promise<void> {
  if (process.env.COMPAZIO_V2_SMOKE !== "true") return;
  if (process.env.COMPAZIO_V2_SMOKE_PAUSE_AFTER_REPLACE !== operation) return;
  const requiredContents = process.env.COMPAZIO_V2_SMOKE_PAUSE_AFTER_REPLACE_CONTAINS;
  if (requiredContents !== undefined && !contents.includes(requiredContents)) return;
  const expectedCount = Number(process.env.COMPAZIO_V2_SMOKE_PAUSE_AFTER_REPLACE_COUNT ?? "1");
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) return;
  const currentCount = (smokeReplaceCounts.get(operation) ?? 0) + 1;
  smokeReplaceCounts.set(operation, currentCount);
  if (currentCount !== expectedCount) return;
  process.stdout.write(`COMPAZIO_V2_ATOMIC_REPLACE_READY:${operation}\n`);
  await new Promise<void>(() => undefined);
}
