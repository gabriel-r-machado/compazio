# Current capabilities

This document describes the active Compazio Community product. Historical TeamRun and automatic
coordination code may remain for compatibility, but it does not define the default runtime.

## Core

- Persistent local-first canvas with position, size, groups, connections and viewport state.
- Terminals can be created by click/shortcut or by drawing a rectangle on the canvas.
- Visible xterm-based terminals backed by a real PTY on Windows (ConPTY/node-pty), with shell,
  Claude Code, Codex, OpenCode and custom-command adapters.
- Transactional terminal creation: a failed preflight or spawn removes the newly created node and
  surfaces the error.
- A single input path: `xterm → typed IPC → workspace service → supervisor → PTY`.
- Serialized writes, resize during startup, stop/restart and process-tree cleanup.
- Clipboard, selection, scrollback, wheel, Unicode, ANSI/truecolor and bracketed paste through xterm.
- Markdown notes stored at `<project>/.compazio/notes/<id>.md`, with atomic replacement, backup,
  workspace containment and reload after observed external edits.
- File tree, previews and browser Portals.
- Search/palette across actions, workspaces, terminals, notes and files.
- Ephemeral coding-agent bootstrap without changing the user's provider authentication, profile,
  sandbox or approval settings.
- Portal MCP access only when a connection explicitly grants the Portal capability.

## Explicit connections

A connection is an explicit capability grant:

| Pair                | Default capabilities                                    |
| ------------------- | ------------------------------------------------------- |
| terminal ↔ terminal | Bidirectional messages and shared context               |
| terminal → note     | Read, replace, append and share context                 |
| note ↔ note         | Context chaining                                        |
| terminal → Portal   | Read, control, screenshot and context, all explicit     |
| terminal → file     | Context sharing without implicit execution              |

Each Claude Code, Codex or OpenCode session receives an ephemeral token and a private `compazio` CLI:

```text
compazio me
compazio list
compazio send <destination> "<message>" [--wait] [--timeout <seconds>]
compazio reply <request-id> "<result>"
compazio inbox
compazio wait <request-id> [--timeout <seconds>]
compazio note read|write|append <note> [content]
```

Requests and responses are persisted per workspace with atomic writes and backup recovery. `send`
delivers one visible bracketed-paste envelope to the destination PTY. Only `reply` completes a
request; provider output, silence, matching text or process exit never count as a response.
Destinations can be resolved by stable ID, unique title or unique role; notes by ID or unique title.

## Intentional limits

- Shell and custom-command terminals do not receive automatic messages.
- Stopped, missing, disconnected or ambiguous destinations fail explicitly.
- Message/envelope size is limited to 32 KiB UTF-8; replies are limited to 64,000 characters.
- `--wait` has a finite timeout and exits non-zero on timeout, failure or cancellation.
- Tokens never cross the preload/renderer boundary and are not persisted in the workspace.
- Compazio does not install, authenticate or pay for AI providers.
- A durable `reply` result does not certify the technical quality of the work.
- Cloud, billing, remote control and telemetry are disabled by default.

## Visible coordination

A visible Claude Code, Codex or OpenCode terminal can be granted local team-coordination
capabilities. The agent continues to use its real TUI and PTY; the grant does not create a hidden
parallel runtime.

```text
compazio spawn [--agent <id>] [--role <role>] [--title <title>]
compazio connect <created-terminal> <connected-resource>
compazio disconnect <edge-id> | <source> <target>
compazio assign-role <created-terminal> <role>
compazio close <created-terminal>
compazio note create <title> [content]
compazio notify <message> [--title <title>]
```

Each coordinator can own up to six terminals it created, with up to four active at once. It can
close only terminals it created; closing removes the process and its connections while leaving the
canvas card in place. Manually created notes and terminals must be visibly connected to the
coordinator before they can be shared with its team.

`COMPAZIO_ORCHESTRATOR_MODE=false` disables this grant as a rollback kill switch. Historical
TeamRun screens, hidden workers, mission budgets and automatic QA remain outside the public path.
Legacy operational state stays readable for migration and diagnostics.

The architectural rationale is documented in ADR 048.

## Security and persistence

- Local IPC/HTTP boundaries validate commands, options, IDs, paths and payloads.
- The bridge listens only on loopback and requires a 256-bit bearer token per session.
- Text injected into a PTY strips C0/C1 controls and ESC before the envelope is formed.
- Note files reject invalid IDs, traversal, symlink/junction escapes and non-atomic writes.
- Workspace schema 10 preserves historical fields, but the manual runtime does not derive managed
  execution behavior from ownership metadata.

## Development and testing

See the [development guide](development.md). The community edition requires no activation and
supports unlimited local workspaces.
