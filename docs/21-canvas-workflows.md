# Canvas e workflows locais

## Limites de responsabilidade

O canvas é uma projeção editável persistida no SQLite. A fonte de verdade de uma execução é o
snapshot imutável do workflow, seus hashes, as projeções de run/node e o event store ordenado. Uma
mudança visual posterior não altera um run já criado.

O renderer usa somente IPC com canais fixos e contratos Zod. Ele pode carregar/salvar canvas,
listar templates e solicitar dry-run. Execução real, `cwd`, caminhos de artefato e processos não
são controlados pelo renderer. Projetos e worktrees confiáveis são compostos no processo principal
pelos serviços descritos em `docs/22-git-quality.md`.

## Canvas

- Node types: terminal, agent, note, artifact, fontes de contexto, task, gate, shape, frame e comment.
- Edges carregam contrato versionado com tipo e evidência exigida.
- Para contexto explícito, uma nota ou artefato publicado é visível a um agente apenas quando existe
  uma conexão direta do tipo `context` para ele. O CLI `compasso context` não percorre o grafo, não
  inicia sessão nem escreve no terminal; `compasso connect create` grava a mesma aresta durável
  projetada no canvas aberto.
- O autosave usa revisão otimista, debounce de 500 ms e uma única fila de gravação.
- Viewport, posição, dimensões e dados dos nós são restaurados exatamente.
- Minimap, command palette e navegação por teclado fazem parte da projeção local. Configuração
  avançada não abre um inspector permanente sobre o canvas.

Atalhos: `Ctrl/Cmd+K` abre a command palette, setas percorrem nós, `F` enquadra o canvas,
`Ctrl/Cmd+Z` desfaz, `Ctrl/Cmd+Shift+Z` refaz, `Ctrl/Cmd+C` copia a seleção e `Ctrl/Cmd+V` cola no
workspace atual. `Ctrl/Cmd` mais arraste alterna temporariamente para seleção múltipla; sem essa
tecla, o arraste primário navega pelo canvas. `Ctrl/Cmd+Enter` executa o dry-run do template bugfix,
`Shift+F10` abre o menu do nó selecionado e `Esc` fecha overlays ou sai do modo de foco/conexão.

Shapes, frames e comments sao anotacoes visuais persistidas, com dimensoes e ordem de camada.
Shapes e frames nao possuem handles e o menu contextual nao permite criar dependencias ou handoffs a
partir deles. Um frame criado a partir de uma selecao guarda seus membros apenas para navegacao
visual; copiar um fragmento remapeia somente os membros tambem copiados.

Nos operacionais tambem podem registrar um percentual de progresso e um motivo local de bloqueio.
Esses dados sao apenas uma projecao visual persistida: nao concedem permissoes, nao iniciam trabalho
e nao modificam uma run imutavel. Fontes de contexto mostram uma previa segura e exigem sempre uma
aresta `context` direta para chegar a um agente; caminhos locais, bytes e consultas nao aparecem no
canvas, na CLI ou no IPC.

### Seleção de contexto

Cada fonte direta pode usar a política `required`, `relevant`, `optional` ou `never`. A última nunca
é enviada ao contexto efetivo. Ao criar contexto ou iniciar uma run, `--context-mode` escolhe
`full`, `intelligent` ou `economical`; obrigatório nunca é removido. O checkpoint armazena hashes,
chunks, motivo de cada inclusão ou exclusão e estimativa local de tokens. Tokens/custo reais somente
aparecem quando um provider os reportar; até lá o custo é explicitamente estimado. Consulte
`adr/045-reproducible-context-selection.md`.

### Workspace visual

- O desktop abre diretamente no canvas; a navegação lateral recolhível mostra somente projetos
  locais e não desmonta o canvas quando é fechada.
- Projeto local, Terminal, Agente e Nota ficam na barra compacta do canvas.
- O projeto continua sendo escolhido pelo diálogo nativo. O renderer envia somente o `projectId`
  persistido ao solicitar uma sessão.
- A pasta escolhida e sua árvore são o limite de acesso aprovado para o projeto e para seus
  terminais. O app não solicita acesso irrestrito ao disco; pastas adicionais precisam ser
  importadas explicitamente pelo usuário.
- Um terminal novo inicia automaticamente pelo adapter registrado e recebe foco no xterm. Um nó
  restaurado aguarda `Start`, evitando relançar processos silenciosamente ao abrir o aplicativo.
- Terminais podem ser movidos, redimensionados, abertos em foco, duplicados, limpos, reiniciados e
  encerrados no canvas. A exclusão tenta cancelar a sessão antes de remover o nó, evitando processo
  órfão.
- Trocar ou limpar o layout exige confirmação quando existem sessões e só substitui a projeção
  depois que todos os cancelamentos terminam com sucesso.
- Canvas, histórico de execuções e configurações ficam no rodapé da navegação. Projeto é aberto
  pelo botão junto a "Meus projetos" ou pelo menu contextual; revisão Git permanece fora da
  navegação principal para reduzir duplicidade visual.

### Workspaces e ações contextuais

- Cada workspace tem um projeto principal, um canvas e um viewport próprios. Vários workspaces
  podem permanecer abertos em abas na mesma janela; a troca aguarda o autosave antes de carregar a
  próxima projeção e aplica imediatamente seu zoom e posição persistidos.
- `Ctrl/Cmd` mais arraste cria uma seleção múltipla. Copiar preserva configuração, dimensões,
  posições relativas e conexões internas, mas nunca copia sessões de processo em execução.
- O botão direito sobre uma seleção múltipla oferece Centralizar, Copiar, Desconectar e Excluir
  selecionados. Operações visuais entram no histórico de Desfazer do canvas.
- Abrir uma pasta já conhecida reabre sua aba. Fechar a aba preserva o workspace, seu canvas e o
  projeto no SQLite.
- O idioma padrão é PT-BR. English pode ser escolhido em Configurações e a escolha fica em app
  settings locais.
- Botão direito em Terminal, Claude Code, Codex, Nota ou conexão abre ações específicas. A conexão
  é removida diretamente pelo menu contextual e pode ser restaurada por Desfazer; não há modal de
  confirmação para essa ação reversível.
- O menu de terminal/agente contém foco, renomear, duplicar, conectar, desconectar, limpar,
  reiniciar e excluir. Notas expõem edição de título, duplicação, conexão e exclusão; conexões
  permitem editar o rótulo da regra ou excluir o contrato visual.
- A mini toolbar do nó selecionado mantém ações por ícone presas ao nó. A toolbar do canvas oferece
  Desfazer, Refazer, Adicionar, Modelos, Tesoura, Ver tudo e Organizar. **Modelos** abre os modelos
  `Canvas vazio`, `Blueprint para PR` e `Correção de bug`; eles não são sessões do Histórico local.
  Aplicar um modelo confirma a substituição, interrompe sessões ativas antes de trocar a projeção e
  nunca inicia um fluxo automaticamente. A Tesoura remove a conexão clicada e continua clicável
  para que o modo possa ser desligado mesmo após remover a última conexão. A operação permanece
  recuperável por Desfazer. A organização calcula colunas pelo DAG, respeita as dimensões dos nós e
  move itens desconectados para uma faixa separada. Ela altera somente posições, nunca contratos ou
  a ordem do scheduler.

- Notas são editáveis diretamente no canvas e persistem ao perder foco ou com `Ctrl/Cmd+Enter`; a
  digitação não cria uma entrada de histórico por caractere. As alças de redimensionamento do terminal
  aparecem fora da borda quando o nó está selecionado, preservando a área de conteúdo.

- Configurações permite tema claro ou escuro; escuro é o padrão. A preferência é local, atualiza
  canvas e terminais com contraste adequado e não altera dados do workspace.

### Terminais de agente

- Claude Code, Codex e OpenCode são sessões locais interativas iniciadas no diretório aprovado do
  projeto. Seus adapters validam e iniciam executáveis conhecidos no processo principal; a TUI
  nativa de cada provider continua visível no xterm.
- Se o CLI não puder ser validado, o shell continua aberto e mostra orientação de diagnóstico. O
  app não tenta reparar nem instalar ferramentas de terceiros silenciosamente.
- Autenticação e mensagens de instalação são mostradas pelo próprio CLI dentro do terminal. O
  renderer nunca escolhe executável, caminho ou texto de comando arbitrário.
- Conexões de saída funcionam como rotas de handoff, não como conversa autônoma. O usuário usa
  **Concluir e entregar**, escolhe o destino quando houver mais de uma saída, revisa o pacote e
  aprova o envio. Somente essa aprovação cria `handoff_ready`. Encerrar o PTY não encaminha nada.
- O pacote contém snapshots de missão, papéis e contrato mais resumo, trabalho concluído, decisões,
  evidências e riscos. O buffer bruto pode ser consultado localmente, mas não é persistido ou
  enviado por padrão.
- O destino precisa ter uma sessão ativa. O main process usa IDs tipados para localizar sessão e
  adapter; o renderer não envia comando, executável, argumentos ou caminho. O adapter insere o
  pacote e executa sua estratégia explícita de submissão. A escrita no PTY sozinha não é entrega.
- Handoffs são persistidos com estados `draft`, `ready`, `awaiting_destination`, `submitting`,
  `written_to_terminal`, `submitted_to_agent`, `delivered`, `failed`, `delivery_unknown` e
  `cancelled`. `delivered` significa que uma resposta nova foi detectada após a submissão, não que
  a tarefa está concluída ou correta.
- O padrão é `require_active_session`: destino encerrado não cria uma sessão silenciosamente. O
  pacote aprovado permanece local e o usuário escolhe iniciar uma nova sessão, selecionar outra
  sessão ativa ou cancelar. `delivery_unknown` oferece inspeção do terminal, retry explícito,
  marcação manual de envio com responsável local e cancelamento que preserva pacote, tentativas e
  eventos. Não existe retry automático.
- O seletor de branch do header lista apenas branches locais por IPC tipado. A troca exige
  confirmação nativa, valida o ref e é recusada quando o working tree possui mudanças locais.
- No Windows, wheel/scroll respeita o mecanismo nativo de cada TUI: Claude usa paginação, OpenCode
  recebe eventos SGR de mouse e Codex abre o transcript nativo antes de paginar. Shells mantêm o
  scrollback local do xterm. Nenhum desses caminhos submete prompt ou interpreta output do provider.
- `context_read` entrega imagens raster conectadas como bloco MCP real e fornece texto extraído de
  PDFs conectados, limitado a 5 MB e 200 páginas. Caminhos canônicos continuam presos ao workspace.
  A leitura visual depende do modelo escolhido no provider: um OpenCode configurado com modelo
  text-only recebe o arquivo, mas deve declarar que não possui visão; o Compazio não troca o modelo
  nem inventa uma descrição.

## Workflow engine

O schema 1.0 é estrito: comandos são `{ executable, args }`, permissões pertencem a uma lista
fechada e recursos declaram locks. A validação rejeita ciclos, referências ausentes, IDs duplicados
e ampliação de permissões.

O scheduler oferece:

- ordem determinística e limite de concorrência;
- bloqueio de dependentes após falha;
- retry somente para causas e tentativas declaradas;
- pausa e retomada por aprovação humana;
- locks ordenados por recurso e chaves de idempotência;
- evidência obrigatória antes de marcar um nó como concluído;
- relatório Markdown final redigido e registrado com SHA-256;
- recuperação de runs ativos como `interrupted` na inicialização.

O template confiável `local-agent-delivery` exige `compasso run start
local-agent-delivery --agent <id-ou-nome>`. O agente precisa já existir no
canvas; o CLI resolve nome sem ambiguidade e o runtime persiste somente seu ID
estrutural. A execução enfileira uma mensagem auditável pelo Agent Bridge,
sem criar equipe, sessão ou comando de terminal.

O template `local-quality-suite` roda, nesta ordem fixa, `lint`, `typecheck`,
`test` e `build` do projeto aprovado. Cada etapa tem timeout de dez minutos e
registra apenas exit code, duração e evidência `test`; nenhum output bruto de
processo é persistido ou enviado à UI.

`compasso run retry <run-id> <node-id> --rerun-scope <node|dependents>` cria uma
nova run manual e preserva a anterior. Um retry de no inclui todas as dependencias
transitivas; o escopo de dependentes tambem inclui os descendentes e seus pre-requisitos.
`compasso run alternative <run-id> <node-id> [--alternative-label <label>]` cria
uma ramificacao manual persistida, agrupada pela run e pelo no de origem, para que
mais de uma alternativa possa usar o mesmo scheduler em paralelo. Nenhuma dessas
acoes faz merge, restaura bytes ou agenda retries automaticamente.

Templates de workflow possuem formato `1.1` com questionario, materiais obrigatorios e opcionais,
agentes por papel, contratos, gates e permissoes. O preview de importacao aceita apenas formatos
`1.0` e `1.1`, migra o legado em memoria, valida o DAG e calcula checksum SHA-256 do documento
sanitizado. Ele recusa comandos, executaveis, paths, SQL e credenciais e nunca registra ou executa
o conteudo durante o preview. Consulte `adr/043-versioned-sanitized-workflow-templates.md`.

O envelope `.compasso` `1.0` representa template, workspace, fluxo ou fragmento com checksum
SHA-256. Exportar ou importar produz somente uma previa inerte: fluxos de canvas removem terminais,
notas, artefatos, fontes de contexto, conteudo, permissoes e referencias locais, preservando apenas
a estrutura visual segura. Nenhum pacote e gravado, aplicado ou executado automaticamente. Consulte
`adr/044-inert-sanitized-compasso-packages.md`.

Eventos recebem sequência única por run. Transições relevantes gravam evento e projeção na mesma
transação SQLite. Payloads e artefatos passam por redaction; artefatos são escritos atomicamente
sob `.forgedeck/runs/<run-id>` e não podem escapar desse diretório.

## Templates e isolamento

`blueprint-to-pr` e `bugfix` podem ser validados em dry-run. Ambos declaram etapas com
`git_worktree`, mas essa declaração não associa automaticamente os terminais interativos a
worktrees. O fluxo Git precisa criar o diretório gerenciado e adquirir a lease explicitamente.

## Validação

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm db:migrate
pnpm --filter @forgedeck/desktop native:electron
pnpm build
pnpm test:desktop-smoke
```

O smoke usa um perfil temporário, confirma o ping tipado, salva 40 nós pelo preload, recarrega o
Electron e verifica a restauração visual dos 40 nós e a disponibilidade dos dois templates.
