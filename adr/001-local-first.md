# ADR 001 — Local-first

## Status

Accepted.

## Decisão

Projetos, terminais, prompts, output e runs são locais por padrão. Conta e cloud são opcionais.

## Consequências

- maior confiança;
- app funciona offline;
- arquitetura com SQLite + Supabase;
- sync exige modelo explícito;
- não há dashboard cloud completo no MVP.
