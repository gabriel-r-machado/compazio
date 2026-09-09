# Lifecycle de tarefas do Compazio V2

## Estados

O fluxo normal é `queued → assigned → running → completed`. Esperas explícitas
usam `waiting-input` ou `waiting-dependency`. `failed` e `cancelled` encerram a
tentativa corrente.

As transições são centralizadas no domínio e validadas por schema. Uma tarefa
concluída não volta silenciosamente a executar.

## Tentativas

Cada tentativa mantém número, terminal, horários, resultado e falha estruturada.
Retry:

1. exige uma tarefa em `failed`;
2. verifica `maxAttempts`;
3. usa idempotency key;
4. preserva a tentativa anterior;
5. cria nova tentativa e activity;
6. reutiliza ou reinicia a sessão de modo seguro;
7. correlaciona o encerramento real do processo;
8. registra `task.retried` e `recovery.performed`.

A mesma idempotency key retorna a ação original e não duplica tarefa, sessão ou
mensagem. Limite excedido produz `TASK_RETRY_EXHAUSTED`.

## Reatribuição

Reatribuir preserva descrição, dependências, tentativas e resultados anteriores.
O destino pode ser outro agente, o Orquestrador ou execução manual. A decisão
sobre manter ou dispensar o agente anterior é separada. A trilha inclui motivo,
novo terminal, correlation ID e `task.reassigned`.

Timeout não é inferido por regex de saída. Ele vem do timer estruturado da
Bridge/política, registra `TASK_TIMEOUT` e cria uma solicitação de atenção.
