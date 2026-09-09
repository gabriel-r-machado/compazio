# ADR 008 — Workspace visual e fronteira de terminais

## Status

Accepted — 2026-07-17.

## Contexto

O ForgeDeck já possui um motor local para processos, adapters, workflows,
worktrees e persistência. A próxima experiência precisa tornar esse motor
visível e operável: o usuário escolhe um projeto, adiciona um terminal ou
agent e interage com a sessão no canvas.

Essa mudança aumenta a superfície de segurança do Electron. Um renderer que
pudesse enviar executáveis, argumentos, diretórios de trabalho ou ambiente
arbitrários ao processo principal transformaria a UI em uma API de execução
genérica. Isso viola a fronteira local-first e enfraquece as garantias já
oferecidas pelos adapters e pelo `ProcessSupervisor`.

## Decisão

- O `ProcessSupervisor` continua sendo a única autoridade de lifecycle de
  processos: spawn, batching de saída, limites de buffer, cancelamento,
  recuperação e encerramento da árvore. Scheduler, adapters, Git/worktrees e
  o banco local não serão reescritos pela camada visual.
- O renderer recebe uma API de terminal pequena e tipada no preload. Ela aceita
  somente identificadores validados e dados operacionais mínimos:
  `sessionId`, texto de entrada e dimensões de terminal. Não aceita
  executável, argumentos, `cwd`, ambiente, shell ou paths arbitrários.
- O processo principal resolve projeto e worktree por seus IDs já persistidos;
  resolve executável e argumentos exclusivamente pelo adapter registrado; e
  aplica a allowlist de ambiente existente. Uma sessão criada pela UI é sempre
  local e associada a esses registros, nunca a valores fornecidos pelo
  renderer.
- Cada canal IPC tem schema Zod, handler allowlisted e bridge explícita. Não
  haverá `ipcRenderer.send`, `invoke` genérico ou acesso Node no renderer.
  `contextIsolation` permanece ligado e `nodeIntegration` desligado.
- O terminal visual usa xterm apenas como projeção de saída e entrada. Ele não
  inicia processos, não lê arquivos e não decide permissões. O web app não
  ganha terminal, saída integral, paths absolutos ou controle remoto.
- As sessões reutilizam o store de runtime e os registros SQLite existentes;
  a primeira etapa não altera schema nem migration. Qualquer alteração futura
  de persistência exige migration reversível e ADR complementar.
- Ao fechar a janela ou cancelar uma sessão, o main solicita parada graciosa e
  então delega o force kill ao encerrador de árvore de processos. Inscrições de
  saída devem poder ser removidas e não podem manter uma sessão viva.
- A CSP de produção permanece estrita. Em desenvolvimento, a exceção fica
  limitada a estilos injetados pelo Vite, WebSocket local e ao hash exato do
  preâmbulo do `@vitejs/plugin-react` travado no lockfile. Ela nunca habilita
  `unsafe-inline` para scripts, `eval` ou fontes remotas; produção não recebe
  exceção alguma.

## Consequências

- A UX pode abrir um Claude Code, Codex ou Terminal em poucos cliques sem
  duplicar o runtime nem acoplar o produto a um fornecedor.
- O main passa a compor uma fachada de sessões sobre o motor existente. Essa
  integração exige testes de schema IPC, lifecycle, cancelamento idempotente,
  ausência de processos órfãos e empacotamento do módulo nativo `node-pty`.
- Windows, macOS e Linux mantêm comandos e caminhos sob responsabilidade do
  adapter. Os testes incluem caminho com espaços e shell do Windows; nenhuma
  tela pressupõe Bash.
- Configuração avançada permanece disponível em drawer/inspector sob demanda;
  não é requisito para abrir nem usar um terminal.

## Não objetivos

- Refatorar `ProcessSupervisor`, scheduler, adapters, Git/worktrees ou
  persistência sem uma necessidade comprovada pelo novo contrato.
- Expor um console genérico no preload, executar comandos do web app ou enviar
  logs/diffs/caminhos locais para cloud.
- Alterar permissões de agentes ou permitir que uma conexão no canvas amplie
  as permissões declaradas de um nó.

## Alternativas rejeitadas

- **Spawn direto pelo renderer:** quebra isolamento de contexto e permite
  command injection por parâmetros arbitrários.
- **Novo runtime específico para o canvas:** duplicaria cancelamento,
  recuperação e limpeza de processos já tratados pelo motor local.
- **Terminal remoto no web:** conflita com o escopo local-first e amplia
  desnecessariamente a superfície de dados sensíveis.
