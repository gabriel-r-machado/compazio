import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  NodeExecutionContext,
  NodeExecutionResult,
  WorkflowNodeExecutor
} from "@forgedeck/orchestration";
import { createAllowedEnvironment, ProcessTerminalWaitTimeoutError } from "@forgedeck/terminal";
import type { ProcessSessionSnapshot } from "@forgedeck/terminal";
import type { ArtifactReference, Evidence, WorkflowNode } from "@forgedeck/workflow";

import type { WorkflowRunRootResolver } from "./workflow-shell-execution-adapter";

/** Minimal slice of the ProcessSupervisor the agent executor needs; keeps it unit-testable. */
export interface AgentProcessSupervisor {
  start(input: {
    readonly sessionId: string;
    readonly adapterId: string;
    readonly launch: {
      readonly executable: { readonly path: string; readonly kind: "native" | "command-shim" };
      readonly args: readonly string[];
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly cols: number;
      readonly rows: number;
      /** Optional stdin primed once at start (e.g. an agent prompt), closed after writing. */
      readonly initialInput?: { readonly data: string; readonly closeAfterWrite: boolean };
      /** Process transport: `pipe` for non-interactive single-shot agents, else the default `pty`. */
      readonly transport?: "pty" | "pipe";
    };
    readonly allowedCwdRoots: readonly string[];
    readonly additionalAllowedEnvKeys?: readonly string[];
  }): Promise<ProcessSessionSnapshot>;
  waitForTerminal(sessionId: string, timeoutMs: number): Promise<ProcessSessionSnapshot>;
  cancel(sessionId: string): Promise<ProcessSessionSnapshot>;
}

/**
 * The official artifact surface the executor uses. A node's structured output only counts once it
 * is published here; the next node receives the resulting reference, never a raw file path or the
 * upstream terminal transcript.
 */
export interface NodeArtifactStore {
  publishNodeArtifact(input: {
    readonly runId: string;
    readonly nodeRunId: string;
    readonly nodeId: string;
    readonly type: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly content: string;
  }): Promise<ArtifactReference>;
  getNodeArtifact(
    runId: string,
    nodeId: string
  ): (ArtifactReference & { readonly nodeId: string; readonly nodeRunId: string | null }) | null;
  resolveArtifactPath(reference: ArtifactReference): string;
}

/** An upstream artifact resolved into the official context handed to a consuming agent node. */
export interface ResolvedAgentInput {
  readonly nodeId: string;
  readonly artifactId: string;
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
}

/** Adapter-specific launch decision: which executable/args realize this agent node. */
export interface AgentNodeLaunchPlan {
  readonly executable: { readonly path: string; readonly kind: "native" | "command-shim" };
  readonly args: readonly string[];
  /** When true, the process writes to `outputPath` and the executor publishes it officially. */
  readonly producesArtifact: boolean;
  readonly artifactType: string;
  readonly artifactFilename: string;
  readonly mediaType: string;
  /** Content primed on the child's stdin (e.g. the agent prompt), so large text stays out of argv. */
  readonly stdin?: string;
  /** Process transport: `pipe` for non-interactive single-shot agents; defaults to `pty` when unset. */
  readonly transport?: "pty" | "pipe";
  /**
   * Extra environment entries the adapter supplies for this launch (managed values only, e.g. a
   * result path). Their keys must appear in {@link additionalAllowedEnvKeys} to survive the allowlist.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /** Extra environment keys this adapter is allowed to pass through (e.g. a local profile dir). */
  readonly additionalAllowedEnvKeys?: readonly string[];
  /** Adapter-validated timeout for this node; falls back to the node timeout, then a safe default. */
  readonly timeoutMs?: number;
}

export interface AgentNodeLaunchInput {
  readonly node: WorkflowNode;
  readonly role: string;
  /**
   * The complete instruction the node's agent must receive. It comes from the prompt source when the run
   * is automatic-mode work (see {@link NodePromptSource}), and otherwise falls back to the node title.
   */
  readonly task: string;
  readonly cwd: string;
  readonly runId: string;
  readonly attempt: number;
  /** Stable per run+node across attempts, so a resolver can arm a deterministic single failure. */
  readonly statePath: string;
  /** Managed path (per attempt) the process must write its structured output to. */
  readonly outputPath: string;
  readonly inputs: readonly ResolvedAgentInput[];
}

/**
 * Supplies the full prompt for one node of one run. The official workflow definition deliberately cannot
 * carry a prompt — its shape is strict and its title is capped — so the composition layer records each
 * approved prompt per run and the executor reads it here at launch time. Returning null means no richer
 * approved prompt was recorded, and the node title remains the instruction.
 */
export interface NodePromptSource {
  getNodePrompt(runId: string, nodeId: string): string | null;
}

/** Publishes a workflow worker as a visible read-only terminal without affecting execution truth. */
export interface WorkflowAgentSessionObserver {
  onStarting(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly adapterId: string;
  }): void;
}

/**
 * Resolves how a given agent adapter is launched. This is the only adapter-specific seam; the
 * fake-agent resolver used in tests and the future real-adapter resolvers implement it. Returning
 * null means the adapter is unavailable and the node fails safely without pretending to succeed.
 */
export interface AgentNodeLaunchResolver {
  resolve(
    input: AgentNodeLaunchInput
  ): AgentNodeLaunchPlan | null | Promise<AgentNodeLaunchPlan | null>;
}

/**
 * Reusable executor for `agent` workflow nodes. It launches a real process through the existing
 * ProcessSupervisor, publishes structured output as an official immutable artifact, feeds each
 * consumer node the resolved upstream artifact reference, and verifies consumption by hash. Success
 * is decided by exit code and structured evidence — never by the terminal transcript. Timeouts and
 * cancellation are honored cooperatively. It defines no scheduler or engine of its own.
 */
export class ProcessAgentNodeExecutor implements WorkflowNodeExecutor {
  public constructor(
    private readonly supervisor: AgentProcessSupervisor,
    private readonly artifacts: NodeArtifactStore,
    private readonly roots: WorkflowRunRootResolver,
    private readonly resolver: AgentNodeLaunchResolver,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    /** Optional approved-prompt source shared by Manual and Automatic workflow runs. */
    private readonly prompts?: NodePromptSource,
    /** Optional UI observer only; scheduler state and structured evidence remain authoritative. */
    private readonly sessions?: WorkflowAgentSessionObserver
  ) {}

  public async execute(
    node: WorkflowNode,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    if (node.type !== "agent") return unavailable("This executor only runs agent nodes.");
    const root = this.roots.resolveRunRoot(context.runId);
    if (root === null) return unavailable("The workflow run target is unavailable.");

    const sourceInputs = this.resolveInputs(node, context.runId);
    const stagingDirectory = join(root, ".forgedeck", "staging", context.runId);
    await mkdir(stagingDirectory, { recursive: true });
    // Official artifacts live in Compazio's managed local store, not necessarily inside the project.
    // Copy only hash-verified inputs into this run's approved staging area before giving an agent their
    // paths. That preserves the project-root boundary for the process while allowing a handoff to work.
    const inputs = await this.stageInputs(sourceInputs, stagingDirectory);
    if (inputs === null) {
      return {
        success: false,
        reason: "missing_evidence",
        message: "An official upstream result could not be verified before the next agent started.",
        evidence: []
      };
    }
    const statePath = join(stagingDirectory, `${node.id}.state`);
    const outputPath = join(stagingDirectory, `${node.id}.${context.attempt}.out`);

    const plan = await this.resolver.resolve({
      node,
      role: node.role ?? "agent",
      // An automatic-mode node carries a generated prompt far longer than a title can hold; it is
      // delivered from the prompt source instead of the definition, and never placed on argv.
      task: this.prompts?.getNodePrompt(context.runId, node.id) ?? node.title ?? node.id,
      cwd: root,
      runId: context.runId,
      attempt: context.attempt,
      statePath,
      outputPath,
      inputs
    });
    if (plan === null) {
      // An unknown or unavailable adapter fails here, before any process is started.
      return unavailable("No launch plan is available for this agent adapter.");
    }

    const additionalAllowedEnvKeys = plan.additionalAllowedEnvKeys ?? [];
    const sessionId = `workflow-agent-${context.runId}-${node.id}-${context.attempt}`;
    this.sessions?.onStarting({
      sessionId,
      runId: context.runId,
      nodeId: node.id,
      attempt: context.attempt,
      adapterId: node.adapter ?? "process"
    });
    await this.supervisor.start({
      sessionId,
      adapterId: `agent:${node.adapter ?? "process"}`,
      launch: {
        executable: plan.executable,
        args: plan.args,
        cwd: root,
        environment: createAllowedEnvironment(
          this.environment,
          { TERM: "xterm-256color", ...(plan.environment ?? {}) },
          additionalAllowedEnvKeys
        ),
        cols: 120,
        rows: 30,
        ...(plan.stdin === undefined
          ? {}
          : { initialInput: { data: plan.stdin, closeAfterWrite: true } }),
        ...(plan.transport === undefined ? {} : { transport: plan.transport })
      },
      allowedCwdRoots: [root],
      additionalAllowedEnvKeys
    });

    const cancelOnAbort = (): void => {
      void this.supervisor.cancel(sessionId).catch(() => undefined);
    };
    context.abortSignal.addEventListener("abort", cancelOnAbort, { once: true });
    let snapshot: ProcessSessionSnapshot;
    try {
      snapshot = await this.supervisor.waitForTerminal(
        sessionId,
        plan.timeoutMs ?? node.timeout_ms ?? 600_000
      );
    } catch (error: unknown) {
      if (error instanceof ProcessTerminalWaitTimeoutError) {
        await this.supervisor.cancel(sessionId);
        return {
          success: false,
          reason: "timeout",
          message: "The agent step reached its timeout before producing a structured result.",
          evidence: []
        };
      }
      throw error;
    } finally {
      context.abortSignal.removeEventListener("abort", cancelOnAbort);
    }

    if (context.abortSignal.aborted) {
      // The scheduler marks the node cancelled; dependents are never released on a cancel.
      return {
        success: false,
        reason: "process_exit_nonzero",
        message: "The agent step was cancelled before completion.",
        evidence: []
      };
    }
    if (snapshot.state !== "succeeded" || snapshot.exitCode !== 0) {
      return {
        success: false,
        reason: "process_exit_nonzero",
        message: `The agent process exited with ${snapshot.exitCode ?? "an unknown code"}.`,
        evidence: []
      };
    }

    const evidence: Evidence[] = [];
    for (const input of inputs) {
      const verified = await this.verifyConsumption(input);
      if (verified === null) {
        return {
          success: false,
          reason: "missing_evidence",
          message: "The consumed artifact did not match its official recorded hash.",
          evidence: []
        };
      }
      evidence.push(verified);
    }

    if (plan.producesArtifact) {
      let content: string;
      try {
        content = await readFile(outputPath, "utf8");
      } catch {
        // Exit code 0 without the declared structured result is a failure, never a success — the
        // terminal transcript is not authority for completion.
        return {
          success: false,
          reason: "missing_evidence",
          message: "The agent exited successfully but produced no structured result.",
          evidence: []
        };
      }
      if (content.trim().length === 0) {
        return {
          success: false,
          reason: "missing_evidence",
          message: "The agent's structured result was empty.",
          evidence: []
        };
      }
      const reference = await this.artifacts.publishNodeArtifact({
        runId: context.runId,
        nodeRunId: context.nodeRunId,
        nodeId: node.id,
        type: plan.artifactType,
        filename: plan.artifactFilename,
        mediaType: plan.mediaType,
        content
      });
      evidence.push({
        id: `published-${node.id}`,
        type: "artifact",
        summary: `Published official artifact ${reference.id} for node ${node.id}.`,
        artifact_id: reference.id,
        metadata: { artifactId: reference.id, sha256: reference.sha256 }
      });
      return {
        success: true,
        evidence,
        output: { artifactId: reference.id, sha256: reference.sha256, exitCode: snapshot.exitCode }
      };
    }

    evidence.push({
      id: `agent-exit-${node.id}`,
      type: "exit_code",
      summary: `Agent node ${node.id} completed with exit code 0.`,
      metadata: { exitCode: snapshot.exitCode }
    });
    return { success: true, evidence, output: { exitCode: snapshot.exitCode } };
  }

  private resolveInputs(node: WorkflowNode, runId: string): ResolvedAgentInput[] {
    const inputs: ResolvedAgentInput[] = [];
    for (const dependency of node.depends_on) {
      const reference = this.artifacts.getNodeArtifact(runId, dependency);
      if (reference === null) continue;
      inputs.push({
        nodeId: dependency,
        artifactId: reference.id,
        path: this.artifacts.resolveArtifactPath(reference),
        sha256: reference.sha256,
        mediaType: reference.media_type
      });
    }
    return inputs;
  }

  /**
   * Makes the immutable result of an upstream agent available inside the approved project root. The
   * source path comes only from the artifact registry; its content is verified before and after the
   * handoff so neither a missing nor a tampered result is treated as valid context.
   */
  private async stageInputs(
    inputs: readonly ResolvedAgentInput[],
    stagingDirectory: string
  ): Promise<ResolvedAgentInput[] | null> {
    const staged: ResolvedAgentInput[] = [];
    for (const [index, input] of inputs.entries()) {
      let content: Buffer;
      try {
        content = await readFile(input.path);
      } catch {
        return null;
      }
      if (createHash("sha256").update(content).digest("hex") !== input.sha256) return null;

      const path = join(stagingDirectory, `input-${index}.artifact`);
      try {
        await writeFile(path, content);
      } catch {
        return null;
      }
      staged.push({ ...input, path });
    }
    return staged;
  }

  private async verifyConsumption(input: ResolvedAgentInput): Promise<Evidence | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(input.path);
    } catch {
      return null;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== input.sha256) return null;
    return {
      id: `consumed-${input.nodeId}`,
      type: "artifact",
      summary: `Consumed official artifact ${input.artifactId} from node ${input.nodeId}.`,
      artifact_id: input.artifactId,
      metadata: { consumedArtifactId: input.artifactId, sha256: input.sha256 }
    };
  }
}

function unavailable(message: string): Extract<NodeExecutionResult, { success: false }> {
  return { success: false, reason: "adapter_unavailable", message, evidence: [] };
}
