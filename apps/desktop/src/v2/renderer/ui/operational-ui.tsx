import { useMemo, useState } from "react";

import {
  AUTONOMY_WORKER_BUDGETS,
  EXECUTION_POLICIES,
  type AgentInstallation,
  type CanvasEdge,
  type CanvasNode,
  type ExecutionPolicyId,
  type OrchestrationRun,
  type OrchestrationTask,
  type TeamRun,
  type TerminalSession,
  type Workspace,
  type WorkspaceOperationalState
} from "@forgedeck/compazio-v2-domain";

import { ORCHESTRATOR_LABEL } from "./role-labels";

type Sessions = Readonly<Record<string, TerminalSession>>;

const runLabels: Record<OrchestrationRun["status"], string> = {
  created: "Criada",
  planning: "Planejando",
  running: "Executando",
  waiting: "Aguardando",
  "needs-attention": "Precisa de atenção",
  paused: "Pausada",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada"
};

const taskLabels: Record<OrchestrationTask["status"], string> = {
  queued: "Na fila",
  assigned: "Atribuída",
  running: "Executando",
  "waiting-input": "Aguardando entrada",
  "waiting-dependency": "Aguardando dependência",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada"
};

const teamRunLabels: Record<TeamRun["status"], string> = {
  planning: "Planejando",
  recruiting: "Recrutando",
  running: "Executando",
  blocked: "Aguardando",
  review: "Em revisao",
  completed: "Concluida",
  failed: "Falhou",
  cancelled: "Cancelada"
};

export function PolicySelector({
  state,
  disabled,
  onChange
}: {
  readonly state: WorkspaceOperationalState;
  readonly disabled: boolean;
  readonly onChange: (policyId: ExecutionPolicyId) => void;
}) {
  return (
    <div className="v2-policy" aria-label="Política de execução">
      {(["economy", "standard", "high-performance"] as const).map((policyId) => (
        <button
          key={policyId}
          className={state.policyId === policyId ? "active" : ""}
          disabled={disabled}
          aria-pressed={state.policyId === policyId}
          title={policyDescription(policyId)}
          onClick={() => onChange(policyId)}
        >
          {policyId === "economy"
            ? "Econômico"
            : policyId === "standard"
              ? "Padrão"
              : "Alta Performance"}
        </button>
      ))}
    </div>
  );
}

export function TeamSummary({
  workspace,
  state,
  sessions,
  run,
  onClose,
  onOpenTimeline,
  onRunAction
}: {
  readonly workspace: Workspace;
  readonly state: WorkspaceOperationalState;
  readonly sessions: Sessions;
  readonly run: OrchestrationRun;
  readonly onClose: () => void;
  readonly onOpenTimeline: () => void;
  readonly onRunAction: (action: "pause" | "resume" | "cancel" | "fit") => void;
}) {
  const assignments = state.assignments.filter(
    (assignment) => assignment.runId === run.id && assignment.releasedAt === undefined
  );
  const tasks = state.tasks.filter((task) => task.runId === run.id);
  const counts = {
    working: tasks.filter((task) => task.status === "running").length,
    waiting: tasks.filter((task) => task.status.startsWith("waiting")).length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    attention: state.attention.filter(
      (request) => request.runId === run.id && request.status === "open"
    ).length
  };
  return (
    <section
      className="v2-team-summary"
      aria-label="Resumo da equipe"
      data-testid="v2-team-summary"
    >
      <header>
        <div>
          <strong>Equipe — {workspace.name}</strong>
          <span className={`v2-run-state ${run.status}`}>{runLabels[run.status]}</span>
        </div>
        <button onClick={onClose} aria-label="Fechar resumo da equipe">
          ×
        </button>
      </header>
      <div className="v2-team-list">
        <TeamMember
          name={
            workspace.nodes.find((node) => node.id === run.orchestratorTerminalId)?.title ??
            ORCHESTRATOR_LABEL
          }
          responsibility={ORCHESTRATOR_LABEL}
          processState={sessions[run.orchestratorTerminalId]?.state ?? "stopped"}
        />
        {assignments.map((assignment) => {
          const node = workspace.nodes.find((candidate) => candidate.id === assignment.terminalId);
          const task = [...tasks]
            .reverse()
            .find((candidate) => candidate.assignedTerminalId === assignment.terminalId);
          return (
            <TeamMember
              key={assignment.id}
              name={node?.title ?? "Agente removido"}
              responsibility={assignment.roleId ?? "Sem responsabilidade"}
              processState={sessions[assignment.terminalId]?.state ?? "stopped"}
              task={task}
            />
          );
        })}
      </div>
      <dl className="v2-team-counts">
        <div>
          <dt>Agentes</dt>
          <dd>{assignments.length}</dd>
        </div>
        <div>
          <dt>Trabalhando</dt>
          <dd>{counts.working}</dd>
        </div>
        <div>
          <dt>Aguardando</dt>
          <dd>{counts.waiting}</dd>
        </div>
        <div>
          <dt>Concluídas</dt>
          <dd>{counts.completed}</dd>
        </div>
        <div>
          <dt>Falhas</dt>
          <dd>{counts.failed}</dd>
        </div>
        <div>
          <dt>Atenção</dt>
          <dd>{counts.attention}</dd>
        </div>
      </dl>
      <footer>
        <button onClick={onOpenTimeline}>Histórico</button>
        <button onClick={() => onRunAction("fit")}>Enquadrar equipe</button>
        {run.status === "paused" ? (
          <button onClick={() => onRunAction("resume")}>Retomar</button>
        ) : (
          <button onClick={() => onRunAction("pause")}>Pausar</button>
        )}
        <button className="v2-danger" onClick={() => onRunAction("cancel")}>
          Cancelar
        </button>
      </footer>
    </section>
  );
}

function TeamMember({
  name,
  responsibility,
  processState,
  task
}: {
  readonly name: string;
  readonly responsibility: string;
  readonly processState: TerminalSession["state"] | "stopped";
  readonly task?: OrchestrationTask;
}) {
  return (
    <div className="v2-team-member">
      <span className={`v2-presence ${processState}`} aria-hidden="true" />
      <div>
        <strong>{name}</strong>
        <small>{responsibility}</small>
      </div>
      <span>{task === undefined ? processLabel(processState) : taskLabels[task.status]}</span>
    </div>
  );
}

export function RecoveryNotice({
  state,
  onRecover
}: {
  readonly state: WorkspaceOperationalState;
  readonly onRecover: (
    runId: string,
    action: "resume" | "restart-agents" | "end" | "canvas-only"
  ) => void;
}) {
  const request = state.attention.find(
    (candidate) => candidate.type === "recovery" && candidate.status === "open"
  );
  if (request?.runId === undefined) return null;
  const runId = request.runId;
  return (
    <section className="v2-recovery" role="alert" data-testid="v2-recovery-notice">
      <div>
        <strong>Esta execução foi interrompida quando o aplicativo fechou.</strong>
        <span>Os processos antigos não são mostrados como ativos.</span>
      </div>
      <button onClick={() => onRecover(runId, "resume")}>Retomar</button>
      <button onClick={() => onRecover(runId, "restart-agents")}>Reiniciar agentes</button>
      <button onClick={() => onRecover(runId, "end")}>Encerrar execução</button>
      <button onClick={() => onRecover(runId, "canvas-only")}>Manter somente o canvas</button>
    </section>
  );
}

export function OperationalInspector({
  workspace,
  state,
  selectedNode,
  selectedEdge,
  session,
  installation,
  onClose,
  onWorkspace,
  onState,
  onMessage,
  onConfigureTerminal,
  onRequestNodeDeletion,
  onFocusTerminal,
  onOpenTimeline,
  onFitTeam
}: {
  readonly workspace: Workspace;
  readonly state: WorkspaceOperationalState;
  readonly selectedNode?: CanvasNode;
  readonly selectedEdge?: CanvasEdge;
  readonly session?: TerminalSession;
  readonly installation?: AgentInstallation;
  readonly onClose: () => void;
  readonly onWorkspace: (workspace: Workspace) => void;
  readonly onState: (state: WorkspaceOperationalState) => void;
  readonly onMessage: (message: string) => void;
  readonly onConfigureTerminal: (terminal: Extract<CanvasNode, { type: "terminal" }>) => void;
  readonly onRequestNodeDeletion: (node: CanvasNode) => void;
  readonly onFocusTerminal: (terminalId: string) => void;
  readonly onOpenTimeline: () => void;
  readonly onFitTeam: (runId: string) => void;
}) {
  const run = latestRunForSelection(state, selectedNode?.id, selectedEdge);
  const task =
    selectedNode?.type === "terminal"
      ? [...state.tasks]
          .reverse()
          .find(
            (candidate) =>
              candidate.runId === run?.id && candidate.assignedTerminalId === selectedNode.id
          )
      : undefined;
  const teamTask =
    selectedNode?.type === "terminal"
      ? [...state.teamTasks]
          .reverse()
          .find((candidate) => candidate.assignedToTerminalId === selectedNode.id)
      : undefined;
  const teamMember =
    selectedNode?.type === "terminal"
      ? state.teamMembers.find((candidate) => candidate.terminalId === selectedNode.id)
      : undefined;
  const teamRun =
    selectedNode?.type === "terminal"
      ? state.teamRuns.find(
          (candidate) =>
            candidate.compazioTerminalId === selectedNode.id ||
            (teamMember !== undefined && candidate.memberIds.includes(teamMember.id))
        )
      : undefined;
  const recentMessages =
    selectedNode?.type === "terminal"
      ? state.messages.filter(
          (message) =>
            message.fromTerminalId === selectedNode.id || message.toTerminalId === selectedNode.id
        )
      : [];
  const activities = state.activities.filter(
    (activity) =>
      activity.edgeId === selectedEdge?.id ||
      activity.sourceNodeId === selectedNode?.id ||
      activity.targetNodeId === selectedNode?.id
  );
  const execute = (operation: () => Promise<void>): void => {
    void operation().catch((error: unknown) =>
      onMessage(error instanceof Error ? error.message : "A ação não pôde ser concluída.")
    );
  };
  return (
    <aside className="v2-inspector" aria-label="Inspector contextual" data-testid="v2-inspector">
      <header>
        <div>
          <small>Inspector</small>
          <h2>{selectedNode?.title ?? (selectedEdge === undefined ? "Execução" : "Conexão")}</h2>
        </div>
        <button onClick={onClose} aria-label="Fechar inspector">
          ×
        </button>
      </header>
      {selectedNode?.type === "terminal" && (
        <>
          <DefinitionList
            rows={[
              ["Agente", selectedNode.agentConfig.agentId],
              ["Versão", installation?.version ?? "Não informada"],
              ["Responsabilidade", selectedNode.agentConfig.roleId ?? "Nenhuma"],
              ["Capacidade", selectedNode.isCompazio ? ORCHESTRATOR_LABEL : "Agente comum"],
              ["Processo", processLabel(session?.state ?? "stopped")],
              [
                "Tarefa",
                teamTask === undefined
                  ? task === undefined
                    ? "Nenhuma"
                    : taskLabels[task.status]
                  : (taskLabels[teamTask.status as keyof typeof taskLabels] ?? teamTask.status)
              ],
              [
                "Equipe",
                teamRun === undefined ? "Nenhuma" : `${teamRun.title} — ${teamRun.status}`
              ],
              [
                "Dependências",
                teamTask === undefined || teamTask.dependsOn.length === 0
                  ? "Nenhuma"
                  : teamTask.dependsOn.length === 1
                    ? "1 tarefa"
                    : `${teamTask.dependsOn.length} tarefas`
              ],
              [
                "Bloqueio",
                teamTask?.status === "blocked"
                  ? teamTask.blockedBy.length === 0
                    ? "Aguardando liberação"
                    : `${teamTask.blockedBy.length} dependência(s)`
                  : "Não"
              ],
              [
                "Mensagens",
                recentMessages.length === 0 ? "Nenhuma" : String(recentMessages.length)
              ],
              ["Execução", run === undefined ? "Nenhuma" : runLabels[run.status]],
              ["Última atividade", formatTime(session?.lastActivityAt)]
            ]}
          />
          {task?.failure !== undefined && (
            <FailureCard task={task} workspace={workspace} onState={onState} execute={execute} />
          )}
          {teamTask !== undefined && recentMessages.length > 0 && (
            <section className="v2-team-message-preview" aria-label="Mensagens recentes da equipe">
              <strong>Mensagens recentes</strong>
              <ul>
                {recentMessages.slice(-3).map((message) => (
                  <li key={message.id}>
                    <span>{message.type}</span>
                    <small>{message.status}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {teamRun !== undefined && (
            <TeamActivity workspace={workspace} state={state} run={teamRun} />
          )}
          <InspectorActions>
            <button onClick={() => onFocusTerminal(selectedNode.id)}>Focar terminal</button>
            <button onClick={() => onConfigureTerminal(selectedNode)}>Editar</button>
            <button
              disabled={session === undefined}
              onClick={() =>
                execute(async () => {
                  if (session === undefined) return;
                  await window.compazioV2.terminal.restart({
                    workspaceId: workspace.id,
                    nodeId: selectedNode.id,
                    sessionId: session.id
                  });
                })
              }
            >
              Reiniciar
            </button>
            <button
              disabled={session === undefined}
              onClick={() =>
                execute(async () => {
                  if (session === undefined) return;
                  await window.compazioV2.terminal.stop({
                    workspaceId: workspace.id,
                    nodeId: selectedNode.id,
                    sessionId: session.id
                  });
                })
              }
            >
              Interromper
            </button>
            <button onClick={onOpenTimeline}>Ver histórico</button>
            {run !== undefined && (
              <button onClick={() => onFitTeam(run.id)}>Enquadrar equipe</button>
            )}
            <button className="v2-danger" onClick={() => onRequestNodeDeletion(selectedNode)}>
              Excluir
            </button>
          </InspectorActions>
        </>
      )}
      {selectedNode?.type === "note" && (
        <>
          <DefinitionList
            rows={[
              ["Tipo", "Nota"],
              [
                "Conexões",
                String(
                  workspace.edges.filter(
                    (edge) =>
                      edge.sourceNodeId === selectedNode.id || edge.targetNodeId === selectedNode.id
                  ).length
                )
              ],
              ["Última alteração", formatTime(selectedNode.updatedAt)],
              [
                "Alterada por",
                [...state.events]
                  .reverse()
                  .find(
                    (event) => event.type === "note.updated" && event.target === selectedNode.id
                  )?.actor ?? "Usuário"
              ]
            ]}
          />
          <InspectorActions>
            <button onClick={() => onFocusTerminal(selectedNode.id)}>Abrir no canvas</button>
            <button onClick={onOpenTimeline}>Ver histórico</button>
            <button className="v2-danger" onClick={() => onRequestNodeDeletion(selectedNode)}>
              Excluir
            </button>
          </InspectorActions>
        </>
      )}
      {selectedNode?.type === "file-tree" && (
        <>
          <DefinitionList
            rows={[
              ["Caminho", selectedNode.currentPath],
              [
                "Visualização",
                selectedNode.viewMode === "diff"
                  ? "Diff"
                  : selectedNode.viewMode === "grid"
                    ? "Grade"
                    : "Lista"
              ],
              ["Arquivo aberto", selectedNode.editor.openedPath ?? "Nenhum"],
              [
                "Conexões",
                String(
                  workspace.edges.filter(
                    (edge) =>
                      edge.sourceNodeId === selectedNode.id || edge.targetNodeId === selectedNode.id
                  ).length
                )
              ],
              ["Última atividade", formatTime(selectedNode.updatedAt)]
            ]}
          />
          <InspectorActions>
            <button onClick={() => onFocusTerminal(selectedNode.id)}>Abrir no canvas</button>
            <button onClick={onOpenTimeline}>Ver histórico</button>
            <button
              onClick={() =>
                execute(async () => {
                  onWorkspace(
                    await window.compazioV2.nodes.updateFileTree({
                      workspaceId: workspace.id,
                      nodeId: selectedNode.id,
                      viewMode: "diff"
                    })
                  );
                })
              }
            >
              Abrir Diff
            </button>
            <button className="v2-danger" onClick={() => onRequestNodeDeletion(selectedNode)}>
              Excluir
            </button>
          </InspectorActions>
        </>
      )}
      {selectedNode?.type === "file-preview" && (
        <>
          <DefinitionList
            rows={[
              ["Arquivo", selectedNode.filePath],
              ["Tipo", selectedNode.previewKind],
              ["Estado", selectedNode.missing ? "Arquivo não encontrado" : "Disponível"],
              ["Última atividade", formatTime(selectedNode.updatedAt)]
            ]}
          />
          <InspectorActions>
            <button onClick={() => onFocusTerminal(selectedNode.id)}>Abrir no canvas</button>
            <button onClick={onOpenTimeline}>Ver histórico</button>
            <button className="v2-danger" onClick={() => onRequestNodeDeletion(selectedNode)}>
              Excluir
            </button>
          </InspectorActions>
        </>
      )}
      {selectedEdge !== undefined && (
        <>
          <DefinitionList
            rows={[
              [
                "Origem",
                workspace.nodes.find((node) => node.id === selectedEdge.sourceNodeId)?.title ??
                  selectedEdge.sourceNodeId
              ],
              [
                "Destino",
                workspace.nodes.find((node) => node.id === selectedEdge.targetNodeId)?.title ??
                  selectedEdge.targetNodeId
              ],
              ["Capacidades", selectedEdge.capabilities.join(", ") || "Visual"],
              ["Última atividade", formatTime(activities.at(-1)?.updatedAt)],
              ["Eventos não lidos", String(activities.filter((activity) => activity.unread).length)]
            ]}
          />
          <ActivityList activities={activities} />
          <InspectorActions>
            <button onClick={onOpenTimeline}>Ver histórico</button>
            <button
              className="v2-danger"
              onClick={() =>
                execute(async () =>
                  onWorkspace(
                    await window.compazioV2.edges.delete({
                      workspaceId: workspace.id,
                      edgeId: selectedEdge.id
                    })
                  )
                )
              }
            >
              Remover
            </button>
          </InspectorActions>
        </>
      )}
      {selectedNode === undefined && selectedEdge === undefined && (
        <AttentionSection
          workspaceId={workspace.id}
          state={state}
          onState={onState}
          execute={execute}
        />
      )}
      <NotificationPreferences workspaceId={workspace.id} state={state} onState={onState} />
    </aside>
  );
}

function FailureCard({
  task,
  workspace,
  onState,
  execute
}: {
  readonly task: OrchestrationTask;
  readonly workspace: Workspace;
  readonly onState: (state: WorkspaceOperationalState) => void;
  readonly execute: (operation: () => Promise<void>) => void;
}) {
  const candidates = workspace.nodes.filter(
    (node) => node.type === "terminal" && node.id !== task.assignedTerminalId
  );
  const [targetTerminalId, setTargetTerminalId] = useState(candidates[0]?.id ?? "manual");
  return (
    <section className="v2-failure-card" role="alert">
      <strong>{task.failure?.message}</strong>
      <span>
        Tentativa {task.attempt} de {task.maxAttempts}
      </span>
      <small>{task.failure?.suggestedAction}</small>
      <div>
        <button
          disabled={!task.failure?.retryable || task.attempt >= task.maxAttempts}
          onClick={() =>
            execute(async () =>
              onState(
                await window.compazioV2.tasks.retry({
                  workspaceId: workspace.id,
                  taskId: task.id,
                  idempotencyKey: `retry-${task.id}-${task.attempt + 1}`
                })
              )
            )
          }
        >
          Tentar novamente
        </button>
        <select
          aria-label="Reatribuir para"
          value={targetTerminalId}
          onChange={(event) => setTargetTerminalId(event.target.value)}
        >
          {candidates.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
            </option>
          ))}
          <option value="manual">Execução manual pelo usuário</option>
        </select>
        <button
          onClick={() =>
            execute(async () =>
              onState(
                await window.compazioV2.tasks.reassign({
                  workspaceId: workspace.id,
                  taskId: task.id,
                  terminalId: targetTerminalId,
                  idempotencyKey: `reassign-${task.id}-${task.attempt + 1}-${targetTerminalId}`
                })
              )
            )
          }
        >
          Reatribuir
        </button>
        <button
          onClick={() =>
            execute(async () =>
              onState(
                await window.compazioV2.tasks.cancel({
                  workspaceId: workspace.id,
                  taskId: task.id
                })
              )
            )
          }
        >
          Cancelar
        </button>
      </div>
    </section>
  );
}

function AttentionSection({
  workspaceId,
  state,
  onState,
  execute
}: {
  readonly workspaceId: string;
  readonly state: WorkspaceOperationalState;
  readonly onState: (state: WorkspaceOperationalState) => void;
  readonly execute: (operation: () => Promise<void>) => void;
}) {
  const open = state.attention.filter((request) => request.status === "open");
  const waitingForUser = state.teamUserInputRequests.filter(
    (request) => request.status === "waiting-for-user-input"
  );
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  return (
    <section className="v2-attention-section">
      <h3>Atenção necessária</h3>
      {waitingForUser.map((request) => (
        <article key={request.id} className="v2-attention blocking">
          <strong>{request.question}</strong>
          <p>{request.reason}</p>
          {request.context !== undefined && <small>{request.context}</small>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const answer = answers[request.id]?.trim() ?? "";
              if (answer === "") return;
              execute(async () =>
                onState(
                  await window.compazioV2.teamUserInput.answer({
                    workspaceId,
                    compazioTerminalId: request.compazioTerminalId,
                    requestId: request.id,
                    answer
                  })
                )
              );
            }}
          >
            <label>
              Responder pelo Compazio
              <input
                aria-label={`Resposta para ${request.question}`}
                value={answers[request.id] ?? ""}
                inputMode={request.expectedAnswerType === "number" ? "numeric" : "text"}
                placeholder={
                  request.expectedAnswerType === "url"
                    ? "https:// ou número/URL solicitado"
                    : "Digite a informação solicitada"
                }
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [request.id]: event.target.value }))
                }
              />
            </label>
            <button type="submit" disabled={(answers[request.id]?.trim() ?? "") === ""}>
              Responder e continuar
            </button>
          </form>
        </article>
      ))}
      {open.length === 0 && waitingForUser.length === 0 ? (
        <p className="v2-muted">Nenhuma solicitação aberta.</p>
      ) : (
        open.map((request) => (
          <article key={request.id} className={`v2-attention ${request.severity}`}>
            <strong>{request.title}</strong>
            {request.description !== undefined && <p>{request.description}</p>}
            <div>
              <button
                onClick={() =>
                  execute(async () =>
                    onState(
                      await window.compazioV2.attention.resolve({
                        workspaceId,
                        attentionId: request.id
                      })
                    )
                  )
                }
              >
                Resolver
              </button>
              <button
                onClick={() =>
                  execute(async () =>
                    onState(
                      await window.compazioV2.attention.dismiss({
                        workspaceId,
                        attentionId: request.id
                      })
                    )
                  )
                }
              >
                Dispensar
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function NotificationPreferences({
  workspaceId,
  state,
  onState
}: {
  readonly workspaceId: string;
  readonly state: WorkspaceOperationalState;
  readonly onState: (state: WorkspaceOperationalState) => void;
}) {
  const update = (key: keyof WorkspaceOperationalState["notificationPreferences"]): void => {
    void window.compazioV2.notifications
      .update({
        workspaceId,
        preferences: {
          ...state.notificationPreferences,
          [key]: !state.notificationPreferences[key]
        }
      })
      .then(onState);
  };
  return (
    <details className="v2-notification-settings">
      <summary>Notificações</summary>
      {(
        [
          ["executionCompleted", "Execução concluída"],
          ["attentionRequired", "Atenção necessária"],
          ["failures", "Falhas"],
          ["backgroundActivity", "Atividade em segundo plano"]
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={state.notificationPreferences[key]}
            onChange={() => update(key)}
          />
          {label}
        </label>
      ))}
    </details>
  );
}

export function Timeline({
  workspace,
  state,
  onClose,
  onUndo,
  onRedo
}: {
  readonly workspace: Workspace;
  readonly state: WorkspaceOperationalState;
  readonly onClose: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "agents" | "tasks" | "errors" | "notes" | "edges">(
    "all"
  );
  const [query, setQuery] = useState("");
  const events = useMemo(
    () =>
      [...state.events]
        .reverse()
        .filter((event) => matchesEventFilter(event.type, filter))
        .filter((event) =>
          `${event.type} ${event.actor} ${event.target}`.toLowerCase().includes(query.toLowerCase())
        ),
    [filter, query, state.events]
  );
  return (
    <aside className="v2-timeline" aria-label="Timeline da execução" data-testid="v2-timeline">
      <header>
        <div>
          <small>Histórico operacional</small>
          <h2>{workspace.name}</h2>
        </div>
        <button onClick={onClose} aria-label="Fechar timeline">
          ×
        </button>
      </header>
      <div className="v2-timeline-navigation" aria-label="Desfazer e refazer ações">
        <button onClick={onUndo} title="Desfazer — Ctrl+Z">
          ← Desfazer
        </button>
        <button onClick={onRedo} title="Refazer — Ctrl+Y">
          Refazer →
        </button>
      </div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Buscar no histórico"
        aria-label="Buscar no histórico"
      />
      <div className="v2-timeline-filters" role="group" aria-label="Filtrar timeline">
        {(["all", "agents", "tasks", "errors", "notes", "edges"] as const).map((value) => (
          <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {value === "all"
              ? "Tudo"
              : value === "agents"
                ? "Agentes"
                : value === "tasks"
                  ? "Tarefas"
                  : value === "errors"
                    ? "Erros"
                    : value === "notes"
                      ? "Notas"
                      : "Conexões"}
          </button>
        ))}
      </div>
      <ol>
        {events.map((event) => (
          <li key={event.id}>
            <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
            <div>
              <strong>{eventLabel(event.type)}</strong>
              <span>{event.actor === "system" ? "Compazio" : event.actor}</span>
              <small>ID {event.correlationId}</small>
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  readonly x: number;
  readonly y: number;
  readonly items: readonly {
    readonly label: string;
    readonly danger?: boolean;
    readonly disabled?: boolean;
    readonly action: () => void;
  }[];
  readonly onClose: () => void;
}) {
  return (
    <div
      className="v2-context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? "v2-danger" : ""}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function TeamActivity({
  workspace,
  state,
  run
}: {
  readonly workspace: Workspace;
  readonly state: WorkspaceOperationalState;
  readonly run: TeamRun;
}) {
  const taskIds = new Set(
    state.teamTasks.filter((task) => task.runId === run.id).map((task) => task.id)
  );
  const memberTerminalIds = new Set(
    state.teamMembers
      .filter((member) => member.runId === run.id || run.memberIds.includes(member.id))
      .map((member) => member.terminalId)
  );
  const events = state.events
    .filter((event) => {
      if (
        event.runId === run.id ||
        taskIds.has(event.target) ||
        memberTerminalIds.has(event.target)
      )
        return true;
      const message = state.messages.find((candidate) => candidate.id === event.target);
      return message?.taskId !== undefined && taskIds.has(message.taskId);
    })
    .slice(-16)
    .reverse();
  const nextStep = teamNextStep(workspace, state, run);
  return (
    <details className="v2-team-activity" open>
      <summary>
        Atividade <span>{teamRunLabels[run.status]}</span>
      </summary>
      <p className="v2-team-next-step">PrÃ³ximo passo: {nextStep}</p>
      {events.length === 0 ? (
        <p className="v2-muted">A execucao ainda nao registrou eventos.</p>
      ) : (
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
              <span>{teamEventDescription(event, workspace, state)}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function teamNextStep(
  workspace: Workspace,
  state: WorkspaceOperationalState,
  run: TeamRun
): string {
  const tasks = state.teamTasks.filter((task) => task.runId === run.id);
  const running = tasks.find((task) => task.status === "running");
  if (running !== undefined) {
    const assignee =
      running.assignedToTerminalId === undefined
        ? "um agente"
        : teamActorLabel(running.assignedToTerminalId, workspace, state);
    return `${assignee} executa â€œ${running.title}â€.`;
  }
  const blocked = tasks.find((task) => task.status === "blocked");
  if (blocked !== undefined) return `liberar a dependÃªncia de â€œ${blocked.title}â€.`;
  const assigned = tasks.find((task) => task.status === "assigned" || task.status === "queued");
  if (assigned !== undefined)
    return `aguardar o aceite de â€œ${assigned.title}â€ no canal operacional.`;
  if (tasks.length > 0 && tasks.every((task) => task.status === "completed"))
    return "Compazio revisa o resultado consolidado.";
  return "Compazio organiza a prÃ³xima tarefa.";
}

function teamEventDescription(
  event: WorkspaceOperationalState["events"][number],
  workspace: Workspace,
  state: WorkspaceOperationalState
): string {
  const task = state.teamTasks.find((candidate) => candidate.id === event.target);
  const actor = teamActorLabel(event.actor, workspace, state);
  const assignee =
    task?.assignedToTerminalId === undefined
      ? undefined
      : teamActorLabel(task.assignedToTerminalId, workspace, state);
  const taskTitle = task === undefined ? undefined : `“${task.title}”`;
  if (event.type === "team.member.recruited")
    return `${actor} recrutou ${teamTargetLabel(event.target, workspace, state)}.`;
  if (event.type === "team.member.ready")
    return `${teamTargetLabel(event.target, workspace, state)} esta pronto.`;
  if (event.type === "team.member.failed")
    return `${teamTargetLabel(event.target, workspace, state)} falhou ao iniciar.`;
  if (event.type === "team.member.dismissed")
    return `${teamTargetLabel(event.target, workspace, state)} foi dispensado.`;
  if (event.type === "task.created") return `${actor} criou a tarefa ${taskTitle ?? "da equipe"}.`;
  if (event.type === "task.assigned")
    return `${actor} atribuiu ${taskTitle ?? "uma tarefa"}${assignee === undefined ? "" : ` a ${assignee}`}.`;
  if (event.type === "task.started")
    return `${assignee ?? actor} iniciou ${taskTitle ?? "uma tarefa"}.`;
  if (event.type === "task.completed")
    return `${assignee ?? actor} concluiu ${taskTitle ?? "uma tarefa"}.`;
  if (event.type === "task.blocked") return `${taskTitle ?? "Uma tarefa"} aguarda uma dependencia.`;
  if (event.type === "task.failed") return `${taskTitle ?? "Uma tarefa"} falhou.`;
  if (event.type === "team.run.completed") return "Compazio concluiu a execucao da equipe.";
  if (event.type === "team.run.cancelled") return "Compazio cancelou a execucao da equipe.";
  if (event.type === "team.run.review") return "Compazio moveu a equipe para revisao.";
  if (event.type === "message.sent") return `${actor} publicou uma atualizacao operacional.`;
  if (event.type === "message.acknowledged")
    return `${actor} confirmou uma atualizacao operacional.`;
  if (event.type === "message.failed") return "Uma atualizacao operacional falhou.";
  return eventLabel(event.type);
}

function teamActorLabel(
  id: string,
  workspace: Workspace,
  state: WorkspaceOperationalState
): string {
  if (id === "system") return ORCHESTRATOR_LABEL;
  if (id === "user") return "Voce";
  return (
    workspace.nodes.find((node) => node.id === id)?.title ??
    state.teamMembers.find((member) => member.terminalId === id)?.displayName ??
    ORCHESTRATOR_LABEL
  );
}

function teamTargetLabel(
  id: string,
  workspace: Workspace,
  state: WorkspaceOperationalState
): string {
  return (
    workspace.nodes.find((node) => node.id === id)?.title ??
    state.teamMembers.find((member) => member.terminalId === id)?.displayName ??
    "Agente"
  );
}

function ActivityList({
  activities
}: {
  readonly activities: WorkspaceOperationalState["activities"];
}) {
  return (
    <section className="v2-activity-list">
      <h3>Atividade da conexão</h3>
      {activities.length === 0 ? (
        <p className="v2-muted">Ainda não houve atividade operacional.</p>
      ) : (
        [...activities]
          .reverse()
          .slice(0, 20)
          .map((activity) => (
            <article key={activity.id}>
              <span className={`v2-activity-icon ${activity.status}`} aria-hidden="true" />
              <div>
                <strong>{activity.kind}</strong>
                <span>{activity.status}</span>
                <small>
                  {formatTime(activity.updatedAt)} · tentativa {activity.attempt}
                </small>
                {activity.preview !== undefined && <p>{activity.preview}</p>}
              </div>
            </article>
          ))
      )}
    </section>
  );
}

function DefinitionList({ rows }: { readonly rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="v2-definition-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function InspectorActions({ children }: { readonly children: React.ReactNode }) {
  return <div className="v2-inspector-actions">{children}</div>;
}

function latestRunForSelection(
  state: WorkspaceOperationalState,
  nodeId: string | undefined,
  edge: CanvasEdge | undefined
): OrchestrationRun | undefined {
  if (nodeId === undefined && edge === undefined)
    return [...state.runs].reverse().find((run) => run.id === state.lastSelectedRunId);
  return [...state.runs].reverse().find((run) => {
    if (nodeId !== undefined)
      return (
        run.orchestratorTerminalId === nodeId ||
        run.recruitedTerminalIds.includes(nodeId) ||
        state.teamLayouts.some(
          (layout) => layout.runId === run.id && layout.nodeIds.includes(nodeId)
        )
      );
    return state.activities.some(
      (activity) => activity.runId === run.id && activity.edgeId === edge?.id
    );
  });
}

function processLabel(state: TerminalSession["state"] | "stopped"): string {
  const labels: Record<string, string> = {
    idle: "Parado",
    starting: "Iniciando",
    running: "Executando",
    "waiting-input": "Aguardando entrada",
    stopping: "Encerrando",
    stopped: "Parado",
    completed: "Concluído",
    failed: "Falhou",
    disconnected: "Desconectado"
  };
  return labels[state] ?? state;
}

function policyDescription(policyId: ExecutionPolicyId): string {
  const policy = EXECUTION_POLICIES[policyId];
  const workers = AUTONOMY_WORKER_BUDGETS[policyId];
  if (policyId === "economy")
    return `Planeja até ${workers} worker e reutiliza contexto; teto operacional de ${policy.maxConcurrentAgents} processos.`;
  if (policyId === "standard")
    return `Planeja até ${workers} workers, permitindo Builder + Reviewer quando necessário.`;
  return `Planeja até ${workers} workers especializados, sem criar funções apenas para ocupar capacidade.`;
}

function formatTime(value: string | undefined): string {
  if (value === undefined) return "Sem atividade";
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function matchesEventFilter(type: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "agents") return type.startsWith("agent.") || type.startsWith("role.");
  if (filter === "tasks") return type.startsWith("task.");
  if (filter === "errors")
    return (
      type.includes("failed") || type.includes("attention") || type.includes("recovery-required")
    );
  if (filter === "notes") return type.startsWith("note.");
  return type.startsWith("edge.");
}

function eventLabel(type: string): string {
  const labels: Readonly<Record<string, string>> = {
    "run.created": "Orquestrador criou a execução",
    "run.started": "Execução iniciada",
    "run.paused": "Execução pausada",
    "run.resumed": "Execução retomada",
    "run.completed": "Equipe concluiu a execução",
    "run.failed": "Execução falhou",
    "run.cancelled": "Execução cancelada",
    "run.recovery-required": "Recuperação necessária após encerramento",
    "agent.recruited": "Agente recrutado",
    "agent.dismissed": "Agente dispensado",
    "agent.failed": "Agente falhou",
    "role.assigned": "Responsabilidade atribuída",
    "task.created": "Tarefa criada",
    "task.assigned": "Tarefa atribuída",
    "task.started": "Tarefa iniciada",
    "task.completed": "Tarefa concluída",
    "task.failed": "Tarefa falhou",
    "task.retried": "Nova tentativa iniciada",
    "task.reassigned": "Tarefa reatribuída",
    "task.cancelled": "Tarefa cancelada",
    "edge.created": "Conexão criada",
    "edge.activity": "Conexão teve atividade",
    "note.created": "Nota criada",
    "note.updated": "Nota atualizada",
    "attention.created": "Atenção solicitada",
    "attention.resolved": "Atenção resolvida",
    "attention.dismissed": "Atenção dispensada",
    "policy.changed": "Política de execução alterada",
    "layout.organized": "Equipe organizada no canvas",
    "recovery.performed": "Ação de recuperação executada"
  };
  return labels[type] ?? type;
}
