# ADR 033 — Workflow runs require immutable execution context checkpoints

## Status

Accepted

## Context

Profiles, missions, workspace memory, delivery contracts and context snapshots were already
persisted independently. A workflow run could still begin without recording which of those versions
it used, so its final report could not prove the execution context.

## Decision

- A newly requested workflow run must name an existing agent and a non-empty task.
- The desktop-owned dispatcher creates a `function` checkpoint before it starts the scheduler.
- The scheduler invokes a runtime-only callback to create a `delivery` checkpoint after nodes settle
  and before it writes the final report and terminal transition.
- Runs persist only a safe context projection: stable IDs, versions and SHA-256 values. Complete
  snapshot payloads remain in `execution_context_snapshots` and never cross IPC.
- CLI and renderer starts enqueue a durable local command. The renderer cannot define a workflow,
  command, working directory, executable or context payload.
- Historical runs remain readable with a `null` context projection. Retrying a context-bound run
  requires the dispatcher so it receives a new function checkpoint; the runtime refuses an unsafe
  direct retry.

## Consequences

- Final reports now name the executing agent, task, relevant versions and both checkpoint hashes.
- A migration adds nullable run-context storage and additive command fields, preserving existing
  databases and report history.
- The start IPC response is a queued command acknowledgement rather than an immediate run snapshot;
  the runtime assigns the run ID only after it consumes the approved durable request.
