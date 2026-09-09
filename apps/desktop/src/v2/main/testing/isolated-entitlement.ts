import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EntitlementService, writeTestHarnessMarker } from "../entitlement-service";

/**
 * Everything a run that creates workspaces needs in order to stay off the real installation: its
 * own data root under the OS temporary directory, the harness marker that pairs the two, and an
 * entitlement built through the only factory allowed to lift the free workspace limit.
 */
export interface IsolatedTestRun {
  /** The V2 storage root. Pass it to V2WorkspaceRepository and as COMPAZIO_V2_DATA_DIR. */
  readonly stateDirectory: string;
  /** The temporary parent. Removed by {@link IsolatedTestRun.cleanup}. */
  readonly root: string;
  readonly harnessId: string;
  readonly entitlement: EntitlementService;
  /** Environment a child Electron process needs to be recognised as this same harness run. */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Removes the temporary root. It first asserts the run left nothing behind anywhere else, so a
   * harness that wrote into the real user data fails instead of passing quietly.
   */
  cleanup(): Promise<void>;
}

export interface IsolatedTestRunOptions {
  /** Appears in the temporary directory name so a leaked root names the run that created it. */
  readonly label: string;
  readonly appVersion?: string;
  /** Real user data root. Checked for leftovers during cleanup; defaults to the installed path. */
  readonly realUserDataRoot?: string;
  /**
   * Adopts a state root an earlier run of the same harness owns, instead of creating a new one.
   * Still validated: a path outside the OS temporary root is refused. `cleanup` will not delete an
   * adopted root, because it belongs to whoever created it.
   */
  readonly adoptStateDirectory?: string;
}

/**
 * Creates an isolated run. The entitlement comes from {@link EntitlementService.forIsolatedTest},
 * which refuses any state path outside the OS temporary root, so this helper cannot raise the
 * workspace limit on a real installation even if it is called from the wrong place.
 */
export async function createIsolatedTestRun(
  options: IsolatedTestRunOptions
): Promise<IsolatedTestRun> {
  const adopted = options.adoptStateDirectory;
  const root =
    adopted === undefined ? await mkdtemp(join(tmpdir(), `compazio-${options.label}-`)) : adopted;
  const stateDirectory = adopted ?? join(root, "state");
  const harnessId = `${options.label}-${randomUUID()}`;
  await writeTestHarnessMarker(stateDirectory, harnessId);
  const entitlement = EntitlementService.forIsolatedTest({
    statePath: join(stateDirectory, "license", "entitlement.json"),
    appVersion: options.appVersion ?? "0.0.0-isolated-test",
    harnessId
  });
  const realUserDataRoot = options.realUserDataRoot ?? defaultRealUserDataRoot();
  // Compared against the same listing during cleanup. Only workspaces this run added are a leak;
  // the ones already on the machine are the user's and are never counted or touched.
  const workspacesBefore = await workspaceFilesUnder(realUserDataRoot);
  return {
    root,
    stateDirectory,
    harnessId,
    entitlement,
    environment: {
      NODE_ENV: "test",
      COMPAZIO_TEST_UNLIMITED_WORKSPACES: "1",
      COMPAZIO_TEST_HARNESS_ID: harnessId,
      COMPAZIO_V2_DATA_DIR: stateDirectory
    },
    cleanup: async () => {
      const workspacesAfter = await workspaceFilesUnder(realUserDataRoot);
      const leaked = workspacesAfter.filter((file) => !workspacesBefore.includes(file));
      // A root this run created goes away either way; a leak must not also leave a stale directory.
      // An adopted root belongs to its creator and is left alone.
      if (adopted === undefined) await rm(root, { recursive: true, force: true });
      if (leaked.length > 0) {
        throw new Error(
          `The isolated run "${options.label}" wrote ${leaked.length} workspace file(s) into the real user data at ${realUserDataRoot}: ${leaked.join(", ")}`
        );
      }
    }
  };
}

/**
 * A lighter entitlement for a test that already owns a temporary directory. It goes through the
 * same guarded factory, so pointing it at a real installation throws instead of lifting the limit.
 */
export function isolatedTestEntitlement(
  stateDirectory: string,
  label = "isolated-test"
): EntitlementService {
  return EntitlementService.forIsolatedTest({
    statePath: join(stateDirectory, "license", "entitlement.json"),
    appVersion: "0.0.0-isolated-test",
    harnessId: `${label}-${randomUUID()}`
  });
}

/** Workspace documents currently present in a V2 storage root. Missing roots list as empty. */
async function workspaceFilesUnder(storageRoot: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(storageRoot, "workspaces"));
    return entries.filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
}

function defaultRealUserDataRoot(): string {
  const appData =
    process.env.APPDATA ??
    (process.env.HOME === undefined ? undefined : join(process.env.HOME, ".config"));
  return appData === undefined
    ? join(tmpdir(), "compazio-absent")
    : join(appData, "Compazio", "compazio", "v2");
}
