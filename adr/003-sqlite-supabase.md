# ADR 003 — SQLite + Supabase

## Status

Accepted.

## Decisão

SQLite é fonte de verdade local. Supabase é fonte de verdade para conta/equipe/entitlements e resumos sincronizados.

## Motivo

Separar runtime sensível e offline de recursos SaaS.

## Consequência

É proibido depender de Supabase para iniciar agentes locais.
