export interface TerminalGridSize {
  readonly cols: number;
  readonly rows: number;
}

interface TerminalResizeCoordinatorOptions {
  readonly measure: () => TerminalGridSize | undefined;
  readonly resizePty: (size: TerminalGridSize) => Promise<void>;
  readonly resizeRenderer: (size: TerminalGridSize) => void;
  readonly onTransitionStart?: () => void;
  readonly onTransitionEnd?: () => void;
  readonly onError: (error: unknown) => void;
  readonly delayMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (timer: number) => void;
}

export interface TerminalResizeCoordinator {
  request(): void;
  dispose(): void;
}

function sameSize(left: TerminalGridSize | undefined, right: TerminalGridSize): boolean {
  return left?.cols === right.cols && left.rows === right.rows;
}

/**
 * Keeps the PTY and xterm on one committed grid. Measurements may change freely while a card is
 * dragged, but neither side is mutated until the dimensions settle. PTY output can be buffered by
 * the transition callbacks while the main process applies the ConPTY resize.
 */
export function createTerminalResizeCoordinator(
  options: TerminalResizeCoordinatorOptions
): TerminalResizeCoordinator {
  const setTimer =
    options.setTimer ??
    ((callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number);
  const clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));
  const delayMs = options.delayMs ?? 80;
  let timer: number | undefined;
  let pending: TerminalGridSize | undefined;
  let committed: TerminalGridSize | undefined;
  let committing = false;
  let disposed = false;

  const scheduleCommit = (delay = delayMs): void => {
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      void commit();
    }, delay);
  };

  const commit = async (): Promise<void> => {
    if (disposed || committing) return;
    const size = pending;
    pending = undefined;
    if (size === undefined || sameSize(committed, size)) return;
    committing = true;
    options.onTransitionStart?.();
    try {
      // Await the real PTY resize before exposing the new renderer grid. Output produced in this
      // interval is buffered by the caller and replayed only after xterm has the matching size.
      await options.resizePty(size);
      if (disposed) return;
      options.resizeRenderer(size);
      committed = size;
    } catch (error: unknown) {
      options.onError(error);
    } finally {
      options.onTransitionEnd?.();
      committing = false;
      if (!disposed && pending !== undefined && !sameSize(committed, pending)) scheduleCommit(0);
    }
  };

  return {
    request(): void {
      if (disposed) return;
      const measured = options.measure();
      if (
        measured === undefined ||
        !Number.isInteger(measured.cols) ||
        !Number.isInteger(measured.rows) ||
        measured.cols < 1 ||
        measured.rows < 1
      )
        return;
      pending = measured;
      if (!committing) scheduleCommit();
    },
    dispose(): void {
      disposed = true;
      pending = undefined;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    }
  };
}
