import { buildOrchestratorPrompt, renderOrchestratorPrompt } from "@forgedeck/orchestration";
import { isRuntimeUsable } from "@forgedeck/schemas";
import type {
  AgentRuntimeCapability,
  AgentRuntimeProvider,
  CanvasSnapshot,
  CompositionState,
  ExecutionProfile,
  WorkflowComposition,
  WorkflowCompositionError,
  WorkflowCompositionStatus,
  WorkflowDraft
} from "@forgedeck/schemas";

/** A request to spawn the user's selected orchestrator CLI. */
export interface OrchestratorLaunchRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly adapterId: string;
}

/**
 * The only transport surface the composition state machine needs. Production delegates to the live
 * terminal supervisor; tests provide a real-process-safe fake launcher.
 */
export interface OrchestratorSessionLauncher {
  launch(request: OrchestratorLaunchRequest): Promise<{ readonly sessionId: string }>;
  write(sessionId: string, data: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

/** A verified single-shot planning turn that returns the reviewed draft itself. */
export interface OrchestratorPlanner {
  compose(input: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly runtimeId: string;
    readonly objective: string;
    /** Current hybrid canvas. Production must not plan as if the user's configured team did not exist. */
    readonly canvas: CanvasSnapshot;
    readonly executionProfile: ExecutionProfile;
    /** Retry-only token saving: reuse one identical, unstarted plan when it completed late. */
    readonly reuseRecentPlan?: boolean;
  }): Promise<WorkflowDraft>;
}

export interface OrchestratorSessionServiceDeps {
  readonly launcher: OrchestratorSessionLauncher;
  readonly loadCapabilities: () => Promise<readonly AgentRuntimeCapability[]>;
  /** Production uses the pipe-based planner; the interactive path remains available for compatibility. */
  readonly planner?: OrchestratorPlanner;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** Every automatic stage has a deadline. No renderer spinner is trusted to enforce it. */
export const WORKFLOW_COMPOSITION_TIMEOUTS = {
  connectAgent: 30_000,
  // Real local planners have a five-minute process deadline. The UI must outlive that deadline,
  // otherwise a valid plan that takes two or three minutes is persisted and then falsely discarded.
  composeWorkflow: 5 * 60_000 + 15_000,
  validateWorkflow: 15_000
} as const;

export interface StartOrchestratorInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly preferredRuntimeId?: string;
}

export interface StartOrchestratorResult {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly state: CompositionState;
}

export interface SendObjectiveInput {
  readonly sessionId: string;
  readonly objective: string;
  readonly canvas: CanvasSnapshot;
  readonly executionProfile: ExecutionProfile;
  readonly reuseRecentPlan?: boolean;
  /**
   * The orchestrator's own canvas node, when it has one. Supplying it is what turns the session from
   * one that only drafts a plan into one that can build the team for real with the `compazio`
   * command. Absent for a composition session that exists outside the canvas, which can honestly
   * only propose.
   */
  readonly selfNodeId?: string;
}

interface OrchestratorSessionRecord {
  readonly runtimeId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly compositionId: string;
}

/**
 * Owns the observable lifecycle of a real CLI composition. A valid draft is the only success signal:
 * raw terminal prose, a prompt echo and an idle process can never complete this state machine.
 */
export class OrchestratorSessionService {
  private readonly launcher: OrchestratorSessionLauncher;
  private readonly loadCapabilities: () => Promise<readonly AgentRuntimeCapability[]>;
  private readonly planner: OrchestratorPlanner | null;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sessions = new Map<string, OrchestratorSessionRecord>();
  private readonly workspaceSessions = new Map<string, string>();
  private readonly compositions = new Map<string, WorkflowComposition>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(composition: WorkflowComposition) => void>();
  private readonly draftListeners = new Set<
    (sessionId: string, draft: WorkflowDraft) => Promise<void> | void
  >();

  constructor(deps: OrchestratorSessionServiceDeps) {
    this.launcher = deps.launcher;
    this.loadCapabilities = deps.loadCapabilities;
    this.planner = deps.planner ?? null;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  }

  async start(input: StartOrchestratorInput): Promise<StartOrchestratorResult> {
    const existingSessionId = this.workspaceSessions.get(input.workspaceId);
    if (existingSessionId !== undefined) {
      const existing = this.sessions.get(existingSessionId);
      const composition = this.compositions.get(existingSessionId);
      if (
        existing !== undefined &&
        composition !== undefined &&
        isActiveComposition(composition.status)
      ) {
        return {
          sessionId: existingSessionId,
          runtimeId: existing.runtimeId,
          state: "orchestrator_starting"
        };
      }
    }
    const capabilities = await withTimeout(
      this.loadCapabilities(),
      WORKFLOW_COMPOSITION_TIMEOUTS.connectAgent,
      "The available agents could not be validated in time."
    );
    const runtimeId = resolveOrchestratorRuntime(capabilities, input.preferredRuntimeId);
    const { sessionId } = await withTimeout(
      this.launcher.launch({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        adapterId: runtimeId
      }),
      WORKFLOW_COMPOSITION_TIMEOUTS.connectAgent,
      "The agent did not start within the expected time."
    );
    const compositionId = this.newId();
    this.sessions.set(sessionId, {
      runtimeId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      compositionId
    });
    this.workspaceSessions.set(input.workspaceId, sessionId);
    this.update(
      sessionId,
      this.createComposition({
        compositionId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        sessionId,
        status: "connecting_agent",
        currentStage: "Connecting to the selected agent…",
        timeoutMs: WORKFLOW_COMPOSITION_TIMEOUTS.connectAgent
      })
    );
    return { sessionId, runtimeId, state: "orchestrator_starting" };
  }

  async sendObjective(input: SendObjectiveInput): Promise<void> {
    if (!this.sessions.has(input.sessionId)) {
      throw new Error(`Unknown orchestrator session "${input.sessionId}".`);
    }
    try {
      this.transition(
        input.sessionId,
        "validating",
        "Validating the objective and available agents…"
      );
      const capabilities = await withTimeout(
        this.loadCapabilities(),
        WORKFLOW_COMPOSITION_TIMEOUTS.connectAgent,
        "The available agents could not be validated in time."
      );
      if (this.planner !== null) {
        this.transition(
          input.sessionId,
          "composing",
          "Planning the workflow and agent handoffs...",
          {
            timeoutMs: WORKFLOW_COMPOSITION_TIMEOUTS.composeWorkflow
          }
        );
        const session = this.sessions.get(input.sessionId);
        if (session === undefined)
          throw new Error(`Unknown orchestrator session "${input.sessionId}".`);
        const draft = await withTimeout(
          this.planner.compose({
            sessionId: input.sessionId,
            projectId: session.projectId,
            workspaceId: session.workspaceId,
            runtimeId: session.runtimeId,
            objective: input.objective,
            canvas: input.canvas,
            executionProfile: input.executionProfile,
            ...(input.reuseRecentPlan === undefined
              ? {}
              : { reuseRecentPlan: input.reuseRecentPlan })
          }),
          WORKFLOW_COMPOSITION_TIMEOUTS.composeWorkflow,
          "The agent did not return a valid workflow within the expected time."
        );
        // A cancelled or timed-out composition must never be revived by a late answer.
        if (isActiveComposition(this.compositions.get(input.sessionId)?.status ?? "failed")) {
          await Promise.all(
            [...this.draftListeners].map((listener) => listener(input.sessionId, draft))
          );
        }
        return;
      }
      const prompt = buildOrchestratorPrompt({
        objective: input.objective,
        canvas: input.canvas,
        capabilities,
        executionProfile: input.executionProfile,
        ...(input.selfNodeId === undefined ? {} : { selfNodeId: input.selfNodeId })
      });
      this.transition(input.sessionId, "composing", "Planning the workflow and agent handoffs…", {
        timeoutMs: WORKFLOW_COMPOSITION_TIMEOUTS.composeWorkflow
      });
      await withTimeout(
        this.launcher.write(input.sessionId, `${renderOrchestratorPrompt(prompt)}\n`),
        WORKFLOW_COMPOSITION_TIMEOUTS.connectAgent,
        "The agent did not accept the composition request in time."
      );
    } catch (error: unknown) {
      this.fail(
        input.sessionId,
        "COMPOSITION_START_FAILED",
        error instanceof Error ? error.message : "The composition could not be started."
      );
      throw error;
    }
  }

  isOrchestratorSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  onCompositionUpdated(listener: (composition: WorkflowComposition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Receives only the schema-validated draft from the pipe-based planning transport. */
  onWorkflowDraft(
    listener: (sessionId: string, draft: WorkflowDraft) => Promise<void> | void
  ): () => void {
    this.draftListeners.add(listener);
    return () => this.draftListeners.delete(listener);
  }

  /** Called only after a schema-valid composition action changed the persisted workflow draft. */
  onDraftChanged(sessionId: string, draft: WorkflowDraft): void {
    if (!this.sessions.has(sessionId)) return;
    if (draft.state === "ready") {
      this.transition(sessionId, "validating_result", "Validating the generated workflow…", {
        timeoutMs: WORKFLOW_COMPOSITION_TIMEOUTS.validateWorkflow
      });
      this.transition(sessionId, "ready_for_approval", "Workflow ready for approval.");
      return;
    }
    this.transition(sessionId, "composing", "Building the custom workflow…", {
      timeoutMs: WORKFLOW_COMPOSITION_TIMEOUTS.composeWorkflow
    });
  }

  /** The terminal ending before a ready draft is a failure, never an implicit success. */
  onTerminalState(
    sessionId: string,
    state: "succeeded" | "failed" | "cancelled" | "interrupted"
  ): void {
    const composition = this.compositions.get(sessionId);
    if (
      composition === undefined ||
      ["ready_for_approval", "cancelled", "failed"].includes(composition.status)
    ) {
      return;
    }
    if (state === "cancelled") {
      this.transition(sessionId, "cancelled", "Composition cancelled.");
      return;
    }
    this.fail(
      sessionId,
      state === "succeeded" ? "NO_VALID_WORKFLOW" : "AGENT_PROCESS_FAILED",
      state === "succeeded"
        ? "The agent finished without returning a valid workflow."
        : "The agent process ended before returning a valid workflow."
    );
  }

  async cancel(sessionId: string): Promise<WorkflowComposition> {
    const composition = this.compositions.get(sessionId);
    if (composition === undefined) throw new Error(`Unknown composition session "${sessionId}".`);
    try {
      await this.launcher.cancel(sessionId);
    } catch {
      // The process can already be terminal. Cancellation is still a durable, retryable user decision.
    }
    return this.transition(sessionId, "cancelled", "Composition cancelled.");
  }

  getComposition(sessionId: string): WorkflowComposition | null {
    return this.compositions.get(sessionId) ?? null;
  }

  forget(sessionId: string): void {
    this.clearTimeout(sessionId);
    const session = this.sessions.get(sessionId);
    if (session !== undefined && this.workspaceSessions.get(session.workspaceId) === sessionId) {
      this.workspaceSessions.delete(session.workspaceId);
    }
    this.sessions.delete(sessionId);
    this.compositions.delete(sessionId);
  }

  private createComposition(input: {
    readonly compositionId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly status: WorkflowCompositionStatus;
    readonly currentStage: string;
    readonly timeoutMs?: number;
  }): WorkflowComposition {
    const timestamp = this.now().toISOString();
    return {
      compositionId: input.compositionId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      status: input.status,
      currentStage: input.currentStage,
      startedAt: timestamp,
      updatedAt: timestamp,
      timeoutAt:
        input.timeoutMs === undefined
          ? null
          : new Date(this.now().getTime() + input.timeoutMs).toISOString(),
      error: null
    };
  }

  private transition(
    sessionId: string,
    status: WorkflowCompositionStatus,
    currentStage: string,
    options: { readonly timeoutMs?: number; readonly error?: WorkflowCompositionError | null } = {}
  ): WorkflowComposition {
    const current = this.compositions.get(sessionId);
    if (current === undefined) throw new Error(`Unknown composition session "${sessionId}".`);
    this.clearTimeout(sessionId);
    const next: WorkflowComposition = {
      ...current,
      status,
      currentStage,
      updatedAt: this.now().toISOString(),
      timeoutAt:
        options.timeoutMs === undefined
          ? null
          : new Date(this.now().getTime() + options.timeoutMs).toISOString(),
      error: options.error ?? null
    };
    this.update(sessionId, next);
    if (["failed", "cancelled"].includes(status)) {
      const session = this.sessions.get(sessionId);
      if (session !== undefined && this.workspaceSessions.get(session.workspaceId) === sessionId) {
        this.workspaceSessions.delete(session.workspaceId);
      }
    }
    if (options.timeoutMs !== undefined) {
      const timeout = setTimeout(() => {
        this.fail(
          sessionId,
          "COMPOSITION_TIMEOUT",
          "The agent did not return a valid workflow within the expected time."
        );
        void this.launcher.cancel(sessionId).catch(() => undefined);
      }, options.timeoutMs);
      this.timeouts.set(sessionId, timeout);
    }
    return next;
  }

  private fail(sessionId: string, code: string, message: string): void {
    const current = this.compositions.get(sessionId);
    if (current === undefined || ["failed", "cancelled"].includes(current.status)) return;
    this.transition(sessionId, "failed", "The workflow composition could not be completed.", {
      error: { code, message, retryable: true }
    });
  }

  private update(sessionId: string, composition: WorkflowComposition): void {
    this.compositions.set(sessionId, composition);
    for (const listener of this.listeners) listener(composition);
  }

  private clearTimeout(sessionId: string): void {
    const timeout = this.timeouts.get(sessionId);
    if (timeout !== undefined) clearTimeout(timeout);
    this.timeouts.delete(sessionId);
  }
}

function isActiveComposition(status: WorkflowCompositionStatus): boolean {
  return [
    "validating",
    "connecting_agent",
    "composing",
    "validating_result",
    "starting",
    "running"
  ].includes(status);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Picks the user's requested usable runtime, otherwise the strongest installed coding agent. */
export function resolveOrchestratorRuntime(
  capabilities: readonly AgentRuntimeCapability[],
  preferredRuntimeId?: string
): string {
  const usable = capabilities.filter(isRuntimeUsable);
  if (preferredRuntimeId !== undefined) {
    const match = usable.find((entry) => entry.runtimeId === preferredRuntimeId);
    if (match === undefined) {
      throw new Error(
        `The runtime "${preferredRuntimeId}" is not installed and authenticated. Choose an available agent.`
      );
    }
    return match.runtimeId;
  }
  const chosen = [...usable].sort(
    (left, right) => providerRank(right.provider) - providerRank(left.provider)
  )[0];
  if (chosen === undefined) {
    throw new Error(
      "No installed and authenticated AI runtime is available. Install and sign in to an agent to start with AI."
    );
  }
  return chosen.runtimeId;
}

function providerRank(provider: AgentRuntimeProvider): number {
  switch (provider) {
    case "claude-code":
      return 5;
    case "codex":
      return 4;
    case "opencode":
      return 3;
    case "gemini-cli":
      return 2;
    case "custom":
      return 0;
  }
}
