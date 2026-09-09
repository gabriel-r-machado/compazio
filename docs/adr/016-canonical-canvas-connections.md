# ADR 016 — conexões canônicas de canvas pelo Compasso

Status: aceito

## Contexto

O canvas já persistia arestas em `canvas_edges`, enquanto o primeiro comando `compasso connect`
era limitado a uma rota de contexto. Criar uma tabela ou DTO exclusivo para a CLI faria o desktop e
a linha de comando divergirem e impediria que uma remoção fosse refletida no canvas aberto.

## Decisão

`canvas_edges` permanece o único modelo de conexão. O serviço local de conexões consulta e altera
essas mesmas arestas, usando o contrato versionado para representar os tipos `context`, `handoff`
e `dependency`.

`workspace_connection_events` registra a criação e a remoção, o autor estrutural, a revisão do
canvas e a projeção pendente. Esses eventos não duplicam o estado da conexão: são o histórico
auditável e a fila que entrega a mesma aresta ao renderer.

O CLI expõe `connect create`, `list`, `show` e `remove`, além do atalho de criação. Referências de
origem e destino são resolvidas por ID ou título sem ambiguidade. A criação rejeita self-loop,
duplicata de rota e ciclos formados por `dependency` ou `handoff`. `context` é a única conexão que
libera fontes para `compasso context`, e exige nota/artefato publicado como origem e agente como
destino.

Quando `--from` identifica um agente, ele deve possuir `connect_context`; para contexto, só pode
criar ou remover a rota do próprio agente. A CLI e o evento IPC retornam IDs, tipos, rótulos e
revisões, sem paths locais, comandos, executáveis ou SQL.

## Consequências

- conexões criadas pelo desktop continuam listáveis e removíveis, sem migração para um segundo
  modelo;
- conexões antigas de nota/artefato para agente são migradas para o tipo explícito `context`;
- o renderer recebe criação e remoção pela fila durável existente e atualiza sem reload;
- a identidade de `--from` continua estrutural, não uma autenticação criptográfica;
- esta decisão não cria planejamento autônomo, equipes automáticas ou orquestração.
