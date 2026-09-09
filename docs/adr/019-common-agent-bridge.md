# ADR 019 — ponte comum de agentes locais

Status: aceito

## Contexto

Claude Code e Codex possuíam adapters com contratos de baixo nível compatíveis, mas a verificação
de disponibilidade era disparada de formas diferentes e o envio de mensagens não tinha uma camada
única de timeout, readiness e diagnóstico. Um exit code de `--version` não prova que o provider está
autenticado nem que pode participar do runtime.

## Decisão

`AgentBridge` centraliza, sobre o contrato de adapter existente, a inspeção funcional, capabilities,
readiness de sessão, envio limitado por tempo e observação de resposta por sequência. Para um adapter
ser anunciado como disponível, a ponte exige detecção do executável e validação de autenticação.
Claude Code e Codex permanecem adapters independentes, mas entram pelo mesmo caminho.

Falhas e timeouts são convertidos em códigos e mensagens sanitizados. A ponte não retorna output do
terminal, paths, linhas de comando, credenciais ou diagnóstico bruto do provider. O processo main
usa a ponte para o status do runtime e para a entrega da fila de mensagens. Handoffs continuam
dependendo de aprovação explícita e da confirmação observável do adapter.

## Consequências

- o renderer recebe status funcional já sanitizado e capabilities tipadas;
- uma entrega de mensagem possui causa auditável, sem retry automático;
- `--from` não participa da autenticação do provider;
- a ponte não inicia agentes, planeja tarefas ou coordena equipes.
