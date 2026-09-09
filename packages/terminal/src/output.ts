export class LineRingBuffer {
  private data = "";
  private newlineCount = 0;
  private endsWithNewline = false;

  public constructor(private readonly maxLines: number) {
    if (!Number.isInteger(maxLines) || maxLines < 1) {
      throw new Error("Buffer line limit must be a positive integer");
    }
  }

  public append(data: string): void {
    let appendedNewlines = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data.charCodeAt(index) === 10) appendedNewlines += 1;
    }
    this.data += data;
    this.newlineCount += appendedNewlines;
    if (data.length > 0) this.endsWithNewline = data.charCodeAt(data.length - 1) === 10;
    const overflow = this.currentLineCount() - this.maxLines;
    if (overflow <= 0) {
      return;
    }
    let cutIndex = 0;
    let removedNewlines = 0;
    for (let line = 0; line < overflow; line += 1) {
      const newlineIndex = this.data.indexOf("\n", cutIndex);
      if (newlineIndex === -1) {
        break;
      }
      cutIndex = newlineIndex + 1;
      removedNewlines += 1;
    }
    this.data = this.data.slice(cutIndex);
    this.newlineCount -= removedNewlines;
  }

  public snapshot(): string {
    return this.data;
  }

  public clear(): void {
    this.data = "";
    this.newlineCount = 0;
    this.endsWithNewline = false;
  }

  public get lineCount(): number {
    return this.currentLineCount();
  }

  private currentLineCount(): number {
    if (this.data.length === 0) {
      return 0;
    }
    return this.newlineCount + (this.endsWithNewline ? 0 : 1);
  }
}

export class OutputBatcher {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly emit: (data: string) => void,
    private readonly intervalMs: number,
    private readonly maxBatchChars: number
  ) {}

  public push(data: string): void {
    this.pending += data;
    while (this.pending.length >= this.maxBatchChars) {
      const batch = this.pending.slice(0, this.maxBatchChars);
      this.pending = this.pending.slice(this.maxBatchChars);
      this.emit(batch);
    }
    if (this.pending.length > 0 && this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  public flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = "";
      this.emit(batch);
    }
  }

  public dispose(): void {
    this.flush();
  }
}
