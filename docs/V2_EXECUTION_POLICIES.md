# Políticas de execução — estado de release

As políticas de TeamRun e seus orçamentos pertencem ao runtime histórico. Elas continuam
serializáveis para leitura e migração, mas não controlam o núcleo manual ativo.

No release do núcleo:

- `COMPAZIO_ORCHESTRATOR_MODE` é `false` por padrão;
- nenhum objetivo inicia processos, recruta agentes ou cria QA automaticamente;
- todo processo de agente corresponde a um terminal visível;
- mensagens entre agentes dependem de uma conexão manual e de `compazio send/reply`;
- cloud, billing, remote control e telemetry também permanecem desligados por padrão.

Uma política futura só poderá limitar capacidades de um terminal PTY visível. Ela não autoriza um
worker privado, uma TUI substituta ou conclusão inferida de output.
