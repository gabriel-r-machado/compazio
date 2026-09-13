# Compazio

A local desktop workspace for coding agents. Keep Claude Code, Codex, OpenCode,
terminals, notes, files and web pages together on a persistent canvas. Connect
sessions to share context and exchange messages through a local broker.

This is the community edition: run it locally, change the code and create as many
workspaces as you need. No account, activation code or subscription is required.
Agent CLIs use your existing installations and provider accounts.

[Product website](https://www.compazio.app/) · [Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

## Run locally

Requires Node.js 22.13+, pnpm 11.9 and Git. Windows x64 is the current desktop
target. On Windows, native modules may require Visual Studio Build Tools with
**Desktop development with C++** and Python.

```sh
git clone https://github.com/gabriel-r-machado/compazio.git
cd compazio
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @forgedeck/desktop native:electron
pnpm dev:desktop
```

The desktop needs no `.env` file. Install and authenticate agent CLIs separately;
an ordinary shell works without an AI account. The `@forgedeck/*` package names
are internal names retained for compatibility.

## What you can do

- Arrange real terminals, notes, files and browser Portals on the canvas.
- Connect agents to exchange messages and explicitly share resources.
- Give a visible agent permission to coordinate a small team.
- Inspect Git changes and keep workspace state on disk with recovery backups.

See [capabilities](docs/23-current-capabilities.md) for the local CLI and limits.
Agents and shell commands run with your operating-system permissions. Canvas
connections govern the Compazio broker; they do not sandbox a CLI's filesystem
or network access.

## Development

The current desktop lives in `apps/desktop/src/v2`. Shared contracts, process
management and persistence are under `packages`. The optional `apps/web` and
`supabase` services are not required for local desktop use.

Read [development](docs/development.md) for checks and native-module setup, and
[architecture](docs/architecture.md) for the code map and security boundaries.

Community builds use a separate application identity and update repository from
the commercial distribution linked on the product website. Windows is the
validated target; macOS and Linux packaging configurations are experimental.

## License

[AGPL-3.0-only](LICENSE). See [TRADEMARKS.md](TRADEMARKS.md) for use of the Compazio
name and logo.
