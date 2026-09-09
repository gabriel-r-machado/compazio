# Modelo de dados Supabase

## Princípio

Supabase não substitui SQLite local. Ele suporta recursos opcionais de conta e equipe.

## Tabelas

- `profiles`
- `organizations`
- `organization_members`
- `devices`
- `cloud_projects`
- `cloud_runs`
- `cloud_run_events`
- `templates`
- `template_versions`
- `subscriptions`
- `entitlements`
- `billing_events`
- `audit_logs`

## Multi-tenant

Toda tabela privada possui `organization_id`.

RLS deve exigir membership ativa. Service role é usada apenas em jobs/webhooks server-side.

## Dados do device

Guardar:

- id;
- user id;
- nome escolhido;
- platform;
- app version;
- public key;
- last seen;
- revoked at.

Não guardar hostname real sem consentimento.

## Sync

MVP cloud usa sync de alto nível, não replicação total do SQLite.

### Desktop → cloud

- run started;
- node status changed;
- run completed;
- summary updated.

### Cloud → desktop

- feature flags;
- templates;
- entitlement;
- team metadata.

## Realtime

Usar para status e monitoramento. Não enviar output de PTY completo por canais de banco.

## Storage

Somente bundles explicitamente enviados pelo usuário, com expiração e política privada.
