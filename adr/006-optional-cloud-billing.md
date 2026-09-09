# ADR 006 — Cloud opcional e billing por capabilities

## Status

Accepted — após validação do produto local e aprovação explícita da Fase 5.

## Contexto

O desktop continua sendo a autoridade para projetos, workflows, runs e artefatos locais. Conta,
organização, dispositivos, preferências opt-in, run summaries sanitizados e entitlements podem ser
sincronizados para Supabase. Cobrança é um adaptador server-side da AbacatePay e não é fonte de
verdade para o core local.

## Decisão

- Cloud sync, billing, monitor remoto e telemetria permanecem desligados por padrão.
- O desktop só sincroniza DTOs com allowlist: nome público escolhido, identificadores opacos,
  status, duração, adapter e resumo sanitizado. Paths, código, diff, prompt completo, output de
  terminal, env, tokens e notas privadas não têm representação no contrato cloud.
- `packages/schemas` guarda contratos de sync e IPC; `packages/core` resolve capabilities sem
  importar Electron, Next.js, Supabase ou AbacatePay.
- Supabase é acessado pelo browser apenas com chave publicável e RLS. A chave de serviço só pode
  ser usada no servidor web para webhooks, reconciliation e exclusão autenticada.
- O browser recebe apenas um monitor de leitura. O preload Electron expõe somente operações cloud
  tipadas e não expõe `ipcRenderer`, credenciais ou um transporte genérico.
- Entitlements são capabilities e possuem fallback Community. Falha de pagamento ou cloud nunca
  bloqueia criação, execução ou leitura local.
- Redirect de checkout somente informa estado pendente. Alterações de entitlement vêm de webhook
  validado e idempotente ou de reconciliation server-side.

## Segurança e retenção

- Todas as tabelas expostas usam RLS por membership ativa; tabelas de billing não possuem políticas
  para browser.
- Webhooks validam secret de URL, HMAC do corpo raw e identidade idempotente em transação.
- Logs e payloads persistidos são sanitizados. Eventos de cobrança mantêm apenas metadados mínimos
  necessários para auditoria e reconciliation.
- Exportação contém somente dados cloud da conta autenticada. Exclusão exige confirmação explícita
  e falha de forma acionável quando a pessoa ainda é proprietária de uma organização compartilhada.

## Rollback

- Desligar `NEXT_PUBLIC_CLOUD_ENABLED` e `NEXT_PUBLIC_BILLING_ENABLED` interrompe tráfego novo sem
  alterar o core local.
- As migrations cloud são aditivas; rollback operacional é desabilitar flags, reter dados conforme
  política publicada e executar exclusão/exportação autenticada antes de qualquer remoção de dados.
