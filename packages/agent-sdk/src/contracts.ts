import { z } from "zod";

export const runtimePlatformSchema = z.enum(["win32", "darwin", "linux"]);

export const adapterCapabilitiesSchema = z
  .object({
    interactive: z.boolean(),
    nonInteractive: z.boolean(),
    resume: z.boolean(),
    structuredOutput: z.boolean(),
    mcp: z.boolean(),
    imageInput: z.boolean().default(false),
    messageQueue: z.boolean().default(false)
  })
  .strict();

export const agentManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    displayName: z.string().min(1),
    version: z.string().min(1),
    executables: z.array(z.string().min(1)).min(1),
    platforms: z.array(runtimePlatformSchema).min(1),
    capabilities: adapterCapabilitiesSchema,
    permissions: z.array(z.string().min(1)).default([])
  })
  .strict();

export type RuntimePlatform = z.infer<typeof runtimePlatformSchema>;
export type AdapterCapabilities = z.infer<typeof adapterCapabilitiesSchema>;
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export type ExecutableKind = "native" | "command-shim";

export interface DetectedExecutable {
  readonly path: string;
  readonly kind: ExecutableKind;
}

export interface ExecutableDetector {
  find(
    candidates: readonly string[],
    context: ExecutableDetectionContext
  ): Promise<DetectedExecutable | null>;
}

export interface ExecutableDetectionContext {
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CommandRunner {
  run(input: CommandRunInput): Promise<CommandResult>;
}

export interface CommandRunInput {
  readonly executable: DetectedExecutable;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export type AdapterErrorCode =
  | "adapter_executable_not_found"
  | "adapter_platform_unsupported"
  | "adapter_auth_unavailable"
  | "adapter_detection_failed";

export interface AdapterIssue {
  readonly code: AdapterErrorCode;
  readonly message: string;
  readonly remediation: string;
}

export interface DetectionResult {
  readonly available: boolean;
  readonly executable: DetectedExecutable | null;
  readonly version: string | null;
  readonly issue: AdapterIssue | null;
}

export interface AuthResult {
  readonly authenticated: boolean;
  readonly issue: AdapterIssue | null;
}

export type LaunchMode = "interactive" | "non-interactive";
export type WorkspaceAccess = "read-only" | "workspace-write";

export interface AgentMessage {
  readonly id: string;
  readonly content: string;
}

export interface LaunchInput {
  readonly executable: DetectedExecutable;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mode: LaunchMode;
  readonly workspaceAccess: WorkspaceAccess;
  readonly initialMessage?: AgentMessage;
  readonly resumeSessionId?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface LaunchInputPayload {
  readonly data: string;
  readonly closeAfterWrite: boolean;
}

export interface LaunchSpec {
  readonly executable: DetectedExecutable;
  readonly args: readonly string[];
  /** Required only for an explicitly quoted Windows command-processor fallback. */
  readonly windowsVerbatimArguments?: boolean;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly initialInput?: LaunchInputPayload;
  /**
   * Selects the process transport. `pty` (the default) runs the child under a pseudo-terminal, for
   * interactive terminals. `pipe` runs it with piped stdio for non-interactive single-shot agents,
   * where the child reads its input from a real stdin pipe (a pty does not deliver written input to a
   * child's stdin on Windows ConPTY). It is a controlled field on the launch plan, never chosen by a
   * renderer.
   */
  readonly transport?: "pty" | "pipe";
}

export interface OutputChunk {
  readonly data: string;
  readonly timestamp: string;
}

export interface ParsedOutput {
  readonly kind: "text" | "event" | "error";
  readonly data: unknown;
}

export interface ParserState {
  readonly remainder: string;
}

export interface ParseResult {
  readonly outputs: readonly ParsedOutput[];
  readonly state: ParserState;
}

export interface AdapterSessionControl {
  write(data: string): Promise<void>;
  requestGracefulStop(): Promise<void>;
  forceKill(): Promise<void>;
}

/**
 * A private terminal snapshot used by an adapter to decide whether an
 * interactive CLI can accept a reviewed handoff. It never crosses IPC.
 */
export interface AdapterTerminalOutputSnapshot {
  readonly data: string;
  readonly sequence: number;
}

export type ReviewedHandoffSubmissionPhase = "written_to_terminal" | "submitted_to_agent";

export interface ReviewedHandoffSubmissionControl {
  write(data: string): Promise<void>;
  getOutputSnapshot(): AdapterTerminalOutputSnapshot;
  waitForOutputAfter(
    sequence: number,
    timeoutMs: number
  ): Promise<AdapterTerminalOutputSnapshot | null>;
  reportPhase(phase: ReviewedHandoffSubmissionPhase): Promise<void>;
}

export interface ReviewedHandoffSubmissionResult {
  readonly confirmation: "response_detected";
  readonly responseSequence: number;
}

export interface AdapterContext {
  readonly platform: RuntimePlatform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly detector: ExecutableDetector;
  readonly commandRunner: CommandRunner;
}

export interface AgentAdapter {
  readonly manifest: AgentManifest;
  detect(context: AdapterContext): Promise<DetectionResult>;
  validateAuth(context: AdapterContext, executable: DetectedExecutable): Promise<AuthResult>;
  buildLaunch(input: LaunchInput): Promise<LaunchSpec>;
  parseOutput(chunk: OutputChunk, state: ParserState): ParseResult;
  encodeMessage(message: AgentMessage): string;
  sendMessage(control: AdapterSessionControl, message: AgentMessage): Promise<void>;
  isReadyForReviewedHandoff(snapshot: AdapterTerminalOutputSnapshot): boolean;
  submitReviewedHandoff(
    control: ReviewedHandoffSubmissionControl,
    payload: string
  ): Promise<ReviewedHandoffSubmissionResult>;
  requestStop(control: AdapterSessionControl): Promise<void>;
  forceKill(control: AdapterSessionControl): Promise<void>;
}
