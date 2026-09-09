import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AppTheme,
  CloudSyncStatus,
  OrchestrationProposal,
  OrchestrationProposalEvent,
  OrchestrationProposalExecutionResponse,
  OrchestrationProposalPlanningOptionsResponse,
  RuntimeDiagnostics,
  TerminalSession,
  WorkflowRunEvent,
  WorkflowRunGraphDto,
  WorkflowRunSnapshotDto
} from "@forgedeck/schemas";
import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { projectWorkflowRunToCanvas, type CanvasNodeRuntimeState } from "./workflow-run-projection";
import { WorkflowNodeInspector } from "./workflow-node-inspector";

export function RunHistoryPanel({ workspaceId }: { readonly workspaceId: string | null }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<readonly TerminalSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.forgedeck.terminals.list());
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t("runs.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    return window.forgedeck.terminals.onEvent((event) => {
      if (event.type !== "session.state") {
        return;
      }
      setSessions((current) => {
        const remaining = current.filter((session) => session.id !== event.session.id);
        return [event.session, ...remaining];
      });
    });
  }, [refresh]);

  return (
    <section className="workspace-placeholder runtime-panel" aria-labelledby="run-history-title">
      <header className="runtime-panel-header">
        <div>
          <p className="fd-eyebrow">{t("runs.eyebrow")}</p>
          <h2 id="run-history-title">{t("runs.title")}</h2>
          <p>{t("runs.body")}</p>
        </div>
        <button type="button" onClick={() => void refresh()}>
          {t("common.refresh")}
        </button>
      </header>
      {error === null ? null : <p className="review-notice is-error">{error}</p>}
      <OrchestrationProposalPanel workspaceId={workspaceId} />
      <WorkflowRunPanel />
      <section className="terminal-run-history" aria-labelledby="terminal-history-title">
        <h3 id="terminal-history-title">{t("runs.terminalSessions")}</h3>
        {sessions.length === 0 ? (
          <p className="runtime-empty">{t("runs.empty")}</p>
        ) : (
          <ol className="runtime-list" aria-label={t("runs.aria")}>
            {sessions.map((session) => (
              <li key={session.id}>
                <strong>{t(adapterTranslationKeys[session.adapterId])}</strong>
                <span>{t(sessionStateTranslationKeys[session.state])}</span>
                <small>
                  {session.exitCode === null
                    ? t("runs.noExit")
                    : t("runs.exitCode", { code: session.exitCode })}
                </small>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

/**
 * Monitoring-only view of local proposals. Creation and prompt-based adjustment moved to the
 * canvas composer (automatic mode); this panel keeps the follow-up responsibilities: status,
 * history, auditable events and the explicit review decisions for proposals created elsewhere
 * (canvas or CLI).
 */
function OrchestrationProposalPanel({ workspaceId }: { readonly workspaceId: string | null }) {
  const [proposals, setProposals] = useState<readonly OrchestrationProposal[]>([]);
  const [events, setEvents] = useState<readonly OrchestrationProposalEvent[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [planningOptions, setPlanningOptions] =
    useState<OrchestrationProposalPlanningOptionsResponse | null>(null);
  const [execution, setExecution] = useState<
    (OrchestrationProposalExecutionResponse & { readonly proposalId: string }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = proposals.find((proposal) => proposal.id === selectedProposalId) ?? null;

  const refresh = useCallback(async () => {
    if (workspaceId === null) {
      setProposals([]);
      setSelectedProposalId(null);
      setPlanningOptions(null);
      return;
    }
    const [next, options] = await Promise.all([
      window.forgedeck.orchestrationProposals.list({ workspaceId, limit: 100 }),
      window.forgedeck.orchestrationProposals.planningOptions({ workspaceId })
    ]);
    setProposals(next);
    setPlanningOptions(options);
    setSelectedProposalId((current) =>
      current !== null && next.some((proposal) => proposal.id === current)
        ? current
        : (next[0]?.id ?? null)
    );
  }, [workspaceId]);

  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error ? cause.message : "Não foi possível carregar propostas locais."
        )
      );
  }, [refresh]);

  useEffect(() => {
    if (selected === null) return;
    let active = true;
    void window.forgedeck.orchestrationProposals
      .events({ workspaceId: selected.workspaceId, proposalId: selected.id })
      .then((next) => {
        if (active) setEvents(next);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Não foi possível carregar eventos.");
      });
    return () => {
      active = false;
    };
  }, [selected]);

  const review = useCallback(
    async (action: "approve" | "reject") => {
      if (selected === null || selected.status !== "draft") return;
      setBusy(true);
      setError(null);
      try {
        const proposal = await window.forgedeck.orchestrationProposals[action]({
          workspaceId: selected.workspaceId,
          proposalId: selected.id,
          revision: selected.revision
        });
        setProposals((current) => replaceProposal(current, proposal));
      } catch (cause: unknown) {
        setError(
          cause instanceof Error ? cause.message : "A decisão conflitou com outra alteração."
        );
        await refresh().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [refresh, selected]
  );

  const execute = useCallback(async () => {
    if (selected === null || selected.status !== "approved") return;
    setBusy(true);
    setError(null);
    try {
      const command = await window.forgedeck.orchestrationProposals.execute({
        workspaceId: selected.workspaceId,
        proposalId: selected.id
      });
      setExecution({ ...command, proposalId: selected.id });
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "A proposta aprovada nÃ£o pode ser executada."
      );
    } finally {
      setBusy(false);
    }
  }, [selected]);

  return (
    <section className="orchestration-proposals" aria-labelledby="orchestration-proposals-title">
      <header className="workflow-run-header">
        <div>
          <p className="fd-eyebrow">Acompanhamento</p>
          <h3 id="orchestration-proposals-title">Propostas para revisão</h3>
          <p>
            Crie e ajuste propostas pelo modo Automático no canvas. Aqui você acompanha o estado,
            decide propostas pendentes e consulta a auditoria. Aprovar não inicia workflow nem
            concede permissões.
          </p>
        </div>
        <button
          disabled={busy || workspaceId === null}
          type="button"
          onClick={() => void refresh()}
        >
          Atualizar
        </button>
      </header>
      {workspaceId === null ? (
        <p className="runtime-empty">Abra um workspace para acompanhar propostas.</p>
      ) : (
        <div className="orchestration-proposal-grid">
          <div className="orchestration-proposal-detail">
            {selected === null ? (
              <p className="runtime-empty">
                Selecione uma proposta para ver detalhes, decidir e auditar.
              </p>
            ) : (
              <>
                <dl>
                  <div>
                    <dt>Objetivo</dt>
                    <dd>{selected.objective}</dd>
                  </div>
                  <div>
                    <dt>Entendimento</dt>
                    <dd>{selected.understanding}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      {selected.status} — revisão {selected.revision}
                    </dd>
                  </div>
                  <div>
                    <dt>Template confiável</dt>
                    <dd>
                      {selected.workflowTemplateId === null
                        ? "Selecionar na revisão do canvas"
                        : (planningOptions?.templates.find(
                            (template) => template.id === selected.workflowTemplateId
                          )?.name ?? selected.workflowTemplateId)}
                    </dd>
                  </div>
                  <div>
                    <dt>Agente executor</dt>
                    <dd>
                      {selected.executionAgentNodeId === null
                        ? "Selecionar na revisão do canvas"
                        : (planningOptions?.agents.find(
                            (agent) => agent.nodeId === selected.executionAgentNodeId
                          )?.name ?? selected.executionAgentNodeId)}
                    </dd>
                  </div>
                  <div>
                    <dt>Nível de autonomia</dt>
                    <dd>
                      {selected.autonomyLevel === "autonomous"
                        ? "Autônomo supervisionado"
                        : selected.autonomyLevel === "supervised"
                          ? "Supervisionado"
                          : "Assistido"}
                    </dd>
                  </div>
                </dl>
                <div className="orchestration-proposal-actions">
                  {selected.status === "draft" ? (
                    <>
                      <button disabled={busy} type="button" onClick={() => void review("approve")}>
                        Aprovar proposta
                      </button>
                      <button disabled={busy} type="button" onClick={() => void review("reject")}>
                        Rejeitar
                      </button>
                    </>
                  ) : selected.status === "approved" ? (
                    <button disabled={busy} type="button" onClick={() => void execute()}>
                      Executar proposta aprovada
                    </button>
                  ) : null}
                </div>
                {execution === null || execution.proposalId !== selected.id ? null : (
                  <p className="review-notice">
                    Comando {execution.commandId} {execution.status}
                    {execution.runId === null ? "" : ` - run ${execution.runId}`}
                    {execution.errorCode === null ? "" : ` - ${execution.errorCode}`}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="orchestration-proposal-history">
            {error === null ? null : <p className="review-notice is-error">{error}</p>}
            {proposals.length === 0 ? (
              <p className="runtime-empty">
                Nenhuma proposta neste workspace. Use o modo Automático no canvas para criar uma.
              </p>
            ) : (
              <ol aria-label="Propostas locais">
                {proposals.map((proposal) => (
                  <li key={proposal.id}>
                    <button
                      aria-pressed={proposal.id === selectedProposalId}
                      type="button"
                      onClick={() => setSelectedProposalId(proposal.id)}
                    >
                      <strong>{proposal.objective}</strong>
                      <span>{proposal.status}</span>
                      <small>revisão {proposal.revision}</small>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {selected === null ? null : (
              <ol className="orchestration-proposal-events" aria-label="Eventos da proposta">
                {events.map((event) => (
                  <li key={event.id}>
                    <strong>{event.type}</strong>
                    <small>{event.createdAt}</small>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function replaceProposal(
  proposals: readonly OrchestrationProposal[],
  proposal: OrchestrationProposal
): readonly OrchestrationProposal[] {
  return [proposal, ...proposals.filter((candidate) => candidate.id !== proposal.id)];
}

function WorkflowRunPanel() {
  const { t } = useI18n();
  const [runs, setRuns] = useState<readonly WorkflowRunSnapshotDto[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<readonly WorkflowRunEvent[]>([]);
  const [graph, setGraph] = useState<WorkflowRunGraphDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  const refresh = useCallback(async () => {
    const nextRuns = await window.forgedeck.workflows.list({ limit: 100 });
    setRuns(nextRuns);
    setSelectedRunId((current) =>
      current !== null && nextRuns.some((run) => run.id === current)
        ? current
        : (nextRuns[0]?.id ?? null)
    );
  }, []);

  const refreshRun = useCallback(
    async (runId: string) => {
      const run = await window.forgedeck.workflows.show({ runId });
      setRuns((current) => upsertRun(current, run));
      if (selectedRunId === runId) {
        setEvents(await window.forgedeck.workflows.events({ runId }));
      }
    },
    [selectedRunId]
  );

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(refresh)
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t("workflowRuns.loadFailed"));
      });
    const unsubscribe = window.forgedeck.workflows.onEvent((event) => {
      void refreshRun(event.runId).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t("workflowRuns.loadFailed"));
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refresh, refreshRun, t]);

  useEffect(() => {
    if (selectedRunId === null) return;
    let active = true;
    void Promise.resolve()
      .then(() =>
        Promise.all([
          window.forgedeck.workflows.events({ runId: selectedRunId }),
          window.forgedeck.workflows.graph({ runId: selectedRunId })
        ])
      )
      .then(([nextEvents, nextGraph]) => {
        if (active) setEvents(nextEvents);
        if (active) setGraph(nextGraph);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t("workflowRuns.loadFailed"));
      });
    return () => {
      active = false;
    };
  }, [selectedRunId, t]);

  const apply = useCallback(
    async (action: "pause" | "resume" | "cancel" | "retry" | "approve" | "reject") => {
      if (selectedRun === null) return;
      setBusy(true);
      setError(null);
      try {
        const approvalNodeId = pendingApprovalNodeId(events);
        const result =
          action === "pause"
            ? await window.forgedeck.workflows.pause({ runId: selectedRun.id })
            : action === "resume"
              ? await window.forgedeck.workflows.resume({ runId: selectedRun.id })
              : action === "cancel"
                ? await window.forgedeck.workflows.cancel({ runId: selectedRun.id })
                : action === "retry"
                  ? await window.forgedeck.workflows.retry({ runId: selectedRun.id })
                  : action === "approve" && approvalNodeId !== null
                    ? await window.forgedeck.workflows.approve({
                        runId: selectedRun.id,
                        nodeId: approvalNodeId,
                        note: "Approved in local desktop"
                      })
                    : action === "reject" && approvalNodeId !== null
                      ? await window.forgedeck.workflows.reject({
                          runId: selectedRun.id,
                          nodeId: approvalNodeId,
                          note: "Rejected in local desktop"
                        })
                      : null;
        if (result !== null) {
          await refresh();
        }
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : t("workflowRuns.actionFailed"));
      } finally {
        setBusy(false);
      }
    },
    [events, refresh, selectedRun, t]
  );

  const approvalNodeId = pendingApprovalNodeId(events);
  // The official snapshot is the only source of truth; the projection is pure and derives nothing
  // from terminal text, timers or optimistic UI.
  const projection = useMemo(
    () => projectWorkflowRunToCanvas(selectedRun, graph, events),
    [selectedRun, graph, events]
  );
  const edgeStateByPair = useMemo(
    () => new Map(projection.edges.map((edge) => [`${edge.from}->${edge.to}`, edge.state])),
    [projection]
  );
  return (
    <section className="workflow-run-history" aria-labelledby="workflow-runs-title">
      <div className="workflow-run-header">
        <div>
          <p className="fd-eyebrow">{t("workflowRuns.eyebrow")}</p>
          <h3 id="workflow-runs-title">{t("workflowRuns.title")}</h3>
          <p>{t("workflowRuns.body")}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy}>
          {t("common.refresh")}
        </button>
      </div>
      {error === null ? null : <p className="review-notice is-error">{error}</p>}
      {runs.length === 0 ? (
        <p className="runtime-empty">{t("workflowRuns.empty")}</p>
      ) : (
        <div className="workflow-run-grid">
          <ol className="workflow-run-list" aria-label={t("workflowRuns.list")}>
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  aria-pressed={selectedRun?.id === run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <strong>{run.workflowId}</strong>
                  <span>{run.state}</span>
                  <small>
                    {run.nodeRuns.length} {t("workflowRuns.nodes")}
                  </small>
                </button>
              </li>
            ))}
          </ol>
          {selectedRun === null ? null : (
            <section className="workflow-run-detail" aria-label={t("workflowRuns.details")}>
              <header>
                <div>
                  <strong>{selectedRun.workflowId}</strong>
                  <span data-testid="workflow-run-state">{selectedRun.state}</span>
                  {projection.hasReport ? (
                    <details data-testid="workflow-run-report">
                      <summary>{t("workflowRuns.openReport")}</summary>
                      <small>{t("workflowRuns.reportReady")}</small>
                      <code>{officialReportId(selectedRun.reportArtifact)}</code>
                    </details>
                  ) : null}
                </div>
                <div className="workflow-run-actions">
                  {canPause(selectedRun.state) ? (
                    <button disabled={busy} type="button" onClick={() => void apply("pause")}>
                      {t("workflowRuns.pause")}
                    </button>
                  ) : null}
                  {selectedRun.state === "paused" ? (
                    <button disabled={busy} type="button" onClick={() => void apply("resume")}>
                      {t("workflowRuns.resume")}
                    </button>
                  ) : null}
                  {canCancel(selectedRun.state) ? (
                    <button disabled={busy} type="button" onClick={() => void apply("cancel")}>
                      {t("workflowRuns.cancel")}
                    </button>
                  ) : null}
                  {isTerminalRun(selectedRun.state) ? (
                    <button disabled={busy} type="button" onClick={() => void apply("retry")}>
                      {t("workflowRuns.retry")}
                    </button>
                  ) : null}
                  {selectedRun.state === "waiting" && approvalNodeId !== null ? (
                    <>
                      <button disabled={busy} type="button" onClick={() => void apply("approve")}>
                        {t("workflowRuns.approve")}
                      </button>
                      <button disabled={busy} type="button" onClick={() => void apply("reject")}>
                        {t("workflowRuns.reject")}
                      </button>
                    </>
                  ) : null}
                </div>
              </header>
              <div>
                <h4>{t("workflowRuns.nodes")}</h4>
                <ol className="workflow-node-list" data-testid="workflow-run-nodes">
                  {projection.nodes.map((node) => (
                    <li
                      key={node.nodeId}
                      data-testid="workflow-run-node"
                      data-node-id={node.nodeId}
                      data-runtime-state={node.runtimeState}
                    >
                      <strong>{node.title}</strong>
                      <span
                        className={`workflow-node-state workflow-node-state--${node.runtimeState}`}
                        data-testid="workflow-run-node-state"
                      >
                        {t(RUNTIME_STATE_KEYS[node.runtimeState])}
                      </span>
                      <small>
                        {node.attempt > 1
                          ? t("workflowRuns.attempt", { attempt: node.attempt })
                          : null}
                        {node.durationMs === null
                          ? null
                          : ` · ${t("workflowRuns.durationMs", { ms: node.durationMs })}`}
                        {node.isRecovered ? ` · ${t("workflowRuns.recovered")}` : null}
                      </small>
                      {node.shortError === null ? null : (
                        <small className="workflow-node-error" role="status">
                          {t("workflowRuns.failure", { reason: node.shortError })}
                        </small>
                      )}
                      <WorkflowNodeInspector node={node} />
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <h4>{t("workflowRuns.context")}</h4>
                {selectedRun.executionContext === null ? (
                  <p className="runtime-empty">{t("workflowRuns.contextUnavailable")}</p>
                ) : (
                  <div className="workflow-run-context">
                    <small>
                      {t("workflowRuns.contextAgent", {
                        agent: selectedRun.executionContext.agentNodeId
                      })}
                    </small>
                    <small>{selectedRun.executionContext.task}</small>
                    <small>
                      {t("workflowRuns.contextVersions", {
                        profile: selectedRun.executionContext.profileVersion,
                        mission: selectedRun.executionContext.missionVersion ?? "—",
                        memory: selectedRun.executionContext.memoryVersion ?? "—"
                      })}
                    </small>
                    <small>
                      {t("workflowRuns.contextCheckpoints", {
                        functionId: selectedRun.executionContext.functionCheckpoint.checkpointId,
                        deliveryId:
                          selectedRun.executionContext.deliveryCheckpoint?.checkpointId ?? "—"
                      })}
                    </small>
                  </div>
                )}
              </div>
              <div>
                <h4>{t("workflowRuns.dependencies")}</h4>
                {graph === null ? (
                  <p className="runtime-empty">{t("workflowRuns.dependenciesLoading")}</p>
                ) : (
                  <ol className="workflow-dependency-list">
                    {graph.nodes.map((node) => (
                      <li key={node.id}>
                        <strong>{node.title ?? node.id}</strong>
                        <span>{node.type}</span>
                        {node.dependsOn.length === 0 ? (
                          <small>{t("workflowRuns.noDependencies")}</small>
                        ) : (
                          <ul className="workflow-edge-list">
                            {node.dependsOn.map((dependency) => (
                              <li
                                key={dependency}
                                data-testid="workflow-run-edge"
                                data-edge-from={dependency}
                                data-edge-to={node.id}
                                data-edge-state={
                                  edgeStateByPair.get(`${dependency}->${node.id}`) ?? "pending"
                                }
                              >
                                {t("workflowRuns.dependsOn", { nodes: dependency })}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div>
                <h4>{t("workflowRuns.events")}</h4>
                {events.length === 0 ? (
                  <p className="runtime-empty">{t("workflowRuns.eventsEmpty")}</p>
                ) : (
                  <ol className="workflow-event-list">
                    {events.map((event) => (
                      <li key={event.id}>
                        <strong>{event.type}</strong>
                        <small>{event.timestamp}</small>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}

const RUNTIME_STATE_KEYS = {
  idle: "workflowRuns.state.idle",
  queued: "workflowRuns.state.queued",
  blocked: "workflowRuns.state.blocked",
  running: "workflowRuns.state.running",
  retrying: "workflowRuns.state.retrying",
  succeeded: "workflowRuns.state.succeeded",
  failed: "workflowRuns.state.failed",
  cancelled: "workflowRuns.state.cancelled"
} as const satisfies Record<CanvasNodeRuntimeState, string>;

function officialReportId(reportArtifact: unknown): string {
  if (typeof reportArtifact === "object" && reportArtifact !== null) {
    const id = (reportArtifact as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return "—";
}

function upsertRun(
  current: readonly WorkflowRunSnapshotDto[],
  next: WorkflowRunSnapshotDto
): readonly WorkflowRunSnapshotDto[] {
  const withoutCurrent = current.filter((run) => run.id !== next.id);
  return [next, ...withoutCurrent];
}

function pendingApprovalNodeId(events: readonly WorkflowRunEvent[]): string | null {
  const event = [...events].reverse().find((item) => item.type === "approval.requested");
  const nodeId = event?.payload.nodeId;
  return typeof nodeId === "string" ? nodeId : null;
}

function canPause(state: WorkflowRunSnapshotDto["state"]): boolean {
  return state === "running" || state === "waiting";
}

function canCancel(state: WorkflowRunSnapshotDto["state"]): boolean {
  return ["created", "running", "paused", "waiting"].includes(state);
}

function isTerminalRun(state: WorkflowRunSnapshotDto["state"]): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(state);
}

const adapterTranslationKeys = {
  shell: "adapter.shell",
  "claude-code": "adapter.claude-code",
  codex: "adapter.codex",
  opencode: "adapter.opencode"
} as const;

const sessionStateTranslationKeys = {
  starting: "state.starting",
  running: "state.running",
  waiting: "state.waiting",
  stopping: "state.stopping",
  succeeded: "state.succeeded",
  failed: "state.failed",
  cancelled: "state.cancelled",
  interrupted: "state.interrupted"
} as const;

export function LocalSettingsPanel({
  theme,
  onThemeChange
}: {
  readonly theme: AppTheme;
  readonly onThemeChange: (theme: AppTheme) => Promise<void>;
}) {
  const { locale, setLocale, t } = useI18n();
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([window.forgedeck.runtime.diagnostics(), window.forgedeck.cloudSync.status()])
      .then(([nextDiagnostics, nextCloudStatus]) => {
        if (!active) {
          return;
        }
        setDiagnostics(nextDiagnostics);
        setCloudStatus(nextCloudStatus);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : t("settings.loadFailed"));
        }
      });
    return () => {
      active = false;
    };
  }, [t]);

  return (
    <section className="workspace-placeholder runtime-panel" aria-labelledby="local-settings-title">
      <header className="runtime-panel-header">
        <div>
          <p className="fd-eyebrow">{t("settings.runtimeEyebrow")}</p>
          <h2 id="local-settings-title">{t("settings.title")}</h2>
          <p>{t("settings.body")}</p>
        </div>
      </header>
      {error === null ? null : <p className="review-notice is-error">{error}</p>}
      {diagnostics === null || cloudStatus === null ? (
        <p className="runtime-empty">{t("settings.loading")}</p>
      ) : (
        <div className="runtime-settings-grid">
          <section className="runtime-card" aria-labelledby="runtime-summary-title">
            <p className="fd-eyebrow">{t("settings.device")}</p>
            <h3 id="runtime-summary-title">{t("settings.summary")}</h3>
            <label>
              {t("settings.language")}
              <select
                value={locale}
                onChange={(event) => {
                  void setLocale(event.target.value === "en" ? "en" : "pt-BR").catch(
                    (cause: unknown) =>
                      setError(cause instanceof Error ? cause.message : t("settings.loadFailed"))
                  );
                }}
              >
                <option value="pt-BR">{t("settings.portuguese")}</option>
                <option value="en">{t("settings.english")}</option>
              </select>
            </label>
            <div className="appearance-control">
              <span>Aparência</span>
              <button
                aria-label={theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro"}
                className="theme-toggle"
                title={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
                type="button"
                onClick={() => {
                  void onThemeChange(theme === "dark" ? "light" : "dark").catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : t("settings.loadFailed"))
                  );
                }}
              >
                <Icon name={theme === "dark" ? "sun" : "moon"} />
                {theme === "dark" ? "Tema claro" : "Tema escuro"}
              </button>
              <small>Salvo somente neste dispositivo.</small>
            </div>
            <dl>
              <div>
                <dt>{t("settings.platform")}</dt>
                <dd>{diagnostics.platform}</dd>
              </div>
              <div>
                <dt>{t("settings.architecture")}</dt>
                <dd>{diagnostics.architecture}</dd>
              </div>
              <div>
                <dt>{t("settings.terminalBackend")}</dt>
                <dd>{diagnostics.terminalBackend}</dd>
              </div>
              <div>
                <dt>{t("settings.recovered")}</dt>
                <dd>{diagnostics.interruptedSessionsRecovered}</dd>
              </div>
            </dl>
          </section>
          <section className="runtime-card" aria-labelledby="adapter-summary-title">
            <p className="fd-eyebrow">{t("settings.adapters")}</p>
            <h3 id="adapter-summary-title">{t("settings.availability")}</h3>
            <ul>
              {diagnostics.adapters.map((adapter) => (
                <li key={adapter.id}>
                  <strong>{adapter.displayName}</strong>
                  <span>
                    {adapter.available
                      ? t("common.available")
                      : (adapter.issue?.remediation ?? t("common.unavailable"))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="runtime-card" aria-labelledby="local-boundaries-title">
            <p className="fd-eyebrow">{t("settings.boundary")}</p>
            <h3 id="local-boundaries-title">{t("settings.cloud")}</h3>
            <p>
              {t("settings.cloudBody", {
                state: t(cloudStatus.enabled ? "settings.cloudEnabled" : "settings.cloudDisabled")
              })}
            </p>
          </section>
        </div>
      )}
    </section>
  );
}
