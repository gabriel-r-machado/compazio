# Runtime local e adapters

O runtime do Compasso executa processos somente no processo main do Electron. Os nomes técnicos
`@forgedeck/*` e `window.forgedeck` permanecem por compatibilidade. O renderer recebe
apenas descoberta e diagnóstico por IPC tipado; não existe API genérica de spawn, shell, filesystem
ou ambiente no preload.

O `CompassoRuntime` compõe a entrega durável de mensagens, criação manual de agentes e projeções
do workspace sem importar Electron ou o renderer. O desktop é o host que injeta os callbacks da
janela; a CLI é cliente local do mesmo banco e do mesmo registro autenticado. Cada projeto aberto
recebe um lease persistido de runtime, separado dos locks curtos de operações Git, para impedir que
duas instâncias atendam o mesmo projeto ao mesmo tempo. Esta coordenação não cria scheduler ou
execução autônoma.

## Componentes

- `@forgedeck/agent-sdk`: contratos de manifest, detecção, autenticação, launch e parsing;
- `@forgedeck/agent-adapters`: shell local, Claude Code e Codex CLI, detector no `PATH` e runner de
  comandos sem concatenação de argumentos;
- `@forgedeck/terminal`: encapsula `node-pty`, supervisor, lifecycle, batching, ring buffer, fila,
  resize, input, cancelamento e encerramento da árvore de processos;
- `@forgedeck/fake-agent`: CLI determinística usada em testes de burst, crash, hang, echo e segredo;
- `@forgedeck/local-db`: migration e persistência das sessões locais em SQLite;
- `@forgedeck/cli`: descoberta de agentes e envio assíncrono de solicitações para a caixa postal
  local.

Os adapters descrevem capacidades, mas não controlam lifecycle, persistência ou permissões. Esse
limite permite adicionar outro CLI sem acoplar o core a Claude ou Codex.

## Segurança

- `cwd` deve existir, ser diretório e estar dentro de uma raiz aprovada após resolução de symlinks;
- executáveis devem ter caminho absoluto e permissão de execução na plataforma;
- executable e args permanecem separados; prompts entram por stdin;
- shims `.cmd` e `.bat` aceitam somente argumentos sem metacaracteres de shell;
- somente variáveis operacionais da allowlist são herdadas; tokens e API keys são descartados;
- diagnóstico omite cwd, path do executável, args, env, prompt e output e aplica redaction;
- cancelamento envia interrupção primeiro e, após o grace period, encerra a árvore inteira;
- o preload expõe somente `runtime.listAdapters()` e `runtime.diagnostics()`.

Claude Code usa `stream-json` no modo não interativo. Codex usa `exec --json` com sandbox
`read-only` ou `workspace-write`; nenhum adapter adiciona flags de bypass de permissões.

## Lifecycle persistido

O lifecycle do processo local é explícito e manual. A CLI aceita `compasso runtime status`, `start`,
`pause`, `resume`, `drain`, `cancel` e `shutdown`; esses comandos criam solicitações tipadas e
auditáveis no SQLite. Eles não aceitam `--from`, não expõem dados de processo e não iniciam um
scheduler. `pause` preserva sessões já em execução; `drain` processa a fila durável atual e pausa;
`cancel` encerra PTYs ativos; `shutdown` também libera o lease de projeto. O desktop aplica a ação
somente enquanto o processo local estiver aberto.

Estados suportados:

`idle → starting → running/waiting → stopping → succeeded/failed/cancelled`

Antes de aceitar novas sessões, a composição do runtime chama `recoverInterrupted()`: registros em
`starting`, `running`, `waiting` ou `stopping` são marcados como `interrupted`. A migration
`0001_runtime_sessions.sql` não persiste prompt, output, args ou ambiente. O desktop compõe o
supervisor somente com projetos abertos e validados no processo main. O renderer identifica o
projeto e o adapter por IDs tipados; ele não envia executável, argumentos ou `cwd` arbitrário.

O stream de terminal preserva ANSI, retorno de carro, backspace e movimentos de cursor necessários
para aplicações interativas. A redaction do stream mascara segredos conhecidos sem remover esses
controles. O snapshot do buffer inclui a sequência do último evento para que o renderer consiga
combinar histórico e saída ao vivo sem duplicar ou perder bytes durante a conexão.

Os nós Claude Code e Codex iniciam o executável do adapter diretamente no PTY; eles não dependem de
um shell intermediário para "digitar" o comando. O nó Terminal continua abrindo o shell local
interativo para comandos manuais.

## Caixa postal e CLI

Ao iniciar uma sessão de um nó, o main process persiste seu endpoint local. `compasso ask` grava a
solicitação como `queued`; o dispatcher entrega apenas quando o endpoint e a sessão estão ativos.
Estados em `delivering` encontrados após reinício viram `delivery_unknown` e exigem revisão, sem
retry silencioso.

Em um projeto já aberto pelo desktop, a CLI descobre o runtime local automaticamente por meio do
registro `.forgedeck/compasso-runtime.json`; não é necessário informar o banco normalmente:

```powershell
pnpm compasso -- agents
pnpm compasso -- ask reviewer "Revise a autenticação."
pnpm compasso -- ask --batch reviewer,qa "Analise a implementação atual."
pnpm compasso -- status
pnpm compasso -- respond <message-id> --from reviewer "Encontrei dois problemas."
pnpm compasso -- responses <message-id>
pnpm compasso -- spawn --agent codex --role tester --name qa-auth
pnpm compasso -- note create --title "Decisoes" --content "Usar SQLite local."
pnpm compasso -- note append Decisoes "Registrar a decisao no ADR."
pnpm compasso -- artifact publish reports/test-report.json --kind test-report
pnpm compasso -- handoff author reviewer --summary "Implementacao pronta para revisao."
pnpm compasso -- context reviewer --from reviewer
pnpm compasso -- connect reviewer Decisoes
```

`--database <arquivo>` e `COMPASSO_DB_PATH` continuam disponíveis como fallback explícito para
automação local ou um banco legado. O conteúdo permanece no SQLite local e não integra a outbox de
cloud. O estado `sent` confirma somente a escrita na sessão, não uma resposta ou entrega.

Quando o desktop está ativo, ele também registra uma sessão local de CLI com token e nonce
rotacionáveis. A CLI confirma essa identidade num endpoint de saúde que escuta somente em
`127.0.0.1` antes de abrir o banco. O endpoint não aceita comandos, paths, executáveis ou SQL e
nunca é exposto por IPC ou ao renderer. O manifesto e a saída do comando não revelam as credenciais.
`--from` continua sendo uma identidade estrutural do canvas; a decisão central de autorização será
introduzida pelo Policy Engine.

Claude Code e Codex passam pela mesma ponte local de agentes. O status só anuncia um provider como
disponível depois de verificar o executável e a autenticação local, dentro de um timeout limitado.
Capabilities, readiness, envio e confirmação de resposta usam esse contrato comum; erros publicados
são códigos sanitizados, sem output bruto, paths ou comandos do provider.

`compasso history` consolida eventos já persistidos do workspace: mensagens, respostas, notas,
artefatos, conexões, handoffs, aprovações, falhas, retries e lifecycle de agentes. Aceita filtros
`--agent`, `--type`, `--state`, `--since`, `--until` e `--limit`; a consulta retorna apenas metadados
auditáveis, sem conteúdo ou output bruto.
Um batch grava todas as solicitações ou nenhuma delas e deriva uma chave idempotente por agente.
`status` consulta os estados persistidos mais recentes sem interpretar texto produzido pelo agente.
Cada mensagem entregue inclui seu ID e a forma de responder. `respond` exige que `--from` identifique
o destinatário original, registra a resposta idempotente e a devolve pela fila quando `ask` também
informou um agente remetente. Sem remetente, `responses` mantém a resposta disponível localmente.
Terminais de shell puro nunca entram no diretório nem recebem mensagens, evitando interpretar texto
de colaboração como comando.

`spawn` grava uma solicitação idempotente. O dispatcher do processo principal cria o nó no canvas,
detecta o executável pelo adapter e inicia a sessão sem expor uma API genérica de processo ao
renderer ou à CLI. O lifecycle persistido usa `queued`, `spawning`, `running`, `failed` e
`interrupted`; reinícios não repetem automaticamente uma criação incerta. Invocações humanas não
usam `--from`. Quando outro agente se identifica com `--from`, o nó precisa declarar
`create_agents` em suas permissões.

`note create`, `note append`, `note list` e `note show` usam o mesmo banco local, mas não iniciam
processos nem expõem novas APIs de filesystem ao renderer. A criação e o append atualizam a nota e
o nó de canvas numa transação. A projeção segue uma fila persistida; em reinício, itens que ficaram
em entrega voltam para a fila. Para uma chamada feita com `--from`, o nó precisa ser um agente
capaz e declarar `create_notes`; sem `--from`, a autoria é do usuário local. A CLI também adota uma
nota manual quando ela é referenciada pelo ID do nó ou pelo título.

`artifact publish` resolve o caminho recebido contra a raiz canônica do projeto e recusa caminhos
que escapem desse limite, inclusive quando isso ocorreria por symlink. O arquivo precisa ser regular
e ter até 20 MiB. O conteúdo é
copiado para `.forgedeck/artifacts/<id>/`, recebe SHA-256 e permanece imutável mesmo que o arquivo
de origem mude. `artifact list` e `artifact show` expõem apenas metadados; publicar não envia o
arquivo a um terminal. A publicação cria um nó de canvas com esses metadados e uma projeção durável
para o desktop aberto. Para publicar com `--from`, o agente precisa declarar `publish_artifacts`.

`connect create <source> <target>` aceita referências por ID ou título único e grava a mesma aresta
persistida e mostrada pelo canvas. Os tipos iniciais são `context`, `handoff` e `dependency`; o
atalho `connect <source> <target>` cria uma conexão `context`. `connect list`, `connect show` e
`connect remove` consultam ou removem essa aresta canônica. Títulos duplicados exigem ID explícito,
self-loops e duplicatas são recusados, e `dependency`/`handoff` não podem formar ciclos. `context`
aceita nota ou artefato publicado como origem e agente como destino; somente esse tipo libera a
fonte para `context`. A saída não inclui paths, comandos, executáveis ou SQL.

`handoff <source> <target>` cria um rascunho de entrega no banco local. A criação requer uma missão
persistida, papéis nos dois agentes e uma conexão do emissor ao destino no canvas; o contrato dessa
conexão é copiado para o rascunho. `--artifact` aceita uma referência já publicada. A CLI não emite
`handoff_ready`, não escreve em PTY e não entrega o pacote: a revisão, aprovação e submissão seguem
no desktop. Um agente usando `--from` precisa ter `create_handoffs`.

`context <agent>` retorna a missão do workspace e as notas que têm conexão direta de entrada para
esse agente. Não percorre conexões indiretas, não inclui artefatos e não escreve em PTY. Uma consulta
humana pode inspecionar qualquer agente localmente; quando `--from` identifica um agente, ele deve
ser o mesmo agente consultado e declarar `read_context`. Essa permissão é estrutural, não uma
fronteira criptográfica de autenticação.

Uma criação ou remoção de conexão aumenta a revisão do canvas e publica uma projeção tipada depois
de persistida. Um agente usando `--from` precisa declarar `connect_context` e, para `context`, só
pode criar ou remover a rota do próprio nó.

`compasso inbox <agent>` consulta a caixa postal persistida de um agente. `compasso message cancel
<message-id>` só cancela itens que ainda estão em `queued`; `compasso message retry <message-id>`
recoloca manualmente uma entrega `failed`, `delivery_unknown` ou `cancelled` na mesma fila, sem gerar
uma mensagem nova. Cancelamento e retry produzem eventos auditáveis. No canvas, selecione um agente
Codex ou Claude e abra a Inbox para revisar as mensagens e executar as mesmas ações tipadas. Nem a
CLI nem IPC revelam paths, comandos, executáveis ou SQL.

`compasso handoff list`, `show` e `history` consultam o mesmo lifecycle de entrega do canvas.
`compasso handoff approve <id> --revision <n>` torna um rascunho `ready`; `reject` registra uma
rejeição auditável, `cancel` encerra uma entrega ainda não concluída e `retry` reabre apenas o
estado persistido. Nenhum desses comandos seleciona um terminal ou submete conteúdo ao agente. Com
`--from`, a revisão exige a permissão estrutural `approve_deliveries`; o usuário local continua
podendo revisar diretamente.

## Policy Engine

O `SqlitePolicyEngine` decide as permissões de agente por negação padrão para mensagens, notas,
artefatos, criação de agentes, conexões, contexto e handoffs. A mesma dependência é usada pela CLI,
pelos dispatchers do runtime e pelo fluxo direto de handoff no desktop. Cada decisão permitida ou
negada cria um registro imutável em `policy_decisions` com IDs, permissão, resultado e código técnico
de motivo. O audit log não contém paths, comandos, executáveis, SQL ou conteúdo.

As permissões disponíveis são `send_messages`, `create_notes`, `publish_artifacts`,
`create_agents`, `connect_context`, `create_handoffs`, `approve_deliveries`, `execute_tasks`,
`manage_worktrees` e `merge_changes`; `read_context` continua somente para compatibilidade com
canvas antigo. Não há API de concessão de permissões para o agente, portanto ele não pode ampliar as
próprias permissões. `--from` continua estrutural e não é uma identidade criptográfica do processo.

## Eventos ao vivo

Notas, artefatos, conexões e criação de agentes usam projeções duráveis para atualizar o canvas.
Mensagens e handoffs usam `workspace-activity:event`: o processo principal observa somente os arquivos
SQLite conhecidos com debounce e tem uma varredura de segurança lenta. O renderer não faz polling;
Inbox e histórico filtram o workspace, atualizam a partir de metadados redigidos e removem o listener
no cleanup. Após reload, cada painel recarrega o estado persistido, sem depender de evento transitório.

## Testes locais

```bash
pnpm test
pnpm test:integration
```

A integração usa o executável Node atual e o fake agent, inclusive em um `cwd` com espaços. Ela
valida quatro sessões paralelas, batching/buffer, input, resize, cancelamento, force-kill, crash
isolado e recuperação persistida. Não chama Claude ou Codex de verdade, portanto não usa rede,
créditos nem modifica sessões do usuário.

Para os gates completos:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm db:migrate
pnpm build
pnpm --filter @forgedeck/desktop smoke
```

## Compatibilidade

- Windows usa ConPTY pelo `node-pty`; shims `.cmd`/`.bat` são detectados via `PATHEXT` e iniciados
  pelo `COMSPEC` com args fixos, inclusive quando o caminho contém espaços;
- se o shim global do Claude Code estiver quebrado no Windows, o adapter procura o binário nativo
  da extensão local do VS Code e ainda o valida com `--version` antes de iniciar uma sessão;
- macOS e Linux usam o backend PTY nativo e `/bin/sh` somente como fallback de shell;
- nenhuma rotina assume Bash;
- a matriz de CI está configurada para Windows, macOS e Linux, mas cada plataforma só é considerada
  validada depois de um job realmente executado e aprovado.

## Interação do terminal

O canvas renderiza as sessões com xterm e preserva o cursor, a seleção de texto e o scrollback.
Um clique no terminal prioriza a entrada da sessão; `Ctrl+C` copia quando há texto selecionado e
continua enviando interrupção ao processo quando não há seleção. `Ctrl+V` cola texto no PTY.

Binários nativos precisam ser recompilados para o ABI do Electron no packaging. A cópia das
migrations para os recursos do aplicativo empacotado e os testes de instaladores/assinatura ficam
para a fase de release; o build de desenvolvimento usa as migrations do workspace.
