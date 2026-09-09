# ADR 015 — Equipes por contrato e caderno persistente por agente

## Status

Superado pelo ADR 016 no caminho ativo. Mantido apenas como contexto histórico e de migração.

## Contexto

O terminal orquestrador expunha tanto ferramentas MCP de TeamRun quanto comandos baixos de
recrutamento. Um agente podia montar integrantes um a um, atingir um limite no meio do fluxo e então
descrever como “equipe criada” uma topologia diferente da solicitada. O terminal de cada worker
também acabava funcionando como canal privado para progresso e perguntas, escondendo informação da
superfície principal do produto.

## Decisão

- todo objetivo acionável usa `team_run_create` como caminho primário, mesmo quando a pessoa não pede
  uma equipe, e persiste integrantes, prompts de tarefa, contexto, dependências e gates antes do
  primeiro recrutamento;
- a política é um orçamento de autonomia: Econômico permite até um worker, Padrão até dois e Alta
  Performance até três; o Compazio escolhe a menor composição suficiente dentro desse teto;
- QA não nasce por disponibilidade de slot: exige `reviewOf`, dependência explícita, integrante
  independente e no máximo uma revisão inicial por entrega;
- falha de provider ou capacidade bloqueia uma TeamRun retomável; não autoriza reutilizar outro
  integrante, eliminar QA independente ou declarar sucesso por texto;
- cada novo integrante recebe uma nota markdown `Caderno — <agente>`, conectada ao integrante e ao
  Compazio com `share-context`, `read-note` e `write-note` antes da tarefa iniciar;
- o caderno guarda progresso verificável, decisões, ações, bloqueios e evidências, não transcrição
  bruta de chat;
- perguntas humanas usam `task_request_user_input` e são respondidas pela superfície do Compazio. O
  card mostra o estado da execução gerenciada; a TUI só abre quando a pessoa escolhe controle manual;
- uma mudança humana durante a missão usa `team_run_instruct`, cria trabalho corretivo durável para o
  integrante afetado e reposiciona a revisão pendente depois desse trabalho.

## Consequências

- o canvas mostra estado e memória operacional de cada agente sem confundir uma TUI ociosa com a
  execução real;
- reload preserva a relação entre integrante e caderno por `notebookNodeId`;
- um recrutamento que falha remove o terminal e o caderno que ainda não chegaram a formar um
  integrante válido;
- comandos baixos de recrutamento continuam disponíveis para recuperação de um único worker, mas
  não são o protocolo de uma missão em equipe.

## Verificação

- integração exige um caderno e as duas conexões para cada recrutamento;
- o protocolo encenado exige TeamRun, recusa fallback silencioso e direciona perguntas ao control
  plane;
- smoke Electron valida que a roda do mouse altera as linhas visíveis do scrollback do xterm sem
  mover ou ampliar o canvas.
