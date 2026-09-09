# ADR 0001 — submissao de handoff revisado por adapter

Status: aceito

## Contexto

Um handoff revisado e um pacote de contexto local. Escrever esse pacote no PTY
nao prova que uma CLI interativa o submeteu ou comecou a responder. Claude Code
e Codex recebem texto por uma interface interativa; a acao que confirma o envio
depende do adapter e nao deve ficar escondida no servico generico de handoff.

## Decisao

- `HandoffService` continua responsavel por autorizacao, redacao, persistencia e
  controle de idempotencia.
- Cada `AgentAdapter` implementa `submitReviewedHandoff(control, payload)` por
  meio de um controle privado de terminal. A estrategia registra separadamente
  a insercao do payload e a acao de submissao.
- Claude Code e Codex usam insercao com bracketed paste seguida por uma acao de
  submissao propria. Shell possui estrategia explicita e testavel, embora a UI
  atual entregue handoffs somente para terminais de agentes.
- A entrega so e marcada como `delivered` apos o adapter detectar output novo
  depois da submissao. Isso significa apenas `response_detected`; nao significa
  que a tarefa foi compreendida, concluida ou correta.
- A persistencia mantem uma tentativa local por envio, com estados
  `submitting`, `written_to_terminal`, `submitted_to_agent`,
  `response_detected`, `failed`, `delivery_unknown`, `cancelled` ou
  `manually_marked_sent`.
- Registros legados em `delivering` continuam legiveis e, depois de reinicio,
  sao recuperados como `delivery_unknown` em vez de serem declarados entregues.

## Consequencias

O produto mostra estados honestos: **Inserido no terminal**, **Enviado ao
agente** e **Resposta detectada**. Nao usa o simples sucesso de `write` como
confirmacao. O custo e manter testes de estrategia para cada adapter e exigir
que adapters futuros definam sua prontidao e sua confirmacao de resposta.

Esta decisao nao altera `ProcessSupervisor`, o lifecycle do PTY ou permissoes
do renderer. Nenhum executavel, argumento ou caminho e aceito do renderer.
