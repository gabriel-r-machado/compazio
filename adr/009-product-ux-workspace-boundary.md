# ADR 009 — Refinamento de produto e workspaces persistidos

## Status

Accepted — 2026-07-17.

## Contexto

O ForgeDeck já possui canvas persistido, projetos Git aprovados, terminais PTY,
adapters e lifecycle local. A interface atual mantém um único canvas `default`
e um projeto ativo no `localStorage` do renderer. Esse modelo não atende
`RF-PROJ-005`: vários projetos não podem permanecer abertos com projeções
independentes no mesmo processo do aplicativo.

Esta fase também introduz menus contextuais, internacionalização e comandos de
canvas. Essas ações não podem transformar o renderer em autoridade sobre
processos, filesystem, permissões ou estado do scheduler.

## Decisão

- Um workspace local representa exatamente um projeto principal e um canvas.
  Um projeto pode possuir mais de um workspace no futuro, mas cada canvas
  pertence a apenas um workspace.
- A tabela SQLite `workspaces` guarda `project_id`, `canvas_id`, título, ordem e
  estado de abertura. `projects` e `canvases` continuam sendo as autoridades
  para seus respectivos dados.
- A preferência de idioma e o workspace ativo usam `app_settings`, com chaves
  e valores validados. PT-BR é o padrão quando ainda não existe configuração;
  English é a segunda opção suportada.
- O canvas legado `default` não será apagado. No primeiro uso da nova versão,
  ele poderá ser associado ao projeto anteriormente selecionado por uma
  operação de compatibilidade explícita e idempotente.
- O preload expõe somente operações tipadas de workspace e settings. Criação
  recebe um `projectId` já persistido; o main valida o projeto e gera IDs. O
  renderer não envia path, executável, argumentos, ambiente ou SQL.
- Menus contextuais alteram apenas projeção e contratos já tipados. Excluir um
  terminal ativo exige confirmação e cancelamento idempotente antes de remover
  o nó. Reiniciar reutiliza o adapter e projeto aprovados.
- Limpar o terminal será uma operação tipada por `sessionId`. Ela descarta o
  ring buffer da sessão e limpa a projeção xterm; não envia comandos ao shell e
  não muda permissões.
- Conectar e desconectar significam criar ou remover edges do canvas. Uma
  conexão nunca inicia processo nem amplia permissões.
- O auto-layout será determinístico e local, sem alterar o DAG, scheduler ou
  ordem de execução. Viewport e posições continuam no snapshot do canvas.
- A camada de i18n usa catálogos tipados no renderer. Os componentes principais
  não mantêm texto visível hardcoded, e os catálogos precisam ter as mesmas
  chaves em testes.

## Consequências

- Trocar de aba carrega outro snapshot e mantém sessões existentes sob o mesmo
  `ProcessSupervisor`; não haverá um supervisor por workspace.
- O autosave precisa finalizar ou preservar a revisão antes da troca de aba,
  evitando escrita de um canvas no ID de outro.
- A migration é aditiva. Rollback da aplicação mantém as tabelas antigas
  intactas, embora versões anteriores ignorem `workspaces` e as novas settings.
- Context menus precisam funcionar por mouse e teclado (`Shift+F10`) em
  Windows, macOS e Linux. Atalhos exibem `Ctrl` ou `Cmd` conforme a plataforma.
- Testes de integração cobrem migration, isolamento entre workspaces, ordem de
  abas, idioma e operação idempotente de limpeza.

## Não objetivos

- Reescrever runtime, IPC existente, scheduler, adapters, Git/worktrees ou
  persistência de runs.
- Implementar colaboração simultânea, projetos remotos, terminal web ou sync de
  paths/output.
- Permitir vários projetos dentro do mesmo workspace nesta fase.
- Traduzir output de CLIs, mensagens do sistema operacional ou conteúdo criado
  pelo usuário.

## Alternativas rejeitadas

- **Registry de workspaces em `localStorage`:** mantém o renderer como fonte de
  verdade, dificulta migration e não oferece integridade entre projeto/canvas.
- **JSON único em `app_settings`:** não garante referências nem atualização
  transacional de ordem e estado das abas.
- **Um processo Electron por projeto:** duplica memória, lifecycle e cleanup sem
  benefício para a experiência solicitada.
- **Executar ações do menu como comandos de shell:** criaria command injection e
  quebraria a fronteira aprovada no ADR 008.
