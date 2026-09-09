const maximumBufferBytes = 200_000;

class TerminalOutputBus {
  private readonly buffers = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(data: string) => void>>();

  public publish(sessionId: string, data: string): void {
    this.buffers.set(
      sessionId,
      `${this.buffers.get(sessionId) ?? ""}${data}`.slice(-maximumBufferBytes)
    );
    for (const listener of this.listeners.get(sessionId) ?? []) listener(data);
  }

  public subscribe(sessionId: string, listener: (data: string) => void): () => void {
    const current = this.listeners.get(sessionId) ?? new Set<(data: string) => void>();
    current.add(listener);
    this.listeners.set(sessionId, current);
    return () => {
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  public snapshot(sessionId: string): string {
    return this.buffers.get(sessionId) ?? "";
  }

  public clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.buffers.clear();
      return;
    }
    this.buffers.delete(sessionId);
  }

  public diagnostics(): { readonly bufferedSessionCount: number; readonly listenerCount: number } {
    return {
      bufferedSessionCount: this.buffers.size,
      listenerCount: [...this.listeners.values()].reduce(
        (total, listeners) => total + listeners.size,
        0
      )
    };
  }
}

export const terminalOutputBus = new TerminalOutputBus();
