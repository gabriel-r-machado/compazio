# ADR-014: structured worker-to-human input routing

## Status

Superseded by ADR 016 for the active product path. Retained only as historical design context.

## Context

A background worker sometimes needs information that only the user can provide. Letting the worker
print a question in its private terminal creates two human channels, strands the task when that
terminal is hidden, and makes mission state depend on terminal prose.

## Decision

A worker assigned to a running task may create one durable `TeamUserInputRequest` containing its
task, agent, question, reason, expected answer type and bounded context. The task transitions to
`waiting-for-user-input`, its TeamRun remains alive and blocked, and the request is projected on the
Compazio attention surface.

Only the Compazio terminal that owns the TeamRun may answer. The coordinator persists the answer,
returns the same task to `running`, delivers the answer through the internal control-plane mailbox
and resolves the pending MCP tool call so the worker continues without a private human chat.

The request and answer are SQLite-backed operational state. Terminal output is neither the request
nor the response protocol, and agent prose cannot complete the task or TeamRun.

## Consequences

- the user has one visible communication surface;
- worker terminals remain private execution/observability surfaces;
- reload preserves an unanswered request and the blocked mission;
- capability discovery exposes request creation only to workers and answering only to Compazio;
- task completion still requires a structured result after the answer.

## Validation

Integration coverage proves `running → waiting-for-user-input → running`, ownership checks, durable
request fields, answer delivery and continued mission gating.
