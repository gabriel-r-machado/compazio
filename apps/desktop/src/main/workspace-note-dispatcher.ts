import type { WorkspaceNoteCanvasEvent } from "@forgedeck/schemas";

interface WorkspaceNoteProjectionStore {
  claimNextCanvasEvent(): WorkspaceNoteCanvasEvent | null;
  markCanvasEventPublished(eventId: string): void;
}

export interface WorkspaceNoteDispatcherServices {
  readonly store: WorkspaceNoteProjectionStore;
  readonly publish: (event: WorkspaceNoteCanvasEvent) => void;
}

export class WorkspaceNoteDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  public constructor(
    private readonly services: WorkspaceNoteDispatcherServices,
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
