# Requisitos executáveis

Estes requisitos derivam de `docs/01-product-vision.md`. Capacidades-alvo não devem ser anunciadas
como prontas sem a evidência registrada em `docs/23-current-capabilities.md`.

## Projeto e runtime

- abrir um projeto por diálogo nativo e persistir metadados localmente;
- iniciar sessões independentes com `cwd` derivado no processo principal;
- suportar input, resize, cancelamento, crash e output em lote;
- manter um shell livre utilizável mesmo sem agente de IA instalado;
- detectar somente runtimes realmente disponíveis e autenticáveis;
- não expor executável, argumentos, ambiente ou path arbitrário ao renderer;
- nunca enviar dados ao cloud quando os flags estiverem desligados;
- manter runs fora do ciclo de vida do renderer e recuperar estado após reload;
- usar o adapter de shell falso nos testes antes de depender de um runtime real.

## Canvas contínuo

- persistir nós, conexões, dimensões, viewport e múltiplos workspaces;
- suportar terminais de shell e agentes como nós reais, interativos e redimensionáveis;
- suportar notas, referências de arquivo/pasta/imagem, artefatos, aprovações e grupos;
- permitir que um canvas criado manualmente seja continuado com IA e vice-versa;
- preservar nós, conexões e posições ao alternar a forma de composição;
- permitir missão única por workspace e responsabilidade por agente;
- rejeitar ciclos quando o contrato exigir DAG;
- não tratar a projeção visual como fonte de verdade de um run formal;
- não atribuir comportamento ou permissão oculta a uma conexão visual.

## Composição manual

- criar um terminal de agente exigindo, no caminho mínimo, apenas a escolha de um runtime disponível;
- aplicar defaults editáveis para nome, papel, pasta, perfil e permissões;
- permitir adicionar materiais e conectar agentes sem construir um formulário técnico completo;
- permitir iniciar uma execução automática a partir do time montado;
- permitir salvar perfil, time ou blueprint reutilizável;
- continuar oferecendo digitação e controle manual dentro de qualquer terminal.

## Composição com IA do usuário

- exigir a escolha de um agente-capitão instalado e autenticado;
- enviar ao capitão objetivo, materiais autorizados, capacidades disponíveis, políticas e perfil;
- expor ferramentas estruturadas para criar e alterar um rascunho de workflow;
- nunca usar um planner interno, uma chamada oculta a modelo ou um workflow genérico como fallback;
- validar rascunho, runtimes, DAG, permissões, limites e contratos no processo principal;
- projetar a proposta no canvas como estado revisável antes da execução;
- permitir editar, bloquear campos, aprovar ou descartar a proposta;
- produzir propostas coerentemente diferentes para objetivos materialmente diferentes;
- preservar o canvas existente quando a IA for chamada no meio do trabalho.

## Execução de workflow

- separar a forma de composição da política de execução;
- usar o scheduler determinístico para dependências, filas, concorrência, retries e locks;
- suportar iniciar, pausar, retomar, cancelar e repetir etapas compatíveis;
- manter terminais visíveis durante execuções de agentes;
- permitir ao usuário assumir um terminal e devolver o controle ao fluxo;
- registrar estados `queued`, `preparing`, `running`, `waiting_for_input`, `validating`,
  `repairing`, `completed`, `failed`, `cancelled` ou equivalentes versionados;
- não inferir conclusão por texto, silêncio ou encerramento do PTY;
- não iniciar execução apenas porque uma aresta visual foi criada;
- impedir que um agente amplie permissões ou altere limites globais.

## Perfis de execução

- oferecer Econômico, Padrão e Alta Performance, com Padrão como default;
- fazer o perfil alterar contexto, especialização, concorrência, validações e política de reparo;
- respeitar limites globais independentemente do perfil;
- nunca remover materiais ou gates obrigatórios por economia;
- aplicar mudanças de perfil somente a tarefas ainda não iniciadas;
- persistir o perfil e a política efetiva no snapshot da execução;
- rotular custo e tokens como estimativa quando o provider não fornecer métricas reais.

## Contexto, artefatos e handoffs

- classificar fontes como obrigatórias, relevantes, opcionais ou proibidas;
- montar contexto reproduzível a partir de objetivo, papel, contrato, decisões, fontes e artefatos;
- persistir hash, versão e motivo de inclusão das fontes;
- preferir entregas estruturadas a histórico bruto de terminal;
- permitir que contratos declarem inputs, outputs, critérios de aceite e evidências;
- manter artefatos imutáveis ou versionados e referenciáveis entre etapas;
- nunca enviar automaticamente todo o output de um terminal ao próximo agente.

## Handoffs interativos

- manter **Concluir e entregar** para passagens iniciadas manualmente pelo usuário;
- exigir revisão antes de `handoff_ready` nesse fluxo interativo;
- persistir pacote estruturado sem output bruto por padrão;
- tornar aprovação e entrega idempotentes;
- recuperar envio interrompido como incerto, sem retry silencioso;
- distinguir handoff interativo de transição automática já autorizada dentro de um run formal.

## Git e qualidade

- criar worktree gerenciada quando tarefas de código forem executadas em paralelo;
- impedir duas execuções de código na mesma worktree gerenciada;
- registrar diff e gates por worktree;
- registrar exit code, duração e evidência de cada gate;
- suportar lint, typecheck, testes, build e validação visual quando aplicáveis;
- manter merge e cleanup destrutivo sob confirmação explícita;
- tratar conflito sem perda;
- não aceitar mensagem final do agente como prova de sucesso.

## Falhas e recuperação

- persistir eventos, tentativas, bloqueios, aprovações e resultados;
- diferenciar falha recuperável, permissão, autenticação, ambiguidade e erro definitivo;
- parar diante de login, autorização ausente, conflito, ação destrutiva ou limite excedido;
- permitir reiniciar somente a etapa compatível;
- não relançar processo perdido como se a sessão anterior tivesse sido retomada;
- explicar ao usuário o que aconteceu e quais ações são seguras.

## Compatibilidade e release

- testar paths com espaços e shell do Windows;
- não assumir Bash;
- separar CI configurada de job executado e aprovado;
- não alegar suporte de release antes de testar o instalador correspondente;
- manter cloud, billing, controle remoto, telemetria e composição automática (`automaticWorkflow`)
  atrás de feature flags.
