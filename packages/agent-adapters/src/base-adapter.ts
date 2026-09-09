import type {
  AdapterContext,
  AdapterTerminalOutputSnapshot,
  AdapterSessionControl,
  AgentAdapter,
  AgentManifest,
  AgentMessage,
  AuthResult,
  DetectionResult,
  DetectedExecutable,
  LaunchInput,
  LaunchSpec,
  OutputChunk,
  ParseResult,
  ParserState,
  ReviewedHandoffSubmissionControl,
  ReviewedHandoffSubmissionResult
} from "@forgedeck/agent-sdk";

export interface ReviewedHandoffStrategy {
  readonly insertionSettleMs: number;
  readonly responseTimeoutMs: number;
  readonly awaitInsertionAcknowledgement: boolean;
  isReady(snapshot: AdapterTerminalOutputSnapshot): boolean;
  insertion(payload: string): string;
  submission(): string;
}

export abstract class BaseAgentAdapter implements AgentAdapter {
  public abstract readonly manifest: AgentManifest;
  protected abstract readonly reviewedHandoffStrategy: ReviewedHandoffStrategy;

  public async detect(context: AdapterContext): Promise<DetectionResult> {
    if (!this.manifest.platforms.includes(context.platform)) {
      return unavailable(
        "adapter_platform_unsupported",
        `${this.manifest.displayName} is not supported on ${context.platform}`,
        "Use a supported operating system."
      );
    }
    const executable = await context.detector.find(this.manifest.executables, context);
    if (executable === null) {
      return unavailable(
        "adapter_executable_not_found",
        `${this.manifest.displayName} executable was not found`,
        `Install ${this.manifest.displayName} and ensure it is available on PATH.`
      );
    }
    const versionResult = await context.commandRunner.run({
      executable,
      args: ["--version"],
      cwd: context.cwd,
      environment: compactEnvironment(context.environment),
      timeoutMs: 5_000
    });
    const version = firstLine(versionResult.stdout) ?? firstLine(versionResult.stderr);
    if (versionResult.exitCode !== 0 || version === null) {
      return {
        available: false,
        executable,
        version: null,
        issue: {
          code: "adapter_detection_failed",
          message: `${this.manifest.displayName} was found but could not be executed`,
          remediation: "Verify the installation and run its --version command in a terminal."
        }
      };
    }
    return { available: true, executable, version, issue: null };
  }

  public async validateAuth(
    context: AdapterContext,
    executable: DetectedExecutable
  ): Promise<AuthResult> {
    void context;
    void executable;
    return { authenticated: true, issue: null };
  }

  public abstract buildLaunch(input: LaunchInput): Promise<LaunchSpec>;

  public parseOutput(chunk: OutputChunk, state: ParserState): ParseResult {
    return {
      outputs: [{ kind: "text", data: chunk.data }],
      state: { remainder: state.remainder }
    };
  }

  public encodeMessage(message: AgentMessage): string {
    return `${message.content}\n`;
  }

  public async sendMessage(control: AdapterSessionControl, message: AgentMessage): Promise<void> {
    await control.write(this.encodeMessage(message));
  }

  public isReadyForReviewedHandoff(snapshot: AdapterTerminalOutputSnapshot): boolean {
    return this.reviewedHandoffStrategy.isReady(snapshot);
  }

  public async submitReviewedHandoff(
    control: ReviewedHandoffSubmissionControl,
    payload: string
  ): Promise<ReviewedHandoffSubmissionResult> {
    const beforeInsertion = control.getOutputSnapshot();
    await control.write(this.reviewedHandoffStrategy.insertion(payload));
    await control.reportPhase("written_to_terminal");

    await delay(this.reviewedHandoffStrategy.insertionSettleMs);
    const afterInsertion = control.getOutputSnapshot();
    const insertionOutput = this.reviewedHandoffStrategy.awaitInsertionAcknowledgement
      ? await control.waitForOutputAfter(
          beforeInsertion.sequence,
          this.reviewedHandoffStrategy.responseTimeoutMs
        )
      : afterInsertion;
    if (insertionOutput === null) {
      throw new Error("The adapter did not acknowledge the reviewed handoff insertion");
    }

    await control.write(this.reviewedHandoffStrategy.submission());
    await control.reportPhase("submitted_to_agent");
    const response = await control.waitForOutputAfter(
      insertionOutput.sequence,
      this.reviewedHandoffStrategy.responseTimeoutMs
    );
    if (response === null) {
      throw new Error("The adapter did not confirm a response after submitting the handoff");
    }
    return { confirmation: "response_detected", responseSequence: response.sequence };
  }

  public async requestStop(control: AdapterSessionControl): Promise<void> {
    await control.requestGracefulStop();
  }

  public async forceKill(control: AdapterSessionControl): Promise<void> {
    await control.forceKill();
  }
}

export function interactiveCliHandoffStrategy(
  readiness: (text: string) => boolean
): ReviewedHandoffStrategy {
  return {
    insertionSettleMs: 120,
    responseTimeoutMs: 12_000,
    awaitInsertionAcknowledgement: true,
    isReady: (snapshot) => readiness(terminalText(snapshot.data)),
    insertion: (payload) => `\u001b[200~${payload}\u001b[201~`,
    submission: () => "\r"
  };
}

export function shellHandoffStrategy(): ReviewedHandoffStrategy {
  return {
    insertionSettleMs: 0,
    responseTimeoutMs: 4_000,
    awaitInsertionAcknowledgement: false,
    isReady: () => true,
    insertion: (payload) => payload,
    submission: () => "\r"
  };
}

export function launchSpec(
  input: LaunchInput,
  args: readonly string[],
  initialData?: string
): LaunchSpec {
  const inputData =
    initialData === undefined
      ? undefined
      : input.mode === "interactive"
        ? `${initialData}\r`
        : initialData;
  return {
    executable: input.executable,
    args,
    cwd: input.cwd,
    environment: input.environment,
    cols: input.cols ?? 120,
    rows: input.rows ?? 30,
    ...(inputData === undefined
      ? {}
      : { initialInput: { data: inputData, closeAfterWrite: input.mode === "non-interactive" } })
  };
}

export function parseJsonLines(chunk: OutputChunk, state: ParserState): ParseResult {
  const combined = state.remainder + chunk.data;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  return {
    outputs: lines.filter(Boolean).map((line) => {
      try {
        return { kind: "event" as const, data: JSON.parse(line) as unknown };
      } catch {
        return { kind: "text" as const, data: line };
      }
    }),
    state: { remainder }
  };
}

export function compactEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function unavailable(
  code: "adapter_platform_unsupported" | "adapter_executable_not_found",
  message: string,
  remediation: string
): DetectionResult {
  return {
    available: false,
    executable: null,
    version: null,
    issue: { code, message, remediation }
  };
}

function firstLine(value: string): string | null {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function terminalText(value: string): string {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  return value
    .replace(new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, "g"), "")
    .replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(/\r/g, "");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
