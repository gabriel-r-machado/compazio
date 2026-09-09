# ADR 021 — controle manual da inbox de agentes

Status: aceito

## Contexto

Mensagens entre agentes já são registros duráveis no SQLite e o dispatcher só entrega itens em
`queued` para endpoints ativos. Depois de uma falha ou de um reinício, o usuário precisava de uma
forma explícita de revisar a inbox sem criar uma segunda fila ou repetir entregas automaticamente.

## Decisão

O registro em `agent_messages` continua sendo a única fonte de verdade. A inbox filtra esse mesmo
registro por workspace e agente. `cancel` só transita `queued` para `cancelled`; `retry` só retorna
`failed`, `delivery_unknown` ou `cancelled` para `queued`, mantendo o ID e a chave idempotente
originais. Cada transição escreve um evento durável em `agent_message_events`.

A CLI fornece `compasso inbox <agent>` e `compasso message <cancel|retry> <message-id>`. O desktop
acessa a inbox por três canais IPC estritos, sempre com `workspaceId`; o main process confirma que a
mensagem pertence ao workspace antes de qualquer mutação. O renderer nunca recebe comandos, paths,
executáveis, SQL ou controle direto de sessão.

## Consequências

- uma recuperação não reentrega mensagens incertas sozinha;
- retry é uma decisão humana auditável e não cria um segundo registro;
- cancelamento não vence a transição atômica para `delivering`;
- a UI mostra a inbox do agente selecionado e oferece apenas as ações válidas para o estado atual;
- eventos ao vivo de ações externas serão centralizados no A8, sem adicionar polling ao renderer.
