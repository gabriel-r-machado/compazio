import { AgentBridge, AgentBridgeError } from "@forgedeck/agent-adapters";
import type { AgentAdapter, AdapterSessionControl } from "@forgedeck/agent-sdk";
import type { AgentMessage } from "@forgedeck/schemas";

interface AgentMessageDeliveryStore {
  claimNext(projectId?: string): AgentMessage | null;
  markSent(messageId: string): AgentMessage;
  markFailed(messageId: string, errorCode: string): AgentMessage;
}

interface AgentAdapterResolver {
  get(adapterId: string): AgentAdapter;
}

interface AgentMessageTerminal {
  write(sessionId: string, data: string): Promise<void>;
  cancel(sessionId: string): Promise<unknown>;
  forceKill(sessionId: string): Promise<void>;
}

export interface AgentMessageDispatcherServices {
  readonly store: AgentMessageDeliveryStore;
  readonly adapters: AgentAdapterResolver;
  readonly terminal: AgentMessageTerminal;
  readonly bridge?: Pick<AgentBridge, "send">;
  readonly projectId?: string;
  readonly maxConcurrentDeliveries?: number;
}

export class AgentMessageDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private readonly maxConcurrentDeliveries: number;

  public constructor(
    private readonly services: AgentMessageDispatcherServices,
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
        const messages: AgentMessage[] = [];
        for (let index = 0; index < this.maxConcurrentDeliveries; index += 1) {
          const message = this.services.store.claimNext(this.services.projectId);
          if (message === null) break;
          messages.push(message);
        }
        if (messages.length === 0) break;
        processed += messages.length;
        await Promise.all(messages.map((message) => this.deliver(message)));
      }
      return processed;
    } finally {
      this.draining = false;
    }
  }

  private async deliver(message: AgentMessage): Promise<void> {
    if (message.sessionId === null || message.adapterId === null) {
      this.services.store.markFailed(message.id, "endpoint_unavailable");
      return;
    }
    if (message.adapterId === "shell") {
      this.services.store.markFailed(message.id, "recipient_not_agent");
      return;
    }
    try {
      this.services.adapters.get(message.adapterId);
    } catch {
      this.services.store.markFailed(message.id, "adapter_unavailable");
      return;
    }
    const control: AdapterSessionControl = {
      write: (data) => this.services.terminal.write(message.sessionId as string, data),
      requestGracefulStop: async () => {
        await this.services.terminal.cancel(message.sessionId as string);
      },
      forceKill: () => this.services.terminal.forceKill(message.sessionId as string)
    };
    try {
      await (this.services.bridge ?? new AgentBridge(this.services.adapters)).send(
        message.adapterId,
        control,
        {
          id: message.id,
          content: formatAgentMessage(message)
        }
      );
      this.services.store.markSent(message.id);
    } catch (error: unknown) {
      this.services.store.markFailed(
        message.id,
        error instanceof AgentBridgeError ? error.code : "session_write_failed"
      );
    }
  }
}

function validatedConcurrency(value: number | undefined): number {
  const concurrency = value ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Agent message dispatcher concurrency must be between 1 and 8");
  }
  return concurrency;
}

function formatAgentMessage(message: AgentMessage): string {
  return [
    "[Compazio message]",
    `message_id: ${message.id}`,
    `from: ${message.senderNodeId ?? "user"}`,
    `to: ${message.recipientNodeId}`,
    `respond_with: compasso respond ${message.id} --from ${message.recipientNodeId} "<response>"`,
    "",
    message.content
  ].join("\n");
}
