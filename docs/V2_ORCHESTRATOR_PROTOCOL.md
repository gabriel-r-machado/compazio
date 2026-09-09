# Protocolo do Orquestrador V2

Este é o contrato da CLI privada `compazio` injetada somente em uma sessão com
`TerminalNode.orchestrator: true`.

| Comando | Efeito |
| --- | --- |
| `compazio me` | Retorna a identidade da sessão, política do workspace, agentes e responsabilidades disponíveis. |
| `compazio list` | Retorna nós, sessões e conexões do workspace sem incluir conteúdo de notas. |
| `compazio recruit --agent <id> [--role <id>] [--title <texto>]` | Cria, inicia e conecta um novo terminal. Se o launch falhar, remove o nó criado. |
| `compazio connect <node-id> [--capabilities ...]` | Cria uma conexão dirigida do orquestrador com capacidades explícitas. |
| `compazio connect <source-node-id> <target-node-id> [--capabilities ...]` | Conecta um recruta já conectado ao orquestrador, por exemplo a uma nota de briefing. |
| `compazio assign-role <terminal-id> <role-id>` | Troca a responsabilidade de um terminal conectado e o reinicia se estiver ativo. |
| `compazio send <terminal-id> <texto> [--wait] [--timeout <ms>]` | Escreve uma tarefa num terminal conectado. Com `--wait`, observa o lifecycle do processo. |
| `compazio wait <task-id ou terminal-id> [--timeout <ms>]` | Aguarda uma tarefa previamente enviada pelo mesmo orquestrador. |
| `compazio note read <note-id>` | Lê uma nota conectada com `read-note`. |
| `compazio note write <note-id> <texto>` | Atualiza uma nota conectada com `write-note`. |
| `compazio dismiss <terminal-id>` | Para e remove um terminal conectado; não permite dispensar o próprio orquestrador. |
| `compazio notify <texto> [--title <texto>]` | Pede uma notificação local. |

Capacidades permitidas em uma conexão:

- `send-message`
- `read-note`
- `write-note`
- `share-context`

Os comandos retornam JSON em stdout e erros amigáveis em stderr. A bridge não aceita string de comando
crua: cada argumento é enviado separadamente para o endpoint local autenticado. IDs são obtidos em
`compazio list`; não devem ser adivinhados.

Para CLIs conhecidas (Claude Code, Codex e OpenCode), o Compazio também envia uma instrução inicial
para ler `COMPAZIO_ORCHESTRATOR_PROTOCOL`. Para shell e comando personalizado o protocolo permanece
disponível por ambiente, sem escrever texto de produto em stdin arbitrariamente.

Um recruta criado por `recruit` recebe token próprio e restrito. Ele pode chamar `compazio note read`
somente quando existe uma conexão dirigida dele para a nota com `read-note`; não pode listar o canvas,
recrutar, enviar tarefas, editar notas ou controlar terminais.
