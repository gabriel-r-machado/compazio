import { ORCHESTRATOR_RESULT_CLOSE, ORCHESTRATOR_RESULT_OPEN } from "@forgedeck/schemas";
import type { WorkflowNodeDraft } from "@forgedeck/schemas";

/**
 * Builds the contract a coordinated worker receives when the scheduler dispatches its task (spec §11.3).
 * The worker gets its identity, responsibility, acceptance criteria and — crucially — how to report
 * completion: it must emit a structured {@link TaskResult} inside the `⟦compasso:result⟧` envelope. A
 * terminal going idle is NOT completion; only that result marks the task done (spec §11.4/§20.5.1).
 */

export interface WorkerPromptInput {
  readonly node: WorkflowNodeDraft;
  readonly taskId: string;
  readonly dispatchId: string;
  /** The overall objective, for context — the worker implements only its own task. */
  readonly objective: string;
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const { node } = input;
  const acceptance =
    node.acceptanceCriteria.length === 0
      ? "- (nenhum critério explícito; entregue algo funcional e verificável)"
      : node.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
  const resultExample =
    `${ORCHESTRATOR_RESULT_OPEN}` +
    JSON.stringify({
      taskId: input.taskId,
      dispatchId: input.dispatchId,
      status: "completed",
      summary: "<o que você fez>",
      filesModified: [],
      checksRun: [],
      artifacts: [],
      decisions: [],
      remainingIssues: [],
      completedAt: "<ISO-8601>"
    }) +
    `${ORCHESTRATOR_RESULT_CLOSE}`;

  return [
    `Você é "${node.title}" — um worker coordenado pelo Compazio.`,
    node.objective.length > 0 ? `\nSua tarefa:\n${node.objective}` : "",
    `\nObjetivo geral do projeto (contexto, não implemente o todo):\n${input.objective}`,
    "\nCritérios de aceite:",
    acceptance,
    "\n## Como concluir",
    "Faça o trabalho e, ao terminar, emita EXATAMENTE um resultado estruturado em uma linha,",
    "entre os delimitadores abaixo. Terminal ocioso NÃO conclui a tarefa — só este resultado conclui.",
    "Preserve o taskId e o dispatchId exatamente como recebidos:",
    resultExample,
    `\ntaskId=${input.taskId} dispatchId=${input.dispatchId}`,
    '\nSe ficar bloqueado ou falhar, emita o mesmo envelope com status "blocked" ou "failed" e',
    "descreva o motivo em summary e remainingIssues. Não invente conclusão."
  ]
    .filter((line) => line !== "")
    .join("\n");
}
