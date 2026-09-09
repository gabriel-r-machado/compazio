import type { WorkspaceArtifactCanvasEvent } from "@forgedeck/schemas";

interface WorkspaceArtifactProjectionStore {
  claimNextCanvasEvent(): WorkspaceArtifactCanvasEvent | null;
  markCanvasEventPublished(eventId: string): void;
}

export interface WorkspaceArtifactDispatcherServices {
  readonly store: WorkspaceArtifactProjectionStore;
  readonly publish: (event: WorkspaceArtifactCanvasEvent) => void;
}

export class WorkspaceArtifactDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  public constructor(
    private readonly services: WorkspaceArtifactDispatcherServices,
    private readonly intervalMs = 250
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.drain(), this.intervalMs);
    this.timer.unref();
    void this.drain();
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let published = 0;
    try {
      for (;;) {
        const event = this.services.store.claimNextCanvasEvent();
        if (event === null) return published;
        try {
          this.services.publish(event);
          this.services.store.markCanvasEventPublished(event.id);
          published += 1;
        } catch {
          return published;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
