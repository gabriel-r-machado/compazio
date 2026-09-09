# Recuperação operacional do Compazio V2

Falhas são `StructuredFailure`: código, mensagem amigável, detalhe técnico
seguro, ação sugerida, `retryable` e correlation ID. A causa interna permanece
somente nos logs do processo principal.

## Caminhos cobertos

- processo que falha ao iniciar ou encerra inesperadamente;
- agente ausente ou terminal excluído;
- tarefa com timeout ou resposta perdida;
- Bridge/permissão indisponível;
- retry e reatribuição;
- fechamento do aplicativo ou reload do renderer;
- falha de nota/conexão devolvida de forma estruturada;
- falha da notificação nativa registrada como `NOTIFICATION_FAILED`.

`AttentionRequest` é criado a partir de sinais estruturados, falhas de processo,
timeout, permissão, revisão manual e recuperação. Inatividade isolada não é
transformada automaticamente em erro.

## Reabertura

Ao carregar um estado com execução ou tarefa ativa sem processo vivo, o serviço:

- marca a execução como `needs-attention`;
- preserva canvas e histórico;
- registra `run.recovery-required`;
- oferece retomar, reiniciar agentes, encerrar ou manter o canvas.

Reiniciar agentes recria sessões a partir da configuração persistida; não promete
restauração perfeita de memória do CLI.

## Cleanup

Excluir uma equipe libera sessões pelo `ProcessSupervisor`, revoga credenciais
da Bridge, limpa injeção de responsabilidade, remove terminais recrutados e
arestas incidentes e apaga runs, tasks, assignments, activities, attention,
events, recovery actions e layout daquela execução.
