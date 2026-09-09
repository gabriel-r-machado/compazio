# Compazio

**Compazio is an open-source, local-first desktop workspace for orchestrating coding agents.**

It puts real terminals, Claude Code, Codex, OpenCode, notes, project files, web Portals and explicit agent-to-agent coordination on the same visual canvas. Compazio does not host a model, resell tokens or hide providers behind a proprietary runtime: it works with tools installed and authenticated on your machine.

> **Status:** Public Beta — `0.2.0-beta.1`
>
> **Current packaged target:** Windows x64
>
> **License:** GNU Affero General Public License v3.0 only (`AGPL-3.0-only`)

## Why Compazio exists

Coding agents are powerful, but multi-agent work quickly becomes hard to inspect: terminals disappear into tabs, context is implicit, handoffs are hidden in prompts and it becomes difficult to understand which process can access which resource.

Compazio keeps that work visible.

- real PTY terminals stay visible on the canvas;
- local agent CLIs keep their native TUI and authentication;
- context is attached explicitly through nodes and connections;
- capabilities are granted through scoped connections instead of ambient access;
- coordination happens through durable structured messages;
- workspace state is local-first and recoverable;
- web Portals run behind an isolated Electron boundary;
- cloud sync, billing, remote control and telemetry are not required to use the desktop.

## What works today

- persistent visual workspaces with pan/zoom, groups, connections and viewport recovery;
- real Shell, Claude Code, Codex, OpenCode and custom-command terminals;
- xterm-based PTY with Unicode, ANSI/truecolor, resize, clipboard and process-tree cleanup;
- Markdown notes and project-managed attachments;
- file tree and file preview nodes;
- contextual Git operations including status, diff, stage, unstage, commit, fetch, fast-forward pull, push, branches and stash;
- isolated web Portals with navigation, screenshots, limited DOM/accessibility inspection and described automation;
- a local ephemeral MCP gateway bound to `127.0.0.1` and scoped per session/workspace/capability;
- visible team coordination between real terminal agents;
- atomic persistence, backups, recovery states and sanitized diagnostics;
- Windows beta packaging with checksums and release metadata.

The beta intentionally does **not** expose hidden autonomous workers, remote execution, scheduled jobs, a model-hosting layer or a marketplace.

## Security model

Compazio executes local processes and touches real project directories, so security boundaries are part of the architecture rather than an afterthought.

Key properties include:

- Electron `contextIsolation` and sandboxing remain enabled;
- renderer code does not receive unrestricted Node.js access;
- privileged operations go through typed/validated IPC;
- process commands and Git operations use separated arguments instead of shell interpolation where applicable;
- Portals are isolated from the main renderer and privileged preload surface;
- the local MCP bridge uses ephemeral session credentials and loopback-only endpoints;
- sensitive diagnostic fields and personal paths are redacted;
- signing private keys, service-role credentials and release tokens are never shipped in the desktop app.

Please read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability or changing a security-sensitive boundary.

## Requirements

For development:

- Node.js 22.13+
- pnpm 11.9 through Corepack
- Git
- native build tools compatible with `better-sqlite3` and `node-pty`
- Docker Desktop only when running local Supabase/RLS tests
- Claude Code, Codex or OpenCode only when testing those adapters with a real local provider

On Windows, install the **Desktop development with C++** workload from Visual Studio Build Tools if a native module needs compilation.

## Development setup

```bash
corepack enable
pnpm install
```

The current desktop entry is V2. Rebuild native modules for Electron and start it with:

```bash
pnpm --filter @forgedeck/desktop native:electron
pnpm dev:desktop:v2
```

If you switch to Node-based tests that load native modules, restore the Node ABI first:

```bash
pnpm --filter @forgedeck/desktop native:node
```

The optional web application is separate from the local runtime:

```bash
pnpm dev:web
```

No production Supabase project, license signing key or release credential is required to work on the open-source desktop core.

## Validation

Repository-wide gates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Electron V2 / Portal validation when relevant:

```bash
pnpm --filter @forgedeck/desktop native:electron
pnpm --filter @forgedeck/desktop build:v2
pnpm test:v2-electron-smoke
pnpm test:portal-integration
pnpm test:portal-electron-smoke
```

Deterministic beta journey:

```bash
pnpm test:beta-e2e
```

Tests that call real local providers are opt-in and may consume credits from your local provider accounts. They are not required for ordinary community pull requests.

## Architecture

```text
renderer / visual canvas
        │
        │ typed preload + validated IPC
        ▼
Electron main process
        ├── workspace + persistence authority
        ├── process supervisor + agent adapters
        ├── Portal runtime / WebContentsView isolation
        ├── local ephemeral MCP gateway
        └── visible team coordination bridge
```

The main process is the authority for privileged process, filesystem, Portal, MCP and lifecycle operations. Structured contracts and persisted events govern state transitions; an LLM is never the source of truth for application state.

### Monorepo

```text
apps/desktop                       Electron + React; active V2 under src/v2
apps/web                           optional Next.js web surface
packages/compazio-v2-domain        workspace/canvas/lifecycle domain
packages/compazio-v2-runtime       process and agent runtime
packages/compazio-v2-persistence   atomic local persistence
packages/agent-sdk                 adapter contracts
packages/agent-adapters            Shell / Claude Code / Codex / OpenCode
packages/terminal                  PTY transport and process-tree cleanup
packages/schemas                   Zod and IPC contracts
packages/local-db                  SQLite / Drizzle and cloud-sync support
packages/git                       contextual Git operations and gates
packages/config                    typed feature flags
packages/logger                    structured logging and redaction
```

The historical `@forgedeck/*`, `.forgedeck` and `compasso` identifiers remain in compatibility surfaces. New public product work should use **Compazio** naming unless a compatibility constraint requires the legacy identifier.

## Data and cloud boundaries

Compazio is local-first:

- application state lives under the user's Compazio application-data directory;
- project-managed notes/attachments live under `.compazio/` in the selected project;
- deleting a Compazio workspace must not delete the selected source-code directory;
- cloud sync, billing and telemetry are optional surfaces rather than requirements for the desktop runtime.

Public `.env.example` files contain placeholders only. Real production secrets belong in local/CI secret stores and must never be committed.

## Releases

The current beta packaging pipeline targets Windows x64:

```bash
pnpm release:windows:beta
```

Official release publication is a maintainer operation because it requires protected credentials and signing/release infrastructure. Community contributors do not need those credentials to build or test the source tree.

Official binaries should be distributed with checksums/release metadata. A build produced by a fork is not an official Compazio release unless explicitly published by the Compazio maintainers.

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md).

Important points:

- keep pull requests focused;
- add or update tests when behavior changes;
- discuss major architecture/security changes before implementing them;
- never commit credentials, user workspaces, production identifiers or personal machine data;
- sign commits with the [Developer Certificate of Origin](https://developercertificate.org/) using `git commit -s`.

Project governance is documented in [`GOVERNANCE.md`](GOVERNANCE.md). Community behavior expectations are in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Documentation

Useful technical references include:

- [`START_HERE.md`](START_HERE.md)
- [`docs/23-current-capabilities.md`](docs/23-current-capabilities.md)
- [`docs/19-development.md`](docs/19-development.md)
- [`docs/20-local-runtime.md`](docs/20-local-runtime.md)
- [`docs/21-canvas-workflows.md`](docs/21-canvas-workflows.md)
- [`docs/22-git-quality.md`](docs/22-git-quality.md)
- [`adr/`](adr/) for architectural decisions

Historical/internal investigation documents are not part of the public API or compatibility contract.

## License

Unless a file states otherwise, Compazio source code is licensed under the **GNU Affero General Public License v3.0 only (`AGPL-3.0-only`)**. See [`LICENSE`](LICENSE).

Dependencies and bundled third-party components retain their respective licenses.

The software license does not grant permission to present modified distributions as official Compazio builds. See [`TRADEMARKS.md`](TRADEMARKS.md).

## Maintainer

Compazio is currently maintained by [Gabriel Machado](https://github.com/gabriel-r-machado).
