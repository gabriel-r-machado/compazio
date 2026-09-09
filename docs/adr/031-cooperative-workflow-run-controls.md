# ADR 031 — Controles cooperativos de runs de workflow

## Contexto

O scheduler determinístico já persistia transições, mas não possuía controles
seguros para pausar, retomar ou cancelar uma run em andamento. Encerrar um
processo de forma opaca ou reiniciar automaticamente violaria a política de
execução local auditável.

## Decisão

- `pause` bloqueia novas unidades de trabalho depois que as unidades já ativas
  terminarem; não finge suspender um processo em execução.
- `resume` é sempre uma ação explícita e libera somente a run pausada.
- `cancel` sinaliza `AbortSignal` ao executor, libera aprovações pendentes e
  marca as unidades ainda não iniciadas como canceladas.
- O scheduler persiste eventos específicos de pausa, retomada, cancelamento e
  cancelamento de nó. O relatório final também registra o estado cancelado.
- No restart, runs nos estados `created`, `running`, `paused` ou `waiting`
  tornam-se `interrupted`; não há tentativa de restaurar processo, terminal ou
  aprovação pendente.

## Consequências

Executores precisam respeitar o sinal de aborto para encerrar seus próprios
recursos. A pausa é cooperativa, portanto uma ação já iniciada só termina após
o executor retornar. Isso preserva consistência e evita estados falsos.
