import { describe, expect, it } from "vitest";

import {
  githubReleaseAssetUrl,
  githubReleaseRepository,
  githubReleaseTag,
  resolveGitHubToken
} from "./github-release-utils";

describe("GitHub release utilities", () => {
  it("uses the public distribution repository and v-prefixed tags", () => {
    expect(githubReleaseRepository).toBe("gabriel-r-machado/compazio-releases");
    expect(githubReleaseTag("0.1.0-beta.2")).toBe("v0.1.0-beta.2");
    expect(githubReleaseAssetUrl("v0.1.0-beta.2", "beta.yml")).toBe(
      "https://github.com/gabriel-r-machado/compazio-releases/releases/download/v0.1.0-beta.2/beta.yml"
    );
  });

  it("accepts only a local or CI GitHub publishing token", () => {
    expect(resolveGitHubToken({ GH_TOKEN: "local-token" })).toBe("local-token");
    expect(resolveGitHubToken({ GITHUB_TOKEN: "ci-token" })).toBe("ci-token");
    expect(() => resolveGitHubToken({})).toThrow("GH_TOKEN or GITHUB_TOKEN");
  });
});
