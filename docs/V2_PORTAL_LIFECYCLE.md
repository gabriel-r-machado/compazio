# Lifecycle de Portais

`creating → loading → ready` é o caminho normal. Erro de carga do frame principal produz `failed`;
queda do processo de renderização produz `crashed`. O nó do canvas é a descrição persistente; o
runtime nativo é criado apenas quando o workspace ativo o pede.

## Uma View por Portal

O mapa é indexado por `workspace:portal`. Recarregar o renderer replica a descrição de todos os nós,
então `ensure` é idempotente: encontra o runtime existente, atualiza a descrição e devolve o mesmo
snapshot em vez de construir uma segunda `WebContentsView`. Os contadores de diagnóstico
(`views`, `webContents`, `listeners`, `pendingOperations`, `screenshots`, `consoleEntries`,
`sessions`, `attachedViews`, `focusedPortals`) existem para que o smoke consiga acusar duplicação.

## Superfícies nativas e z-order

Uma `WebContentsView` é superfície do sistema operacional: ela pinta por cima do React
independentemente do CSS. Em vez de cada modal reinventar a regra, o `NativeSurfaceCoordinator`
decide a partir do estado da janela — overlay aberto, workspace ativo, minimização, visibilidade do
nó e viewport do canvas.

Modal, menu, Command Palette, Prompt Composer, popover, diálogo, configurações, confirmação
destrutiva e inspector escondem o Portal **sem destruir o runtime**; fechá-los devolve a superfície
sem recriar nada, o que evita o flicker de recriar uma View a cada menu. Fora do workspace ativo a
View é desanexada da janela; fora da viewport ela some em vez de invadir a moldura do produto. A
minimização vem da janela, não do documento: perguntar ao `document` chamaria de minimizada uma
janela apenas encoberta.

## Foco

Clicar no Portal foca o conteúdo. `Esc`, selecionar outro nó, abrir uma superfície acima, trocar de
workspace ou esconder o nó devolvem o teclado ao canvas. "Resetar Foco" alcança os Portais em vez de
parar no React — um Portal desfocado não captura atalhos globais.

## Falha e recuperação

`render-process-gone`, `unresponsive`, `did-fail-load` de frame principal e destruição inesperada
produzem estado visual **Portal falhou**, com motivo amigável, última URL e as ações Recarregar
Portal, Recriar Runtime, Copiar diagnóstico e Excluir.

A recuperação automática tem orçamento por janela de tempo, e **um carregamento bem-sucedido não
devolve tentativas**: uma página que morre logo depois de cada recuperação é justamente o laço que o
limite existe para interromper. Esgotado o orçamento, o Portal permanece visivelmente falho e espera
uma pessoa. Recriar mantém `nodeId`, posição, tamanho, conexões e configurações, descarta a View e
os listeners antigos antes de construir os novos, e revalida a política de URL.

Eventos: `portal.crashed`, `portal.recovery.started`, `portal.recovery.completed`,
`portal.recovery.failed`.

## Destruição

Destruir é idempotente e cancela as operações pendentes daquele Portal antes de desanexar a View,
remover listeners, fechar o `webContents`, limpar o buffer de console e apagar os screenshots
gerenciados. `destroyWorkspace` faz o mesmo para o workspace; `shutdown` cancela tudo com
`application-closing`, destrói cada Portal e limpa o diretório temporário de capturas.
