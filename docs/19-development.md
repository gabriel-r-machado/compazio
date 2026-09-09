# Desenvolvimento local

## Pré-requisitos

- Node.js 22.13 ou superior;
- pnpm 11.9 via Corepack;
- Git;
- Docker Desktop para executar o Supabase local e seus testes de RLS;
- toolchain nativa compatível com `better-sqlite3` quando não houver binário pré-compilado.

Compasso é local-first: desktop, SQLite, runtime e workflows continuam funcionando sem conta,
Supabase, billing ou internet depois da instalação das dependências.

## Instalação

```bash
corepack enable
pnpm install
```

Se a versão do Node mudou e os testes SQLite relatarem incompatibilidade de ABI, recompile o
módulo para o Node atual antes de executar os testes:

```bash
pnpm --dir node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3 run build-release
```

Não registre tokens, chaves, URLs de banco ou valores de ambiente em documentação, fixtures ou
logs. Use `.env.example` como inventário de nomes, nunca como fonte de credenciais.

## Aplicações

```bash
pnpm dev:desktop
pnpm dev:web
```

- Desktop: Electron + Vite, com renderer isolado de Node.js.
- Web: Next.js, normalmente em `http://localhost:3000`.

O preload expõe apenas APIs de domínio com canais fixos. Todo IPC novo precisa de canal explícito,
schemas Zod de entrada e saída e testes. Não adicione canais genéricos nem exponha módulos Node ao
renderer.

## Banco local

Aplicar migrations no SQLite padrão `.forgedeck/forgedeck.db`:

```bash
pnpm db:migrate
```

Para usar outro arquivo sem imprimir informações sensíveis:

```powershell
$env:FORGEDECK_DB_PATH = "C:\temp\forgedeck.db"
pnpm db:migrate
```

SQLite é a autoridade para dados locais: configurações, sessões do runtime, canvas, workflows,
eventos, artefatos, aprovações, handoffs, projetos Git, worktrees, gates e relatórios.

Quando um banco já inicializado possui migrations pendentes, o processo cria um snapshot SQLite
consistente antes da alteração e verifica sua integridade. A recuperação nunca substitui o banco
ativo: ela só pode gerar uma cópia nova, que precisa de revisão humana antes de ser adotada. Não
exponha esse mecanismo como caminho arbitrário por CLI, IPC ou renderer; consulte ADR 046.

## Cloud opcional

Cloud começa desligado. Mantenha `DESKTOP_CLOUD_SYNC=false`,
`NEXT_PUBLIC_CLOUD_ENABLED=false` e `NEXT_PUBLIC_BILLING_ENABLED=false` até existir uma decisão de
produto para habilitá-los. A sincronização aceita somente referências SHA-256, status e resumos
sanitizados; ela nunca inclui código, diff, path absoluto, prompt, saída de terminal, ambiente ou
credencial.

Para iniciar a stack local do Supabase e aplicar as migrations:

```bash
pnpm exec supabase start
pnpm exec supabase db reset --local --no-seed
pnpm exec supabase test db --local supabase/tests/database
pnpm exec supabase db advisors --local --type security --fail-on error
```

Use apenas a chave publicável no browser. A service role é exclusiva de rotas server-side; não deve
aparecer no renderer Electron, em variáveis `NEXT_PUBLIC_*` ou em código de cliente. As políticas
RLS são o limite de tenancy, e os testes pgTAP devem acompanhar toda migration exposta.

## Billing opcional

Billing fica indisponível até o flag estar ativo e todas as variáveis server-side de AbacatePay
estarem configuradas. Checkout recebe apenas organização e plano; produto, URLs, API key e secret
vêm do servidor. O retorno do checkout informa estado pendente: ele não ativa plano algum.

O webhook exige `webhookSecret` na URL e `X-Webhook-Signature` HMAC-SHA256 sobre o corpo bruto. A
rota é idempotente pela identidade/hash do evento e somente um webhook validado pode alterar
subscription e entitlement. `BILLING_RECONCILIATION_SECRET` protege a reconciliação server-side,
que repara a projeção de entitlements do ledger local sem conceder acesso a partir de redirect.

Falha ou ausência de billing nunca bloqueia a experiência local. Cancele pelo portal de conta e
aguarde a confirmação do webhook antes de mostrar o novo estado.

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Como `better-sqlite3` é usado pelo Node nos testes e pelo Electron no desktop, execute o rebuild do
ABI do Electron somente depois dos testes Node e antes do smoke:

```bash
pnpm --filter @forgedeck/desktop native:electron
pnpm test:desktop-smoke
```

O workflow de CI está configurado para qualidade em Windows, macOS e Linux. O job Linux adicional
está configurado para subir Supabase local, executar testes RLS/billing e consultar o advisor. A
configuração da matriz não prova que os jobs remotos executaram ou passaram; registre a execução
real antes de declarar validação de uma plataforma.

## Pacotes

- `core`: domínio independente de frameworks, incluindo resolução pura de entitlements;
- `schemas`: contratos Zod compartilhados, incluindo IPC e payload cloud;
- `agent-sdk` e `agent-adapters`: contratos e adapters locais de shell, Claude Code e Codex;
- `terminal`: PTY e supervisor local;
- `workflow`: DAG, dry-run e templates;
- `orchestration`: scheduler, aprovação, retry, locks e event store;
- `git`: projetos, worktrees, locks, diff, conflitos, gates, merge confirmado e relatórios;
- `local-db`: schema Drizzle, migrations SQLite e outbox de sync criptografado pelo SO;
- `config`: feature flags tipadas;
- `logger`: logging estruturado com redaction;
- `ui`: design tokens e componentes compartilhados.

## Compatibilidade e segurança

- Não monte comandos concatenando strings; use executable e array de argumentos.
- Trate paths como dados e teste caminhos com espaços; não assuma Bash ou separadores POSIX.
- `contextIsolation` e sandbox permanecem ligados; `nodeIntegration` permanece desligado.
- Navegação e novas janelas permanecem bloqueadas por padrão.
- Logs devem passar pelo pacote `@forgedeck/logger` e erros não podem ser mascarados.
- Cloud, billing, remote control e telemetry são `false` por padrão.
