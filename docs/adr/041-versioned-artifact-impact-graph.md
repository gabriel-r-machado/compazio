# ADR 041 - grafo de impacto de artefatos versionados

## Contexto

O Modo Livre ja persiste uma memoria imutavel por versao de artefato, incluindo as relacoes
`derived_from`, `supports` e `supersedes`. Essa informacao ainda nao podia ser inspecionada como
um grafo de impacto sem vazar a origem local do artefato.

## Decisao

- `SqliteWorkspaceImpactStore` le apenas a revisao mais recente de cada memoria de artefato do
  workspace. Ele nao cria revisao, nao restaura bytes e nao inicia rerun.
- `compasso impact <artifact>` resolve o artefato pelo mesmo resolver de ID ou nome da CLI e devolve
  somente IDs, nome de arquivo, tipo, hash, versao e estado. Origem, paths relativos, comandos,
  executaveis e SQL ficam fora do contrato.
- `compasso artifact memory compare <artifact> <base-version> <target-version>` compara apenas
  metadados de duas revisoes imutaveis: relacoes adicionadas ou removidas, relevancia e estado. O
  comando nao le bytes, nem devolve origem ou path do artefato.
- `compasso artifact memory restore <artifact> <version>` copia os metadados da revisao escolhida
  para uma nova revisao e registra `restoredFromVersion`. Ele nao substitui bytes, nao faz merge e
  nao cria ou inicia um workflow.
- `compasso artifact feedback create <artifact> <version> "<feedback>"` registra uma observacao
  local do usuario vinculada a uma revisao existente. A criacao valida a revisao, nao concede
  permissao a agentes e nao altera o artefato ou a execucao.
- O componente conectado mantem as tres relacoes para inspecao. A lista `affectedArtifactIds` segue
  apenas a direcao inversa de `derived_from`: se B foi derivado de A, uma mudanca em A pode afetar B.
  `supports` e `supersedes` nao disparam impacto implicito nesta etapa.
- A travessia e limitada a mil artefatos versionados e usa conjuntos de visitados, portanto ciclos
  legados nao causam loop nem ampliam o resultado.

## Consequencias

O grafo torna uma alteracao revisavel antes de qualquer restauracao, execucao ou merge. Essas acoes
continuam explicitas e futuras: o comando nunca executa um workflow, muda permissao ou altera o
canvas. A migration aditiva 0035 cria a revisao inicial para artefatos publicados antes da memoria
versionada, sem mover bytes nem alterar o artefato original. A migration 0036 adiciona somente a
proveniencia nullable de restauracao, preservando revisoes ja existentes. A migration 0037 cria a
tabela local de feedback com a versao do artefato como referencia explicita.
