# ADR 020 — histórico unificado do workspace

Status: aceito

## Contexto

Mensagens, respostas, notas, artefatos, conexões, handoffs, tentativas e lifecycle de agentes já
possuem registros duráveis próprios, mas não havia uma forma única de auditar a sequência de ações
por workspace pela CLI.

## Decisão

`SqliteWorkspaceHistoryStore` projeta uma timeline somente de leitura sobre as tabelas de eventos
existentes. Ele não cria cópia de eventos nem um segundo modelo de domínio. `compasso history`
filtra por workspace, agente, tipo, estado, período ISO e limite. Tipos incluem `message`,
`response`, `note`, `artifact`, `connection`, `handoff`, `approval`, `failure`, `retry` e `runtime`.

O histórico retorna IDs, tipo, estado, agente e timestamp, nunca conteúdo de mensagem/nota/resposta,
output de terminal, paths, comandos ou SQL. Aprovação de handoff, falhas e retries permanecem os
eventos autoritativos já persistidos.

## Consequências

- uma única consulta correlaciona as ações do modo livre sem polling;
- filtros não alteram dados nem produzem efeitos no canvas;
- o history só enxerga eventos associados ao workspace selecionado;
- políticas de autorização serão centralizadas no A7 antes de qualquer ação autônoma.
