# Contexto de Arquivos para Agentes V2

Uma conexão com a capacidade `share-context` entre árvore/preview e terminal representa autorização de contexto, não um sandbox fictício.

O payload contém tipo, caminho relativo, revisão opcional, intervalo de linhas, preview limitado ou diff. O backend confirma que os dois nós pertencem ao workspace, que a conexão existe e que o terminal está em execução antes de escrever o contexto. Conteúdo é limitado e eventos operacionais não persistem o arquivo integral.

A Bridge inclui `file-tree create|list|focus`, `file-preview pin`, `git status|diff` e `review open` para orquestradores autorizados.
