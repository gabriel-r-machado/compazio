# Start here — Compazio contributors

Compazio is an open-source, local-first desktop workspace for orchestrating coding agents on a visual canvas.
The current public beta is `0.2.0-beta.1`, with Windows x64 as the packaged release target.

## Read first

1. `README.md` — product overview, supported capabilities and architecture.
2. `CONTRIBUTING.md` — setup, pull-request expectations and DCO sign-off.
3. `SECURITY.md` — vulnerability reporting and security-sensitive boundaries.
4. `docs/23-current-capabilities.md` — current product capabilities.
5. `docs/19-development.md` — development workflow.
6. `docs/20-local-runtime.md` — local runtime behavior.
7. `docs/21-canvas-workflows.md` — canvas and workflow model.
8. `docs/22-git-quality.md` — Git and quality-gate behavior.
9. `adr/` — architectural decisions.

## Development

```bash
corepack enable
pnpm install
pnpm --filter @forgedeck/desktop native:electron
pnpm dev:desktop:v2
```

The historical `@forgedeck/*`, `.forgedeck` and `compasso` identifiers remain only where compatibility
requires them. New public product work should use the **Compazio** name.

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

For Electron/runtime changes, also run the native rebuild and the relevant Electron/Portal smoke tests.
Tests that invoke real Claude Code, Codex or OpenCode installations are opt-in and may consume credits
from the contributor's own local provider account.

## Security

Never commit credentials, production identifiers, personal machine paths or private workspace data.
Do not weaken Electron isolation, process-spawn boundaries, filesystem containment, Portal isolation or
session-scoped bridge credentials without tests and an explicit security review in the pull request.

## Contribution model

Keep pull requests focused, add tests for behavior changes, and sign commits with the Developer
Certificate of Origin using `git commit -s`. See `GOVERNANCE.md`, `CODE_OF_CONDUCT.md` and
`TRADEMARKS.md` for project policy.
