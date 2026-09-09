# ADR 029 — Memória de artefatos e contratos de entrega versionados

## Contexto

O Compasso precisa recuperar a origem e a relevância de um artefato, além de
provar quais critérios e evidências foram usados em uma entrega. Alterar esses
dados em linha destruiria a evidência necessária para uma execução auditável.

## Decisão

- Cada artefato publicado cria, na mesma transação, a versão inicial de
  `ArtifactMemory`, com origem relativa ao workspace e hash SHA-256.
- Relações entre artefatos, relevância e estado são alterações append-only:
  cada alteração cria uma nova versão, preservando as anteriores.
- `DeliveryContract` separa a identidade estável do contrato de sua revisão.
  A verificação registra uma nova revisão com as evidências verificadas; ela
  nunca altera as evidências declaradas.
- Os dados residem apenas no SQLite local e só contêm IDs, conteúdo declarado,
  hashes e caminhos relativos já públicos ao workspace. Não são expostos SQL,
  executáveis ou caminhos absolutos.
- Esta camada não executa processos e não aceita `--from` como autoridade. O
  usuário local cria e verifica contratos; futuras execuções deverão carregar
  versões imutáveis através do Context Builder e dos checkpoints.

## Consequências

O banco cresce com o histórico, em troca de rastreabilidade e reprodução de
contexto. Artefatos antigos recebem uma versão inicial de metadados sob demanda
para manter compatibilidade com workspaces criados antes da migration.
