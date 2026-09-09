# Compazio V2 — lifecycle de processos

`V2ProcessSupervisor` é a única autoridade de processos ativos. O renderer só envia pedidos IPC
tipados e recebe eventos `terminal.state`, `terminal.output` e `terminal.error`.

```text
idle → starting → running ─────────────→ completed
                    │                     │
                    ├→ stopping → stopped │
                    └──────────────→ failed
```

`waiting-input` existe no contrato, mas não é inferido nesta fase: PTY/output não é usado para
inventar disponibilidade. Ao recuperar um workspace, não há sessão persistida; o terminal volta
parado e pode ser iniciado manualmente.

Para parar ou excluir:

1. o supervisor recusa nova entrada e emite `stopping`;
2. solicita encerramento gracioso ao transporte;
3. aguarda o timeout;
4. se necessário, usa `PlatformProcessTreeKiller` para encerrar a árvore;
5. descarta listeners, buffer/process handle e sessão;
6. o serviço remove nó e arestas, depois persiste o workspace.

As operações de stop e release são idempotentes. A exclusão de workspace encerra todas as sessões
antes de excluir somente os arquivos internos da V2; o diretório de trabalho do usuário nunca é
removido.
