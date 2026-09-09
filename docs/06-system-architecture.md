# Arquitetura do sistema

## Relação com o produto

A arquitetura implementa um único workspace híbrido:

```text
Canvas e terminais reais
          |
          v
Application / Control Plane
          |
          v
Runtime + Scheduler determinístico
     |          |          |
  Adapters   Contexto   Git/Gates
     |
Claude / Codex / Shell / futuros runtimes
```

- O renderer projeta e manipula o canvas; não decide estado de execução.
- O main/domain valida comandos, permissões, rascunhos, conexões e transições.
- O runtime mantém filas, sessões, eventos, locks e recuperação.
- Os adapters traduzem contratos comuns para cada CLI.
- Terminais PTY permanecem interativos, mas seu output não é protocolo de workflow.
- A composição com IA usa um runtime do usuário e o mesmo control plane do modo manual.
- Não existe um segundo engine exclusivo para “Automático”.

## Decisão principal

O produto é composto por dois sistemas desacoplados:

1. **Desktop local-first**, autoridade sobre projetos, terminais e runs locais.
2. **Web/cloud opcional**, autoridade sobre conta, equipe, entitlement e dados sincronizados.

## Monorepo

```text
apps/
  desktop/
    src/main/
    src/preload/
    src/renderer/
  web/
  docs/
packages/
  cli/
  core/
  schemas/
  agent-sdk/
  agent-adapters/
  orchestration/
  local-db/
  git/
  terminal/
  workflow/
  ui/
  config/
  logger/
  test-utils/
```

## CLI e message bus local

`@forgedeck/cli` é uma superfície externa estreita sobre o mesmo estado local do desktop. O CLI não
recebe handles de PTY e não executa adapters. `compasso agents` consulta o diretório derivado dos nós
persistidos; `compasso ask` grava mensagens idempotentes, inclusive em batch atômico, e
`compasso status` consulta seus estados no SQLite. `respond` persiste uma resposta correlacionada e
a enfileira para o agente remetente quando ele foi declarado por `ask --from`. `spawn` grava uma
solicitação separada e durável; a CLI não inicia o processo.

O processo main mantém o vínculo efêmero entre nó e sessão e entrega a fila pela `AgentBridge`
comum aos adapters. A ponte valida provider e autenticação para o status, aplica timeout ao envio e
produz apenas códigos sanitizados. Os estados `queued → delivering → sent|failed|delivery_unknown`
e seus eventos são persistidos. `sent` prova somente a escrita pelo adapter, nunca a conclusão da
tarefa. Consulte `adr/011-durable-local-agent-message-bus.md` e
`adr/019-common-agent-bridge.md`.

O dispatcher de spawn materializa o nó no canvas e usa o mesmo serviço tipado de criação de sessão
do desktop. Seu lifecycle `queued → spawning → running|failed|interrupted` fica no SQLite, e o
renderer recebe apenas a projeção tipada do nó. Consulte `adr/012-durable-local-agent-spawn.md`.

`compasso note` grava notas estruturadas no SQLite e atualiza o nó correspondente na mesma
transação. Os eventos de projeção não duplicam o conteúdo da nota: o processo principal reenvia o
nó tipado ao renderer e marca o evento como publicado. Uma nota manual existente é adotada quando
for referenciada pela CLI. Consulte `adr/013-durable-workspace-notes.md`.

`compasso artifact publish` aceita um arquivo local dentro do projeto, cria uma cópia imutável sob
`.forgedeck/artifacts` e persiste somente metadados auditáveis (hash, tamanho, tipo e caminho
relativo) no SQLite. A publicação não lê arquivos fora do projeto e não entrega conteúdo para outro
agente; ela também cria o nó tipado correspondente no canvas e o entrega ao renderer por uma fila
durável. O uso posterior como contexto ou handoff continua requerendo uma superfície explícita. Consulte
`adr/014-immutable-workspace-artifacts.md`.

`compasso handoff` deriva um rascunho de entrega dos dados persistidos do canvas: missão, papéis dos
agentes, contrato da conexão e uma referência opcional a artefato imutável. A CLI nunca aprova,
submete ou entrega esse rascunho. O desktop continua sendo a superfície que emite `handoff_ready` e
usa o adapter para a entrega revisada. Uma chamada por `--from` precisa da permissão estrutural
`create_handoffs`.

`compasso context <agent>` resolve a missão e as notas ou artefatos que possuem uma conexão direta para aquele
agente. O resultado é uma leitura local explícita, sem abrir sessão ou escrever no PTY. Quando a
chamada declara `--from`, o nó solicitante deve ser o próprio destino e possuir `read_context`;
essa identidade permanece estrutural, não criptográfica. Conexões indiretas, artefatos e outros
agentes não entram no resultado. Consulte `adr/015-explicit-canvas-context.md`.

`compasso connect` administra a aresta canônica do canvas no mesmo banco local: `create`, `list`,
`show` e `remove` usam IDs ou títulos únicos e suportam `context`, `handoff` e `dependency`. A fila
de projeção persistida entrega criação e remoção ao renderer, portanto o canvas aberto atualiza sem
reload. Apenas `context` concede fontes ao resolver de contexto. Em chamadas por agente, o
solicitante precisa de `connect_context` e só pode administrar seu próprio contexto. Consulte
`adr/016-canonical-canvas-connections.md`.

O runtime mantém identidades e sessões locais auditáveis no SQLite. A CLI descobre uma credencial
efêmera pelo manifesto privado do projeto e a apresenta apenas ao endpoint `127.0.0.1` de saúde do
main process. Esse endpoint não é IPC e não expõe controle de processo, paths, comandos ou SQL.
Consulte `adr/018-local-runtime-identity.md`.

## Desktop

### Main process

Responsável por:

- PTY;
- filesystem;
- Git;
- SQLite;
- keychain/safe storage;
- notifications;
- updates;
- deep links;
- IPC handlers;
- process supervision.
- validação e materialização de rascunhos de workflow;
- policy engine e aplicação de limites;
- composição de contexto e handoffs;
- coordenação com o runtime persistente.

### Preload

Expõe API mínima e tipada:

```ts
window.forgedeck.projects.list;
window.forgedeck.terminals.create;
window.forgedeck.terminals.write;
window.forgedeck.handoffs.createDraft;
window.forgedeck.handoffs.markReady;
window.forgedeck.handoffs.deliver;
window.forgedeck.agentSpawns.onEvent;
window.forgedeck.notes.onEvent;
```

Não expor `ipcRenderer`, `fs`, `child_process` ou objetos genéricos.

### Renderer

Responsável por:

- canvas;
- terminal rendering;
- state projection;
- forms;
- diff viewer;
- command palette;
- inspectors.
- projeção de propostas, runs, intervenções e recuperação.

Renderer não acessa filesystem diretamente.

## Bancos

### SQLite local

Autoridade para:

- projetos locais;
- canvases;
- nodes/edges;
- sessions;
- runs;
- events;
- artifacts metadata;
- worktrees;
- app settings;
- adapter detection cache.

### Supabase

Autoridade para:

- users;
- organizations;
- memberships;
- devices;
- entitlements;
- subscriptions;
- opt-in synced preferences;
- sanitized run summaries;
- cloud templates;
- audit log da conta.

## Fluxo de eventos

```text
PTY / Git / Workflow Engine
          |
          v
     Domain Events
          |
     Event Store (SQLite)
          |
   Projections / UI state
          |
 Optional sanitized sync
```

## Boundary rules

- `core` não conhece Electron.
- `orchestration` não executa shell diretamente; usa ports.
- `agent-adapters` não escreve na UI.
- `web` não controla PTY local no MVP.
- cloud nunca é requisito para abrir projeto.
- terminal output completo não sincroniza por padrão.

## Performance

- um renderer principal;
- virtualização de listas;
- xterm buffer limitado;
- batching de terminal output;
- event persistence em lotes;
- não armazenar cada caractere como evento;
- snapshot do canvas + event log;
- web workers para parse pesado;
- lazy load de diff e syntax highlighter.

## Recuperação

- heartbeat por process handle;
- runs interrompidos viram `interrupted`;
- reabertura oferece recuperar, reiniciar ou arquivar;
- cleanup de worktree é explícito;
- migrations transacionais;
- backups rotativos do SQLite.
