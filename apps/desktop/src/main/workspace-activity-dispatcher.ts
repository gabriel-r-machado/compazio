import type { WorkspaceActivityEvent } from "@forgedeck/schemas";

interface WorkspaceActivityStore {
  prime(): void;
  pull(): readonly WorkspaceActivityEvent[];
}

export interface WorkspaceActivityDispatcherServices {
  readonly store: WorkspaceActivityStore;
  readonly observe: (onChange: () => void) => () => void;
  readonly publish: (event: WorkspaceActivityEvent) => void;
}

/**
 * Uses one debounced local database observer, with a slow safety sweep for filesystems that do not
 * emit watch notifications. It carries only redacted persisted event metadata to the renderer.
 */
export class WorkspaceActivityDispatcher {
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private draining = false;

  public constructor(
    private readonly services: WorkspaceActivityDispatcherServices,
    private readonly fallbackIntervalMs = 5_000,
    private readonly debounceMs = 80
  ) {}

  public start(): void {
    if (this.unsubscribe !== null) return;
    this.services.store.prime();
    this.unsubscribe = this.services.observe(() => this.scheduleDrain());
    this.fallbackTimer = setInterval(() => this.scheduleDrain(), this.fallbackIntervalMs);
    this.fallbackTimer.unref();
    void this.drain();
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  public async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const events = this.services.store.pull();
      for (const event of events) this.services.publish(event);
      return events.length;
    } finally {
      this.draining = false;
    }
  }

  private scheduleDrain(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.drain();
    }, this.debounceMs);
  }
}
