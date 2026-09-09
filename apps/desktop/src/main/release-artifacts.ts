import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const releaseChannels = ["beta", "stable"] as const;
export type ReleaseChannel = (typeof releaseChannels)[number];

export interface ReleaseArtifact {
  readonly filename: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ReleaseArtifactManifest {
  readonly schemaVersion: "1.0";
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly createdAt: string;
  readonly artifacts: readonly ReleaseArtifact[];
}

export interface WriteReleaseArtifactManifestInput {
  readonly artifactsDirectory: string;
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly now?: () => Date;
}

/**
 * Writes a local release manifest and SHA-256 list for files emitted by electron-builder. It is
 * release tooling only: it is not reachable from the renderer, app IPC or the Compasso CLI.
 */
export async function writeReleaseArtifactManifest(
  input: WriteReleaseArtifactManifestInput
): Promise<ReleaseArtifactManifest> {
  assertReleaseChannel(input.channel);
  if (!isReleaseVersion(input.version)) throw new Error("Release version is invalid");
  const directory = resolve(input.artifactsDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const artifacts = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name !== "release-manifest.json" &&
          entry.name !== "SHA256SUMS" &&
          isReleaseArtifactFilename(entry.name)
      )
      .map(async (entry) => releaseArtifact(join(directory, entry.name)))
  );
  artifacts.sort((left, right) => compareStable(left.filename, right.filename));
  if (artifacts.length === 0) throw new Error("Release artifact directory is empty");
  const manifest: ReleaseArtifactManifest = {
    schemaVersion: "1.0",
    channel: input.channel,
    version: input.version,
    artifacts,
    createdAt: (input.now ?? (() => new Date()))().toISOString()
  };
  await writeAtomically(
    join(directory, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeAtomically(
    join(directory, "SHA256SUMS"),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.filename}`).join("\n")}\n`
  );
  return manifest;
}

function assertReleaseChannel(value: string): asserts value is ReleaseChannel {
  if (!releaseChannels.includes(value as ReleaseChannel))
    throw new Error("Release channel is invalid");
}

async function releaseArtifact(filename: string): Promise<ReleaseArtifact> {
  const details = await stat(filename);
  if (!details.isFile() || details.size < 1) throw new Error("Release artifact is invalid");
  return {
    filename: basename(filename),
    byteSize: details.size,
    sha256: await sha256File(filename)
  };
}

async function sha256File(filename: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filename);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function writeAtomically(filename: string, content: string): Promise<void> {
  const temporaryFilename = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporaryFilename, content, "utf8");
  await rename(temporaryFilename, filename);
}

function isReleaseVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isReleaseArtifactFilename(value: string): boolean {
  return [".appimage", ".blockmap", ".deb", ".dmg", ".exe", ".rpm", ".snap", ".zip"].some(
    (suffix) => value.toLowerCase().endsWith(suffix)
  );
}

function compareStable(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
