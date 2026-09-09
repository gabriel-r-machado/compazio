import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemService, normalizeRelative } from "./file-system-service";
import type { FileSystemError } from "./file-system-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    })
  );
});

async function fixture(): Promise<{ readonly root: string; readonly service: FileSystemService }> {
  const root = await mkdtemp(join(tmpdir(), "compazio-v2-files-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "example.ts"), "export const value = 1;\n", "utf8");
  return { root, service: new FileSystemService({ workspaceRoot: async () => root }) };
}

describe("FileSystemService", () => {
  it("lists lazily, reads text and saves atomically with a revision", async () => {
    const { service } = await fixture();
    expect(await service.list("workspace", ".")).toMatchObject([
      { path: "src", kind: "directory" }
    ]);
    const opened = await service.read("workspace", "src/example.ts");
    const saved = await service.write(
      "workspace",
      "src/example.ts",
      "export const value = 2;\n",
      opened.revision
    );
    expect(saved.content).toContain("2");
    expect(await service.read("workspace", "src/example.ts")).toEqual(saved);
  });

  it("detects external edits instead of silently overwriting them", async () => {
    const { root, service } = await fixture();
    const opened = await service.read("workspace", "src/example.ts");
    await writeFile(join(root, "src", "example.ts"), "externally changed\n", "utf8");
    await expect(
      service.write("workspace", "src/example.ts", "local\n", opened.revision)
    ).rejects.toMatchObject({
      code: "FILE_CHANGED_EXTERNALLY"
    } satisfies Partial<FileSystemError>);
  });

  it("blocks traversal and keeps operations under the canonical workspace root", async () => {
    const { root, service } = await fixture();
    const attempts = [
      "../secrets.txt",
      "..\\secrets.txt",
      join(root, "outside.txt"),
      "%2e%2e/secrets.txt"
    ];
    for (const path of attempts) {
      expect(() => normalizeRelative(path)).toThrow(/workspace/i);
      await expect(service.read("workspace", path)).rejects.toMatchObject({
        code: "PATH_TRAVERSAL_BLOCKED"
      } satisfies Partial<FileSystemError>);
    }
  });

  it("creates, renames and removes files without leaving destination collisions", async () => {
    const { root, service } = await fixture();
    await service.createFile("workspace", "src/new file.txt", "hello");
    await service.rename("workspace", "src/new file.txt", "src/renamed.txt");
    expect(await readFile(join(root, "src", "renamed.txt"), "utf8")).toBe("hello");
    await service.remove("workspace", "src/renamed.txt");
    await expect(service.read("workspace", "src/renamed.txt")).rejects.toMatchObject({
      code: "FILE_NOT_FOUND"
    });
  });

  it("keeps a file already inside the workspace where it is", async () => {
    const { root, service } = await fixture();
    expect(await service.importFiles("workspace", [join(root, "src", "example.ts")])).toEqual([
      { path: "src/example.ts", previewKind: "text", copied: false }
    ]);
  });

  it("copies a file chosen outside the workspace into the workspace", async () => {
    const { root, service } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "compazio-v2-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "diagrama.md"), "# fora\n", "utf8");
    const [imported] = await service.importFiles("workspace", [join(outside, "diagrama.md")]);
    expect(imported).toEqual({
      path: ".compazio/anexos/diagrama.md",
      previewKind: "text",
      copied: true
    });
    expect(await readFile(join(root, ".compazio", "anexos", "diagrama.md"), "utf8")).toBe(
      "# fora\n"
    );
  });

  // Trazer o mesmo nome duas vezes não pode apagar o primeiro anexo.
  it("never overwrites an attachment with the same name", async () => {
    const { root, service } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "compazio-v2-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "nota.md"), "primeiro", "utf8");
    await service.importFiles("workspace", [join(outside, "nota.md")]);
    await writeFile(join(outside, "nota.md"), "segundo", "utf8");
    const [second] = await service.importFiles("workspace", [join(outside, "nota.md")]);
    expect(second?.path).toBe(".compazio/anexos/nota-1.md");
    expect(await readFile(join(root, ".compazio", "anexos", "nota.md"), "utf8")).toBe("primeiro");
  });

  it("refuses folders and unreadable choices", async () => {
    const { root, service } = await fixture();
    await expect(service.importFiles("workspace", [join(root, "src")])).rejects.toMatchObject({
      code: "FILE_NOT_FOUND"
    });
    await expect(
      service.importFiles("workspace", [join(root, "src", "ausente.ts")])
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("never turns create or rename into an overwrite when a destination exists", async () => {
    const { service } = await fixture();
    await expect(
      service.createFile("workspace", "src/example.ts", "replacement")
    ).rejects.toMatchObject({
      code: "FILE_WRITE_CONFLICT"
    });
    await service.createFile("workspace", "src/other.ts", "other");
    await expect(
      service.rename("workspace", "src/other.ts", "src/example.ts")
    ).rejects.toMatchObject({ code: "FILE_WRITE_CONFLICT" });
    expect((await service.read("workspace", "src/example.ts")).content).toContain("value = 1");
  });
});
