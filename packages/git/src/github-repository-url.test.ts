import { describe, expect, it } from "vitest";

import { parseGitHubRepositoryUrl } from "./github-repository-url";

describe("GitHub clone URL validation", () => {
  it("normalizes an explicit HTTPS GitHub repository URL", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/ForgeDeck/desktop.git")).toEqual({
      owner: "ForgeDeck",
      repository: "desktop",
      cloneUrl: "https://github.com/ForgeDeck/desktop.git"
    });
  });

  it.each([
    "git@github.com:ForgeDeck/desktop.git",
    "http://github.com/ForgeDeck/desktop.git",
    "https://example.com/ForgeDeck/desktop.git",
    "https://github.com/ForgeDeck/desktop/tree/main",
    "https://github.com/ForgeDeck/desktop.git?token=secret",
    "https://user:password@github.com/ForgeDeck/desktop.git",
    "https://github.com/ForgeDeck/../desktop.git",
    "https://github.com/ForgeDeck/-c-core.sshCommand=forged.git"
  ])("rejects a non-repository or unsafe URL: %s", (value) => {
    expect(() => parseGitHubRepositoryUrl(value)).toThrow("GitHub HTTPS repository URL");
  });
});
