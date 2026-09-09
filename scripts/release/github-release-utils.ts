export const githubReleaseOwner = "gabriel-r-machado";
export const githubReleaseRepository = `${githubReleaseOwner}/compazio-releases`;

export function githubReleaseTag(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version))
    throw new Error("Release version is invalid");
  return `v${version}`;
}

export function githubReleaseAssetUrl(tag: string, filename: string): string {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag))
    throw new Error("Release tag is invalid");
  if (filename.length === 0 || filename !== filename.split(/[\\/]/).pop())
    throw new Error("Release asset filename is invalid");
  return `https://github.com/${githubReleaseRepository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
}

export function resolveGitHubToken(environment: NodeJS.ProcessEnv = process.env): string {
  const token = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim();
  if (token === undefined || token.length === 0)
    throw new Error("GH_TOKEN or GITHUB_TOKEN is required for GitHub release publishing.");
  return token;
}
