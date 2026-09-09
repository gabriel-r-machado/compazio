# ADR 023 — Policy Engine local centralizado

Status: aceito

## Contexto

As primeiras superfícies do Modo Livre validavam permissões estruturais diretamente em cada store.
Isso preservava a segurança de cada fluxo, mas permitia mensagens de erro e auditoria divergentes e
deixava o desktop, a CLI e o runtime sem um ponto comum de decisão.

## Decisão

`SqlitePolicyEngine` é o único ponto de autorização para ações de agente. Ele aplica negação por
padrão e aceita somente um nó `agent` ou `terminal` com adapter de agente e a permissão exigida no
snapshot persistido do canvas. O usuário local autenticado é representado por `actorNodeId: null` e
tem suas decisões permitidas também registradas.

As permissões atuais são `send_messages`, `create_notes`, `publish_artifacts`, `create_agents`,
`connect_context`, `create_handoffs`, `approve_deliveries`, `execute_tasks`,
`manage_worktrees` e `merge_changes`. `read_context` permanece apenas como permissão de
compatibilidade para canvases já persistidos. Metadados de permissões desconhecidos nunca são uma
concessão.

Cada consulta ao motor grava uma linha imutável em `policy_decisions` com workspace, canvas, ator,
permissão, resultado, código técnico de motivo e timestamp. O registro não contém conteúdo de
mensagens, paths, comandos, executáveis ou SQL. A API pública não expõe operação de conceder ou
alterar permissões; em especial, um agente não pode ampliar as próprias permissões.

Os stores de mensagens, notas, artefatos, conexões, contexto, spawn e handoff chamam esse motor
antes de mutar estado. O fluxo de handoff iniciado pelo desktop também recebe a mesma dependência,
em vez de fazer uma verificação paralela.

## Consequências

- autorizações aprovadas e negadas são auditáveis com a mesma taxonomia;
- `--from` continua sendo uma identidade estrutural local, não uma identidade criptográfica do
  processo do agente;
- regras de domínio continuam fora do motor: por exemplo, contexto só pode ser conectado ou lido
  pelo agente destino e ciclos de workflow continuam proibidos;
- as permissões reservadas para execução, worktree e merge estão modeladas desde já, mas não há rota
  de agente que permita concedê-las ou executar essas operações automaticamente.
