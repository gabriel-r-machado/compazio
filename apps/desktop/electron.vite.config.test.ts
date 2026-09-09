import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { nativeRuntimeDependencies } from "./electron.vite.config";

interface DesktopPackageManifest {
  readonly dependencies: Record<string, string>;
  readonly build: {
    readonly asarUnpack: readonly string[];
    readonly extraResources: readonly {
      readonly from: string;
      readonly to: string;
    }[];
  };
}

describe("desktop native runtime packaging", () => {
  it("keeps native modules and SQLite migrations available to packaged Electron", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("./package.json", import.meta.url), "utf8")
    ) as DesktopPackageManifest;

    expect(nativeRuntimeDependencies).toContain("node-pty");
    expect(manifest.dependencies["node-pty"]).toBe("1.1.0");
    expect(manifest.build.asarUnpack).toContain("**/node_modules/node-pty/**");
    expect(manifest.build.extraResources).toContainEqual({
      from: "../../packages/local-db/drizzle",
      to: "drizzle"
    });
    await expect(
      readFile(
        new URL("../../packages/local-db/drizzle/meta/_journal.json", import.meta.url),
        "utf8"
      )
    ).resolves.toContain('"entries"');
  });
});
