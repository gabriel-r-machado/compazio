# ADR 013 — notas estruturadas duráveis no workspace

## Contexto

O canvas já permite notas manuais, mas a CLI precisava registrar decisões e contexto sem depender
do renderer, de um terminal ou de um adapter. Criar somente um nó no canvas não fornece
idempotência, autoria estrutural ou recuperação de uma projeção interrompida.

## Decisão

`workspace_notes` é a fonte de verdade para notas criadas ou alteradas por `compasso note`. Cada
criação ou append atualiza a nota, o nó `note` correspondente e a revisão do canvas dentro da mesma
transação SQLite. `workspace_note_events` mantém uma fila de projeção: ela registra apenas tipo,
sequência, idempotência e hash de conteúdo; o conteúdo permanece na nota.

O processo principal reivindica eventos em ordem, publica um `WorkspaceNoteCanvasEvent` validado
para os renderers e marca a projeção como publicada. Eventos que estavam em entrega depois de um
reinício retornam à fila. O canvas já persistido continua suficiente para a recarga de um renderer
que não estava aberto durante a publicação.

Uma chamada humana não declara autor estrutural. Se a CLI usa `--from`, o nó deve ser um agente
capaz e possuir `create_notes`; essa identidade continua sendo estrutural, não autenticação
criptográfica. Uma nota manual preexistente é adotada de forma preguiçosa quando a CLI a resolve por
ID de nota, ID de nó ou título não ambíguo.

## Consequências

- a CLI não abre processos, não escreve em PTYs e não recebe uma API genérica do desktop;
- o renderer continua recebendo somente uma ponte tipada pelo preload;
- a entrega de eventos pode ser ao menos uma vez, mas a projeção é idempotente porque o estado do
  canvas é persistido antes da publicação;
- títulos duplicados são permitidos, porém uma referência por título ambígua falha de forma
  explícita;
- artefatos e handoffs formais permanecem fora deste comando e serão superfícies próprias.
