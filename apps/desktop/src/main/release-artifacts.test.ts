import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeReleaseArtifactManifest } from "./release-artifacts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("writeReleaseArtifactManifest", () => {
  it("writes sorted checksums without absolute paths or stale manifests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-release-artifacts-"));
    directories.push(directory);
    await writeFile(join(directory, "Compasso-setup.exe"), "windows artifact");
    await writeFile(join(directory, "Compasso.AppImage"), "linux artifact");
    await writeFile(join(directory, "builder-debug.yml"), "builder diagnostics");
    await writeFile(join(directory, "release-manifest.json"), "stale");
    await writeFile(join(directory, "SHA256SUMS"), "stale");

    const manifest = await writeReleaseArtifactManifest({
      artifactsDirectory: directory,
      channel: "beta",
      version: "0.1.0-beta.1",
      now: () => new Date("2026-07-21T12:00:00.000Z")
    });

    expect(manifest).toMatchObject({
      schemaVersion: "1.0",
      channel: "beta",
      version: "0.1.0-beta.1",
      createdAt: "2026-07-21T12:00:00.000Z"
    });
    expect(manifest.artifacts.map((artifact) => artifact.filename)).toEqual([
      "Compasso-setup.exe",
      "Compasso.AppImage"
    ]);
    const manifestFile = await readFile(join(directory, "release-manifest.json"), "utf8");
    const checksumFile = await readFile(join(directory, "SHA256SUMS"), "utf8");
    expect(manifestFile).not.toContain(directory);
    expect(checksumFile).toContain("Compasso.AppImage");
    expect(checksumFile).not.toContain(directory);
    expect(checksumFile).not.toContain("builder-debug.yml");
  });

  it("rejects invalid channels, versions and empty release directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compasso-empty-release-"));
    directories.push(directory);
    await expect(
      writeReleaseArtifactManifest({
        artifactsDirectory: directory,
        channel: "preview" as "beta",
        version: "0.1.0"
      })
    ).rejects.toThrow("channel");
    await expect(
      writeReleaseArtifactManifest({
        artifactsDirectory: directory,
        channel: "beta",
        version: "invalid"
      })
    ).rejects.toThrow("version");
    await expect(
      writeReleaseArtifactManifest({
        artifactsDirectory: directory,
        channel: "beta",
        version: "0.1.0"
      })
    ).rejects.toThrow("empty");
  });
});
