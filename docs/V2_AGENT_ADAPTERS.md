# Adapters e descoberta de agentes

Cada agente possui adapter próprio: Claude Code, Codex e OpenCode usam `InstalledCliAdapter`; Shell usa `ShellAdapter`; Comando personalizado usa `CustomCommandAdapter`. A interface concentra detecção, validação do preset e resolução do launch.

A descoberta é Windows-first: aceita caminho manual validado, verifica PATH/PATHEXT de forma segura e usa `where.exe` como fallback limitado. A consulta de versão chama somente `--version` com timeout; não bloqueia a interface. O resultado é cache seguro, nunca uma verdade permanente — o executável é verificado novamente no launch.

Os adapters não inventam flags de Claude, Codex ou OpenCode. Eles preservam `executable + args[]`, incluindo caminhos com espaços, e usam PTY salvo quando o preset escolhe Pipe. Um `.cmd`/`.bat` é marcado como command shim para o transporte existente.

Para adicionar outro agente, crie sua definição, um adapter que implemente o contrato e o registre em `createAdapters`; não espalhe condicionais de fornecedor pelo main ou renderer.
