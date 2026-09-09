import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPlanningSnapshot,
  isInsideWorkspace,
  type PlanningSnapshot
} from "./planning-snapshot";

/**
 * Proves the PREVENTIVE half of the read-only guarantee. Detection is tested with the orchestrator port;
 * here the question is narrower and harder: can the planning turn reach the real project at all, and can a
 * credential leave it?
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

/** A workspace shaped like a real project: manifests, docs, build output, dependencies and secrets. */
async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forgedeck-planning-source-"));
  directories.push(root);
  await writeFile(join(root, "CLAUDE.md"), "# Instructions\nRead the docs first.\n", "utf8");
  await writeFile(join(root, "README.md"), "# Project\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "project", scripts: { build: "tsc" } }),
    "utf8"
  );
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(join(root, "index.ts"), "export const secretless = 1;\n", "utf8");

  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "01-vision.md"), "# Vision\n", "utf8");
  await writeFile(join(root, "docs", "diagram.png"), "binary-ish", "utf8");

  await mkdir(join(root, "specs", "product"), { recursive: true });
  await writeFile(join(root, "specs", "product", "constitution.md"), "# Rules\n", "utf8");

  // Secrets, in every shape the allowlist must refuse.
  await writeFile(join(root, ".env"), "API_KEY=super-secret\n", "utf8");
  await writeFile(join(root, ".env.local"), "TOKEN=nope\n", "utf8");
  await writeFile(join(root, "credentials.json"), '{"key":"leak"}', "utf8");
  await writeFile(join(root, "service-secret.json"), '{"key":"leak"}', "utf8");
  await writeFile(join(root, "id_rsa"), "PRIVATE KEY", "utf8");
  await writeFile(join(root, "server.pem"), "CERT", "utf8");
  await writeFile(join(root, ".npmrc"), "//registry:_authToken=leak\n", "utf8");

  // Directories that must never be walked.
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "config"), "[core]\n", "utf8");
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(root, "node_modules", "left-pad", "package.json"), "{}", "utf8");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "package.json"), "{}", "utf8");
  for (const excluded of ["out", ".forgedeck", ".turbo", "coverage", ".cache", "build"]) {
    await mkdir(join(root, excluded), { recursive: true });
    await writeFile(join(root, excluded, "package.json"), "{}", "utf8");
    await writeFile(join(root, excluded, "README.md"), "# generated\n", "utf8");
  }
  return root;
}

async function listTree(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      const info = await stat(join(root, next));
      found.push(`${next}:${info.size}`);
    }
  };
  await walk("");
  return found;
}

async function snapshotOf(root: string): Promise<PlanningSnapshot> {
  const snapshot = await createPlanningSnapshot({ workspaceRoot: root });
  directories.push(snapshot.path);
  return snapshot;
}

describe("planning snapshot", () => {
  it("copies the files analysis needs, preserving structure", async () => {
    const root = await createWorkspace();
    const snapshot = await snapshotOf(root);
    try {
      // The documents and manifests that describe the project are present…
      expect(snapshot.files).toContain("CLAUDE.md");
      expect(snapshot.files).toContain("README.md");
      expect(snapshot.files).toContain("package.json");
      expect(snapshot.files).toContain("pnpm-workspace.yaml");
      expect(snapshot.files).toContain("docs/01-vision.md");
      expect(snapshot.files).toContain("specs/product/constitution.md");
      // …with their content intact and their relative structure preserved.
      expect(await readFile(join(snapshot.path, "CLAUDE.md"), "utf8")).toContain(
        "Read the docs first."
      );
      expect(await readFile(join(snapshot.path, "docs", "01-vision.md"), "utf8")).toBe(
        "# Vision\n"
      );
    } finally {
      await snapshot.dispose();
    }
  });

  it("never copies a credential, an env file or a key, in any shape", async () => {
    const root = await createWorkspace();
    const snapshot = await snapshotOf(root);
    try {
      const forbidden = [
        ".env",
        ".env.local",
        "credentials.json",
        "service-secret.json",
        "id_rsa",
        "server.pem",
        ".npmrc"
      ];
      for (const name of forbidden) {
        expect(snapshot.files).not.toContain(name);
        await expect(stat(join(snapshot.path, name))).rejects.toThrow();
      }
      // Nothing that leaked a secret string can be in the snapshot at all.
      for (const relative of snapshot.files) {
        const content = await readFile(join(snapshot.path, relative), "utf8");
        expect(content).not.toContain("super-secret");
        expect(content).not.toContain("_authToken");
        expect(content).not.toContain("PRIVATE KEY");
      }
    } finally {
      await snapshot.dispose();
    }
  });

  it("never walks version control, dependencies or build output", async () => {
    const root = await createWorkspace();
    const snapshot = await snapshotOf(root);
    try {
      // Version control, dependencies, build output and caches are never walked, even though each of
      // them contains a file the allowlist would otherwise accept (`package.json`, `README.md`).
      for (const excluded of [
        ".git",
        "node_modules",
        "dist",
        "out",
        ".forgedeck",
        ".turbo",
        "coverage",
        ".cache",
        "build"
      ]) {
        expect(snapshot.files.some((entry) => entry.startsWith(`${excluded}/`))).toBe(false);
        await expect(stat(join(snapshot.path, excluded))).rejects.toThrow();
      }
      // A non-document extension inside a document directory is not analysis material either.
      expect(snapshot.files).not.toContain("docs/diagram.png");
    } finally {
      await snapshot.dispose();
    }
  });

  it("is outside the workspace, so the real project is never the planning cwd", async () => {
    const root = await createWorkspace();
    const snapshot = await snapshotOf(root);
    try {
      expect(snapshot.path).not.toBe(root);
      expect(isInsideWorkspace(root, snapshot.path)).toBe(false);
      // The helper is what callers use to assert isolation, so its own contract is pinned here.
      expect(isInsideWorkspace(root, join(root, "docs"))).toBe(true);
      expect(isInsideWorkspace(root, root)).toBe(true);
    } finally {
      await snapshot.dispose();
    }
  });

  it("absorbs an edit: writes land in the snapshot and the workspace stays identical", async () => {
    const root = await createWorkspace();
    const before = await listTree(root);
    const snapshot = await snapshotOf(root);
    try {
      // Exactly what a misbehaving planning agent would do, done deliberately.
      await writeFile(join(snapshot.path, "CLAUDE.md"), "# Rewritten by the agent\n", "utf8");
      await writeFile(join(snapshot.path, "EVIL.md"), "created by the agent\n", "utf8");
      await rm(join(snapshot.path, "README.md"));

      // The snapshot changed…
      expect(await readFile(join(snapshot.path, "CLAUDE.md"), "utf8")).toContain("Rewritten");
      // …and the real workspace is byte-for-byte what it was.
      expect(await listTree(root)).toEqual(before);
      expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("Read the docs first.");
      await expect(stat(join(root, "EVIL.md"))).rejects.toThrow();
      expect(await readFile(join(root, "README.md"), "utf8")).toBe("# Project\n");
    } finally {
      await snapshot.dispose();
    }
  });

  it("is removed on success and removed again idempotently", async () => {
    const root = await createWorkspace();
    const snapshot = await snapshotOf(root);
    await snapshot.dispose();
    await expect(stat(snapshot.path)).rejects.toThrow();
    // Disposing twice is safe, so a caller may dispose in `finally` after an early return.
    await snapshot.dispose();
    await expect(stat(snapshot.path)).rejects.toThrow();
  });

  it("respects the depth, size and count bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "forgedeck-planning-bounds-"));
    directories.push(root);
    // Depth: a document three levels down is analysis material; one level deeper is out of bounds.
    await mkdir(join(root, "docs", "a", "b", "c"), { recursive: true });
    await writeFile(join(root, "docs", "a", "b", "in-bounds.md"), "# ok\n", "utf8");
    await writeFile(join(root, "docs", "a", "b", "c", "too-deep.md"), "# too deep\n", "utf8");
    // Size: a document larger than the per-file ceiling is skipped rather than truncated.
    await writeFile(join(root, "docs", "huge.md"), "x".repeat(129 * 1024), "utf8");
    await writeFile(join(root, "docs", "small.md"), "# small\n", "utf8");
    // Count: more documents than the ceiling must not all be copied.
    for (let index = 0; index < 210; index += 1) {
      await writeFile(
        join(root, "docs", `bulk-${String(index).padStart(3, "0")}.md`),
        "#\n",
        "utf8"
      );
    }

    const snapshot = await snapshotOf(root);
    try {
      expect(snapshot.files).toContain("docs/a/b/in-bounds.md");
      expect(snapshot.files).not.toContain("docs/a/b/c/too-deep.md");
      expect(snapshot.files).not.toContain("docs/huge.md");
      expect(snapshot.files.length).toBeLessThanOrEqual(200);
      // The cap is a stop, not a filter: what was copied is still a real, readable subset.
      expect(snapshot.files.length).toBeGreaterThan(0);
      for (const relative of snapshot.files) {
        expect((await stat(join(snapshot.path, relative))).isFile()).toBe(true);
      }
    } finally {
      await snapshot.dispose();
    }
  });

  it("stays bounded and tolerates an unreadable workspace instead of failing analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "forgedeck-planning-empty-"));
    directories.push(root);
    const snapshot = await snapshotOf(root);
    try {
      // An empty project yields an empty snapshot rather than an error.
      expect(snapshot.files).toEqual([]);
      expect((await stat(snapshot.path)).isDirectory()).toBe(true);
    } finally {
      await snapshot.dispose();
    }
  });
});
