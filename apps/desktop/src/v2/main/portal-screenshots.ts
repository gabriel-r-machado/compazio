import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PortalCapturedImage {
  getSize(): { readonly width: number; readonly height: number };
  resize(options: { width?: number; height?: number }): PortalCapturedImage;
  toPNG(): Buffer;
  isEmpty(): boolean;
}

export interface PortalScreenshotReference {
  readonly id: string;
  readonly portalId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PortalScreenshotStoreOptions {
  readonly directory: string;
  readonly ttlMs?: number;
  readonly maxPerPortal?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
}

/**
 * Screenshots are temporary evidence, not workspace content. They live in a managed directory with
 * a backend-generated name and an expiry, so a Portal cannot write anywhere it likes and a deleted
 * Portal cannot leave images behind.
 */
export class PortalScreenshotStore {
  public static readonly defaultTtlMs = 10 * 60_000;
  public static readonly defaultMaxPerPortal = 10;

  private readonly references = new Map<string, PortalScreenshotReference>();
  private readonly ttlMs: number;
  private readonly maxPerPortal: number;
  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private sequence = 0;

  public constructor(private readonly options: PortalScreenshotStoreOptions) {
    this.ttlMs = options.ttlMs ?? PortalScreenshotStore.defaultTtlMs;
    this.maxPerPortal = options.maxPerPortal ?? PortalScreenshotStore.defaultMaxPerPortal;
    this.maxWidth = options.maxWidth ?? 1_920;
    this.maxHeight = options.maxHeight ?? 1_920;
    this.now = options.now ?? (() => Date.now());
    this.createId =
      options.createId ??
      (() => `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${randomSuffix()}`);
  }

  public get directory(): string {
    return this.options.directory;
  }

  public async save(
    workspaceId: string,
    portalId: string,
    image: PortalCapturedImage
  ): Promise<PortalScreenshotReference> {
    if (image.isEmpty()) throw new Error("PORTAL_SCREENSHOT_EMPTY");
    const original = image.getSize();
    const scale = Math.min(
      1,
      this.maxWidth / Math.max(1, original.width),
      this.maxHeight / Math.max(1, original.height)
    );
    const resized =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.floor(original.width * scale)),
            height: Math.max(1, Math.floor(original.height * scale))
          })
        : image;
    const size = resized.getSize();
    const buffer = resized.toPNG();
    await mkdir(this.options.directory, { recursive: true });
    const id = this.createId();
    // The name comes from the backend: the page never influences where bytes land.
    const path = join(this.options.directory, `portal-${safeSegment(portalId)}-${id}.png`);
    await writeFile(path, buffer);
    const createdAt = this.now();
    const reference: PortalScreenshotReference = {
      id,
      portalId,
      workspaceId,
      path,
      width: size.width,
      height: size.height,
      bytes: buffer.byteLength,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.ttlMs).toISOString()
    };
    this.references.set(id, reference);
    await this.enforcePortalLimit(workspaceId, portalId);
    await this.sweep();
    return reference;
  }

  public list(filter?: {
    workspaceId?: string;
    portalId?: string;
  }): readonly PortalScreenshotReference[] {
    return [...this.references.values()].filter(
      (reference) =>
        (filter?.workspaceId === undefined || reference.workspaceId === filter.workspaceId) &&
        (filter?.portalId === undefined || reference.portalId === filter.portalId)
    );
  }

  public count(): number {
    return this.references.size;
  }

  public async remove(id: string): Promise<void> {
    const reference = this.references.get(id);
    if (reference === undefined) return;
    this.references.delete(id);
    await rm(reference.path, { force: true });
  }

  public async removePortal(workspaceId: string, portalId: string): Promise<number> {
    const targets = this.list({ workspaceId, portalId });
    for (const reference of targets) await this.remove(reference.id);
    return targets.length;
  }

  public async removeWorkspace(workspaceId: string): Promise<number> {
    const targets = this.list({ workspaceId });
    for (const reference of targets) await this.remove(reference.id);
    return targets.length;
  }

  /** Expired references are deleted even when nobody asked, so a long session cannot accumulate. */
  public async sweep(): Promise<number> {
    const now = this.now();
    const expired = [...this.references.values()].filter(
      (reference) => Date.parse(reference.expiresAt) <= now
    );
    for (const reference of expired) await this.remove(reference.id);
    return expired.length;
  }

  /** Removes every tracked file and any stray PNG left by a previous run in the managed directory. */
  public async clear(): Promise<void> {
    for (const id of [...this.references.keys()]) await this.remove(id);
    let entries: string[];
    try {
      entries = await readdir(this.options.directory);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("portal-") && entry.endsWith(".png"))
        .map((entry) => rm(join(this.options.directory, entry), { force: true }))
    );
  }

  /** Files present on disk but not tracked: a leak the smoke suite must be able to observe. */
  public async orphans(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.options.directory);
    } catch {
      return [];
    }
    const tracked = new Set([...this.references.values()].map((reference) => reference.path));
    const found: string[] = [];
    for (const entry of entries) {
      const path = join(this.options.directory, entry);
      if (tracked.has(path)) continue;
      const info = await stat(path).catch(() => null);
      if (info !== null && info.isFile()) found.push(path);
    }
    return found;
  }

  private async enforcePortalLimit(workspaceId: string, portalId: string): Promise<void> {
    const owned = [...this.list({ workspaceId, portalId })].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
    const excess = owned.length - this.maxPerPortal;
    for (let index = 0; index < excess; index += 1) {
      const reference = owned[index];
      if (reference !== undefined) await this.remove(reference.id);
    }
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "portal";
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
