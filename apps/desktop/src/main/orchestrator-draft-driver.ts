import type { WorkflowDraftEventInput } from "@forgedeck/local-db";
import {
  applyDraftCommand,
  createCompositionActionParser,
  suggestAgentAssignments
} from "@forgedeck/orchestration";
import type { AgentAssignmentCatalog, CompositionActionParser } from "@forgedeck/orchestration";
import type {
  AgentRuntimeCapability,
  CreationMode,
  ExecutionProfile,
  WorkflowDraft,
  WorkflowDraftEvent
} from "@forgedeck/schemas";
import { workflowDraftSchema } from "@forgedeck/schemas";

/**
 * Turns a real orchestrator session's terminal output into a workflow draft. It buffers the session's
 * output, extracts composition actions from the `⟦compasso:draft⟧` wire protocol, and applies each
 * through the deterministic domain reducer, persisting the result as ghost nodes.
 *
 * This is the boundary that makes automatic mode both real and safe: the plan comes from the user's own
 * agent (not a Compazio planner), and yet nothing executes — the driver can ONLY shape a draft. It has
 * no launcher, no shell and no file access, so a composed draft cannot start a process. Terminal output
 * is untrusted: only schema-valid actions the reducer accepts change state.
 */

/** The subset of the workflow-draft store the driver needs. */
export interface OrchestratorDraftStorePort {
  getById(draftId: string): WorkflowDraft | null;
  getLatestForTerminal(workspaceId: string, sourceTerminalId: string): WorkflowDraft | null;
  persist(
    draft: WorkflowDraft,
    events: readonly WorkflowDraftEventInput[]
  ): { readonly draft: WorkflowDraft; readonly lastEvent: WorkflowDraftEvent | null };
}

export interface OrchestratorDraftDriverDeps {
  readonly store: OrchestratorDraftStorePort;
  /** Real runtime discovery; role runtime binding resolves only against usable entries. */
  readonly loadCapabilities: () => Promise<readonly AgentRuntimeCapability[]>;
  /** Live executable-agent catalog used to persist automatic per-node choices at finalization. */
  readonly loadAgents?: () => Promise<AgentAssignmentCatalog>;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

export interface AttachOrchestratorSessionInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly creationMode: CreationMode;
  readonly executionProfile: ExecutionProfile;
}

interface AttachedSession {
  readonly workspaceId: string;
  readonly creationMode: CreationMode;
  readonly executionProfile: ExecutionProfile;
  readonly parser: CompositionActionParser;
}

export class OrchestratorDraftDriver {
  private readonly store: OrchestratorDraftStorePort;
  private readonly loadCapabilities: () => Promise<readonly AgentRuntimeCapability[]>;
  private readonly loadAgents: (() => Promise<AgentAssignmentCatalog>) | null;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, AttachedSession>();
  private listener: ((draft: WorkflowDraft, sessionId: string) => void) | null = null;

  constructor(deps: OrchestratorDraftDriverDeps) {
    this.store = deps.store;
    this.loadCapabilities = deps.loadCapabilities;
    this.loadAgents = deps.loadAgents ?? null;
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
    this.now = deps.now ?? (() => new Date());
  }

  /** Begins turning a session's output into a draft. Each session gets its own parser buffer. */
  attach(input: AttachOrchestratorSessionInput): void {
    this.sessions.set(input.sessionId, {
      workspaceId: input.workspaceId,
      creationMode: input.creationMode,
      executionProfile: input.executionProfile,
      parser: createCompositionActionParser()
    });
  }

  detach(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  isAttached(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Registers the single listener notified whenever a session mutates its draft. */
  onDraftChanged(listener: (draft: WorkflowDraft, sessionId: string) => void): void {
    this.listener = listener;
  }

  /**
   * Persists the objective before waiting for CLI output. If the process hangs or the application closes,
   * reopening the workspace can report an interrupted composition instead of pretending nothing happened.
   */
  async beginComposition(sessionId: string, objective: string): Promise<WorkflowDraft | null> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return null;
    const capabilities = await this.loadCapabilities();
    const current = this.store.getLatestForTerminal(session.workspaceId, sessionId);
    const context = {
      now: this.now().toISOString(),
      newId: this.newId,
      capabilities,
      identity: {
        workspaceId: session.workspaceId,
        sourceTerminalId: sessionId,
        creationMode: session.creationMode,
        executionProfile: session.executionProfile,
        draftId: current?.id ?? this.newId()
      }
    } as const;
    const result = applyDraftCommand(
      current,
      { kind: "composition", action: { type: "start_workflow_draft", objective } },
      context
    );
    if (result.status !== "applied" || result.draft === null) return result.draft;
    const persisted = this.store.persist(result.draft, result.events as WorkflowDraftEventInput[]);
    this.listener?.(persisted.draft, sessionId);
    return persisted.draft;
  }

  /**
   * Imports the schema-validated result from the non-interactive planner into the same review flow
   * used by terminal composition. This bypasses neither validation nor agent assignment.
   */
  async acceptDraft(sessionId: string, draft: WorkflowDraft): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    const capabilities = await this.loadCapabilities();
    const imported = workflowDraftSchema.parse({
      ...draft,
      workspaceId: session.workspaceId,
      sourceTerminalId: sessionId,
      creationMode: session.creationMode,
      executionProfile: session.executionProfile,
      state: "ready"
    });
    const context = {
      now: this.now().toISOString(),
      newId: this.newId,
      capabilities,
      identity: {
        workspaceId: session.workspaceId,
        sourceTerminalId: sessionId,
        creationMode: session.creationMode,
        executionProfile: session.executionProfile,
        draftId: imported.id
      }
    } as const;
    const assigned = await this.assignAutomaticAgents(
      { status: "applied", draft: imported, events: [], rejectionReason: null, message: "" },
      "finalize_workflow_draft",
      session,
      context
    );
    if (assigned.draft === null) throw new Error("The generated workflow could not be prepared.");
    const persisted = this.store.persist(
      assigned.draft,
      assigned.events as WorkflowDraftEventInput[]
    );
    this.listener?.(persisted.draft, sessionId);
  }

  /** Feeds a raw output chunk from a session and applies any complete composition actions. */
  async ingest(sessionId: string, chunk: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    const actions = session.parser.push(chunk);
    if (actions.length === 0) {
      return;
    }
    const capabilities = await this.loadCapabilities();
    for (const action of actions) {
      const current = this.store.getLatestForTerminal(session.workspaceId, sessionId);
      const context = {
        now: this.now().toISOString(),
        newId: this.newId,
        capabilities,
        identity: {
          workspaceId: session.workspaceId,
          sourceTerminalId: sessionId,
          creationMode: session.creationMode,
          executionProfile: session.executionProfile,
          draftId: current?.id ?? this.newId()
        }
      } as const;
      const result = applyDraftCommand(current, { kind: "composition", action }, context);
      if (result.status === "ignored" || result.draft === null) {
        continue;
      }
      const finalized = await this.assignAutomaticAgents(result, action.type, session, context);
      if (finalized.draft === null) continue;
      const persisted = this.store.persist(
        finalized.draft,
        finalized.events as WorkflowDraftEventInput[]
      );
      this.listener?.(persisted.draft, sessionId);
    }
  }

  private async assignAutomaticAgents(
    result: ReturnType<typeof applyDraftCommand>,
    actionType: string,
    session: AttachedSession,
    context: Parameters<typeof applyDraftCommand>[2]
  ): Promise<ReturnType<typeof applyDraftCommand>> {
    if (
      actionType !== "finalize_workflow_draft" ||
      session.creationMode !== "automatic" ||
      this.loadAgents === null ||
      result.status !== "applied" ||
      result.draft?.state !== "ready"
    ) {
      return result;
    }
    const catalog = await this.loadAgents();
    const assignments = suggestAgentAssignments({
      nodes: result.draft.nodes,
      preset: "automatic",
      catalog
    });
    const assigned = applyDraftCommand(
      result.draft,
      {
        kind: "assign_agents",
        preset: "automatic",
        assignments
      },
      context
    );
    if (assigned.status !== "applied" || assigned.draft === null) return result;
    return { ...assigned, events: [...result.events, ...assigned.events] };
  }
}
