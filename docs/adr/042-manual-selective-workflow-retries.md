# ADR 042 - retries seletivos e alternativas manuais de workflow

## Contexto

Uma nova execucao completa era possivel, mas nao havia uma forma auditavel de repetir apenas a
parte relevante de um DAG nem de manter duas alternativas em paralelo sem perder sua proveniencia.
Copiar estado de um no anterior como entrada de uma nova execucao ocultaria dependencias e poderia
reutilizar contexto desatualizado.

## Decisao

- `compasso run retry <run-id> <node-id> --rerun-scope node` cria uma nova run com o no escolhido e
  todas as suas dependencias transitivas. O escopo `dependents` inclui tambem todos os descendentes
  e as dependencias necessarias para eles.
- `compasso run alternative <run-id> <node-id> [--alternative-label <label>]` cria uma ramificacao
  manual com o escopo `dependents`. Duas ou mais solicitacoes desse tipo compartilham um grupo de
  alternativas do run e no de origem e podem ser executadas em paralelo pelo mesmo scheduler.
  `compasso run alternatives <run-id> <node-id>` apenas inspeciona as ramificacoes persistidas.
- A run de origem nunca e alterada. Cada nova run guarda `sourceRunId`, no, escopo, grupo e rotulo
  opcionais no snapshot persistido. A migration 0039 adiciona somente esses metadados e um indice de
  consulta; a 0038 preserva o escopo de retry no comando duravel.
- CLI e renderer continuam solicitando apenas IDs, escopo fechado e rotulo curto. O desktop-owned
  runtime continua sendo o unico consumidor da fila e o unico que cria workflow, contexto e worktree.
  Nenhum caminho, comando, executavel, SQL ou JSON de workflow cruza essa fronteira.

## Consequencias

O usuario pode comparar alternativas por seus relatorios e artefatos sem merge, substituicao de
bytes ou decisao automatica. Cada solicitacao e auditavel na fila de controles e cada run conserva
seu snapshot imutavel. A alternativa nao cria um orquestrador, nao amplia permissoes e nao agenda
novas tentativas sem uma solicitacao manual.
