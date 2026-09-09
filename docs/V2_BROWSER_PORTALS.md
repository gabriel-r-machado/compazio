# Browser Portals

Um Portal é um nó persistente do canvas que abre conteúdo remoto em um `WebContentsView` isolado. Ao reabrir um workspace, o nó é restaurado como dados e seu runtime é criado somente quando solicitado pelo workspace ativo.

O Portal oferece URL, navegação, voltar, avançar, atualizar, foco, captura de tela e automação limitada. O conteúdo remoto não possui Node.js, preload privilegiado, sessão padrão ou acesso ao renderer do Compazio.

Excluir o nó encerra a view, remove listeners e apaga screenshots temporários associados. `PortalRuntimeManager.shutdown()` executa a mesma limpeza para o encerramento do aplicativo.

## Capability MCP nativa

Clientes de agente nao dependem do shell para consultar Portais. O processo principal hospeda um
gateway MCP Streamable HTTP em `127.0.0.1` e usa o SDK oficial MCP. Nesta primeira fatia, a unica
ferramenta registrada e `portal_list`; ela reutiliza a mesma autorizacao `portal-control` usada pela
CLI e pelo runtime, sem expor `WebContents`, `Session`, token ou IPC generico.

O transporte MCP e a sessao de autorizacao do Compazio sao entidades distintas. Cada sessao
Compazio possui token efemero mantido apenas em memoria como hash, escopo de workspace e terminal,
capabilities e expiracao. Revogar a sessao, o terminal ou o workspace fecha os transports ligados.
O cliente precisa enviar o Bearer token em toda requisicao; o MCP session ID nunca concede acesso.

## Limites da superfície no canvas

A view do Portal é uma superfície nativa sobre a janela: ela não é filha do canvas, não herda o
transform do mundo e não é recortada por `overflow`. Sem cuidado explícito ela aparece por cima da
barra superior, da sidebar ou fora do próprio nó.

O card reserva um bloco (`.v2-portal-surface`) e é ele que define os limites:

- as medidas saem do bloco reservado, nunca de deslocamentos fixos;
- o retângulo é interseccionado com a área do canvas; sobrando menos de 12px o Portal fica invisível
  em vez de vazar;
- `canvasZoom` acompanha a escala do canvas e o processo principal aplica
  `zoomFactor * canvasZoom` na página, para o conteúdo caber no nó em qualquer zoom;
- a sincronização acontece a cada pan, zoom, movimento e redimensionamento — não apenas no resize
  da janela;
- abaixo do limite de detalhe do canvas o card é desmontado, o que também esconde a superfície.
