# Fechamento da Onda 5A — Claude Compazio → Codex (2026-08-01)

`TerminalNode.isCompazio` é o estado canônico. Ao criar ou promover um terminal Claude Code, o
lifecycle do workspace revoga qualquer sessão MCP anterior, inicia uma sessão nova de processo e
deriva as capabilities de Compazio antes de entregar o prompt. A promoção não reutiliza token,
configuração temporária ou transporte; a despromoção repete a rotação sem as tools administrativas.

O fluxo real validado nesta máquina foi deliberadamente pequeno e não abriu caminho de shell:

1. Claude Code 2.1.220 negociou MCP `2025-11-25`, descobriu `team_recruit` e recrutou um único
   Codex real;
2. o coordenador persistiu membro, papel, conexão, tarefa inicial e entrega;
3. Codex concluiu `task_status` e devolveu resultado estruturado por `task_result`;
4. Claude consultou `team_status`, `task_status`, `task_result` e `message_list`;
5. Claude chamou `team_dismiss`; o processo recrutado, as conexões e as sessões efêmeras foram
   removidos, enquanto membro, tarefa, mensagem e resultado permanecem no histórico.

O cliente Claude recebeu somente a allowlist MCP `team_recruit`, `team_status`, `team_list`,
`team_dismiss`, `task_status`, `task_result` e `message_list`, com Bash, filesystem, Git e browser
externo bloqueados. `ToolSearch` interno pode aparecer somente para localizar uma ferramenta MCP;
ele não concede nem executa shell.

O harness usa diretório temporário de prefixo controlado, encerra cada árvore de processo que criou
em timeout e falha se gateway, transports, sessões MCP ou sessões do supervisor permanecerem ativos.
O token fica somente no ambiente do processo filho e nunca é persistido ou emitido nos logs.

# Compazio V2 — Compazio e equipes

## Fluxo

`Compazio` é a apresentação da capacidade persistida `TerminalNode.orchestrator`. Ao iniciar um
terminal Claude Code ou Codex, o Compazio cria automaticamente uma sessão MCP efêmera e injeta
somente as ferramentas permitidas pelo canvas. URL, token, protocolo e arquivo de configuração
ficam no processo principal e nunca são exibidos na interface nem persistidos.

O caminho de execução é único para MCP e para a CLI de diagnóstico:

`MCP/CLI → TeamCoordinator → WorkspaceService/ProcessSupervisor → adapter`

O Compazio não inicia processos nem escreve diretamente no terminal de outro agente. Recrutamento,
conexão, tarefas e entrega passam pelo `TeamCoordinator`; a entrega usa o `AgentMessageBus`
persistente antes de alcançar o stdin suportado pelo adapter.

## Permissões

Uma sessão Compazio recebe `team-admin`, `team-read`, `task-read`, `task-update`, `message-send` e
`context-read`. Um recruta recebe apenas leitura/atualização de sua tarefa, mensagens e contexto
quando há conexão no canvas. Toda chamada MCP é revalidada contra workspace, terminal e aresta.
Ser Compazio não concede acesso a Portais, arquivos, Git ou outros workspaces.

As conexões usam as capacidades existentes `send-message` e `share-context`, e podem declarar
`task-delegate`, `result-return` e `review-request`. Remover a aresta impede novas entregas; o
histórico já entregue permanece auditável.

## Persistência e recuperação

O estado operacional passou para schema 2. Ele acrescenta `teamMembers`, `teamTasks` e `messages`.
A migração de schema 1 preserva runs, tarefas e eventos da Fase 4 e inicia os novos arrays vazios.
Nenhum processo, PTY, token MCP, listener ou operação pendente é serializado. Ao reabrir, o canvas
e o histórico reaparecem, mas sessões antigas não são retomadas como ativas.

## Ferramentas MCP

O gateway registra ferramentas de equipe, tarefas, mensagens, canvas e contexto conforme a sessão:

- `team_recruit`, `team_connect`, `team_assign_role`, `team_dismiss`;
- `task_create`, `task_assign`, `task_start`, `task_update`, `task_complete`, `task_fail`;
- `message_send`, `message_reply`, `message_acknowledge`;
- consultas de equipe/contexto e ações explícitas de canvas.

Todas usam schemas estritos, `correlationId` do gateway, limites de payload e erros estruturados.
`evaluate`, shell, Electron, tokens e filesystem genérico não são expostos.

## Limitações desta entrega

Esta fatia valida um único recrutado por Compazio e os dois pares reais Claude↔Codex em workspaces
temporários. Não há fallback por Bash; se um provider não responder, o resultado deve ser
registrado como bloqueio externo, não como sucesso do Compazio. Equipes múltiplas, recrutamento em
profundidade e OpenCode ficam fora da Onda 5B.

## Recrutamento bidirecional (Onda 5B)

O coordenador resolve uma estratégia interna para cada adapter aprovado. Nesta etapa, os pares
reais suportados são `Claude Code Compazio → Codex` e `Codex Compazio → Claude Code`; ambos usam o
mesmo `team_recruit`, `TeamMember`, `TeamTask`, `TeamMessage`, conexão e dismissal. O tipo do
Compazio não dá acesso extra e não limita o tipo do integrante recrutado.

Uma sessão Codex marcada como Compazio descobre as mesmas dez ferramentas de equipe que uma sessão
Claude Compazio. Um Codex comum continua sem `team-recruit`. O Claude recrutado recebe papel e
tarefa pelo adapter de produção e somente as capacidades de worker (`task_status`, `task_result`,
`message_send` e `message_list`). Resultado e mensagens são persistidos antes de serem exibidos ao
Compazio; a dispensa preserva o histórico, mas revoga sessão MCP, processo e aresta.

O harness real executado nesta máquina confirmou o caminho Codex 0.144.6 → Claude Code 2.1.220
sem shell, filesystem, Git ou browser externo: `team_recruit`, `task_status`, `task_result`,
`team_status`, `message_list` e `team_dismiss` foram chamados por MCP e seus efeitos foram lidos
do estado persistido. A regressão real Claude → Codex continua aprovada pelo mesmo harness.
