# ADR 016 — Núcleo de terminais e conexões reais

- Status: aceito
- Data: 2026-08-13

## Contexto

O Compazio é um desktop local-first cujo produto é o canvas contendo terminais reais e visíveis.
A camada de coordenação anterior introduziu processos privados, cartões de execução gerenciada e
conclusão inferida a partir de output ou encerramento. Isso criou dois runtimes diferentes e tirou
do usuário a observabilidade do trabalho.

## Decisão

1. Todo terminal mostrado no canvas é uma sessão PTY real, pertencente ao único supervisor V2.
2. xterm é o dono da interação humana; IPC encaminha bytes sem transformá-los em chat ou linhas.
3. Uma conexão terminal-terminal com `send-message` é uma permissão bidirecional para mensagens.
4. Mensagens são solicitações locais duráveis. A entrega escreve um envelope visível no PTY real
   do destinatário; conclusão exige `compazio reply`, nunca silêncio, output ou exit code.
5. Tokens e shims são efêmeros por sessão e nunca entram no renderer ou no workspace persistido.
6. Shell e terminais customizados não recebem tarefas automaticamente, pois texto seria executado
   como comando. Somente providers de coding agent são destinatários válidos no núcleo.
7. TeamRun, workers pipe-backed, notebooks obrigatórios e coordenação automática ficam fora do
   caminho padrão. Qualquer evolução futura será uma capacidade de um terminal real e visível,
   atrás de `orchestratorMode`, desativada por padrão.
8. Configuração e permissões nativas de Claude, Codex e OpenCode são preservadas. O Compazio pode
   acrescentar instruções e MCP process-scoped, mas não substituir sandbox, approval ou perfil.

## Consequências

- A UI e a bridge compartilham o mesmo runtime observável.
- Requests sobrevivem a restart e podem ser recuperados com `compazio inbox`.
- Um adapter falso continua permitido apenas em testes do contrato de processo; não é evidência de
  aceite nem pode substituir um terminal na interface.
- Dados operacionais antigos permanecem legíveis para migração, sem dirigir o runtime principal.
