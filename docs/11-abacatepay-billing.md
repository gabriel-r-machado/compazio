# Billing com AbacatePay

## Decisão

Cobrança não entra no MVP local. O design de entitlement entra agora para evitar acoplamento futuro.

Feature flags:

```env
NEXT_PUBLIC_BILLING_ENABLED=false
```

## Modelo de monetização

### Community — gratuito

- desktop local;
- projetos;
- agentes;
- workflows;
- worktrees;
- gates;
- plugins;
- templates públicos.

### Pro Cloud — hipótese

- sync entre devices;
- monitor móvel;
- backups criptografados;
- templates privados;
- histórico cloud estendido.

### Team — hipótese

- organização;
- membros;
- dashboards;
- templates privados compartilhados;
- políticas;
- audit log;
- runners futuros.

## Fluxo de assinatura

1. Usuário autenticado escolhe plano.
2. Servidor cria checkout de assinatura.
3. `externalId` recebe ID interno.
4. Usuário conclui checkout.
5. Webhook validado atualiza `subscriptions`.
6. Serviço recalcula `entitlements`.
7. Cliente atualiza por Realtime ou refetch.
8. Cancelamento não apaga dados imediatamente.

## Webhooks

Endpoint:

```text
POST /api/webhooks/abacatepay
```

Requisitos:

- ler raw body;
- validar assinatura/HMAC conforme documentação;
- rejeitar timestamp antigo quando aplicável;
- idempotência por event id/hash;
- registrar payload sanitizado;
- responder rápido;
- processar efeitos em transação;
- nunca confiar em redirect do browser como confirmação.

Eventos a mapear:

- checkout concluído;
- assinatura criada/ativa;
- renovação;
- pagamento falhou;
- cancelamento;
- refund/dispute quando aplicável.

## Entitlements

O desktop recebe capacidades, não o nome do plano:

```ts
interface Entitlements {
  cloudSync: boolean;
  mobileMonitor: boolean;
  privateTemplates: boolean;
  teamMembers: number;
  cloudHistoryDays: number;
}
```

## Falha do gateway

- core local continua funcionando;
- cloud entra em grace period;
- usuário vê status;
- webhook pode ser reprocessado;
- reconciliação diária busca inconsistências.
