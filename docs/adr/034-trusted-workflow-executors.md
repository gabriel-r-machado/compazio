# ADR 034 — Executors de workflow usam apenas templates e sessões internas confiáveis

## Contexto

O scheduler precisa executar verificações locais reais, mas a CLI e o renderer
não podem fornecer comandos, executáveis, argumentos, diretórios de trabalho
ou output bruto para o runtime desktop. As sessões PTY existentes também são
uma superfície interativa do usuário e não podem virar um canal para observar
processos internos de workflow.

## Decisão

- Um nó `shell` ou `quality_gate` só é executável quando pertence a um template
  confiável e contém uma especificação de comando validada no próprio runtime.
  CLI e IPC continuam aceitando somente o ID do template e IDs opacos de run.
- O adapter de execução resolve internamente o root aprovado, o executável e o
  ambiente mínimo, e inicia o processo pelo `ProcessSupervisor`. Cancelamento,
  timeout e árvore de processos seguem a política já usada pelo desktop.
- Gates de qualidade retornam somente exit code, duração e evidência do tipo
  `test`; output de processo nunca se torna evidência, evento de workflow ou
  payload de CLI.
- As sessões com adapter interno `workflow-shell` não são associadas ao
  `TerminalSessionAccessRegistry`. A IPC de terminal lista, lê, escreve,
  redimensiona, limpa e cancela apenas sessões explicitamente associadas ao
  renderer.
- Um nó `agent` só pode usar um agente de canvas que já exista e tenha sido
  selecionado explicitamente no comando de start. O ID estrutural fica ligado
  imutavelmente à run; o executor apenas enfileira uma mensagem pelo Agent
  Bridge existente e registra evidência de mensagem. Ele não cria sessão,
  equipe ou agente, e não interpreta output de terminal como conclusão.

## Consequências

O Modo Livre ganha um executor de shell e um gate de qualidade real sem criar
uma API de comandos arbitrários. A execução permanece auditável por eventos e
evidências verificadas, enquanto a inspeção de output continua limitada ao
runtime. O executor de agente reutiliza o lifecycle de mensagens duráveis;
handoff e worktree ainda exigirão seus próprios adapters e contratos
persistidos antes de serem habilitados.
