# Capacidades atuais do Compazio

Este documento descreve o produto ativo. Documentos antigos de ondas, TeamRun e coordenação
automática são histórico de engenharia e não descrevem o runtime padrão.

## Núcleo disponível

- canvas local-first persistente com posição, tamanho, grupos, conexões e viewport;
- criação de terminal por clique/atalho ou pelo desenho de um retângulo no canvas;
- terminal visível baseado em xterm e PTY real no Windows (ConPTY/node-pty), com shell, Claude Code,
  Codex, OpenCode e comando personalizado;
- criação transacional na UI: falha de preflight ou spawn remove o nó recém-criado e mostra o erro;
- input com um caminho único `xterm → IPC tipado → workspace service → supervisor → PTY`;
- fila serial de escrita, resize durante start, stop, restart e limpeza da árvore de processos;
- clipboard, seleção, scrollback, wheel, Unicode, ANSI/truecolor e bracketed paste pelo xterm;
- notas como Markdown real em `<projeto>/.compazio/notes/<id>.md`, com replace atômico, backup,
  contenção no workspace e recarga quando uma edição externa é observada;
- árvore de arquivos, previews e Portais existentes, sem expansão de escopo nesta entrega;
- busca/palette por ações, workspaces, terminais, notas e arquivos;
- bootstrap efêmero de coding agents sem alterar autenticação, perfil, sandbox ou approval do usuário;
- Portal MCP apenas quando uma conexão concede capacidade de Portal.

## Conexões reais

Uma conexão é uma concessão explícita:

| Par                 | Capacidades padrão                                         |
| ------------------- | ---------------------------------------------------------- |
| terminal ↔ terminal | mensagens bidirecionais e contexto compartilhado           |
| terminal → nota     | ler, substituir, acrescentar e compartilhar contexto       |
| nota ↔ nota         | encadeamento de contexto                                   |
| terminal → Portal   | leitura, controle, screenshot e contexto, todos explícitos |
| terminal → arquivo  | contexto, sem execução implícita                           |

Cada sessão de Claude Code, Codex ou OpenCode recebe um token efêmero e um CLI `compazio` privado:

```text
compazio me
compazio list
compazio send <destino> "<mensagem>" [--wait] [--timeout <segundos>]
compazio reply <request-id> "<resultado>"
compazio inbox
compazio wait <request-id> [--timeout <segundos>]
compazio note read|write|append <nota> [conteúdo]
```

Requests e respostas são persistidos por workspace com escrita atômica e recuperação por backup.
`send` entrega um único bracketed-paste visível ao PTY do destinatário. Somente `reply` conclui a
solicitação. Output, silêncio, texto específico do provider e encerramento do processo nunca contam
como resposta. Destinos podem ser resolvidos por ID estável, título único ou papel único; notas, por
ID ou título único.

## Restrições intencionais

- Shell e comandos personalizados não recebem mensagens automáticas.
- Um destino parado, ausente, desconectado ou ambíguo falha explicitamente.
- O limite de mensagem/envelope é 32 KiB em UTF-8; respostas têm limite de 64 mil caracteres.
- `--wait` tem timeout finito e termina com código diferente de zero em timeout, falha ou cancelamento.
- Tokens não cruzam o preload/renderer e não são persistidos no workspace.
- O produto não instala, autentica nem paga providers.
- O resultado de `reply` é durável, mas não certifica a qualidade técnica do trabalho.
- Cloud, billing, remote control e telemetry ficam desativados por padrão.

## Coordenação visível

Em Claude Code, Codex ou OpenCode, a opção **Este agente coordena o time** concede capacidades locais
àquele terminal visível. O agente continua usando sua TUI e seu PTY reais; a concessão não cria um
runtime paralelo.

```text
compazio spawn [--agent <id>] [--role <papel>] [--title <nome>]
compazio connect <terminal-criado> <recurso-conectado>
compazio disconnect <edge-id> | <origem> <destino>
compazio assign-role <terminal-criado> <papel>
compazio close <terminal-criado>
compazio note create <título> [conteúdo]
compazio notify <mensagem> [--title <título>]
```

Cada coordenador pode manter seis terminais criados por ele, com até quatro ativos ao mesmo tempo.
Ele só encerra terminais que criou; ao encerrar, o processo e as conexões são removidos, mas o cartão
permanece no canvas. Notas e terminais manuais precisam estar conectados visualmente ao coordenador
antes de serem compartilhados com sua equipe.

`COMPAZIO_ORCHESTRATOR_MODE=false` desliga essa concessão como kill switch de rollback. TeamRun,
workers ocultos, orçamento de missão, QA automático e telas históricas de objetivo/equipe continuam
fora do caminho público. Estado operacional antigo permanece legível para migração e diagnóstico.

A decisão arquitetural completa está no ADR 048.

## Segurança e persistência

- IPC/HTTP local validam comandos, opções, IDs, paths e payloads na fronteira.
- O bridge escuta somente em loopback e exige bearer token de 256 bits por sessão.
- Texto injetado no PTY perde controles C0/C1 e ESC antes de formar o envelope.
- Arquivos de nota recusam IDs inválidos, traversal, symlink/junction para fora do projeto e writes
  não atômicos.
- Workspace schema 10 preserva campos históricos, mas o runtime manual não deriva comportamento de
  ownership ou execução gerenciada.

## Homologação

Consulte `docs/COMPAZIO_CORE_RESCUE_ACCEPTANCE.md` para a matriz executada e os itens que ainda
dependem de prova manual/real no Windows.
