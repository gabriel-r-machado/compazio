import type { AgentSpawn, AgentSpawnCanvasEvent } from "@forgedeck/schemas";

interface AgentSpawnDeliveryStore {
  claimNext(projectId?: string): AgentSpawn | null;
  materializeNode(spawnId: string): AgentSpawnCanvasEvent;
  markRunning(
    spawnId: string,
    sessionId: string
  ): { readonly spawn: AgentSpawn; readonly canvasEvent: AgentSpawnCanvasEvent | null };
  markFailed(
    spawnId: string,
    errorCode: string
  ): { readonly spawn: AgentSpawn; readonly canvasEvent: AgentSpawnCanvasEvent | null };
}

export interface AgentSpawnDispatcherServices {
  readonly store: AgentSpawnDeliveryStore;
  readonly startAgent: (spawn: AgentSpawn) => Promise<{ readonly id: string }>;
  readonly stopAgent: (sessionId: string) => Promise<unknown>;
  readonly publish: (event: AgentSpawnCanvasEvent) => void;
  readonly projectId?: string;
  readonly maxConcurrentDeliveries?: number;
}

export class AgentSpawnDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private readonly maxConcurrentDeliveries: number;

  public constructor(
    private readonly services: AgentSpawnDispatcherServices,
    private readonly intervalMs = 250
  ) {
    this.maxConcurrentDeliveries = validatedConcurrency(services.maxConcurrentDeliveries);
  }

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
    let processed = 0;
    try {
      for (;;) {
        const spawns: AgentSpawn[] = [];
        for (let index = 0; index < this.maxConcurrentDeliveries; index += 1) {
          const spawn = this.services.store.claimNext(this.services.projectId);
          if (spawn === null) break;
          spawns.push(spawn);
        }
        if (spawns.length === 0) break;
        processed += spawns.length;
        await Promise.all(spawns.map((spawn) => this.spawn(spawn)));
      }
      return processed;
    } finally {
      this.draining = false;
    }
  }

  private async spawn(request: AgentSpawn): Promise<void> {
    try {
      this.publish(this.services.store.materializeNode(request.id));
    } catch {
      this.fail(request.id);
      return;
    }

    let session: { readonly id: string };
    try {
      session = await this.services.startAgent(request);
    } catch {
      this.fail(request.id);
      return;
    }

    try {
      const completed = this.services.store.markRunning(request.id, session.id);
      if (completed.canvasEvent !== null) this.publish(completed.canvasEvent);
    } catch {
      await this.services.stopAgent(session.id).catch(() => undefined);
      this.fail(request.id);
    }
  }

  private fail(spawnId: string): void {
    const failed = this.services.store.markFailed(spawnId, "agent_launch_failed");
    if (failed.canvasEvent !== null) this.publish(failed.canvasEvent);
  }

  private publish(event: AgentSpawnCanvasEvent): void {
    try {
      this.services.publish(event);
    } catch {
      // Canvas state is durable; a renderer opened later will load the persisted node.
    }
  }
}

function validatedConcurrency(value: number | undefined): number {
  const concurrency = value ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Agent spawn dispatcher concurrency must be between 1 and 8");
  }
  return concurrency;
}
