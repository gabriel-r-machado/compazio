# Portal security

## Remote-content isolation

Portals are created with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
`webSecurity: true`, `webviewTag: false`, `nodeIntegrationInSubFrames: false` and experimental
features disabled. The Electron main process exclusively owns each `WebContents`; the Compazio
renderer never receives `Session`, `WebContents` or generic automation capability. It can request
only allowlisted operations through typed, Zod-validated IPC.

## URL policy

`https:` is allowed. `http:` is limited to `localhost`, `127.0.0.1`, `::1` and RFC1918 networks for
local development and test fixtures. `file:`, `data:`, `javascript:` and unknown protocols are
rejected with `PORTAL_PROTOCOL_BLOCKED`, both for requested navigation and `will-navigate` events
initiated by the page itself.

## Connection-based authorization

Controlling a Portal requires a directed terminal → Portal edge with the `portal-control`
capability. Team coordination does **not** grant Portal access by itself. Without the connection,
the request receives `PORTAL_NOT_CONNECTED`. Removing the connection, terminal or Portal revokes
access immediately and cancels in-flight operations for that pair.

`compazio portal list` shows workspace Portals together with whether each one is `controllable` by
the current terminal. Listing is not control; the agent can discover what exists without receiving
an implicit capability.

## Popups, permissions and media

`setWindowOpenHandler` denies new windows and records `portal.popup.blocked`. Permission request and
check handlers deny camera, microphone, geolocation, notifications and clipboard access. System
screen capture is rejected without a picker.

## Downloads

Downloads require an explicit human decision. A page proposes **a filename, never a path**:
separators, traversal, control characters and Windows device names are sanitized; the destination
must remain inside the authorized directory; and an existing file is renamed instead of silently
overwritten. Without a response to the Compazio dialog, nothing is written or opened automatically.
Each decision emits an event (`portal.download.requested`, `.accepted`, `.cancelled`, `.completed`,
`.failed`).

## Data that never leaves the Portal

DOM, accessibility-tree and console results are returned as data rather than Electron objects. They
exclude cookies, `localStorage`, `sessionStorage`, tokens, request headers, network bodies and
Electron APIs. Sensitive field values such as passwords, card data, secrets, tokens and CVVs are
omitted, and console output is redacted before storage.

## Sessions

Each isolated Portal uses its own persistent partition. `workspace-shared` shares a partition only
between Portals in the same workspace that declare the same `sessionKey`. The domain layer creates
the key; the renderer never chooses an Electron partition name.

## Local MCP gateway

The MCP gateway listens only on loopback (`127.0.0.1`) and validates Host, Origin and bearer token
on every request. Tokens are random, expiring and bound to a terminal and workspace; only the hash
is retained in main-process memory. Tokens are not persisted, sent to the renderer or written to
logs.

An MCP transport session does not replace the Compazio authorization session. Even after
`initialize`, every call revalidates token, expiration, revocation, terminal, workspace, capability
and the terminal → Portal edge with `portal-control`. A coordinator without that edge still receives
`PORTAL_NOT_CONNECTED`.

## Real client MCP configuration

Claude Code and Codex receive temporary per-process configuration and a token only in the child
process environment. The token is not persisted, shown in the renderer, included in prompts or
logged. The OpenCode 1.17.7 harness follows the same rule: it creates `opencode.jsonc` under a
temporary `XDG_CONFIG_HOME` with `Bearer ${COMPAZIO_MCP_TOKEN}`, deletes the directory during
cleanup and never changes the user's global configuration. Provider unavailability does not relax
capabilities, shell access or permission boundaries.
