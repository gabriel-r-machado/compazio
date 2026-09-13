# Development

Install dependencies with `pnpm install --frozen-lockfile`. The desktop requires
no cloud credentials. `pnpm dev:desktop` starts the current V2 entry;
`pnpm dev:desktop:v2` is an alias. The legacy entry remains available through
`pnpm --filter @forgedeck/desktop dev:legacy` for compatibility work.

## Native modules

Electron and Node use different native-module ABIs. Before running the desktop:

```sh
pnpm --filter @forgedeck/desktop native:electron
pnpm dev:desktop
```

Before running Node-based tests after an Electron rebuild:

```sh
pnpm --filter @forgedeck/desktop native:node
```

On Windows, native compilation requires Python and Visual Studio Build Tools
with the C++ desktop workload. Avoid running Node tests while rebuilding modules
for Electron.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm --filter @forgedeck/desktop build:v2
pnpm --filter @forgedeck/desktop native:electron
pnpm test:v2-electron-smoke
```

Use a targeted Vitest path during development. CI runs portable checks on Linux
and macOS, and native/integration checks on Windows. Tests with `real-agents` or
`e2e-local` in their name launch installed providers and may use account credits;
run them only when you intend to use those accounts.

The optional web app starts with `pnpm dev:web`. Its environment variables are
documented in `.env.example`; privileged keys belong only in server environments.
Local database policy tests require Docker and `pnpm exec supabase start`, followed
by `pnpm exec supabase test db --local supabase/tests/database`.

## Packaging

`pnpm --filter @forgedeck/desktop package:windows` builds the community installer
locally without publishing. It uses `com.compazio.community` and the
`Compazio Community` user-data directory. Updates and release scripts target
`gabriel-r-machado/compazio`.

The manual release workflow creates a draft. Check the installer, checksums,
source revision and signing status before publishing. Do not describe unsigned
builds as signed or experimental platforms as supported.
