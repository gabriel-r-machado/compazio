import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverCompassoRuntime,
  registerCompassoRuntime,
  resolveCompassoDatabase
} from "./compasso-runtime-discovery";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("Compasso runtime discovery", () => {
  it("discovers a registered desktop runtime from a nested project directory", async () => {
    const fixture = await createFixture();
    const registration = registerCompassoRuntime({
      projectRoot: fixture.projectRoot,
      databasePath: fixture.databasePath,
      now: new Date("2026-07-20T12:00:00.000Z")
    });

    expect(discoverCompassoRuntime(fixture.nestedDirectory)).toEqual(registration);
    expect(
      resolveCompassoDatabase({ cwd: fixture.nestedDirectory, databaseOverride: null })
    ).toEqual({
      databasePath: registration.databasePath,
      source: "project_runtime"
    });
  });

  it("uses explicit configuration as a compatibility fallback without scanning unrelated directories", async () => {
    const fixture = await createFixture();
    expect(
      resolveCompassoDatabase({ cwd: fixture.nestedDirectory, databaseOverride: null })
    ).toBeNull();
    expect(
      resolveCompassoDatabase({
        cwd: fixture.nestedDirectory,
        databaseOverride: fixture.databasePath
      })
    ).toEqual({ databasePath: await realpath(fixture.databasePath), source: "explicit" });
  });

  it("carries only a valid loopback credential to local CLI clients", async () => {
    const fixture = await createFixture();
    const registration = registerCompassoRuntime({
      projectRoot: fixture.projectRoot,
      databasePath: fixture.databasePath,
      endpoint: {
        url: "http://127.0.0.1:43125",
        identityId: "identity-cli",
        token: "rotated-token",
        nonce: "rotated-nonce"
      }
    });

    expect(
      resolveCompassoDatabase({ cwd: fixture.nestedDirectory, databaseOverride: null })
    ).toMatchObject({
      databasePath: registration.databasePath,
      source: "project_runtime",
      endpoint: { url: "http://127.0.0.1:43125", identityId: "identity-cli" }
    });
  });

  it("rejects a non-loopback endpoint without revealing its credential", async () => {
    const fixture = await createFixture();
    expect(() =>
      registerCompassoRuntime({
        projectRoot: fixture.projectRoot,
        databasePath: fixture.databasePath,
        endpoint: {
          url: "https://example.test:443",
          identityId: "identity-cli",
          token: "private-token",
          nonce: "private-nonce"
        }
      })
    ).toThrow("Compasso runtime registration is invalid");
    expect(() =>
      registerCompassoRuntime({
        projectRoot: fixture.projectRoot,
        databasePath: fixture.databasePath,
        endpoint: {
          url: "https://example.test:443",
          identityId: "identity-cli",
          token: "private-token",
          nonce: "private-nonce"
        }
      })
    ).not.toThrow("private-token");
  });

  it("rejects a malformed project registration without leaking its path", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.projectRoot, ".forgedeck"));
    await writeFile(join(fixture.projectRoot, ".forgedeck", "compasso-runtime.json"), "not json");

    expect(() => discoverCompassoRuntime(fixture.nestedDirectory)).toThrow(
      "Compasso runtime registration is invalid"
    );
    expect(() => discoverCompassoRuntime(fixture.nestedDirectory)).not.toThrow(fixture.projectRoot);
  });
});

async function createFixture(): Promise<{
  readonly projectRoot: string;
  readonly nestedDirectory: string;
  readonly databasePath: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "compasso-runtime-"));
  directories.push(projectRoot);
  const nestedDirectory = join(projectRoot, "packages", "cli");
  await mkdir(nestedDirectory, { recursive: true });
  const databasePath = join(projectRoot, "runtime.db");
  await writeFile(databasePath, "sqlite-placeholder");
  return { projectRoot, nestedDirectory, databasePath };
}
