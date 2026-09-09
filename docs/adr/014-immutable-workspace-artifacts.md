# ADR 014 — artefatos imutáveis do workspace

## Contexto

O Modo Livre precisa permitir que agentes registrem resultados como relatórios, imagens e arquivos
de teste. Referenciar apenas o caminho de origem não é suficiente: ele pode mudar, ser removido ou
apontar para fora do projeto. Copiar arquivos sem metadados também não fornece auditabilidade nem
uma referência estável para handoffs futuros.

## Decisão

`compasso artifact publish <path>` aceita somente um arquivo regular cuja resolução canônica esteja
dentro da raiz do projeto do workspace. O store limita o tamanho a 20 MiB, copia os bytes para
`.forgedeck/artifacts/<artifact-id>/`, calcula SHA-256 e registra os metadados em
`workspace_artifacts`. `workspace_artifact_events` registra a publicação com sequência por
artefato.
Cada artefato possui também um nó de canvas determinístico (`artifact-<id>`), contendo somente
metadados verificáveis. A publicação grava o nó na mesma transação e deixa um evento de projeção
durável para atualizar o renderer aberto.

O caminho e a origem persistidos são relativos à raiz do projeto; caminhos absolutos não entram no
SQLite nem na saída da CLI. A cópia é imutável e a CLI não mostra nem envia seu conteúdo. Se uma
chamada usa `--from`, o nó precisa ser um agente capaz com a permissão estrutural
`publish_artifacts`.

## Consequências

- a publicação não permite ler arquivos fora do projeto, mesmo por symlink;
- um artefato continua verificável após a origem mudar;
- a execução do comando não cria processo, não usa o PTY e não oferece uma ponte genérica ao
  renderer;
- artefatos aparecem no canvas, mas seus bytes continuam fora do IPC e do estado do renderer;
- eles só se tornam contexto quando há uma conexão direta e explícita para um agente;
- handoffs podem referenciá-los por ID e hash, sem acoplar o protocolo a um caminho vivo.
