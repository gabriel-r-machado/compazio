import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PortalScreenshotStore, type PortalCapturedImage } from "./portal-screenshots";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "compazio-portal-shots-"));
  roots.push(root);
  return root;
}

const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function image(width = 800, height = 600, empty = false): PortalCapturedImage {
  const self: PortalCapturedImage = {
    getSize: () => ({ width, height }),
    resize: (options) => image(options.width ?? width, options.height ?? height),
    toPNG: () => Buffer.concat([pngHeader, Buffer.from(`${width}x${height}`)]),
    isEmpty: () => empty
  };
  return self;
}

describe("portal screenshot store", () => {
  it("writes a managed PNG and returns a safe reference", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root });
    const reference = await store.save("w1", "p1", image());
    expect(reference.path.startsWith(root)).toBe(true);
    expect(reference.path).toContain("portal-p1-");
    expect(reference.path.endsWith(".png")).toBe(true);
    const bytes = await readFile(reference.path);
    expect(bytes.subarray(0, 8)).toEqual(pngHeader);
    expect(reference.bytes).toBe(bytes.byteLength);
    expect(Date.parse(reference.expiresAt)).toBeGreaterThan(Date.parse(reference.createdAt));
    expect(store.count()).toBe(1);
  });

  it("keeps the resolution inside the configured limit", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root, maxWidth: 400, maxHeight: 400 });
    const reference = await store.save("w1", "p1", image(1_600, 1_200));
    expect(reference.width).toBe(400);
    expect(reference.height).toBe(300);
  });

  it("never takes the file name from the page", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root });
    const reference = await store.save("w1", "../../evil id", image());
    expect(reference.path.startsWith(root)).toBe(true);
    expect(reference.path).not.toContain("..");
    expect(reference.path).toContain("portal-evilid-");
  });

  it("refuses an empty capture", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root });
    await expect(store.save("w1", "p1", image(0, 0, true))).rejects.toThrow(
      "PORTAL_SCREENSHOT_EMPTY"
    );
    expect(store.count()).toBe(0);
  });

  it("keeps only the newest captures of a Portal", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root, maxPerPortal: 2 });
    const first = await store.save("w1", "p1", image());
    await store.save("w1", "p1", image());
    await store.save("w1", "p1", image());
    expect(store.list({ portalId: "p1" })).toHaveLength(2);
    expect(await readdir(root)).toHaveLength(2);
    expect(store.list().some((item) => item.id === first.id)).toBe(false);
  });

  it("removes expired captures from disk", async () => {
    const root = await directory();
    let clock = 1_000;
    const store = new PortalScreenshotStore({ directory: root, ttlMs: 100, now: () => clock });
    await store.save("w1", "p1", image());
    clock += 500;
    expect(await store.sweep()).toBe(1);
    expect(await readdir(root)).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("cleans up when a Portal or a workspace goes away", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root });
    await store.save("w1", "p1", image());
    await store.save("w1", "p2", image());
    await store.save("w2", "p3", image());
    expect(await store.removePortal("w1", "p1")).toBe(1);
    expect(store.count()).toBe(2);
    expect(await store.removeWorkspace("w1")).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(await readdir(root)).toHaveLength(1);
  });

  it("clears every managed file when the application closes", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root });
    await store.save("w1", "p1", image());
    await writeFile(join(root, "portal-p9-orfa.png"), pngHeader);
    await store.clear();
    expect(await readdir(root)).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("reports untracked files as orphans", async () => {
    const root = await directory();
    const store = new PortalScreenshotStore({ directory: root });
    await store.save("w1", "p1", image());
    expect(await store.orphans()).toEqual([]);
    await writeFile(join(root, "portal-p9-orfa.png"), pngHeader);
    expect(await store.orphans()).toEqual([join(root, "portal-p9-orfa.png")]);
  });

  it("tolerates a directory that was never created", async () => {
    const store = new PortalScreenshotStore({
      directory: join(tmpdir(), "compazio-inexistente-x")
    });
    expect(await store.orphans()).toEqual([]);
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
