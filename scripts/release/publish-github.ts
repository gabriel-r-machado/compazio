import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { resolveSupabaseAdminKey, supabaseAdminHeaders } from "../supabase-admin-auth";
import {
  githubReleaseAssetUrl,
  githubReleaseRepository,
  githubReleaseTag,
  resolveGitHubToken
} from "./github-release-utils";

interface ReleaseManifest {
  readonly channel: "beta";
  readonly version: string;
  readonly platform: "windows";
  readonly architecture: "x64";
  readonly installerFile: string;
  readonly installerSha256: string;
  readonly installerSize: number;
  readonly updateMetadataFile: string | null;
  readonly blockmapFile: string | null;
  readonly signed: boolean;
}

interface GitHubReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly browser_download_url: string;
}

interface GitHubRelease {
  readonly id: number;
  readonly name: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly tag_name: string;
  readonly assets: readonly GitHubReleaseAsset[];
}

async function main(): Promise<void> {
  const directory = resolve(option("--directory") ?? join("release", await readRootVersion()));
  const githubToken = resolveGitHubToken();
  const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
  const supabaseAdminKey = resolveSupabaseAdminKey();
  await assertGitClean();

  const manifest = await readManifest(directory);
  const rootVersion = await readRootVersion();
  if (manifest.version !== rootVersion)
    throw new Error("Release manifest version does not match package.json");
  const tag = githubReleaseTag(manifest.version);
  const assets = await validateArtifacts(directory, manifest);

  let release = await getRelease(tag, githubToken);
  if (release === null) {
    await runGitHub(
      [
        "release",
        "create",
        tag,
        "--repo",
        githubReleaseRepository,
        "--draft",
        "--prerelease",
        "--title",
        `Compazio ${manifest.version} — Public Beta 1`,
        "--notes-file",
        join(directory, "RELEASE_NOTES.md")
      ],
      githubToken
    );
    release = await requiredRelease(tag, githubToken);
  }
  if (!release.draft)
    throw new Error("A published GitHub Release cannot be replaced by this pipeline");

  await runGitHub(
    [
      "release",
      "upload",
      tag,
      "--repo",
      githubReleaseRepository,
      "--clobber",
      ...assets.map((asset) => asset.path)
    ],
    githubToken
  );
  release = await requiredRelease(tag, githubToken);
  assertDraftAssets(release, tag, assets);

  await runGitHub(
    ["release", "edit", tag, "--repo", githubReleaseRepository, "--draft=false", "--prerelease"],
    githubToken
  );
  release = await requiredRelease(tag, githubToken);
  if (release.draft || !release.prerelease)
    throw new Error("GitHub Release was not published as a pre-release");

  for (const local of assets) {
    const remote = asset(release, local.filename);
    if ((await sha256Public(remote.browser_download_url)) !== (await sha256File(local.path)))
      throw new Error(`Public GitHub asset checksum mismatch: ${local.filename}`);
  }

  await registerSupabaseRelease({
    supabaseUrl,
    adminKey: supabaseAdminKey,
    manifest,
    tag
  });
  await assertReleaseCurrent({ supabaseUrl, manifest, tag });

  process.stdout.write(
    `GitHub pre-release published: ${githubReleaseRepository}@${tag} (${manifest.installerSha256})\n`
  );
}

async function readManifest(directory: string): Promise<ReleaseManifest> {
  const parsed = JSON.parse(
    await readFile(join(directory, "release-manifest.json"), "utf8")
  ) as ReleaseManifest;
  if (
    parsed.channel !== "beta" ||
    parsed.platform !== "windows" ||
    parsed.architecture !== "x64" ||
    typeof parsed.version !== "string" ||
    typeof parsed.installerFile !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.installerSha256) ||
    !Number.isSafeInteger(parsed.installerSize) ||
    parsed.installerSize < 1 ||
    typeof parsed.updateMetadataFile !== "string" ||
    typeof parsed.blockmapFile !== "string"
  )
    throw new Error("Release manifest is invalid");
  return parsed;
}

async function validateArtifacts(directory: string, manifest: ReleaseManifest) {
  const filenames = [
    manifest.installerFile,
    manifest.blockmapFile,
    manifest.updateMetadataFile,
    "release-manifest.json",
    "checksums.txt",
    "RELEASE_NOTES.md"
  ];
  if (
    new Set(filenames).size !== filenames.length ||
    filenames.some((filename) => filename === null)
  )
    throw new Error("Release artifact manifest contains duplicate or missing files");
  const names = filenames as string[];
  const assets: { filename: string; path: string; size: number }[] = [];
  for (const filename of names) {
    if (filename !== basename(filename)) throw new Error("Release artifact filename is unsafe");
    const path = join(directory, filename);
    const details = await stat(path);
    if (!details.isFile() || details.size < 1)
      throw new Error(`Release artifact is invalid: ${filename}`);
    assets.push({ filename, path, size: details.size });
  }
  const installerPath = join(directory, manifest.installerFile);
  const installer = await stat(installerPath);
  if (installer.size !== manifest.installerSize)
    throw new Error("Installer size does not match release manifest");
  if ((await sha256File(installerPath)) !== manifest.installerSha256)
    throw new Error("Installer checksum does not match release manifest");
  const checksum = await readFile(join(directory, "checksums.txt"), "utf8");
  if (!checksum.includes(`${manifest.installerSha256}  ${manifest.installerFile}`))
    throw new Error("checksums.txt does not contain the installer checksum");
  return assets;
}

function assertDraftAssets(
  release: GitHubRelease,
  tag: string,
  expected: Awaited<ReturnType<typeof validateArtifacts>>
) {
  if (release.tag_name !== tag || !release.draft) throw new Error("GitHub Release is not a draft");
  for (const local of expected) {
    const remote = asset(release, local.filename);
    if (remote.size !== local.size)
      throw new Error(`GitHub Release asset size mismatch: ${local.filename}`);
  }
}

function asset(release: GitHubRelease, filename: string): GitHubReleaseAsset {
  const found = release.assets.find((candidate) => candidate.name === filename);
  if (found === undefined) throw new Error(`GitHub Release asset is missing: ${filename}`);
  return found;
}

async function registerSupabaseRelease(input: {
  readonly supabaseUrl: string;
  readonly adminKey: string;
  readonly manifest: ReleaseManifest;
  readonly tag: string;
}): Promise<void> {
  const response = await fetch(
    `${input.supabaseUrl}/rest/v1/app_releases?on_conflict=channel,version,platform,architecture`,
    {
      method: "POST",
      headers: {
        ...supabaseAdminHeaders(input.adminKey),
        prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        channel: input.manifest.channel,
        version: input.manifest.version,
        platform: input.manifest.platform,
        architecture: input.manifest.architecture,
        installer_path: githubReleaseAssetUrl(input.tag, input.manifest.installerFile),
        update_metadata_path: githubReleaseAssetUrl(input.tag, input.manifest.updateMetadataFile),
        sha256: input.manifest.installerSha256,
        size_bytes: input.manifest.installerSize,
        signed: input.manifest.signed === true,
        status: "published",
        release_notes_path: githubReleaseAssetUrl(input.tag, "RELEASE_NOTES.md"),
        published_at: new Date().toISOString(),
        metadata: { provider: "github", repository: githubReleaseRepository, tag: input.tag }
      })
    }
  );
  if (!response.ok) throw new Error(`Supabase release registry update failed: ${response.status}`);
}

async function assertReleaseCurrent(input: {
  readonly supabaseUrl: string;
  readonly manifest: ReleaseManifest;
  readonly tag: string;
}): Promise<void> {
  const response = await fetch(`${input.supabaseUrl}/functions/v1/release-current`);
  if (!response.ok) throw new Error(`release-current validation failed: ${response.status}`);
  const payload = (await response.json()) as {
    version?: unknown;
    downloadUrl?: unknown;
    metadataUrl?: unknown;
    sha256?: unknown;
    sizeBytes?: unknown;
    releaseNotesUrl?: unknown;
  };
  if (
    payload.version !== input.manifest.version ||
    payload.downloadUrl !== githubReleaseAssetUrl(input.tag, input.manifest.installerFile) ||
    payload.metadataUrl !== githubReleaseAssetUrl(input.tag, input.manifest.updateMetadataFile) ||
    payload.sha256 !== input.manifest.installerSha256 ||
    payload.sizeBytes !== input.manifest.installerSize ||
    payload.releaseNotesUrl !== githubReleaseAssetUrl(input.tag, "RELEASE_NOTES.md")
  )
    throw new Error("release-current does not match the GitHub Release");
}

async function getRelease(tag: string, token: string): Promise<GitHubRelease | null> {
  const result = await command(
    "gh",
    ["api", `repos/${githubReleaseRepository}/releases/tags/${tag}`],
    token
  );
  if (result.exitCode === 0) return JSON.parse(result.stdout) as GitHubRelease;
  if (!result.stderr.includes("404") && !result.stdout.includes("404"))
    throw new Error("Unable to query GitHub Release");

  // GitHub intentionally serves a newly-created draft from an untagged URL until it is
  // published. The authenticated releases collection still exposes its requested tag name.
  const drafts = await command("gh", ["api", `repos/${githubReleaseRepository}/releases`], token);
  if (drafts.exitCode !== 0) throw new Error("Unable to query GitHub draft releases");
  const matches = (JSON.parse(drafts.stdout) as GitHubRelease[]).filter(
    (release) => release.draft && release.tag_name === tag
  );
  if (matches.length > 1) throw new Error("Multiple GitHub draft releases use this tag");
  return matches[0] ?? null;
}

async function requiredRelease(tag: string, token: string): Promise<GitHubRelease> {
  const release = await getRelease(tag, token);
  if (release === null) throw new Error("GitHub Release was not created");
  return release;
}

async function runGitHub(args: string[], token: string): Promise<void> {
  const result = await command("gh", args, token);
  if (result.exitCode !== 0) throw new Error("GitHub release command failed");
}

async function command(commandName: string, args: string[], token?: string) {
  const environment =
    token === undefined
      ? process.env
      : { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: undefined };
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(commandName, args, {
        windowsHide: true,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
    }
  );
}

async function assertGitClean(): Promise<void> {
  // Generated release assets and local diagnostic evidence are intentionally untracked. Publishing
  // only requires every tracked source change to be committed.
  const result = await command("git", ["status", "--short", "--untracked-files=no"]);
  if (result.exitCode !== 0 || result.stdout.trim() !== "")
    throw new Error("Git must be clean before publishing");
}

async function sha256File(filename: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function sha256Public(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error("Public GitHub installer is unavailable");
  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readRootVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0)
    throw new Error("Root package version is missing");
  return packageJson.version;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "GitHub release publishing failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
