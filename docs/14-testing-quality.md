# Estratégia de testes e evidência

## Camadas

### Unitários

- schemas públicos e transições de estado;
- scheduler, retry e locks;
- redaction e formatação de handoff;
- idempotência e recuperação.

### Integração

- PTY, batching, cancelamento e encerramento da árvore;
- migrations e repositories SQLite;
- snapshot consistente antes de migration, integridade e recuperação somente para um banco novo;
- IPC validado;
- Git/worktrees com repositórios temporários;
- criação, aprovação, entrega e falha de handoffs.

### E2E desktop

- abrir projeto e restaurar canvas;
- executar terminal real;
- criar missão, papel e contrato;
- revisar e enviar entrega ao destino;
- recarregar e consultar histórico;
- confirmar que o fim do PTY não envia handoff.

O smoke do Electron cobre a criação e restauração de 40 nós, ações contextuais, edição espacial e a
revisão de um handoff persistido via IPC tipado. A escrita do pacote em um terminal de destino é
coberta pelo teste integrado com writer controlado, sem depender de credenciais reais de Codex ou
Claude Code.

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm --filter @forgedeck/desktop native:electron
pnpm test:e2e
```

No Windows, testes Node devem rodar antes do rebuild para o ABI do Electron. Uma nova instalação ou
mudança de Node pode exigir reconstrução nativa novamente.

## Plataformas

A matriz de CI está configurada para Windows, macOS e Linux. Isso não comprova que um job específico
executou. Uma release precisa registrar, por plataforma, URL/log, commit, data e resultado. A
evidência atual está resumida em `docs/23-current-capabilities.md`.

## Budgets de release

- 40 nós simples sem travamento perceptível;
- quatro terminais emitindo output em paralelo;
- buffer de terminal limitado;
- canvas restaurado sem perda de layout;
- nenhum segredo marcado no diagnóstico;
- nenhum processo órfão após cancelamento ou saída do app.

Migrations pendentes sobre um banco existente criam um snapshot SQLite local antes da alteração. O
teste de integração prova a preservação dos dados anteriores, `integrity_check` e a recuperação para
um arquivo novo; ele também prova que o banco ativo não pode ser sobrescrito por acidente.

Budgets são critérios até que uma execução registre medições; não devem virar números de marketing.
