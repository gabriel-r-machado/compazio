# ADR 002 — Electron no MVP

## Status

Accepted for MVP.

## Contexto

O time é TypeScript-first e precisa integrar PTY, processos, filesystem e Git em Windows/macOS/Linux rapidamente.

## Decisão

Usar Electron com segurança reforçada e otimizações.

## Motivos

- integração madura com node-pty;
- menor custo cognitivo;
- mais fácil para Claude/Codex gerarem e manterem;
- testes cross-platform acessíveis;
- um único ecossistema principal.

## Tradeoff

Consumo de memória maior que uma solução nativa/Tauri.

## Mitigação

- um renderer;
- virtualização;
- buffer limitado;
- batching;
- profiling;
- lazy loading;
- sem browser views excessivas.

## Reavaliação

Só considerar Tauri após profiling demonstrar que Electron inviabiliza o produto.
