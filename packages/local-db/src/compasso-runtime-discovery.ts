import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const COMPASSO_RUNTIME_MANIFEST = "compasso-runtime.json";

const runtimeDirectory = ".forgedeck";
const maximumAncestorChecks = 64;

export interface CompassoRuntimeRegistrationInput {
  readonly projectRoot: string;
  readonly databasePath: string;
  /** Short-lived loopback credentials. They stay in the owner-only project manifest, never IPC. */
  readonly endpoint?: CompassoRuntimeEndpointCredentials;
  readonly now?: Date;
}

export interface CompassoRuntimeEndpointCredentials {
  readonly url: string;
  readonly identityId: string;
  readonly token: string;
  readonly nonce: string;
}

export interface DiscoveredCompassoRuntime {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly endpoint?: CompassoRuntimeEndpointCredentials;
}

export interface ResolveCompassoDatabaseInput {
  readonly cwd: string;
  readonly databaseOverride: string | null;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedCompassoDatabase {
  readonly databasePath: string;
  readonly source: "explicit" | "legacy_environment" | "project_runtime" | "legacy_project";
  readonly endpoint?: CompassoRuntimeEndpointCredentials;
}

interface RuntimeManifest {
  readonly schemaVersion: 1;
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly updatedAt: string;
  readonly endpoint?: CompassoRuntimeEndpointCredentials;
}

/**
 * Stores the desktop runtime location beside the selected project. The manifest is consumed only by
 * local CLI code; it is never carried over IPC or sent to a renderer.
 */
export function registerCompassoRuntime(
  input: CompassoRuntimeRegistrationInput
): DiscoveredCompassoRuntime {
  const projectRoot = canonicalDirectory(input.projectRoot, "Compasso project");
  const databasePath = canonicalFile(input.databasePath, "Compasso runtime database");
  const directory = join(projectRoot, runtimeDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, COMPASSO_RUNTIME_MANIFEST);
  const endpoint = input.endpoint === undefined ? undefined : validateEndpoint(input.endpoint);
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    projectRoot,
    databasePath,
    updatedAt: (input.now ?? new Date()).toISOString(),
    ...(endpoint === undefined ? {} : { endpoint })
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return {
    projectRoot,
    databasePath,
    manifestPath,
    ...(endpoint === undefined ? {} : { endpoint })
  };
}

/**
 * Checks one fixed manifest name at the current directory and its parents. It never enumerates
 * directories, follows only canonical paths, and stops at the filesystem root.
 */
export function discoverCompassoRuntime(cwd: string): DiscoveredCompassoRuntime | null {
  const canonicalCwd = canonicalDirectory(cwd, "Current directory");
  let directory = canonicalCwd;
  for (let checked = 0; checked < maximumAncestorChecks; checked += 1) {
    const manifestPath = join(directory, runtimeDirectory, COMPASSO_RUNTIME_MANIFEST);
    if (existsSync(manifestPath)) {
      return readRuntimeManifest(manifestPath, directory, canonicalCwd);
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

export function resolveCompassoDatabase(
  input: ResolveCompassoDatabaseInput
): ResolvedCompassoDatabase | null {
  if (input.databaseOverride !== null) {
    return {
      databasePath: canonicalFile(resolve(input.cwd, input.databaseOverride), "Compasso database"),
      source: "explicit"
    };
  }
  const environment = input.environment ?? process.env;
  const legacyEnvironment = environment.COMPASSO_DB_PATH ?? environment.FORGEDECK_DB_PATH;
  if (legacyEnvironment !== undefined && legacyEnvironment.trim().length > 0) {
    return {
      databasePath: canonicalFile(resolve(input.cwd, legacyEnvironment), "Compasso database"),
      source: "legacy_environment"
    };
  }
  const runtime = discoverCompassoRuntime(input.cwd);
  if (runtime !== null) {
    return {
      databasePath: runtime.databasePath,
      source: "project_runtime",
      ...(runtime.endpoint === undefined ? {} : { endpoint: runtime.endpoint })
    };
  }
  const legacyProjectDatabase = join(resolve(input.cwd), runtimeDirectory, "forgedeck.db");
  if (existsSync(legacyProjectDatabase)) {
    return {
      databasePath: canonicalFile(legacyProjectDatabase, "Compasso database"),
      source: "legacy_project"
    };
  }
  return null;
}

function readRuntimeManifest(
  manifestPath: string,
  expectedProjectRoot: string,
  cwd: string
): DiscoveredCompassoRuntime {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    throw new Error(
      "Compasso runtime registration is invalid. Open this project in ForgeDeck again."
    );
  }
  if (!isRuntimeManifest(value)) {
    throw new Error(
      "Compasso runtime registration is invalid. Open this project in ForgeDeck again."
    );
  }
  const projectRoot = canonicalDirectory(value.projectRoot, "Compasso project");
  if (projectRoot !== expectedProjectRoot || !isPathInside(projectRoot, cwd)) {
    throw new Error("Compasso runtime registration does not match this project.");
  }
  return {
    projectRoot,
    databasePath: canonicalFile(value.databasePath, "Compasso runtime database"),
    manifestPath,
    ...(value.endpoint === undefined ? {} : { endpoint: validateEndpoint(value.endpoint) })
  };
}

function canonicalDirectory(path: string, label: string): string {
  const candidate = resolve(path);
  try {
    if (!statSync(candidate).isDirectory()) throw new Error("not a directory");
    return realpathSync.native(candidate);
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
}

function canonicalFile(path: string, label: string): string {
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    return realpathSync.native(path);
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
}

function isRuntimeManifest(value: unknown): value is RuntimeManifest {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.projectRoot === "string" &&
    typeof candidate.databasePath === "string" &&
    typeof candidate.updatedAt === "string" &&
    (candidate.endpoint === undefined || isEndpointCredentials(candidate.endpoint))
  );
}

function isEndpointCredentials(value: unknown): value is CompassoRuntimeEndpointCredentials {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.url === "string" &&
    typeof candidate.identityId === "string" &&
    typeof candidate.token === "string" &&
    typeof candidate.nonce === "string"
  );
}

function validateEndpoint(
  endpoint: CompassoRuntimeEndpointCredentials
): CompassoRuntimeEndpointCredentials {
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new Error(
      "Compasso runtime registration is invalid. Open this project in ForgeDeck again."
    );
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !isBoundedRuntimeSecret(endpoint.identityId, 160) ||
    !isBoundedRuntimeSecret(endpoint.token, 256) ||
    !isBoundedRuntimeSecret(endpoint.nonce, 256)
  ) {
    throw new Error(
      "Compasso runtime registration is invalid. Open this project in ForgeDeck again."
    );
  }
  return {
    url: url.origin,
    identityId: endpoint.identityId,
    token: endpoint.token,
    nonce: endpoint.nonce
  };
}

function isBoundedRuntimeSecret(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength;
}

function isPathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !child.includes(":"));
}
