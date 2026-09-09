# ADR 032 â€” Controles de workflow pertencem ao runtime desktop

## Contexto

O Modo Livre precisa iniciar e controlar workflows pela CLI e pelo canvas sem
criar um segundo scheduler no cliente de linha de comando. A CLI não pode
transportar comandos arbitrários, executáveis, diretórios de trabalho ou JSON
de workflow para o processo desktop.

## Decisão

- O desktop instancia a única `WorkflowRunRuntime` por processo local e a
  conecta ao `CompassoRuntime` já responsável pelo ciclo de vida do projeto.
- CLI e renderer aceitam somente IDs de templates confiáveis, IDs de run, IDs
  de nó e uma nota curta de aprovação. As estruturas são validadas por schemas
  estritos antes do IPC ou da fila persistida.
- A CLI autentica o runtime local existente e registra uma solicitação tipada
  em `workflow_run_commands`; o dispatcher do desktop é o único consumidor.
- Cada solicitação gera eventos de pedido, aplicação ou falha. Após restart,
  uma solicitação que estava sendo aplicada é marcada como falha e nunca é
  repetida automaticamente.
- `retry` inicia uma nova run com o snapshot de definição e permissões
  persistido, preservando a run e suas evidências anteriores.
- O primeiro template executável é `delivery-report`, que não invoca processo
  externo. Templates que dependem de executores ainda indisponíveis falham de
  forma explícita, sem fallback para shell arbitrário.

## Consequências

O runtime, e não a CLI ou o renderer, decide como um template confiável será
executado. Isso torna o controle recuperável e auditável, mas mantém o suporte
a executores de agente, shell, qualidade, handoff e worktree como incrementos
separados e explicitamente autorizados.
