import { executionProfileConfig, isRuntimeUsable } from "@forgedeck/schemas";
import type {
  AgentRuntimeCapability,
  CanvasSnapshot,
  ExecutionProfile,
  ExecutionProfileConfig
} from "@forgedeck/schemas";

import { buildOrchestratorTeamInstructions } from "./orchestrator-team-instructions";
import { COMPASSO_DRAFT_LINE_PREFIX } from "./orchestrator-wire";

/**
 * Builds the real input handed to a CLI orchestrator session (Claude Code / Codex / OpenCode) when
 * automatic mode starts. This is the boundary the spec mandates: the Compazio desktop owns NO planner
 * of its own — it hands the user's objective, the live canvas snapshot, the detected runtimes and the
 * execution policy to the user's own agent, and that agent composes a workflow draft by emitting
 * machine-readable actions on the wire protocol.
 *
 * The builder is pure and deliberately never emits a team, roles or a fixed workflow: the plan is the
 * agent's job. That is why different objectives produce different session input and there is no silent
 * generic fallback. It offers only runtimes that are actually installed, authenticated and enabled.
 */

/** Global safety ceiling (spec §16.1). The agent must plan within these regardless of profile. */
export const ORCHESTRATOR_GLOBAL_LIMITS = Object.freeze({
  maxConcurrentAgents: 3,
  maxSpawnedAgents: 6,
  maxRetriesPerNode: 2,
  maxRuntimeMinutes: 120,
  maxIdleMinutes: 10
});
export type OrchestratorGlobalLimits = typeof ORCHESTRATOR_GLOBAL_LIMITS;

/** Capabilities denied unless a human approves them (spec §16.2). */
export const ORCHESTRATOR_DENIED_BY_DEFAULT = Object.freeze({
  allowNetwork: false,
  allowDependencyInstall: false,
  allowExternalPaths: false,
  allowGitPush: false,
  allowMerge: false,
  allowDeploy: false
});
export type OrchestratorDeniedByDefault = typeof ORCHESTRATOR_DENIED_BY_DEFAULT;

/** What the orchestrator session is authorized to do (spec §12.4). Defaults to draft-only. */
export interface OrchestratorSessionCapabilities {
  readonly composeDraft: boolean;
  readonly createAgentDraft: boolean;
  readonly requestUserInput: boolean;
}

const DEFAULT_SESSION_CAPABILITIES: OrchestratorSessionCapabilities = {
  composeDraft: true,
  createAgentDraft: true,
  requestUserInput: true
};

export interface OrchestratorPromptInput {
  /** The user's plain-language objective, sent verbatim to the session. */
  readonly objective: string;
  /** The live canvas so the agent produces a delta, never a blind rebuild (spec §6.3/§6.4). */
  readonly canvas: CanvasSnapshot;
  /** Real runtime discovery. Only usable entries are offered; unusable ones are hidden. */
  readonly capabilities: readonly AgentRuntimeCapability[];
  readonly executionProfile: ExecutionProfile;
  readonly sessionCapabilities?: OrchestratorSessionCapabilities;
  /**
   * The orchestrator's own canvas node. Supplying it turns the session into one that manages a real
   * team through the `compazio` command, instead of only composing a draft for the person to
   * approve. Omitted for a draft-only session, which is what an orchestrator without a canvas node
   * of its own can honestly do.
   */
  readonly selfNodeId?: string;
}

/** A runtime the agent is allowed to bind team roles to. */
export interface OrchestratorRuntimeOption {
  readonly runtimeId: string;
  readonly provider: AgentRuntimeCapability["provider"];
  readonly displayName: string;
}

export interface OrchestratorPrompt {
  /** Stable skill/contract text: role, wire protocol, ghost semantics, limits, deny-by-default. */
  readonly skillInstructions: string;
  /** How to manage a real team with the CLI. Absent when the session has no canvas node of its own. */
  readonly teamInstructions: string | null;
  /** The variable message: the objective plus a summary of the current canvas. */
  readonly objectiveMessage: string;
  /** Detected, usable runtimes the agent may assign roles to. */
  readonly usableRuntimes: readonly OrchestratorRuntimeOption[];
  /** The execution policy for the chosen profile the agent must respect. */
  readonly executionPolicy: ExecutionProfileConfig;
}

export function buildOrchestratorPrompt(input: OrchestratorPromptInput): OrchestratorPrompt {
  const objective = input.objective.trim();
  if (objective.length === 0) {
    // Never fabricate a plan from an empty objective — fail loudly (spec §18.3).
    throw new Error("An orchestrator prompt requires a non-empty objective.");
  }
  const sessionCapabilities = input.sessionCapabilities ?? DEFAULT_SESSION_CAPABILITIES;
  const usableRuntimes = input.capabilities
    .filter(isRuntimeUsable)
    .map((entry): OrchestratorRuntimeOption => ({
      runtimeId: entry.runtimeId,
      provider: entry.provider,
      displayName: entry.displayName
    }));
  const executionPolicy = executionProfileConfig(input.executionProfile);

  return {
    skillInstructions: renderSkillInstructions(sessionCapabilities),
    teamInstructions:
      input.selfNodeId === undefined
        ? null
        : buildOrchestratorTeamInstructions({
            selfNodeId: input.selfNodeId,
            usableRuntimeIds: usableRuntimes.map((runtime) => runtime.runtimeId),
            maxSpawnedAgents: ORCHESTRATOR_GLOBAL_LIMITS.maxSpawnedAgents,
            maxConcurrentAgents: ORCHESTRATOR_GLOBAL_LIMITS.maxConcurrentAgents
          }),
    objectiveMessage: renderObjectiveMessage(objective, input.canvas),
    usableRuntimes,
    executionPolicy
  };
}

/** Renders the full text written to the orchestrator PTY session. */
export function renderOrchestratorPrompt(prompt: OrchestratorPrompt): string {
  const runtimes =
    prompt.usableRuntimes.length === 0
      ? "Nenhum runtime disponível. Pause e peça ao usuário para instalar/autenticar um agente."
      : prompt.usableRuntimes
          .map((entry) => `- ${entry.displayName} (id: ${entry.runtimeId})`)
          .join("\n");

  const policy = prompt.executionPolicy;
  return [
    prompt.skillInstructions,
    ...(prompt.teamInstructions === null ? [] : ["", prompt.teamInstructions]),
    "",
    "## Runtimes disponíveis (use somente estes)",
    runtimes,
    "",
    "## Política de execução do perfil",
    `- Paralelismo padrão: ${policy.defaultParallelism} (máx ${policy.maxParallelism})`,
    `- Retries por tarefa: ${policy.maxRetries}`,
    `- Estratégia de contexto: ${policy.contextStrategy}`,
    `- Profundidade de revisão: ${policy.reviewDepth}`,
    "",
    "## Limites globais (invioláveis)",
    `- Máx. agentes simultâneos: ${ORCHESTRATOR_GLOBAL_LIMITS.maxConcurrentAgents}`,
    `- Máx. agentes criados: ${ORCHESTRATOR_GLOBAL_LIMITS.maxSpawnedAgents}`,
    `- Máx. retries por nó: ${ORCHESTRATOR_GLOBAL_LIMITS.maxRetriesPerNode}`,
    "",
    "## Objetivo do usuário",
    prompt.objectiveMessage
  ].join("\n");
}

function renderSkillInstructions(capabilities: OrchestratorSessionCapabilities): string {
  return [
    "Você é o Orquestrador de Workflow do Compazio para este canvas.",
    "O Compazio não tem IA própria: a inteligência de planejamento é sua.",
    "",
    "## Seu trabalho",
    "Leia o objetivo e o estado atual do canvas e DECIDA você mesmo:",
    "- se precisa de uma equipe e de quantos agentes;",
    "- os papéis, responsabilidades e critérios de aceite;",
    "- a divisão de tarefas, dependências, ordem e paralelismo.",
    "Não existe equipe ou workflow pré-definido. Não use um template fixo.",
    "Objetivos diferentes devem produzir planos coerentemente diferentes.",
    "Agentes, funções, notas, materiais e conexões já presentes no canvas são escolhas do usuário:",
    "preserve o que for compatível, aproveite o contexto conectado e proponha somente o delta necessário.",
    "Quando a qualidade se beneficiar de especialização, divida o trabalho entre funções focadas e faça",
    "a integração/revisão final explícita em vez de entregar toda a implementação a um único agente genérico.",
    "",
    "## Rascunho transacional (nada executa enquanto você planeja)",
    "Você compõe um RASCUNHO. Os nós aparecem como ghost nodes no canvas do usuário.",
    "Enquanto planeja: nenhum worker inicia, nenhum arquivo é alterado, nenhum comando roda.",
    "O usuário revisa e só então aprova. A aprovação é que inicia os workers, não você.",
    "Você coordena; você NÃO implementa a missão principal.",
    "",
    "## Entrega obrigatória para o Compazio",
    "Quando o plano estiver pronto, entregue SOMENTE comandos de composição: uma linha por comando,",
    `cada uma iniciando exatamente por ${COMPASSO_DRAFT_LINE_PREFIX} seguido de um objeto JSON estrito na mesma linha.`,
    "Não use Markdown, bloco de código, tabela ou texto entre os comandos. Não repita este enunciado.",
    "Uma linha sem JSON válido após o prefixo é ignorada pelo Compazio.",
    "A sequência obrigatória é: start_workflow_draft, um ou mais add_draft_node,",
    "connect_draft_nodes para cada dependência, handoff ou revisão necessária e finalize_workflow_draft por último.",
    "start_workflow_draft exige objective e pode receber title. add_draft_node exige ref (slug minúsculo),",
    "title e role; use objective, responsibilities, expectedOutputs e acceptanceCriteria para tornar cada",
    "tarefa específica ao pedido do usuário. Roles válidos: planner, researcher, strategist, designer,",
    "implementer, reviewer, qa, security ou custom.",
    "Não invente uma equipe genérica: os títulos, entregáveis e critérios devem refletir este objetivo.",
    "Para usar um agente específico, inclua runtimeRequirement com strategy fixed e fixedRuntimeId igual",
    "a um id da lista de runtimes disponíveis. Nunca nomeie um runtime fora dessa lista.",
    "",
    "## Limites e segurança",
    "Respeite os limites globais e a política de execução informados abaixo.",
    "Negado por padrão até aprovação humana: rede, instalar dependências, caminhos externos,",
    "git push, merge e deploy. Em ambiguidade material, credencial, conflito ou limite: pause.",
    "",
    "## Capacidades desta sessão",
    `- Compor rascunho: ${capabilities.composeDraft ? "sim" : "não"}`,
    `- Criar nós de agente no rascunho: ${capabilities.createAgentDraft ? "sim" : "não"}`,
    `- Pedir decisão ao usuário: ${capabilities.requestUserInput ? "sim" : "não"}`
  ].join("\n");
}

function renderObjectiveMessage(objective: string, canvas: CanvasSnapshot): string {
  const summary = summarizeCanvas(canvas);
  return summary.length === 0 ? objective : `${objective}\n\n## Estado atual do canvas\n${summary}`;
}

/** A compact, human-readable summary of what already exists, so the agent builds a delta. */
function summarizeCanvas(canvas: CanvasSnapshot): string {
  if (canvas.nodes.length === 0 && canvas.mission === undefined) {
    return "";
  }
  const nodeLines = canvas.nodes.map((node) => {
    const role = node.data.role;
    const context = nodeContext(node);
    return [
      `- id=${node.id} [${node.type}] ${compact(node.data.title, 160)}`,
      node.data.adapterId === undefined ? "" : `agente=${node.data.adapterId}`,
      role === undefined ? "" : `função=${compact(role.name, 80)}`,
      role?.responsibilities.trim()
        ? `responsabilidades=${compact(role.responsibilities, 600)}`
        : "",
      role?.expectedDeliverable.trim() ? `entrega=${compact(role.expectedDeliverable, 400)}` : "",
      context
    ]
      .filter((value) => value.length > 0)
      .join(" | ");
  });
  const edgeLines = canvas.edges.map((edge) => {
    const details = [
      edge.contract.label,
      edge.contract.sourceDeliverable,
      edge.contract.targetInstruction
    ]
      .filter((value): value is string => value !== undefined && value.trim().length > 0)
      .map((value) => compact(value, 240))
      .join(" · ");
    return `- ${edge.source} -> ${edge.target} [${edge.contract.kind}]${
      details.length === 0 ? "" : ` ${details}`
    }`;
  });
  return [
    canvas.mission === undefined || canvas.mission.trim().length === 0
      ? ""
      : `Missão salva: ${compact(canvas.mission, 1_000)}`,
    nodeLines.length === 0 ? "" : `Nós existentes:\n${nodeLines.join("\n")}`,
    edgeLines.length === 0 ? "" : `Conexões existentes:\n${edgeLines.join("\n")}`
  ]
    .filter((value) => value.length > 0)
    .join("\n")
    .slice(0, 12_000);
}

function nodeContext(node: CanvasSnapshot["nodes"][number]): string {
  if (node.type === "note") {
    const content = node.data.content ?? node.data.summary;
    return content.trim().length === 0 ? "" : `nota=${compact(content, 1_000)}`;
  }
  const source = node.data.contextSource;
  if (source === undefined) return "";
  if (source.content !== undefined && source.content.trim().length > 0) {
    return `contexto=${compact(source.content, 1_000)}`;
  }
  if (source.url !== undefined) return `url=${compact(source.url, 500)}`;
  if (source.filename !== undefined) return `material=${compact(source.filename, 300)}`;
  return "";
}

function compact(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}
