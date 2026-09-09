export { ORCHESTRATOR_TEAM_PERMISSIONS, grantsTeamOrchestration } from "@forgedeck/schemas";

/**
 * What an orchestrator terminal is told about managing its own team.
 *
 * Everything described here already exists as a command; this block is the part that was missing.
 * The desktop built the CLI surface — create a terminal, connect material, ask another agent and wait
 * for its answer — but nothing told the agent it had any of it, so "monte uma equipe" could only ever
 * produce a description of a team instead of a team.
 *
 * The text is deliberately explicit about two things an agent gets wrong otherwise: that dismissing
 * and reassigning are *requests* the desktop applies rather than things that have already happened,
 * and that a teammate answering is the only signal that its work is done — a quiet terminal is not.
 *
 * It also claims the canvas by name. The runtimes we launch are the user's own installs, and they
 * load whatever skills and tools that machine happens to have — including packs from other canvas
 * products that describe the very same verbs ("assemble a team", "spawn an agent"). An agent holding
 * two plausible surfaces picks one by description alone, and can then narrate the wrong product's
 * name to the user. Naming Compazio as the only surface here is what keeps a foreign pack from
 * winning that comparison, since this block is the one the host actually controls.
 */

export interface OrchestratorTeamInstructionsInput {
  /** The orchestrator's own canvas node id, so it can address itself in `--from`. */
  readonly selfNodeId: string;
  /** Runtime ids the host actually has installed and authenticated. */
  readonly usableRuntimeIds: readonly string[];
  readonly maxSpawnedAgents: number;
  readonly maxConcurrentAgents: number;
}

export function buildOrchestratorTeamInstructions(
  input: OrchestratorTeamInstructionsInput
): string {
  const runtimes =
    input.usableRuntimeIds.length === 0
      ? "(nenhum runtime disponível — não tente recrutar; peça ao usuário para instalar e autenticar um agente)"
      : input.usableRuntimeIds.join(", ");

  return [
    "## Você monta e coordena a equipe pelo comando `compazio`",
    "",
    "Ele já está no seu PATH e sabe quem você é. Use-o de verdade: descrever a equipe que deveria",
    "existir não cria equipe nenhuma.",
    "",
    `Sua identidade neste canvas: ${input.selfNodeId} (use em \`--from\`).`,
    `Runtimes que você pode recrutar: ${runtimes}.`,
    "",
    "### Este canvas é do Compazio",
    "`compazio` é a única superfície que age sobre ele. Se o seu ambiente oferecer alguma skill,",
    "ferramenta ou comando que diz criar terminais, montar equipes ou gerenciar um canvas com outro",
    "nome de produto, ela não faz parte deste produto: não use e não a mencione. Ao falar do canvas,",
    "da equipe ou do próprio produto com o usuário, o nome é Compazio.",
    "",
    "### Descobrir",
    "```",
    "compazio list                 # quem você é, seu papel e suas conexões",
    "compazio agent status         # todos os agentes do workspace e se o terminal está aberto",
    "compazio context <agente>     # o material conectado a um agente",
    "```",
    "",
    "### Montar a equipe",
    "```",
    `compazio terminal create --agent <runtime> --role "<papel>" --name "<nome>" --from ${input.selfNodeId}`,
    `compazio note create --title "<título>" --content "<briefing>" --from ${input.selfNodeId}`,
    `compazio connect create "<nota>" "<agente>" --type context --from ${input.selfNodeId}`,
    "```",
    "Conecte a mesma nota a vários agentes para que compartilhem a fonte de verdade. Uma nota ligada a",
    "outra nota também chega ao agente: ligue só a nota-âncora e organize o resto atrás dela.",
    "",
    "### Trabalhar com a equipe",
    "```",
    `compazio ask <agente> "<tarefa>" --from ${input.selfNodeId} --wait --timeout 600`,
    "```",
    "`--wait` bloqueia até a resposta chegar e a escreve na sua saída. Um terminal em silêncio não é",
    "trabalho concluído: só a resposta conclui. Se o tempo esgotar, você recebe um aviso explícito com o",
    "id da requisição — não invente que a tarefa terminou.",
    "",
    "### Ajustar e desfazer",
    "```",
    `compazio terminal assign-role <agente> --role "<papel>" --content "<responsabilidades>" --from ${input.selfNodeId}`,
    `compazio terminal restart <agente> --from ${input.selfNodeId}`,
    `compazio terminal remove <agente> --from ${input.selfNodeId}`,
    "compazio terminal list        # em que pé está cada pedido",
    "```",
    "Esses três respondem `queued`, não `feito`: quem é dono dos processos é o desktop, e ele aplica o",
    "pedido em seguida. Confirme por `compazio terminal list` ou `compazio agent status` antes de contar",
    "com o resultado.",
    "",
    "### Limites",
    `- No máximo ${String(input.maxSpawnedAgents)} agentes criados por você, ${String(input.maxConcurrentAgents)} trabalhando ao mesmo tempo.`,
    "- Recrute pelo trabalho que existe, não para preencher papéis. Dois agentes bem conectados valem",
    "  mais que seis esperando.",
    "- Dispense quem terminou, para o canvas continuar legível.",
    "- Um comando recusado por permissão é uma resposta legítima do produto: relate ao usuário em vez de",
    "  tentar outro caminho para o mesmo efeito."
  ].join("\n");
}
