interface QueueEntry {
  readonly data: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class MessageQueue {
  private readonly entries: QueueEntry[] = [];
  private queuedBytes = 0;
  private writer: ((data: string) => void) | null = null;
  private draining = false;
  private closed = false;

  public constructor(
    private readonly maxMessages: number,
    private readonly maxBytes: number
  ) {}

  public attach(writer: (data: string) => void): void {
    if (this.closed) {
      throw new Error("Cannot attach a closed message queue");
    }
    this.writer = writer;
    this.scheduleDrain();
  }

  public enqueue(data: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Message queue is closed"));
    }
    const bytes = Buffer.byteLength(data, "utf8");
    if (this.entries.length >= this.maxMessages || this.queuedBytes + bytes > this.maxBytes) {
      return Promise.reject(new Error("Message queue limit exceeded"));
    }

    return new Promise<void>((resolve, reject) => {
      this.entries.push({ data, resolve, reject });
      this.queuedBytes += bytes;
      this.scheduleDrain();
    });
  }

  public close(reason = "Message queue closed"): void {
    this.closed = true;
    const error = new Error(reason);
    for (const entry of this.entries.splice(0)) {
      entry.reject(error);
    }
    this.queuedBytes = 0;
  }

  private scheduleDrain(): void {
    if (this.draining || this.writer === null || this.entries.length === 0) {
      return;
    }
    this.draining = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    const writer = this.writer;
    if (writer === null) {
      this.draining = false;
      return;
    }
    const entry = this.entries.shift();
    if (entry === undefined) {
      this.draining = false;
      return;
    }
    this.queuedBytes -= Buffer.byteLength(entry.data, "utf8");
    try {
      writer(entry.data);
      entry.resolve();
    } catch (error: unknown) {
      entry.reject(error instanceof Error ? error : new Error("PTY write failed"));
    }
    this.draining = false;
    this.scheduleDrain();
  }
}
