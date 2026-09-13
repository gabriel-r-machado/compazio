# Architecture

The current desktop entry is `apps/desktop/src/v2/main/index.ts`. Electron main
owns processes, filesystem access, Git, the local broker and persistence.
The preload exposes validated IPC methods; the React renderer displays the canvas
and never receives unrestricted Node.js APIs.

| Location                           | Responsibility                                       |
| ---------------------------------- | ---------------------------------------------------- |
| `apps/desktop/src/v2/main`         | Workspace services, IPC, broker, files and Portals   |
| `apps/desktop/src/v2/preload`      | Renderer API boundary                                |
| `apps/desktop/src/v2/renderer`     | Canvas, terminal rendering and interaction           |
| `packages/compazio-v2-domain`      | Schemas and shared contracts                         |
| `packages/compazio-v2-runtime`     | Agent and process lifecycles                         |
| `packages/compazio-v2-persistence` | Workspace storage and recovery                       |
| `packages/terminal`                | PTY transport and process-tree cleanup               |
| `packages/local-db`                | SQLite and migrations used by shared/legacy services |
| `apps/web`, `supabase`             | Optional cloud services                              |

The legacy desktop and workflow packages remain for compatibility and migration
tests. Historical TeamRun panels are disabled in the current interface. The
[coordination decision](adr/048-visible-terminal-coordination.md) describes how
visible terminal agents exchange durable requests without hidden workers.

## Local boundaries

Electron windows use context isolation and sandboxing with Node integration
disabled. IPC validates requests in the main process. Agent broker credentials
are ephemeral, tied to sessions and kept out of the renderer. Connections grant
broker capabilities and are checked when tools are called.

These controls do not sandbox user-installed shells or agents. Those processes
have the permissions and provider configuration of the user who launches them.
Untrusted projects and pages can contain malicious instructions; connecting an
agent to their content is a deliberate trust decision.

File services validate workspace containment, including symlinks and junctions;
see [filesystem security](V2_FILE_SYSTEM_SECURITY.md). Remote pages run in isolated
Electron sessions; see [Portal security](V2_PORTAL_SECURITY.md).

The community entitlement service always permits local workspace creation and
does not read commercial activation state or contact a licensing server. The
older entitlement implementation remains covered by compatibility tests but is
not used by the community entry point.
