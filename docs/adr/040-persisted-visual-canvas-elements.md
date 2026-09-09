# ADR 040 — elementos visuais persistidos no canvas

## Contexto

O Modo Livre precisa permitir que uma pessoa explique um fluxo no proprio canvas, sem converter cada
forma, comentario ou grupo em uma dependencia de runtime. A projecao ja preserva posicao, tamanho e
dados de no no SQLite, mas nao possuia tipos visuais nem ordem de camada persistida.

## Decisao

- `shape`, `frame` e `comment` sao tipos explicitos de no no snapshot de canvas. Shape declara
  `rectangle`, `ellipse` ou `diamond`; frame declara a lista limitada de membros; comment guarda
  apenas anotacao local limitada.
- A coluna aditiva `canvas_nodes.z_index` preserva a camada de um frame atras dos seus membros.
  Snapshots antigos deixam a coluna nula e continuam equivalentes ao comportamento anterior.
- Criar grupo a partir da selecao calcula um frame visual e registra os IDs dos membros. A exclusao
  de um no remove sua referencia dos frames restantes; copiar um fragmento remapeia apenas os IDs
  presentes no fragmento.
- Shape, frame e comment nao expoem handles e nao oferecem conexao, handoff ou contexto. As setas
  existentes continuam sendo os contratos versionados de edge e agora usam marcador direcional.
- Progresso (`progressPercent`) e motivo de bloqueio (`blocker`) sao metadados locais opcionais de
  qualquer no operacional. Eles aparecem no canvas e podem ser alterados pelo menu contextual, mas
  nao autorizam execucao, nao liberam contexto e nao mudam uma run ja iniciada.
- Previews de fontes de contexto mostram somente conteudo revisado ja presente no no, host HTTPS ou
  metadados limitados (tipo e prefixo de hash). A interface reforca que uma fonte exige uma aresta
  direta `context`; uma lista de capacidades declaradas continua sendo apenas visual, nunca uma
  concessao de permissao.

## Consequencias

Os elementos sao organizacao visual local, nao workflow executavel. Eles nao criam permissoes,
nao atravessam o Policy Engine como fontes de contexto e nao alteram workflow runs ja iniciados.
Frames acompanham a selecao no momento da criacao; eles nao introduzem uma hierarquia que mova ou
redimensione membros automaticamente.
