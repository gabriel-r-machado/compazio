import {
  AutomaticWorkflowCoordinator,
  currentRunId,
  resolveAutomaticModeStrategy,
  VerificationCoordinator,
  type AutomaticRunState,
  type AutomaticWorkflowResult,
  type CheckRunner,
  type OrchestratorPort
} from "@forgedeck/orchestration";
import { createHash } from "node:crypto";

import {
  automaticApprovalFingerprint,
  type AutomaticRunRecord,
  type AutomaticRunStatus,
  type SqliteAutomaticRunStore
} from "@forgedeck/local-db";
import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  orchestratorPlanToDraft,
  orchestratorProvenanceSchema,
  type AgentAdapterId,
  type AutomaticEvent,
  type AutomaticEventType,
  type AutomaticOrchestratorOption,
  type AutomaticRunSnapshotDto,
  type AutomaticWorkflowMode,
  type AutomaticWorkflowRequest,
  type OrchestratorPlan,
  type OrchestratorProvenanceDto,
  type WorkflowDraft
} from "@forgedeck/schemas";

import { materializeWorkflowDraft } from "@forgedeck/orchestration";
import { workflowDraftSchema } from "@forgedeck/schemas";

import type { DesktopWorkflowRunPort } from "./desktop-workflow-run-port";
import { hashDraft, hashPlan, PlanningFailedError } from "./planning-port-bridge";

/**
 * The composition seam for automatic mode in the main process. It owns the automatic SESSION only: it
 * drives the AutomaticWorkflowCoordinator, persists its state through the official store, publishes
 * official events, and gates risky nodes on a persisted human decision.
 *
 * It creates no runtime, scheduler, queue, executor or second persistence. The run port it is given wraps
 * the single live WorkflowRunRuntime, and every run, attempt, retry and recovery stays that runtime's
 * responsibility. The snapshot this service projects is the source of truth; events only say "re-read it".
 */

/**
 * The planners a session may choose from. Selection is by explicit id: the product never infers a
 * planner from a model, a title or the node adapters, never substitutes an unavailable one, and never
 * lets the budget preset change the choice.
 */
export interface OrchestratorSelection {
  /** Availability of every known planner, asked for on demand and never persisted as a truth. */
  list(): Promise<readonly AutomaticOrchestratorOption[]>;
  /**
   * The planner for one id, or null when this build has no port for it. The resolved planner reports
   * whether it can also remediate; when it cannot, the session stops at the first verification failure
   * with a stated reason instead of handing the fix to another agent.
   */
  resolve(
    id: AgentAdapterId,
    workspaceId?: string
  ): {
    readonly port: OrchestratorPort;
    readonly supportsRemediation: boolean;
    readonly version: () => string | null;
    readonly planHash: () => string | null;
  } | null;
}

export interface AutomaticModeServiceDeps {
  readonly store: SqliteAutomaticRunStore;
  /** The planner used when a session names none and no selection is wired. */
  readonly orchestrator: OrchestratorPort;
  /** Selectable planners. Absent keeps the single default planner and records no provenance. */
  readonly orchestrators?: OrchestratorSelection;
  /** The id recorded for a session that names no planner. Absent records `unknown`, never a guess. */
  readonly defaultOrchestrator?: AgentAdapterId;
  /** Builds the run port for one session; the runtime inside it is the single live instance. */
  readonly createRunPort: (input: {
    readonly workspaceId: string;
    readonly automaticRunId: string;
    readonly expectsArtifact: (nodeId: string) => boolean;
  }) => DesktopWorkflowRunPort;
  readonly checkRunner: CheckRunner;
  /**
   * Optional project-scoped verification runner. Automatic runs may coexist for several local
   * projects, so verification must use the workspace belonging to this session rather than the
   * desktop application's installation directory.
   */
  readonly checkRunnerFor?: (workspaceId: string) => CheckRunner;
  /** Sanitizes anything that leaves the main process; defaults to identity for tests. */
  readonly sanitize?: (text: string) => string;
  readonly publish: (event: AutomaticEvent) => void;
  /** Resolves everything a session needs about its workspace before any run is started. */
  readonly prepareWorkspace?: (workspaceId: string) => Promise<void>;
  readonly now?: () => Date;
  readonly clock?: () => number;
}

interface ActiveSession {
  readonly abort: AbortController;
  readonly port: DesktopWorkflowRunPort;
}

/**
 * The persisted session state, plus who planned it. The coordinator neither reads nor writes the extra
 * field; carrying it here means every existing save path preserves provenance without a migration, and
 * a session persisted before planners were selectable simply has none.
 */
interface PersistedAutomaticState extends AutomaticRunState {
  readonly orchestrator?: OrchestratorProvenanceDto;
  /**
   * The exact revision the session will materialize. It is persisted because it IS the reviewed
   * artefact: re-deriving it from the plan would mint a new draft id and would silently discard every
   * per-node choice the user made after planning.
   */
  readonly draft?: WorkflowDraft;
  /** Fingerprint of the inputs the plan was generated from; a change makes the plan out of date. */
  readonly planningFingerprint?: string;
  /** True when the plan no longer matches its inputs. Replanning stays an explicit action. */
  readonly planStale?: boolean;
}

/**
 * The inputs a PLAN depends on. Anything here changing invalidates the plan; anything else — which
 * agent executes a node, an approval, an execution option — only revises the draft.
 */
function planningFingerprintOf(input: {
  readonly workspaceId: string;
  readonly objective: string;
  readonly mode: string;
  readonly orchestratorAdapter: string | null;
  readonly limits: unknown;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.workspaceId,
        input.objective,
        input.mode,
        input.orchestratorAdapter,
        input.limits
      ])
    )
    .digest("hex");
}

export class AutomaticModeService {
  private readonly sessions = new Map<string, ActiveSession>();
  /** In-flight driving loops, so shutdown (and tests) can wait for them instead of racing. */
  private readonly running = new Map<string, Promise<void>>();
  /** The planner each live session was created with; a reload reads it from the record instead. */
  private readonly plannerBySession = new Map<string, AgentAdapterId>();
  /** Sessions whose start has been claimed but whose loop has not registered yet. */
  private readonly starting = new Set<string>();
  private readonly now: () => Date;

  public constructor(private readonly deps: AutomaticModeServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The planners the picker may offer, with the reason any of them cannot be chosen right now. */
  public async orchestrators(): Promise<readonly AutomaticOrchestratorOption[]> {
    return (await this.deps.orchestrators?.list()) ?? [];
  }

  /**
   * Why the chosen planner cannot plan, or null when it can. An unavailable planner blocks planning
   * with its own reason; it is never swapped for one that happens to be installed.
   */
  private async blockedPlanner(id: AgentAdapterId | undefined): Promise<string | null> {
    if (id === undefined || this.deps.orchestrators === undefined) return null;
    const option = (await this.deps.orchestrators.list()).find((entry) => entry.id === id);
    if (option === undefined) return `${id} is not a planner this version knows.`;
    if (!option.supportsPlanning) {
      return option.unavailableReason ?? `Planning with ${id} is not implemented in this version.`;
    }
    if (!option.available) {
      return option.unavailableReason ?? `${id} is not available for planning right now.`;
    }
    return null;
  }

  /** The provenance record written at planning time. Availability is never part of it. */
  private provenance(
    adapter: AgentAdapterId | null,
    options: {
      readonly plan?: OrchestratorPlan;
      readonly draft?: WorkflowDraft;
      readonly diagnostics?: readonly string[];
      readonly mode?: AutomaticWorkflowMode;
    } = {}
  ): OrchestratorProvenanceDto {
    const resolved = adapter === null ? null : (this.deps.orchestrators?.resolve(adapter) ?? null);
    return {
      adapter,
      version: resolved?.version() ?? null,
      plannedAt: this.now().toISOString(),
      strategy: options.mode ?? null,
      planHash: options.plan === undefined ? null : hashPlan(options.plan),
      draftHash: options.draft === undefined ? null : hashDraft(options.draft),
      materializedDraftHash: null,
      supportsRemediation: resolved?.supportsRemediation ?? true,
      diagnostics: (options.diagnostics ?? []).slice(0, 32).map((entry) => this.sanitize(entry))
    };
  }

  /**
   * Registers the objective and plans it. Planning is read-only analysis; nothing is materialized or
   * started here, so a rejected plan costs no run. Returns the session snapshot in every case.
   */
  public async create(input: {
    readonly workspaceId: string;
    readonly objective: string;
    readonly mode: AutomaticWorkflowMode;
    readonly acceptanceCriteria: readonly string[];
    /** Who writes the plan. It never changes which agent executes any node. */
    readonly orchestratorAdapter?: AgentAdapterId | undefined;
  }): Promise<AutomaticRunSnapshotDto> {
    const request: AutomaticWorkflowRequest = {
      workspaceId: input.workspaceId,
      objective: input.objective,
      mode: input.mode,
      limits: AUTOMATIC_MODE_DEFAULT_LIMITS[input.mode]
    };
    // The planner is chosen here, before anything is created, and it is the ONLY planner this session
    // will ever use: an unavailable choice blocks planning with its reason instead of falling back.
    const chosen = input.orchestratorAdapter ?? this.deps.defaultOrchestrator;
    const blocked = await this.blockedPlanner(chosen);
    if (blocked !== null) {
      const record = this.deps.store.create({
        workspaceId: input.workspaceId,
        objective: input.objective,
        mode: input.mode,
        draftId: "",
        state: { request, acceptanceCriteria: [...input.acceptanceCriteria] }
      });
      const saved = this.deps.store.save({
        automaticRunId: record.automaticRunId,
        status: "rejected",
        remediationCycle: 0,
        stopReason: "planner_unavailable",
        result: this.sanitize(blocked),
        state: {
          request,
          issues: [blocked],
          orchestrator: this.provenance(chosen ?? null, {
            diagnostics: [blocked],
            mode: input.mode
          })
        }
      });
      this.emit("planning.rejected", saved, null, null, this.sanitize(blocked));
      return this.project(saved);
    }
    // The session exists before planning, so a crash mid-analysis leaves a visible record instead of
    // silent nothing. The draft id is only known after planning, hence the placeholder.
    const record = this.deps.store.create({
      workspaceId: input.workspaceId,
      objective: input.objective,
      mode: input.mode,
      draftId: "",
      state: { request, acceptanceCriteria: [...input.acceptanceCriteria] }
    });
    // Bound to the session, not the workspace: a session keeps the planner it was created with, and a
    // reload reads it back from the record instead of choosing again.
    if (chosen !== undefined) this.plannerBySession.set(record.automaticRunId, chosen);
    this.emit("automatic.created", record, null, null, "Objective registered.");
    this.emit("planning.started", record, null, null, "Read-only analysis started.");

    const coordinator = this.coordinatorFor(record, () => Promise.resolve(false));
    let composed;
    try {
      // Resolve the selected local project before the planner takes its snapshot. Previously this
      // happened only at start, which meant composition could inspect the desktop app itself.
      await this.deps.prepareWorkspace?.(input.workspaceId);
      composed = await coordinator.compose(request);
    } catch (error: unknown) {
      // A planner that failed structurally reports diagnostics; the session is rejected with them and
      // no other planner is tried.
      const issues =
        error instanceof PlanningFailedError
          ? error.diagnostics.map((entry) => `${entry.code}: ${entry.message}`)
          : [error instanceof Error ? error.message : "Planning failed."];
      const saved = this.deps.store.save({
        automaticRunId: record.automaticRunId,
        status: "rejected",
        remediationCycle: 0,
        stopReason: "plan_rejected",
        result: this.sanitize(issues.join("; ")),
        state: {
          request,
          issues,
          orchestrator: this.provenance(chosen ?? null, { diagnostics: issues, mode: input.mode })
        }
      });
      this.emit("planning.rejected", saved, null, null, this.sanitize(issues[0] ?? ""));
      return this.project(saved);
    }
    if (composed.status === "plan_rejected") {
      const saved = this.deps.store.save({
        automaticRunId: record.automaticRunId,
        status: "rejected",
        remediationCycle: 0,
        stopReason: "plan_rejected",
        result: this.sanitize(composed.issues.join("; ")),
        state: {
          request,
          issues: composed.issues,
          orchestrator: this.provenance(chosen ?? null, {
            diagnostics: [...composed.issues],
            mode: input.mode
          })
        }
      });
      this.emit("planning.rejected", saved, null, null, this.sanitize(composed.issues[0] ?? ""));
      return this.project(saved);
    }

    const state: PersistedAutomaticState = {
      request,
      plan: composed.plan,
      draftId: composed.draft.id,
      runIds: [],
      remediationCycle: 0,
      startedAtMs: this.now().getTime(),
      // The reviewed revision itself, kept so start materializes exactly what was shown — and never
      // asks the planner again to rebuild it.
      draft: composed.draft,
      planningFingerprint: planningFingerprintOf({
        workspaceId: input.workspaceId,
        objective: input.objective,
        mode: input.mode,
        orchestratorAdapter: chosen ?? null,
        limits: request.limits
      }),
      planStale: false,
      // Written once, at planning time, and read back on every reload: the session shows who planned it
      // without ever planning again.
      orchestrator: this.provenance(chosen ?? null, {
        plan: composed.plan,
        draft: composed.draft,
        mode: input.mode
      })
    };
    const pending = this.registerApprovals(
      record.automaticRunId,
      composed.plan,
      composed.approvals
    );
    const saved = this.deps.store.save({
      automaticRunId: record.automaticRunId,
      status: pending.length > 0 ? "awaiting_approval" : "planning",
      remediationCycle: 0,
      state
    });
    this.emit(
      "planning.completed",
      saved,
      null,
      null,
      `Plan with ${composed.plan.nodes.length} nodes.`
    );
    for (const approval of pending) {
      this.emit("approval.required", saved, null, approval.nodeId, approval.reason);
    }
    return this.project(saved);
  }

  /**
   * Starts the planned session: materializes exactly once and drives the lineage to a terminal verdict.
   * A node that still needs a human decision blocks the start instead of running unapproved work.
   */
  public async start(automaticRunId: string): Promise<AutomaticRunSnapshotDto> {
    const record = this.require(automaticRunId);
    if (record.status === "completed" || record.status === "rejected") return this.project(record);
    // Claimed synchronously, before any await: the driving loop is registered in `running` in the same
    // tick that claims it, so two concurrent starts can never both reach materialization and a session
    // can never own two runs.
    if (
      this.sessions.has(automaticRunId) ||
      this.running.has(automaticRunId) ||
      this.starting.has(automaticRunId)
    ) {
      return this.project(record);
    }
    const state = this.stateOf(record);
    if (state === null) throw new Error("The automatic session has no plan to start");
    if (state.planStale === true) {
      // An out-of-date plan is never quietly regenerated at start: replanning is an explicit action.
      return this.project(
        this.deps.store.save({
          automaticRunId,
          status: record.status,
          remediationCycle: state.remediationCycle,
          stopReason: "plan_stale",
          result: "The plan no longer matches its inputs. Replan explicitly before starting.",
          state
        })
      );
    }
    if (this.hasPendingApproval(automaticRunId)) {
      // Approval is still outstanding: nothing may start.
      return this.project(
        this.deps.store.save({
          automaticRunId,
          status: "awaiting_approval",
          remediationCycle: state.remediationCycle,
          state
        })
      );
    }
    this.starting.add(automaticRunId);
    try {
      // The revision that is about to be materialized is recorded before anything starts, so a reload
      // can always say WHICH revision ran.
      const draft = state.draft;
      const provenance = readProvenance(record.state);
      const withMaterialized =
        draft === undefined || provenance === null
          ? state
          : {
              ...state,
              orchestrator: { ...provenance, materializedDraftHash: hashDraft(draft) }
            };
      this.deps.store.save({
        automaticRunId,
        status: record.status,
        remediationCycle: state.remediationCycle,
        state: withMaterialized
      });
      this.startDriving(this.require(automaticRunId), withMaterialized);
    } finally {
      this.starting.delete(automaticRunId);
    }
    return this.project(this.require(automaticRunId));
  }

  /**
   * Resumes the sessions that were mid-flight when the app stopped. It never re-plans, never
   * re-materializes and never starts a second run: the persisted lineage already names the run to wait on,
   * and a session with no run yet is left for the user to start explicitly.
   */
  public async resumeInterrupted(workspaceId?: string): Promise<readonly string[]> {
    const resumed: string[] = [];
    for (const record of this.deps.store.listResumable(workspaceId)) {
      const state = this.stateOf(record);
      // Eligible means: it has a plan, it already owns a run, and no human decision is outstanding.
      if (state === null || state.runIds.length === 0) continue;
      if (this.hasPendingApproval(record.automaticRunId)) continue;
      if (this.sessions.has(record.automaticRunId)) continue;
      this.startDriving(record, state);
      resumed.push(record.automaticRunId);
    }
    return resumed;
  }

  public async pause(automaticRunId: string): Promise<AutomaticRunSnapshotDto> {
    const record = this.require(automaticRunId);
    const session = this.sessions.get(automaticRunId);
    const runId = record.currentRunId;
    if (session !== undefined && runId !== null) await session.port.pause(runId);
    // The pause is persisted, so it survives a reload and the session is not silently resumed.
    return this.project(
      this.deps.store.save({
        automaticRunId,
        status: "awaiting_approval",
        remediationCycle: record.remediationCycle,
        stopReason: "paused",
        state: record.state
      })
    );
  }

  public async resume(automaticRunId: string): Promise<AutomaticRunSnapshotDto> {
    const record = this.require(automaticRunId);
    const state = this.stateOf(record);
    if (state === null) throw new Error("The automatic session has no plan to resume");
    const session = this.sessions.get(automaticRunId);
    if (session !== undefined && record.currentRunId !== null) {
      await session.port.resumeRun(record.currentRunId);
    }
    const saved = this.deps.store.save({
      automaticRunId,
      status: "running",
      remediationCycle: state.remediationCycle,
      stopReason: null,
      state
    });
    if (session === undefined && state.runIds.length > 0) this.startDriving(saved, state);
    return this.project(this.require(automaticRunId));
  }

  public async cancel(automaticRunId: string): Promise<AutomaticRunSnapshotDto> {
    const record = this.require(automaticRunId);
    const session = this.sessions.get(automaticRunId);
    session?.abort.abort();
    if (session !== undefined && record.currentRunId !== null) {
      await session.port.cancel(record.currentRunId);
    }
    const saved = this.deps.store.save({
      automaticRunId,
      status: "stopped",
      remediationCycle: record.remediationCycle,
      stopReason: "cancelled",
      result: "The automatic session was cancelled.",
      state: record.state
    });
    this.emit("automatic.stopped", saved, record.currentRunId, null, "Cancelled.");
    return this.project(saved);
  }

  /** Records a human decision for exactly one action. Approving everything pending releases the start. */
  public async decide(input: {
    readonly automaticRunId: string;
    readonly nodeId: string;
    readonly actionFingerprint: string;
    readonly decision: "approved" | "rejected";
  }): Promise<AutomaticRunSnapshotDto> {
    const record = this.require(input.automaticRunId);
    this.deps.store.decideApproval(input);
    if (input.decision === "rejected") {
      const saved = this.deps.store.save({
        automaticRunId: input.automaticRunId,
        status: "stopped",
        remediationCycle: record.remediationCycle,
        stopReason: "approval_rejected",
        result: `The action on ${input.nodeId} was rejected.`,
        state: record.state
      });
      this.emit("automatic.stopped", saved, null, input.nodeId, "Approval rejected.");
      return this.project(saved);
    }
    if (this.hasPendingApproval(input.automaticRunId)) {
      return this.project(this.require(input.automaticRunId));
    }
    return this.start(input.automaticRunId);
  }

  /**
   * Changes WHICH AGENT EXECUTES a node. This is an execution decision, not a planning one: it revises
   * the persisted draft, moves the draft hash, and re-validates that the revision can still be
   * materialized. The orchestrator is never called.
   */
  public updateAssignments(input: {
    readonly automaticRunId: string;
    readonly assignments: Readonly<Record<string, AgentAdapterId>>;
  }): AutomaticRunSnapshotDto {
    const record = this.require(input.automaticRunId);
    const state = this.stateOf(record);
    if (state === null || state.draft === undefined) {
      throw new Error("The automatic session has no revision to update");
    }
    if (record.currentRunId !== null) {
      throw new Error("The revision cannot change after the run started");
    }
    const draft = workflowDraftSchema.parse({
      ...state.draft,
      nodes: state.draft.nodes.map((node) => {
        const assigned = input.assignments[node.id];
        return assigned === undefined
          ? node
          : {
              ...node,
              agentAssignment: { ...(node.agentAssignment ?? {}), assignedAdapter: assigned },
              runtimeRequirement: {
                ...node.runtimeRequirement,
                strategy: "fixed" as const,
                fixedRuntimeId: assigned,
                resolvedRuntimeId: assigned,
                resolutionReason: "Chosen by the user for this node."
              }
            };
      })
    });
    const issues = materializeWorkflowDraft(draft).issues;
    if (issues.length > 0) {
      throw new Error(`The revision cannot be materialized: ${issues[0]?.message ?? "invalid"}`);
    }
    const provenance = readProvenance(record.state);
    return this.project(
      this.deps.store.save({
        automaticRunId: input.automaticRunId,
        status: record.status,
        remediationCycle: state.remediationCycle,
        state: {
          ...state,
          draft,
          // The plan hash is untouched: what was PLANNED did not change, only who will execute it.
          ...(provenance === null
            ? {}
            : { orchestrator: { ...provenance, draftHash: hashDraft(draft) } })
        }
      })
    );
  }

  /**
   * Records a change to something the PLAN depends on. The existing plan is kept and marked out of
   * date; nothing is regenerated here, because replanning costs a paid turn and is the user's call.
   */
  public invalidatePlan(input: {
    readonly automaticRunId: string;
    readonly reason: string;
  }): AutomaticRunSnapshotDto {
    const record = this.require(input.automaticRunId);
    const state = this.stateOf(record);
    if (state === null) throw new Error("The automatic session has no plan to invalidate");
    return this.project(
      this.deps.store.save({
        automaticRunId: input.automaticRunId,
        status: record.status,
        remediationCycle: state.remediationCycle,
        stopReason: "plan_stale",
        result: this.sanitize(input.reason),
        state: { ...state, planStale: true }
      })
    );
  }

  public show(automaticRunId: string): AutomaticRunSnapshotDto {
    return this.project(this.require(automaticRunId));
  }

  /**
   * Main-process-only bridge for the canvas composer. The renderer still receives this draft only
   * through the existing workflow-draft projection, never as an automatic IPC payload or transcript.
   */
  public draft(automaticRunId: string): WorkflowDraft | null {
    return this.stateOf(this.require(automaticRunId))?.draft ?? null;
  }

  /**
   * Recovers only an identical, unstarted plan that finished recently. This is used exclusively by an
   * explicit retry after the renderer timed out, so a valid late answer is not discarded and the user
   * is not charged for composing the same plan twice.
   */
  public recoverRecentDraft(input: {
    readonly workspaceId: string;
    readonly objective: string;
    readonly mode: AutomaticWorkflowMode;
    readonly orchestratorAdapter: AgentAdapterId;
    readonly maxAgeMs?: number;
  }): WorkflowDraft | null {
    const expectedFingerprint = planningFingerprintOf({
      workspaceId: input.workspaceId,
      objective: input.objective,
      mode: input.mode,
      orchestratorAdapter: input.orchestratorAdapter,
      limits: AUTOMATIC_MODE_DEFAULT_LIMITS[input.mode]
    });
    // A local planner may legitimately spend five minutes, and the user may close/reopen the app
    // before retrying. One hour keeps that recovery useful without turning old plans into a cache.
    const cutoff = this.now().getTime() - (input.maxAgeMs ?? 60 * 60_000);
    for (const record of this.deps.store.list({ workspaceId: input.workspaceId, limit: 20 })) {
      if (
        record.objective !== input.objective ||
        record.mode !== input.mode ||
        record.currentRunId !== null ||
        !["planning", "awaiting_approval"].includes(record.status) ||
        Date.parse(record.updatedAt) < cutoff
      ) {
        continue;
      }
      const state = this.stateOf(record);
      if (
        state?.draft !== undefined &&
        state.planStale !== true &&
        state.planningFingerprint === expectedFingerprint &&
        readProvenance(record.state)?.adapter === input.orchestratorAdapter
      ) {
        return state.draft;
      }
    }
    return null;
  }

  public list(input: {
    readonly workspaceId?: string;
    readonly limit?: number;
  }): readonly AutomaticRunSnapshotDto[] {
    return this.deps.store.list(input).map((record) => this.project(record));
  }

  /** Cancels every in-flight session and waits for its loop to unwind; called on app shutdown. */
  public async close(): Promise<void> {
    for (const [, session] of this.sessions) session.abort.abort();
    await this.waitForIdle();
    this.sessions.clear();
  }

  /** Resolves once no session is being driven. Sessions run in the background, so callers can settle. */
  public async waitForIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  /** Drives a session in the background and keeps its promise so shutdown can wait for it. */
  private startDriving(record: AutomaticRunRecord, state: AutomaticRunState): void {
    const promise = this.drive(record, state).finally(() => {
      this.running.delete(record.automaticRunId);
    });
    this.running.set(record.automaticRunId, promise);
  }

  /** Runs the coordinator loop for one session and persists every transition it reports. */
  private async drive(record: AutomaticRunRecord, state: AutomaticRunState): Promise<void> {
    const abort = new AbortController();
    const plan = state.plan;
    // The workspace root must be known before a run is started, so the port never resolves it mid-flight.
    await this.deps.prepareWorkspace?.(record.workspaceId);
    const port = this.deps.createRunPort({
      workspaceId: record.workspaceId,
      automaticRunId: record.automaticRunId,
      expectsArtifact: (nodeId) =>
        (plan.nodes.find((node) => node.id === nodeId)?.expectedArtifacts.length ?? 0) > 0
    });
    this.sessions.set(record.automaticRunId, { abort, port });
    const coordinator = this.coordinatorFor(record, () => Promise.resolve(true), port);

    try {
      const fresh = state.runIds.length === 0;
      if (fresh) this.emit("workflow.started", record, null, null, "Materializing the plan.");
      // THE fix: a session that already has a reviewed plan materializes exactly that revision. It
      // never composes again, so the orchestrator is called once per planning review — not once more
      // on every start, which spent a second paid turn and could run a plan nobody approved.
      const result = fresh
        ? await coordinator.startApproved(
            { request: state.request, plan: state.plan, draft: this.requireDraft(record, state) },
            { signal: abort.signal }
          )
        : await coordinator.resume(state, { signal: abort.signal });
      this.persistResult(record.automaticRunId, result);
    } catch (error: unknown) {
      const saved = this.deps.store.save({
        automaticRunId: record.automaticRunId,
        status: "stopped",
        remediationCycle: record.remediationCycle,
        stopReason: "unrecoverable",
        result: this.sanitize(error instanceof Error ? error.message : "The session failed."),
        state: this.deps.store.get(record.automaticRunId)?.state ?? state
      });
      this.emit("automatic.stopped", saved, saved.currentRunId, null, "The session failed.");
    } finally {
      this.sessions.delete(record.automaticRunId);
    }
  }

  private persistResult(automaticRunId: string, result: AutomaticWorkflowResult): void {
    const record = this.require(automaticRunId);
    if (result.status === "completed") {
      const saved = this.deps.store.save({
        automaticRunId,
        status: "completed",
        currentRunId: result.runId,
        remediationCycle: result.remediationCycles,
        result: `Completed after ${result.remediationCycles} remediation cycle(s).`,
        state: record.state
      });
      this.emit("automatic.completed", saved, result.runId, null, "Every node verified.");
      return;
    }
    if (result.status === "plan_rejected") {
      const saved = this.deps.store.save({
        automaticRunId,
        status: "rejected",
        remediationCycle: record.remediationCycle,
        stopReason: "plan_rejected",
        result: this.sanitize(result.issues.join("; ")),
        state: record.state
      });
      this.emit("planning.rejected", saved, null, null, this.sanitize(result.issues[0] ?? ""));
      return;
    }
    if (result.status === "awaiting_approval") {
      const saved = this.deps.store.save({
        automaticRunId,
        status: "awaiting_approval",
        remediationCycle: record.remediationCycle,
        state: record.state
      });
      for (const nodeId of result.approvals) {
        this.emit("approval.required", saved, null, nodeId, "A human decision is required.");
      }
      return;
    }
    const saved = this.deps.store.save({
      automaticRunId,
      status: "stopped",
      currentRunId: result.runId,
      remediationCycle: record.remediationCycle,
      stopReason: result.reason,
      result: this.sanitize(result.detail),
      state: record.state
    });
    this.emit("automatic.stopped", saved, result.runId, null, this.sanitize(result.detail));
  }

  /**
   * Builds a coordinator bound to one session. Its persistState hook is what keeps the store in step with
   * the lineage, so a reload resumes the same run instead of starting another.
   */
  private coordinatorFor(
    record: AutomaticRunRecord,
    approve: () => Promise<boolean>,
    port?: DesktopWorkflowRunPort
  ): AutomaticWorkflowCoordinator {
    return new AutomaticWorkflowCoordinator({
      orchestrator: this.observedOrchestrator(record),
      run: port ?? unavailableRunPort(),
      verification: new VerificationCoordinator(this.observedCheckRunner(record), (text) =>
        this.sanitize(text)
      ),
      requestApproval: approve,
      ...(this.deps.clock === undefined ? {} : { clock: this.deps.clock }),
      persistState: (state) => {
        const runIds = state.runIds;
        const current = runIds.length === 0 ? null : currentRunId(state);
        const previous = this.deps.store.get(record.automaticRunId);
        // A new run in the lineage is an official transition worth an event.
        if (current !== null && previous?.currentRunId !== current) {
          this.emit(
            runIds.length === 1 ? "workflow.started" : "remediation.started",
            previous ?? record,
            current,
            null,
            runIds.length === 1
              ? "The official run started."
              : `Run ${runIds.length} of the lineage.`
          );
        }
        // The coordinator's state knows nothing about who planned, so the recorded provenance is
        // merged back here. Without this, the first run transition would quietly erase it and a
        // reload would report the session as unknown.
        const provenance = readProvenance(previous?.state ?? record.state);
        this.deps.store.save({
          automaticRunId: record.automaticRunId,
          status: "running",
          currentRunId: current,
          remediationCycle: state.remediationCycle,
          state: provenance === null ? state : { ...state, orchestrator: provenance }
        });
      }
    });
  }

  /** Wraps the orchestrator so planning and remediation publish their own official events. */
  /**
   * The planner bound to ONE session: the id it was created with, or the one recorded in its own state
   * after a reload. It is never re-chosen, never inferred from the node adapters, and never replaced by
   * another planner because this one is unavailable — an unavailable planner blocks, visibly.
   */
  private plannerFor(record: AutomaticRunRecord): OrchestratorPort {
    const id =
      this.plannerBySession.get(record.automaticRunId) ??
      readProvenance(record.state)?.adapter ??
      this.deps.defaultOrchestrator;
    if (id === undefined || this.deps.orchestrators === undefined) return this.deps.orchestrator;
    return this.deps.orchestrators.resolve(id, record.workspaceId)?.port ?? this.deps.orchestrator;
  }

  private observedOrchestrator(record: AutomaticRunRecord): OrchestratorPort {
    const planner = this.plannerFor(record);
    return {
      analyze: async (request) => planner.analyze(request),
      remediate: async (context) => {
        const current = this.deps.store.get(record.automaticRunId) ?? record;
        this.emit(
          "verification.failed",
          current,
          current.currentRunId,
          context.targetNodeId,
          this.sanitize(context.sanitizedError)
        );
        const raw = await planner.remediate(context);
        const after = this.deps.store.get(record.automaticRunId) ?? record;
        this.emit(
          "remediation.planned",
          after,
          after.currentRunId,
          context.targetNodeId,
          "A structured remediation was produced."
        );
        return raw;
      }
    };
  }

  /** Wraps the check runner so each verification command announces itself. */
  private observedCheckRunner(record: AutomaticRunRecord): CheckRunner {
    const checkRunner = this.deps.checkRunnerFor?.(record.workspaceId) ?? this.deps.checkRunner;
    return {
      run: async (command) => {
        const current = this.deps.store.get(record.automaticRunId) ?? record;
        this.emit("verification.started", current, current.currentRunId, null, command);
        return checkRunner.run(command);
      }
    };
  }

  /** Opens a pending approval per gated node, bound to the exact action each one describes. */
  private registerApprovals(
    automaticRunId: string,
    plan: OrchestratorPlan,
    approvals: readonly string[]
  ): readonly { nodeId: string; reason: string }[] {
    const gated = new Set(approvals);
    const pending: { nodeId: string; reason: string }[] = [];
    for (const node of plan.nodes) {
      if (!gated.has(node.id)) continue;
      this.deps.store.requireApproval({
        automaticRunId,
        nodeId: node.id,
        actionFingerprint: automaticApprovalFingerprint({
          nodeId: node.id,
          prompt: node.prompt,
          operationRisk: node.operationRisk,
          operation: node.title
        })
      });
      pending.push({
        nodeId: node.id,
        reason:
          node.operationRisk === "safe"
            ? "The plan marked this node as needing a human decision."
            : `The operation is ${node.operationRisk}.`
      });
    }
    return pending;
  }

  private hasPendingApproval(automaticRunId: string): boolean {
    return this.deps.store
      .listApprovals(automaticRunId)
      .some((approval) => approval.decision === "pending");
  }

  /**
   * The reviewed revision this session must materialize. A session planned before revisions were
   * persisted has none; it is rebuilt from its own stored plan, deterministically and with no planner
   * call, so an older session still starts exactly what it was shown.
   */
  private requireDraft(record: AutomaticRunRecord, state: PersistedAutomaticState): WorkflowDraft {
    if (state.draft !== undefined) return state.draft;
    return orchestratorPlanToDraft(state.plan, {
      workspaceId: record.workspaceId,
      objective: record.objective,
      executionProfile: resolveAutomaticModeStrategy(
        record.mode as AutomaticWorkflowMode,
        state.request.limits
      ).executionProfile,
      sourceTerminalId: `auto:${record.workspaceId}`,
      ...(state.draftId === "" ? {} : { draftId: state.draftId })
    });
  }

  private stateOf(record: AutomaticRunRecord): PersistedAutomaticState | null {
    const state = record.state;
    if (typeof state !== "object" || state === null) return null;
    const candidate = state as Partial<PersistedAutomaticState>;
    if (candidate.plan === undefined || candidate.request === undefined) return null;
    const provenance = readProvenance(state);
    return {
      request: candidate.request,
      plan: candidate.plan,
      // Carried through every save, so the planner recorded at planning time is never lost by a later
      // transition — and never re-derived either.
      ...(provenance === null ? {} : { orchestrator: provenance }),
      ...(candidate.draft === undefined ? {} : { draft: candidate.draft }),
      ...(candidate.planningFingerprint === undefined
        ? {}
        : { planningFingerprint: candidate.planningFingerprint }),
      ...(candidate.planStale === undefined ? {} : { planStale: candidate.planStale }),
      draftId: candidate.draftId ?? "",
      runIds: candidate.runIds ?? [],
      remediationCycle: candidate.remediationCycle ?? 0,
      startedAtMs: candidate.startedAtMs ?? this.now().getTime(),
      ...(candidate.corrections === undefined ? {} : { corrections: candidate.corrections }),
      ...(candidate.unresolvedFailures === undefined
        ? {}
        : { unresolvedFailures: candidate.unresolvedFailures }),
      ...(candidate.verifiedNodeIds === undefined
        ? {}
        : { verifiedNodeIds: candidate.verifiedNodeIds })
    };
  }

  /** The renderer-facing projection. It never contains a prompt, a path, a command or a definition. */
  private project(record: AutomaticRunRecord): AutomaticRunSnapshotDto {
    const state = this.stateOf(record);
    const mode = record.mode as AutomaticWorkflowMode;
    const strategy = resolveAutomaticModeStrategy(mode, state?.request.limits);
    const verified = new Set(state?.verifiedNodeIds ?? []);
    const failed = new Set((state?.unresolvedFailures ?? []).map((entry) => entry.nodeId));
    const issues = readIssues(record.state);
    return {
      automaticRunId: record.automaticRunId,
      workspaceId: record.workspaceId,
      objective: record.objective,
      mode,
      status: record.status,
      planTitle: state?.plan.title ?? null,
      planSummary: state?.plan.summary ?? null,
      nodes: (state?.plan.nodes ?? []).map((node) => ({
        nodeId: node.id,
        title: node.title,
        role: node.role,
        dependsOn: [...node.dependsOn],
        operationRisk: node.operationRisk,
        requiresHumanApproval: node.requiresHumanApproval,
        verified: verified.has(node.id) ? true : failed.has(node.id) ? false : null
      })),
      runIds: [...(state?.runIds ?? [])],
      currentRunId: record.currentRunId,
      // Read back from the record, never recomputed: a reload shows who planned without planning again.
      // A session with nothing recorded reports `adapter: null` — unknown, not a guess.
      orchestrator: readProvenance(record.state),
      planStale: state?.planStale === true,
      limits: {
        remediationCyclesUsed: record.remediationCycle,
        remediationCyclesTotal: strategy.limits.maxRemediationCycles,
        maxAttemptsPerNode: strategy.limits.maxAttemptsPerNode,
        maxWorkflowNodes: strategy.limits.maxWorkflowNodes,
        timeoutMs: strategy.limits.timeoutMs
      },
      pendingApprovals: this.deps.store
        .listApprovals(record.automaticRunId)
        .filter((approval) => approval.decision === "pending")
        .map((approval) => ({
          nodeId: approval.nodeId,
          actionFingerprint: approval.actionFingerprint,
          reason: "A human decision is required before this node runs."
        })),
      stopReason: record.stopReason,
      result: record.result,
      issues: [...issues],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  private require(automaticRunId: string): AutomaticRunRecord {
    const record = this.deps.store.get(automaticRunId);
    if (record === null) throw new Error("The automatic session was not found");
    return record;
  }

  private emit(
    type: AutomaticEventType,
    record: Pick<AutomaticRunRecord, "automaticRunId" | "workspaceId">,
    runId: string | null,
    nodeId: string | null,
    detail: string
  ): void {
    this.deps.publish({
      type,
      automaticRunId: record.automaticRunId,
      workspaceId: record.workspaceId,
      runId,
      nodeId,
      detail: this.sanitize(detail).slice(0, 2_000),
      at: this.now().toISOString()
    });
  }

  private sanitize(text: string): string {
    return this.deps.sanitize?.(text) ?? text;
  }
}

/** Used only while composing, where no run may be started; every call is a programming error. */
function unavailableRunPort(): DesktopWorkflowRunPort {
  const fail = (): never => {
    throw new Error("Composition never starts a run");
  };
  return {
    materializeAndStart: fail,
    awaitOutcome: fail,
    retryNode: fail,
    addCorrectiveNode: fail,
    cancel: fail,
    pause: fail,
    resumeRun: fail,
    snapshot: fail
  } as unknown as DesktopWorkflowRunPort;
}

function readIssues(state: unknown): readonly string[] {
  if (typeof state !== "object" || state === null) return [];
  const issues = (state as { readonly issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((issue): issue is string => typeof issue === "string").slice(0, 64);
}

/**
 * Reads the recorded planner out of a persisted session, or null when the session predates selectable
 * planners. A legacy session is reported as unknown on purpose: inferring the planner from the node
 * adapters would be a guess dressed as a fact, and the node adapters answer a different question.
 */
function readProvenance(state: unknown): OrchestratorProvenanceDto | null {
  if (typeof state !== "object" || state === null) return null;
  const candidate = (state as { readonly orchestrator?: unknown }).orchestrator;
  const parsed = orchestratorProvenanceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Statuses a session may be in when it is still the user's to act on. */
export const ACTIONABLE_AUTOMATIC_STATUSES: ReadonlySet<AutomaticRunStatus> = new Set([
  "planning",
  "awaiting_approval",
  "running"
]);
