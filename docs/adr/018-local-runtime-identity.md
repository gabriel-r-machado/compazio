# ADR 018 — identidade autenticada do runtime local

Status: aceito

## Contexto

`--from` identifica estruturalmente um nó do canvas para as permissões já persistidas, mas não
prova qual processo local executou a CLI. O runtime precisava de uma identidade local auditável e
rotacionável sem expor uma superfície de comandos no renderer ou em uma porta de rede genérica.

## Decisão

O SQLite passa a registrar identidades locais, sessões e eventos de autenticação. A sessão guarda
somente hashes de token e nonce, tem prazo limitado e é revogada ao emitir uma nova sessão para a
mesma identidade. O desktop registra as identidades `user`, `runtime`, `cli` e `orchestrator`; a
sessão da CLI é rotacionada a cada início do runtime.

O processo principal expõe apenas `GET /v1/health` em `127.0.0.1` e porta efêmera. A chamada exige
`Bearer token`, nonce e ID da identidade, e devolve somente o estado e a classe da identidade. Não
aceita caminhos, comandos, executáveis, SQL, corpo de requisição nem origem renderer. Rejeições são
auditadas e não revelam segredos.

O manifesto de runtime por projeto pode carregar essa credencial efêmera para a CLI local. Ele é
criado como arquivo privado, não cruza IPC, não é impresso pela CLI e não é enviado para cloud. A
CLI autenticada verifica o endpoint antes de abrir o banco; um manifesto legado sem endpoint e o
override explícito de banco mantêm a compatibilidade anterior.

## Consequências

- a identidade de runtime é verificável e os tokens brutos não entram no SQLite;
- reiniciar o desktop invalida as credenciais de manifesto anteriores;
- a porta loopback não se torna uma API de controle remoto ou execução;
- isto ainda não transforma `--from` em autorização central: o Policy Engine do Lote A7 aplicará a
  decisão comum às operações e preservará a regra de que agentes não podem ampliar permissões;
- processos com acesso ao mesmo perfil local continuam dentro do limite de confiança local-first.
