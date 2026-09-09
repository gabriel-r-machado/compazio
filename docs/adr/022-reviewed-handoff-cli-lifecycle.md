# ADR 022 — lifecycle revisável de handoff na CLI

Status: aceito

## Contexto

O canvas já persiste rascunhos, aprovações, tentativas e recuperação de handoffs. A CLI conseguia
criar e consultar rascunhos, mas não podia concluir uma revisão auditável sem recorrer à interface
gráfica.

## Decisão

`compasso handoff` passa a expor `list`, `show`, `history`, `approve`, `reject`, `cancel` e `retry`
sobre o mesmo `canvas_handoffs` e `canvas_handoff_events` usados pelo desktop. Aprovar transita de
`draft` para `ready`; rejeitar transita de `draft` para `rejected` e grava `handoff_rejected`; retry
de uma rejeição volta somente a `draft`. Retry de falha, cancelamento ou estado incerto volta a
`ready`, mas não seleciona sessão nem submete conteúdo ao terminal.

Para ações atribuídas a um agente, `--from` requer `approve_deliveries`; a criação continua exigindo
`create_handoffs`. O usuário local pode revisar sem `--from`. Toda mutação verifica a revisão
otimista e gera evento persistido; a timeline unificada classifica aprovações e rejeições como
`approval` e retries como `retry`.

## Consequências

- não há entrega automática, PTY write ou seleção implícita de destino pela CLI;
- rejeitar não apaga o rascunho nem as evidências;
- uma rejeição precisa de novo ciclo explícito de revisão antes de ficar `ready`;
- chamadas concorrentes recebem conflito de revisão em vez de sobrescrever decisão anterior.
