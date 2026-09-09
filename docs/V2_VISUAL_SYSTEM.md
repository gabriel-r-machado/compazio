# Sistema visual e interação do canvas (V2)

Este documento descreve o sistema visual implementado na experiência operacional V2
(`apps/desktop/src/v2/renderer/ui`) e o modelo de interação do canvas. Ele é a referência para
qualquer alteração de UI: nenhum valor de cor, sombra, raio ou fonte deve ser escrito direto em um
componente.

## Identidade

A identidade é a do manual da marca Compazio: **Precisão. Fluxo. Controle.**

- símbolo: retângulo arredondado com os chevrons `>` e `<` como olhos e um sorriso ao centro,
  desenhado em SVG em `ui/brand.tsx` e herdando `currentColor` — sem arquivo de imagem, sem
  download, sem pontos e sem preenchimento;
- assinatura em caixa alta com tracking largo;
- tema preto absoluto com superfícies em grafite e linhas neutras;
- ícones lineares monocromáticos, todos em `ToolIcon`;
- branco reservado para ação primária, seleção e ênfase.

### Paleta

| Token              | Valor     | Uso                                    |
| ------------------ | --------- | -------------------------------------- |
| `--brand-black`    | `#0a0a0a` | fundo do aplicativo e do canvas         |
| `--brand-graphite` | `#1a1a1a` | superfícies elevadas, cabeçalho de nó    |
| `--brand-gray`     | `#6c6c6c` | texto secundário e ícones inativos       |
| `--brand-light`    | `#e5e5e5` | texto de leitura longa, hover do primário |
| `--brand-white`    | `#ffffff` | ação primária, seleção, foco             |

Cor fora da escala existe apenas para observabilidade — `--v2-success`, `--v2-warning`,
`--v2-danger`, `--v2-info` — e sempre dessaturada. Estado de processo nunca depende só de cor: o
indicador `.v2-state` combina cor, preenchimento do ponto e texto.

### Tipografia

As três famílias são empacotadas via `@fontsource-variable`, importadas no topo de `app.css`. O
desktop precisa abrir sem rede, então nenhuma fonte vem de CDN e nenhuma depende do que o Windows
tem instalado.

- `--v2-font-brand` — Manrope: marca, títulos, números de destaque;
- `--v2-font-ui` — Inter: toda a interface;
- `--v2-font-mono` — JetBrains Mono: terminais, caminhos, diffs, editor leve e horários.

O xterm usa a mesma família mono e um tema derivado da paleta.

## Layout

- **Sidebar** (244px, recolhível): marca, criar workspace, lista de workspaces, e um rodapé com
  licença, updates e exclusão. O botão de recolher fica na barra superior e o estado vive em
  `data-sidebar` no `.v2-app`.
- **Barra superior** (56px): nome e diretório do workspace à esquerda; à direita apenas o que é
  consultado com frequência — política de execução, busca, atenção, Equipe, Histórico — e um menu
  `⋯` com o resto (verificar agentes, responsabilidades, permissões, resetar foco, remover conexões,
  organizar equipe, diagnóstico).
- **Dock flutuante** no topo do canvas: criar terminal e nota, trazer arquivos do computador, abrir
  a árvore do projeto e criar Portal; depois de um divisor, conectar, agrupar e compor prompt. É a
  única barra que cresce com o produto.
- **Controles do viewport** no canto inferior direito: minimapa e a barra de zoom
  (−, porcentagem clicável, +, enquadrar tudo, alternar minimapa).

A regra que evita a barra poluída da versão anterior: a barra superior mostra estado e consulta, o
dock mostra criação, e tudo que é raro vive no menu `⋯`.

## Modelo de interação do canvas

Toda a matemática de viewport é pura e testada em `ui/canvas-viewport.ts`
(`canvas-viewport.test.ts`). O React só entrega coordenadas de ponteiro.

| Gesto                          | Resultado                                            |
| ------------------------------ | ---------------------------------------------------- |
| arrastar o fundo               | anda pelo canvas                                     |
| botão do meio em qualquer lugar | anda pelo canvas, mesmo sobre um nó                  |
| segurar espaço e arrastar      | anda pelo canvas, mesmo sobre um nó                  |
| Shift + arrastar o fundo       | seleção por retângulo (encostar já seleciona)        |
| roda do mouse                  | zoom ancorado no ponteiro                            |
| Shift + roda                   | anda na horizontal                                   |
| arrastar o cabeçalho do nó     | move o nó                                            |
| clique em qualquer parte do nó | seleciona o nó                                       |
| setas / Shift + setas          | empurra a seleção 8px / 24px                         |
| `Ctrl` `+` `-` `0` `1`         | zoom, 100%, enquadrar tudo                           |
| clique no minimapa             | centraliza o canvas naquele ponto                    |
| arrastar a alça da borda do nó | puxa um fio até outro nó e cria a conexão            |
| arrastar a alça do canto       | redimensiona o nó                                    |
| clique duplo no título         | renomeia o nó                                        |
| soltar arquivos do explorador  | traz os arquivos para o canvas onde foram soltos     |

Duas decisões estruturais sustentam isso:

1. **A camada do mundo não recebe ponteiro.** `.v2-world` cobre o canvas inteiro para aplicar a
   transformação; se ela capturasse eventos, o arrasto de fundo morreria — era exatamente o que
   acontecia. Ela é `pointer-events: none` e devolve o ponteiro só aos filhos.
2. **Zoom ancorado no ponteiro.** Zoom em torno da origem faz o canvas fugir de quem está usando.
   `zoomAtPoint` mantém o ponto sob o cursor parado.

### Nível de detalhe

Abaixo de 55% de zoom (`ZOOM_COMPACT`) o nó colapsa para o cabeçalho: título, tipo, estado e
atenção. Um terminal que continua pintando output ilegível é ruído, e o Portal correspondente é
desmontado, o que também esconde a superfície nativa. Acima disso o nó volta inteiro.

### Conexões

Conectar é um gesto direto: quatro alças aparecem nas bordas quando o nó recebe hover ou seleção, e
arrastar de uma delas desenha um fio até onde o ponteiro soltar. O gesto vive na janela porque
atravessa nós, alças e o fundo — nenhum elemento sozinho o enxerga inteiro. Durante o arrasto as
alças ficam `pointer-events: none`, senão o nó de destino nunca seria encontrado sob o cursor.
O botão de conectar da dock continua existindo para quem preferir teclado e seleção.

### Cromo do terminal

A faixa de controles do terminal não rola para o lado: é uma grade de duas colunas onde as
etiquetas encolhem (com máscara de fade) e as ações — ligar/parar, reiniciar, configurar — ficam
fixas à direita como ícones. O título saiu da faixa e vive no cabeçalho do nó, editável com clique
duplo. Redimensionar usa alça própria no canto inferior direito: o `resize` nativo do CSS fica
inalcançável atrás do conteúdo do nó, e o delta precisa ser dividido pelo zoom para o card
acompanhar o ponteiro.

### Arquivos

O botão **Arquivos** da dock abre o seletor do sistema operacional — markdown, texto, imagem, PDF ou
mídia — e cada arquivo escolhido vira um card. Arrastar do explorador direto para o canvas faz o
mesmo, e o card cai onde foi solto. A árvore de arquivos do projeto continua disponível no botão ao
lado. O limite local-first é preservado copiando para dentro do workspace o que vem de fora; a regra
está em `docs/V2_FILE_SYSTEM_SECURITY.md`.

### Portais

A superfície nativa do Portal não é recortada por CSS. O card reserva o bloco que ela deve ocupar, o
retângulo é interseccionado com a área do canvas e a escala do canvas é repassada como `canvasZoom`.
Detalhes em `docs/V2_BROWSER_PORTALS.md`.

### Minimapa

O minimapa projeta a união dos limites dos nós com o retângulo visível, então a viewport aparece
mesmo quando está longe de qualquer nó — não existe estado em que a pessoa "se perde" sem uma volta
de um clique.

## Acessibilidade e movimento

- foco visível em branco com `outline-offset` em todo controle;
- todo botão só de ícone tem `aria-label` e `title`;
- o cabeçalho do nó é focável e responde a Enter/Espaço;
- o minimapa é `role="button"` com teclado;
- `prefers-reduced-motion` desliga transições e a animação de fluxo das conexões.

## Contrato

`ui-contract.test.ts` trava o que não pode regredir: tokens da marca, importação local das fontes,
`pointer-events` da camada do mundo, presença do dock e do menu `⋯`, os gestos de pan, marquee, zoom
ancorado e minimapa, o fio de conexão com as alças fora do caminho durante o arrasto, a faixa do
terminal sem rolagem horizontal, a entrada de arquivos pelo seletor e pelo drop, e a medição da
superfície do Portal. `canvas-viewport.test.ts` cobre a matemática do viewport e
`file-system-service.test.ts` cobre a cópia de anexos sem sobrescrita.
