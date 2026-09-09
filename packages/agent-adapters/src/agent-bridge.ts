import type {
  AdapterContext,
  AdapterIssue,
  AdapterSessionControl,
  AdapterTerminalOutputSnapshot,
  AgentAdapter,
  AgentMessage
} from "@forgedeck/agent-sdk";

export interface AgentBridgeAdapterResolver {
  get(adapterId: string): AgentAdapter;
}

export interface AgentBridgeAdapterSource extends AgentBridgeAdapterResolver {
  list(): readonly AgentAdapter[];
}

export interface AgentBridgeStatus {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentAdapter["manifest"]["capabilities"];
  readonly available: boolean;
  readonly version: string | null;
  readonly issue: AdapterIssue | null;
}

export interface AgentBridgeReadiness {
  readonly ready: boolean;
  readonly reason: "ready" | "adapter_not_interactive" | "prompt_not_ready";
}

export interface AgentBridgeResponseControl {
  getOutputSnapshot(): AdapterTerminalOutputSnapshot;
  waitForOutputAfter(
    sequence: number,
    timeoutMs: number
  ): Promise<AdapterTerminalOutputSnapshot | null>;
}

export interface AgentBridgeResponse {
  readonly status: "response_detected" | "timed_out";
  readonly responseSequence: number | null;
}

export class AgentBridgeError extends Error {
  public constructor(
    public readonly code: "agent_bridge_send_timed_out" | "agent_bridge_send_failed"
  ) {
    super(
      code === "agent_bridge_send_timed_out"
        ? "Agent delivery timed out"
        : "Agent delivery could not be completed"
    );
  }
}

/**
 * One provider-neutral bridge for the interactive agent lifecycle. It deliberately exposes only
 * capabilities, readiness, delivery completion and response sequence—not terminal output,
 * executable locations or provider command lines.
 */
export class AgentBridge {
  public constructor(
    private readonly adapters: AgentBridgeAdapterResolver,
    private readonly verificationTimeoutMs = 6_000
  ) {}

  public async inspect(context: AdapterContext): Promise<readonly AgentBridgeStatus[]> {
    const source = this.adapters as AgentBridgeAdapterSource;
    if (typeof source.list !== "function") {
      throw new Error("Agent bridge cannot enumerate adapters");
    }
    return Promise.all(source.list().map((adapter) => this.inspectAdapter(adapter, context)));
  }

  public async status(adapterId: string, context: AdapterContext): Promise<AgentBridgeStatus> {
    return this.inspectAdapter(this.adapters.get(adapterId), context);
  }

  public readiness(
    adapterId: string,
    snapshot: AdapterTerminalOutputSnapshot
  ): AgentBridgeReadiness {
    const adapter = this.adapters.get(adapterId);
    if (!adapter.manifest.capabilities.interactive) {
      return { ready: false, reason: "adapter_not_interactive" };
    }
    return adapter.isReadyForReviewedHandoff(snapshot)
      ? { ready: true, reason: "ready" }
      : { ready: false, reason: "prompt_not_ready" };
  }

  public async send(
    adapterId: string,
    control: AdapterSessionControl,
    message: AgentMessage,
    timeoutMs = 8_000
  ): Promise<void> {
    try {
      await withTimeout(this.adapters.get(adapterId).sendMessage(control, message), timeoutMs);
    } catch (error: unknown) {
      if (error instanceof BridgeTimeoutError) {
        throw new AgentBridgeError("agent_bridge_send_timed_out");
      }
      throw new AgentBridgeError("agent_bridge_send_failed");
    }
  }

  public async waitForResponse(
    control: AgentBridgeResponseControl,
    timeoutMs = 12_000
  ): Promise<AgentBridgeResponse> {
    const snapshot = control.getOutputSnapshot();
    const response = await control.waitForOutputAfter(
      snapshot.sequence,
      boundedTimeout(timeoutMs, 12_000)
    );
    return response === null
      ? { status: "timed_out", responseSequence: null }
      : { status: "response_detected", responseSequence: response.sequence };
  }

  private async inspectAdapter(
    adapter: AgentAdapter,
    context: AdapterContext
  ): Promise<AgentBridgeStatus> {
    const detectionAttempt = await verify(
      () => adapter.detect(context),
      verificationFailure(adapter.manifest.displayName),
      this.verificationTimeoutMs
    );
    if ("failure" in detectionAttempt)
      return statusWithIssue(adapter, null, detectionAttempt.failure);
    const detection = detectionAttempt.result;
    if (!detection.available || detection.executable === null) {
      return statusWithIssue(adapter, detection.version, detection.issue);
    }
    const executable = detection.executable;
    const authenticationAttempt = await verify(
      () => adapter.validateAuth(context, executable),
      authenticationFailure(adapter.manifest.displayName),
      this.verificationTimeoutMs
    );
    if ("failure" in authenticationAttempt) {
      return statusWithIssue(adapter, detection.version, authenticationAttempt.failure);
    }
    const authentication = authenticationAttempt.result;
    if (!authentication.authenticated) {
      return statusWithIssue(adapter, detection.version, authentication.issue);
    }
    return {
      id: adapter.manifest.id,
      displayName: adapter.manifest.displayName,
      capabilities: adapter.manifest.capabilities,
      available: true,
      version: detection.version,
      issue: null
    };
  }
}

async function verify<T>(
  action: () => Promise<T>,
  fallback: AdapterIssue,
  timeoutMs: number
): Promise<{ readonly result: T } | { readonly failure: AdapterIssue }> {
  try {
    return { result: await withTimeout(action(), timeoutMs) };
  } catch {
    return { failure: fallback };
  }
}

function statusWithIssue(
  adapter: AgentAdapter,
  version: string | null,
  issue: AdapterIssue | null
): AgentBridgeStatus {
  return {
    id: adapter.manifest.id,
    displayName: adapter.manifest.displayName,
    capabilities: adapter.manifest.capabilities,
    available: false,
    version,
    issue: issue ?? {
      code: "adapter_detection_failed",
      message: `${adapter.manifest.displayName} is unavailable`,
      remediation: "Verify the local installation and try again."
    }
  };
}

function verificationFailure(displayName: string): AdapterIssue {
  return {
    code: "adapter_detection_failed",
    message: `${displayName} could not complete functional verification`,
    remediation: "Verify the local installation and try again."
  };
}

function authenticationFailure(displayName: string): AdapterIssue {
  return {
    code: "adapter_auth_unavailable",
    message: `${displayName} could not verify local authentication`,
    remediation: "Sign in through the provider CLI and try again."
  };
}

function boundedTimeout(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 100) return 100;
  return Math.min(Math.floor(value), maximum);
}

class BridgeTimeoutError extends Error {}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new BridgeTimeoutError()),
          boundedTimeout(timeoutMs, 12_000)
        );
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
