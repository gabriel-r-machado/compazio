# ADR 026 — lifecycle manual e auditável do Runtime

Status: aceito

## Contexto

O runtime local precisava oferecer pausas, drenagem, cancelamento e encerramento explícitos sem
introduzir scheduler, planejamento autônomo ou um novo canal de shell remoto. A CLI já é um cliente
local autenticado do banco, mas não pode controlar processos por paths, executáveis ou comandos
arbitrários.

## Decisão

As migrations de lifecycle adicionam um estado singleton, comandos persistidos e eventos de auditoria
redigidos. A CLI aceita somente:

`compasso runtime <status|start|pause|resume|drain|cancel|shutdown>`.

Ela não aceita `--from`, portanto um agente não pode controlar o runtime como identidade estrutural.
O Runtime consulta exclusivamente comandos tipados, em ordem, e registra a aplicação ou falha com um
código sanitizado. Não há paths, comandos de processo, executáveis, output ou SQL nos registros.

`pause` interrompe dispatchers futuros e preserva PTYs ativos. `drain` interrompe novos ciclos e
processa a fila durável atualmente reivindicável antes de pausar. `cancel` encerra explicitamente os
PTYs ativos. `shutdown` também libera os leases de projeto; um `start` posterior precisa adquiri-los
de novo. O loop de controle continua no processo desktop para aceitar um `start` explícito após
shutdown, mas não inicia trabalho por conta própria.

## Consequências

- cada transição solicitada e aplicada é auditável e persiste fora do renderer;
- o desktop pode continuar aberto com o runtime pausado ou desligado;
- dois runtimes não passam a atender o mesmo projeto ao retomar;
- reidratação de comandos interrompidos, heartbeat, quotas e filas por projeto continuam nos
  incrementos B3 e B4.
