# ADR 048 — coordenação por terminais visíveis

## Contexto

O núcleo manual já permite conectar coding agents reais e trocar solicitações duráveis pelo PTY.
Entretanto, montar uma equipe ainda exige criar cada terminal, atribuir responsabilidades, conectar
recursos e enviar cada tarefa manualmente. O runtime histórico de TeamRun resolvia parte desse fluxo
com workers privados e estado operacional paralelo, contrariando a garantia de que o que aparece no
canvas é o processo que realmente trabalha.

## Decisão

- Claude Code, Codex e OpenCode continuam sendo terminais normais, visíveis e PTY-backed. A pessoa
  pode conceder a um deles a capacidade local “coordena o time”.
- A concessão é persistida no nó, mas seu token, CLI e instruções são efêmeros e pertencem somente à
  sessão do processo. Alterar a concessão reinicia o terminal para não preservar autoridade antiga.
- O coordenador usa a mesma bridge local do protocolo manual. Os comandos públicos adicionais são
  `spawn`, `connect`, `disconnect`, `assign-role`, `close`, `note create` e `notify`.
- `spawn` cria e inicia um cartão de terminal real, conecta-o ao coordenador e marca ownership
  explícito. Não cria TeamRun, worker oculto, notebook obrigatório ou processo pipe-backed de produto.
- Um coordenador mantém no máximo seis cartões criados e quatro processos criados ativos. Esses
  limites reduzem consumo acidental sem introduzir orçamento ou scheduler paralelo.
- O coordenador só encerra terminais que ele criou. `close` para o processo, remove as conexões e a
  autoridade, mas preserva o cartão no canvas para inspeção e reutilização manual.
- Recursos manuais permanecem sob consentimento visual: antes de um coordenador compartilhar uma
  nota ou terminal externo com um agente criado, esse recurso precisa estar conectado diretamente ao
  coordenador.
- Requests continuam duráveis e só terminam com `compazio reply`. Output, silêncio, texto do provider
  e encerramento do processo não representam conclusão.
- Os painéis históricos de TeamRun continuam desativados. `COMPAZIO_ORCHESTRATOR_MODE=false` é o kill
  switch de rollback; cloud, billing, remote control e telemetry continuam desligados por padrão.

## Consequências

A pessoa pode dar um objetivo a um agente líder e acompanhar toda a equipe no mesmo canvas, sem
perder a TUI nativa, autenticação, sandbox ou configurações de cada provider. O modelo não oferece
agendamento autônomo, execução remota, billing ou garantia de qualidade automática: coordena pedidos
explícitos entre processos locais e preserva evidências para inspeção humana.
