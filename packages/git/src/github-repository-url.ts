export interface GitHubRepositoryUrl {
  readonly owner: string;
  readonly repository: string;
  readonly cloneUrl: string;
}

const repositorySegmentPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A GitHub HTTPS repository URL is required");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.includes("%")
  ) {
    throw new Error("A GitHub HTTPS repository URL is required");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("A GitHub HTTPS repository URL is required");
  }
  const [owner, repositorySegment] = segments;
  const repository = repositorySegment?.endsWith(".git")
    ? repositorySegment.slice(0, -".git".length)
    : repositorySegment;
  if (
    owner === undefined ||
    repository === undefined ||
    !repositorySegmentPattern.test(owner) ||
    !repositorySegmentPattern.test(repository)
  ) {
    throw new Error("A GitHub HTTPS repository URL is required");
  }
  return { owner, repository, cloneUrl: `https://github.com/${owner}/${repository}.git` };
}
