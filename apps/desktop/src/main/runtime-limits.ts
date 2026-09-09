export interface RuntimeLimits {
  readonly maxConcurrentDeliveriesPerProject: number;
  readonly maxActiveSessionsPerProject: number;
  readonly maxQueuedMessagesPerSession: number;
  readonly maxQueuedBytesPerSession: number;
  readonly maxBufferLinesPerSession: number;
  /**
   * Per-process ceiling inside a terminal. Zero disables the check; the product ships it off, because
   * killing a person's process is not something to start doing without being asked.
   */
  readonly maxProcessMemoryBytesPerSession: number;
  readonly projectLeaseStaleAfterMs: number;
}

/** Reads only host environment values and clamps every resource limit to safe local bounds. */
export function readRuntimeLimits(
  environment: Readonly<Record<string, string | undefined>>
): RuntimeLimits {
  return {
    maxConcurrentDeliveriesPerProject: bounded(
      environment.FORGEDECK_MAX_CONCURRENT_DELIVERIES_PER_PROJECT,
      2,
      1,
      8
    ),
    maxActiveSessionsPerProject: bounded(environment.FORGEDECK_MAX_TERMINALS_PER_PROJECT, 8, 1, 32),
    maxQueuedMessagesPerSession: bounded(environment.FORGEDECK_MAX_QUEUED_MESSAGES, 100, 1, 500),
    maxQueuedBytesPerSession: bounded(
      environment.FORGEDECK_MAX_QUEUED_BYTES,
      1024 * 1024,
      4 * 1024,
      8 * 1024 * 1024
    ),
    maxBufferLinesPerSession: bounded(environment.FORGEDECK_MAX_BUFFER_LINES, 10_000, 100, 50_000),
    maxProcessMemoryBytesPerSession:
      environment.FORGEDECK_MAX_PROCESS_MEMORY_MB === undefined
        ? 0
        : bounded(environment.FORGEDECK_MAX_PROCESS_MEMORY_MB, 0, 256, 32_768) * 1024 * 1024,
    projectLeaseStaleAfterMs: bounded(
      environment.FORGEDECK_RUNTIME_LEASE_TTL_MS,
      30_000,
      15_000,
      300_000
    )
  };
}

function bounded(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
