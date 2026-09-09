# ADR 012 — Spawn local durável de agentes

## Status

Aceito.

## Contexto

A CLI precisa criar agentes sem receber acesso direto a PTYs, executáveis ou APIs genéricas de
processo. A criação também precisa aparecer no canvas, sobreviver a reinícios e respeitar a distinção
entre uma ação humana e uma solicitação feita por outro agente.

## Decisão

- `compasso spawn` grava uma solicitação idempotente no SQLite; a CLI não inicia processos.
- O processo principal reivindica a solicitação, materializa um nó `agent` no canvas e inicia a
  sessão usando o mesmo detector, adapter, supervisor e registro de endpoint dos terminais criados
  pela interface.
- A primeira versão aceita apenas `codex` e `claude-code`. Shell não é agente e OpenCode ainda não
  possui adapter funcional.
- Uma invocação sem `--from` representa a ação local do usuário. Um solicitante informado com
  `--from` precisa ser um agente do mesmo workspace e possuir `create_agents`.
- O lifecycle é `queued`, `spawning`, `running`, `failed` ou `interrupted`, com eventos sem mensagens
  de erro brutas. Um spawn interrompido não é repetido automaticamente.
- O main process publica somente um evento tipado com o nó persistido e a revisão do canvas. O
  renderer mescla essa projeção e nunca recebe um primitive genérico de spawn.
- Se uma sessão for iniciada, mas a confirmação persistida falhar, o dispatcher a encerra para evitar
  processos órfãos.

## Consequências

- O agente criado pode operar mesmo com a janela minimizada, desde que o aplicativo continue ativo.
- A fila e o histórico permitem diagnosticar falhas sem registrar detalhes potencialmente sensíveis
  retornados por CLIs de terceiros.
- `--from` continua sendo identidade estrutural, não uma fronteira criptográfica. Um protocolo de
  autenticação local continua pendente antes de autonomia ampliada.
- Edição detalhada de responsabilidades, constraints e permissões do novo agente continua sendo feita
  pelo canvas depois da criação.
