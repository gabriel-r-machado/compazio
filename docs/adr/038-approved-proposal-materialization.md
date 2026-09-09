# ADR 038 — materializacao explicita de propostas aprovadas

## Contexto

Uma proposta local revisavel (ADR 037) registra objetivo, equipe, template, dependencias,
permissoes e a aprovacao humana. O Modo Livre ja possui um unico dispatcher duravel para
comandos de workflow, um scheduler deterministico, worktrees gerenciados e o Policy Engine.

## Decisao

- A acao explicita **Executar proposta aprovada** materializa no maximo um comando `start` no
  `workflow_run_commands` ja consumido pelo dispatcher do desktop. Ela nao inicia outro runtime.
- A tabela `orchestration_proposal_executions` liga a proposta ao comando com unicidade. A mesma
  transacao grava o evento `execution_requested`, portanto tentativas repetidas devolvem o mesmo
  comando sem criar uma segunda execucao.
- A superficie desktop envia somente `workspaceId` e `proposalId`. Template, agente, tarefa,
  contexto, worktree e workflow sao resolvidos localmente; paths, SQL, executaveis e comandos
  nunca entram por IPC.
- A materializacao exige: proposta `approved`, gate `human_approval`, template built-in com DAG
  valido, agente executor existente e incluido na equipe sugerida. O Policy Engine revalida
  `execute_tasks`, cada permissao solicitada e `manage_worktrees` quando o template o exige.
- `merge_changes` e proibida nessa fronteira. A acao nao concede permissoes, nao ignora gates e
  nao cria equipe, worktree ou merge automaticamente. Um comando que falha antes de iniciar nao
  e repetido automaticamente; a proxima tentativa requer nova proposta auditavel.

## Consequencias

O desktop apresenta templates confiaveis e agentes existentes para configurar o rascunho, mas a
aprovacao continua separada da materializacao. Propostas anteriores permanecem legiveis, com
`executionAgentNodeId` ausente interpretado como `null`; elas nao podem ser executadas sem uma
revisao que defina o alvo. O scheduler e o historico de runs permanecem a unica fonte de verdade
para o ciclo de vida da execucao.
