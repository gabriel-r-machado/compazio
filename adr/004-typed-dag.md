# ADR 004 — DAG tipado

## Status

Accepted.

## Decisão

Workflows são DAGs validados por JSON Schema. O scheduler é determinístico.

## Motivo

Evitar loops opacos e decisões de controle baseadas somente em texto de LLM.

## Consequência

Planos gerados por agentes precisam ser validados e aprovados.
