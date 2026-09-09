# Execuções de orquestração do Compazio V2

Uma execução pertence a um workspace e a um terminal com
`orchestrator: true`. Não há modo automático, chat ou workflow separado. A
execução nasce quando esse terminal realiza a primeira ação administrativa pela
Bridge e usa a política vigente naquele instante.

## Estado

`created → planning → running` é a abertura normal. Uma execução em andamento
pode alternar entre `running`, `waiting`, `needs-attention` e `paused`.
`completed`, `failed` e `cancelled` são estados terminais. Transições inválidas
geram `ORCHESTRATION_INVALID_TRANSITION` com correlation ID.

Processo, tarefa e execução permanecem separados:

- a sessão do terminal descreve o processo local;
- `OrchestrationTask` descreve trabalho e tentativas;
- `OrchestrationRun` agrega equipe, tarefas, política e resultado.

## Controle

Pausar bloqueia novos recrutas e novas tarefas, sem matar terminais. Retomar
restabelece ações administrativas. Cancelar preserva eventos, notas e arquivos,
marca tarefas pendentes/ativas e aceita as estratégias de manutenção da equipe
expostas pela interface.

Desativar a capacidade de Orquestrador preserva equipe e histórico. Se houver
execução ativa, a interface pausa primeiro e explica o efeito.

## Persistência e reabertura

O estado operacional é armazenado separadamente do documento do canvas.
Processos, handles, listeners e tokens nunca são serializados. Na reabertura,
execuções que pareciam ativas tornam-se `needs-attention` com
`RUN_RECOVERY_REQUIRED`; o produto não finge que processos sobreviveram.

As opções são retomar, reiniciar agentes, encerrar a execução ou manter apenas o
canvas. Excluir equipe encerra e remove terminais recrutados, arestas, sessões e
todo o estado operacional associado à execução.
