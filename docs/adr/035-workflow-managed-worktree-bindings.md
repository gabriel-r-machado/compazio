# ADR 035 — execuções isoladas usam worktrees gerenciadas e referências opacas

## Contexto

Os templates confiáveis já podiam declarar que um nó exige isolamento
`git_worktree`, mas o scheduler ainda recebia a raiz do projeto principal e
recusava essa capacidade. Isso impedia que um workflow isolado usasse o mesmo
modelo de worktree já auditado pelo desktop.

## Decisão

- Antes de iniciar uma execução não simulada que exige `git_worktree`, o
  dispatcher desktop cria uma nova worktree pelo `WorktreeManager` existente.
  A entrada deriva somente do ID interno do comando e da tarefa já persistida;
  renderer, CLI e IPC não fornecem branch, ref, diretório ou comando Git.
- O runtime recebe a raiz da worktree apenas em memória e marca a capacidade
  `gitWorktree` para aquela execução. A run persiste somente `worktreeId` na
  sua associação de target, nunca o caminho local.
- Retentar uma run isolada cria outra worktree. A worktree anterior continua
  disponível para inspeção, evidência, merge explicitamente confirmado ou
  limpeza manual já protegida. Não há remoção silenciosa.
- Execuções de simulação não criam worktree e não podem habilitar isolamento
  efetivo. Um template isolado real sem worktree gerenciada é rejeitado antes
  de executar nós.

## Consequências

O scheduler passa a executar templates isolados usando a infraestrutura Git
existente, com leases e validações de caminho centralizadas. O renderer segue
vendo apenas estado seguro da run e IDs opacos; o processo de merge continua
separado e exige confirmação humana.
