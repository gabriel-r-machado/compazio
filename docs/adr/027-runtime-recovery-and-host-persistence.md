# ADR 027 — recuperação explícita e persistência do Runtime local

Status: aceito

## Contexto

O Runtime do Compasso mantém filas, leases e sessões PTY em SQLite, mas um processo desktop pode
encerrar de forma inesperada. Reaplicar um comando ou uma criação de agente incerta poderia duplicar
trabalho; manter indefinidamente um lease sem heartbeat impediria a recuperação local. O renderer
também pode ser recarregado, minimizado ou destruído sem que isso seja uma ordem para encerrar o
runtime.

## Decisão

O host envia heartbeat para seus leases a cada cinco segundos. No início, ele remove apenas leases
cujo heartbeat ultrapassou um prazo local limitado e configurado pelo host (padrão de 30 segundos).
Um lease recente nunca é tomado por outra instância.

Após reinício, PTYs persistidos em execução são marcados como `interrupted`; solicitações de lifecycle
em aplicação falham com `application_restart`; mensagens em entrega ficam para revisão; e spawns em
`spawning` viram `interrupted`. Nenhum desses registros é reproduzido automaticamente. A única forma
de tentar novamente um spawn interrompido ou falho é `compasso spawn retry <spawn-id>`, uma ação
humana explícita, auditada e reautorizada pelo Policy Engine. O mesmo nó de canvas é recolocado em
`starting`; não se alega que a sessão PTY original foi restaurada.

Filas de mensagem e de spawn são particionadas por projeto. A concorrência por fila é limitada pelo
host (`FORGEDECK_MAX_CONCURRENT_DELIVERIES_PER_PROJECT`, padrão 2), e permanece limitada pelos tetos
de sessões, payload, buffer e fila já aplicados ao supervisor. Renderer e CLI não recebem essa
configuração nem podem alterá-la.

O Electron encerra PTYs antes de liberar os leases e grava um evento de lifecycle `shutdown` do
host. O `CompassoRuntime` não depende de React ou da janela: reload, minimizar e troca de workspace
preservam sua composição, timers, estado e filas; apenas o fechamento completo aplica a política de
encerramento.

## Consequências

- crash recovery é conservadora e exige uma nova decisão humana para qualquer execução incerta;
- um runtime abandonado não bloqueia um projeto após o prazo de heartbeat;
- não há restore de processo, retry silencioso, processo órfão intencional nem segundo runtime;
- as mudanças de estado são auditáveis sem expor paths, comandos, executáveis, SQL ou output bruto.
