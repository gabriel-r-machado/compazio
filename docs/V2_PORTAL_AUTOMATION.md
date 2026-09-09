# Automação de Portais

Automação de Portal é sempre **descrita**, nunca escrita. A página recebe uma função fixa, montada
em tempo de build, e um argumento JSON; entrada de automação por isso não pode virar script. O
comando `portal evaluate` não existe mais como caminho alternativo — código arbitrário responde
`PORTAL_EVALUATE_DENIED`.

## Superfície

`compazio portal <ação> [id] [opções]`, disponível para qualquer terminal com conexão
`portal-control` para aquele Portal:

| Ação                                     | O que faz                                                |
| ---------------------------------------- | -------------------------------------------------------- |
| `list`                                   | Portais do workspace, com `controllable` por terminal    |
| `get <id>`                               | Estado atual: título, URL, histórico, falha, superfície  |
| `create [url]`                           | Cria o nó; controlar ainda exige conexão explícita       |
| `navigate <id> <url>`                    | Navega dentro da política de URL                         |
| `back` `forward` `reload` `stop` `focus` | Controles de navegação e foco                            |
| `click <id> [alvo]`                      | Clique por acessibilidade, texto, seletor ou coordenadas |
| `type <id> --text "..."`                 | Digita em campo editável, com `--clear` opcional         |
| `press <id> <tecla>`                     | Uma tecla validada, nunca uma sequência arbitrária       |
| `scroll <id> [--direction] [--amount]`   | Viewport ou elemento                                     |
| `screenshot <id>`                        | Referência gerenciada com validade                       |
| `dom <id> [--query]`                     | DOM limitado e sanitizado                                |
| `accessibility <id> [--role --name]`     | Árvore acessível ou busca                                |
| `console <id> [--level --limit --since]` | Buffer circular por Portal                               |
| `viewport <id>`                          | Tamanho, rolagem e proporção de pixels                   |
| `cancel <correlationId>`                 | Cancela uma operação em andamento                        |
| `close <id>`                             | Destrói o runtime; o nó permanece no canvas              |

Opções globais: `--timeout <ms>` dentro de um limite seguro e `--correlation <id>` para poder
cancelar depois.

## Localização de elementos

A prioridade existe para que o agente descreva o alvo como uma pessoa o leria na tela:

1. `role` + nome acessível (`--role button --name Incrementar`);
2. `label` do campo (`--label Nome`);
3. texto visível (`--text "Segunda página"`);
4. seletor CSS explícito (`--selector "#name"`);
5. coordenadas, apenas quando pedidas (`--x 120 --y 48`).

`type` valida que o elemento é editável, foca, limpa quando solicitado, digita e dispara os eventos
normais de entrada — inclusive pelo setter nativo, para que campos controlados por framework
enxerguem a mudança. Campo sensível nunca tem o valor ecoado de volta.

`press` aceita somente `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, setas, `Home`, `End`,
`PageUp`, `PageDown` e `Space`, com modificadores opcionais. Qualquer outra tecla responde
`PORTAL_INVALID_KEY`.

## Timeout e cancelamento

Toda operação recebe `correlationId`, timeout padrão de 15 s (limite de 120 s), `AbortSignal` e
limpeza de timer. Cancelar é idempotente e nomeia a causa; nenhuma Promise fica pendente para
sempre. As operações são canceladas quando a conexão é removida, o terminal ou o Portal é excluído,
o workspace é trocado ou fechado, o aplicativo encerra, o WebContents cai, o usuário cancela ou o
tempo expira.

Erros estruturados: `PORTAL_TIMEOUT`, `PORTAL_OPERATION_CANCELLED`, `PORTAL_NOT_CONNECTED`,
`PORTAL_DESTROYED`, `PORTAL_CRASHED`, `PORTAL_NOT_FOUND`, `PORTAL_ELEMENT_NOT_FOUND`,
`PORTAL_ELEMENT_NOT_EDITABLE`, `PORTAL_INVALID_KEY`, `PORTAL_DOM_LIMIT_EXCEEDED`,
`PORTAL_PROTOCOL_BLOCKED`, `PORTAL_EVALUATE_DENIED`.

## DOM limitado

O retorno é serializável e limitado por nós, profundidade, caracteres, filhos e classes. Scripts e
estilos ficam de fora; atributos seguem allowlist; `href` e `src` voltam sanitizados; campo sensível
é marcado sem valor. Ultrapassar o limite responde `PORTAL_DOM_LIMIT_EXCEEDED` com os limites
aplicados, para que o agente estreite a consulta com `--query` em vez de pedir a página inteira.
Cookies, `localStorage`, `sessionStorage`, tokens e headers nunca são lidos.

## Árvore acessível

Cada nó traz `role`, nome acessível, estados (`disabled`, `checked`, `selected`, `expanded`,
`required`, `readonly`, `focused`), valor apenas quando seguro e limites opcionais. A busca aceita
`role`, nome ou os dois — é assim que o agente encontra botão, campo, checkbox, select, link,
heading e formulário sem depender de seletores frágeis.

## Console

Um anel por Portal, com capacidade fixa, filtro por nível e por texto, cursor para ler apenas o que
é novo e contagem do que foi descartado. `Authorization`, `Cookie`, `Set-Cookie`, JWT e chaves
conhecidas são redigidos antes de armazenar; o buffer é esvaziado quando o Portal é destruído.

## Screenshots

O nome vem do backend, o arquivo vive em diretório temporário gerenciado, a resolução tem teto, a
referência expira e o número por Portal é limitado. Excluir o Portal ou fechar o aplicativo apaga os
arquivos; `screenshotOrphans()` existe para que o smoke consiga acusar sobra.
