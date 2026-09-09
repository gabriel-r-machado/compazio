# Contributing to Compazio

Thanks for helping improve Compazio. The project welcomes bug fixes, documentation, tests, integrations and focused product improvements.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- For significant behavior, architecture, persistence, security, IPC or runtime changes, open an issue first so the direction can be discussed.
- Keep pull requests focused. Avoid unrelated refactors in the same change.
- Never include real credentials, private workspace data, personal paths, production identifiers or customer data in fixtures, logs, screenshots or documentation.

## Development setup

Requirements:

- Node.js 22.13+
- pnpm 11.9 through Corepack
- Git
- Native build tools required by `better-sqlite3` and `node-pty`
- Docker Desktop only when running local Supabase/RLS tests

Install dependencies:

```bash
corepack enable
pnpm install
```

Run the desktop V2 development entry:

```bash
pnpm --filter @forgedeck/desktop native:electron
pnpm dev:desktop:v2
```

When switching back to Node-based tests that load native modules:

```bash
pnpm --filter @forgedeck/desktop native:node
```

## Quality gates

Run the relevant checks before opening a pull request. For changes that can affect the whole repository, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

For Electron V2 and Portal changes, also run the applicable smoke/integration checks documented in the README.

Tests that invoke real Claude Code, Codex or OpenCode installations are opt-in because they can consume local account credits. Do not make those tests mandatory for ordinary contributors.

## Pull requests

A good pull request:

1. explains the problem and why the change is needed;
2. describes the implementation at the level needed to review it;
3. includes or updates tests when behavior changes;
4. documents security, persistence or migration impact when applicable;
5. does not weaken Electron isolation, IPC validation, path validation, Portal isolation or secret redaction without an explicit security rationale;
6. keeps generated files, local artifacts and credentials out of Git.

Maintainers may ask for an ADR under `adr/` when a change introduces a long-lived architectural decision.

## Commit sign-off (DCO)

Compazio uses the Developer Certificate of Origin (DCO 1.1). By signing off a commit you certify that you have the right to submit the contribution under the project's license.

Add a sign-off with:

```bash
git commit -s -m "fix: describe the change"
```

This adds a `Signed-off-by:` trailer using your Git identity. Pull requests should contain signed-off commits before merge.

The DCO text is available at https://developercertificate.org/.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow `SECURITY.md`.

## License

Unless a file says otherwise, contributions are accepted under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). By contributing, you agree that your contribution may be distributed under that license.

The Compazio name and logos are not granted by the software license. See `TRADEMARKS.md`.