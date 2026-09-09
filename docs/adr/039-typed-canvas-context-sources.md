# ADR 039 — fontes de contexto tipadas no canvas

## Contexto

O contexto explicito por conexao (ADR 015) ja mantinha notas e artefatos publicados isolados por
agente. O Modo Livre tambem precisa representar texto, links, arquivos, pastas, imagens, desenhos e
paginas sem transformar o canvas em uma superficie de paths locais, leitura automatica de disco ou
busca remota.

## Decisao

- O unico modelo de fonte adicional e `CanvasContextSource`, persistido em `data_json` do mesmo no
  de canvas que o desktop exibe. Ele tem `kind`, conteudo limitado opcional e metadados redigidos;
  nao ha tabela, modelo ou ponte IPC exclusiva para CLI.
- Os tipos iniciais sao `text`, `link`, `file`, `folder`, `image`, `drawing` e `page`. Texto,
  desenho e pagina exigem conteudo. Link exige HTTPS sem credenciais, query ou fragmento; o desktop
  nao o busca automaticamente.
- Arquivo, pasta e imagem sao referencias locais gerenciadas por metadados: nenhum path local ou
  byte entra no estado do canvas, CLI ou IPC. Uma futura importacao gerenciada devera associar bytes
  por identificador ou hash sem quebrar este contrato.
- `SqliteWorkspaceContextStore` continua a seguir apenas arestas diretas `context` de uma fonte para
  o agente alvo. A mesma autorizacao `read_context` e a regra de autoacesso do ADR 015 aplicam-se a
  todos os tipos; conexoes dependency e handoff nunca liberam fontes.
- O desktop cria e edita essas fontes no canvas. `compasso context` devolve a mesma projecao,
  preservando a redacao de paths de artefatos e sem expor comandos, executaveis ou SQL.

## Consequencias

Canvases existentes continuam validos porque `contextSource` e opcional em nos legados. O estado e
salvo pela migracao de snapshot ja existente, sem DDL adicional. Conteudo de arquivo, pasta e imagem
nao e ingerido neste incremento; ate o importador gerenciado existir, esses nos representam apenas
contexto revisado e metadados seguros.
