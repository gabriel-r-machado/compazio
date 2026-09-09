# Arquitetura de agentes da V2

O domínio V2 separa quatro conceitos: `AgentDefinition` (agente conhecido), `AgentInstallation` (cache seguro de detecção), `AgentPreset` (configuração reutilizável) e `TerminalSession` (processo apenas em memória).

`AgentRegistry` recebe definições e adapters e rejeita IDs duplicados. Os adapters ficam no runtime main-process e o renderer só chama IPC validado; ele nunca monta a linha de comando final. As definições internas são Claude Code, Codex, OpenCode, Shell e Comando personalizado. Presets, caminhos manuais, cache de instalação e responsabilidades são gravados somente em `agents.json` sob o armazenamento isolado da V2.

O workspace persiste política de permissões, configuração escolhida para cada terminal e a revisão aplicada da responsabilidade. Handles, stdout integral, listeners, tokens e prompts temporários não são persistidos.

O `V2ProcessSupervisor` permanece a única fonte de verdade para processos. `AgentRuntime` resolve um launch tipado e o serviço de workspace o entrega ao supervisor. Isso permite uma futura chamada interna criar um terminal com agente/responsabilidade sem depender do renderer, mas não expõe uma CLI de orquestração nesta fase.
