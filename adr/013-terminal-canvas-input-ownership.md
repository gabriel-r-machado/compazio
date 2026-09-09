# ADR-013: terminal interactive ownership and canvas isolation

## Status

Superseded in part by ADR 016. The interactive-terminal decisions remain active; every private
worker statement below is historical and does not authorize a hidden runtime.

## Decision

An interactive canvas terminal has one input authority: xterm receives keyboard events and emits
the raw `onData` payload to the main-process session, which writes directly to the owned PTY. React
does not mirror, edit, debounce, or reinterpret the current command line. Visible production
terminals use PTY transport; pipe transport exists only in deterministic process tests.

The canvas treats an active xterm as an input boundary. Canvas shortcuts return immediately while
the xterm or its helper textarea is focused. Pointer events from the terminal body are stopped at
the terminal boundary; node dragging begins only from the header. Canvas, node-drag, link, and
resize pointer captures are released on pointerup, pointercancel, and lostpointercapture.

Terminal dimensions follow one pipeline: host `ResizeObserver` -> `FitAddon.fit()` -> xterm `cols` and
`rows` -> PTY resize. The host uses unscaled layout dimensions, so canvas transforms do not enter
cell arithmetic. A resize requested while a PTY is spawning is retained by the supervisor and
applied once the real process exists.

Visible PTY launches set `TERM=xterm-256color` and `COLORTERM=truecolor`.

Clipboard commands stay inside this boundary as well. The renderer uses a narrow, validated
Electron clipboard bridge and calls `Terminal.paste`, preserving xterm's bracketed-paste mode and
the same `onData` path as keyboard input. `Ctrl+C` copies only when xterm owns a selection; without
a selection it remains the PTY interrupt. `Ctrl+A` remains native readline/TUI input, while
`Ctrl+Shift+A` selects xterm's buffer. Right click opens terminal-only copy, paste, selection and
clear actions without changing canvas selection or starting a node drag.

Agent discovery is centralized in the runtime resolver and preflight service. Windows search order
prefers `pwsh.exe`, then `powershell.exe`, then `cmd.exe`; known CLI resolution prefers native
executables and only uses a command shim when that is the available compatible launch target.

## Consequences

- Line editing, Backspace, Delete, cursor movement, clipboard controls, TUI escape sequences and
  Unicode remain the responsibility of the agent's line editor and the PTY.
- The renderer cannot display a speculative input line, so a broken provider reports a process or
  availability state instead of leaving an apparently live black terminal.
- There is no active private worker path; agent work happens in visible terminals.
- A provider cannot be recruited until a cheap availability check reports an executable and usable
  health state; failed creation is rolled back so it cannot leave a ghost node.

## Validation boundary

The release remains paused until the focused Electron validation covers terminal editing, TUI
rendering, pointer isolation, resize/minimize/restore, canvas zoom, PTY dimensions, and unavailable
provider behavior on the target Windows environment.
