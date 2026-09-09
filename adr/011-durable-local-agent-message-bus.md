# ADR 011 — Caixa postal local durável para mensagens entre agentes

## Status

Aceito.

## Contexto

O canvas já possui handoffs revisados, mas ferramentas externas ainda não conseguem descobrir um
agente ou deixar uma solicitação sem depender do foco do renderer. Enviar diretamente a um PTY por
um CLI externo exigiria expor handles de processo, criar um socket sem protocolo persistente ou
tratar uma escrita como prova de conclusão.

## Decisão

- O SQLite local será a autoridade da caixa postal informal do Modo Livre.
- A CLI apenas descobre agentes e grava mensagens idempotentes; ela nunca acessa PTY diretamente.
- O processo main registra o vínculo entre nó, workspace, adapter e sessão ativa.
- Um dispatcher no main process reivindica mensagens enfileiradas e usa `AgentAdapter.sendMessage`.
- Cada transição gera um evento estruturado sem copiar o conteúdo da mensagem para o evento.
- Respostas referenciam a solicitação original e só aceitam como `--from` seu destinatário
  estrutural. Quando existe um agente remetente, a resposta retorna pela mesma fila.
- Terminais de shell puro não entram no diretório nem recebem mensagens.
- `sent` significa somente que o adapter escreveu a solicitação na sessão. Não significa resposta,
  compreensão, conclusão ou aprovação.
- Uma entrega encontrada em andamento após reinício vira `delivery_unknown`. Não há retry
  automático.
- Handoffs revisados continuam em seu store e lifecycle próprios; mensagens informais não liberam
  dependências de workflows.

## Consequências

- Mensagens sobrevivem ao fechamento ou à perda de foco da janela enquanto o banco local existir.
- Um agente offline mantém a mensagem em `queued` até possuir uma sessão vinculada.
- O polling local adiciona latência limitada, atualmente 250 ms, sem introduzir servidor de rede.
- A primeira versão da CLI precisa receber o caminho do banco do desktop por `COMPASSO_DB_PATH` ou
  `--database`; descoberta automática do runtime fica para o empacotamento.
- Notas e artefatos ainda precisam de contratos e comandos próprios. Spawn possui lifecycle próprio
  no ADR 012.
