import { z } from "zod";

import type { CreationMode } from "./workflow-mode";

/**
 * The composition lifecycle of a canvas (spec §8). This replaces a naive `isAutomatic` boolean: a
 * canvas moves through explicit states as the user hands control to an orchestrator, reviews a draft,
 * runs it, takes control back and resumes — the named transitions of spec §6 and §7. The machine is
 * pure and deterministic; illegal transitions are rejected with a reason instead of silently applied,
 * matching the rest of the domain (the desktop, not the LLM, owns state).
 */
export const compositionStateSchema = z.enum([
  "manual",
  "orchestrator_starting",
  "orchestrator_ready",
  "drafting",
  "draft_review",
  "executing",
  "manual_override",
  "paused",
  "blocked",
  "completed"
]);
export type CompositionState = z.infer<typeof compositionStateSchema>;

/** Who created a given canvas element (spec §8). A canvas may mix origins simultaneously. */
export const creationOriginSchema = z.enum(["user", "orchestrator", "template", "system"]);
export type CreationOrigin = z.infer<typeof creationOriginSchema>;

/** The events that drive the composition lifecycle. Each maps to a named product action. */
export const compositionEventSchema = z.enum([
  "start_orchestrator", // "Organizar/Começar com IA" (§6.1)
  "orchestrator_ready", // the CLI session finished booting and injected its skill
  "begin_draft", // the orchestrator opened a transactional draft (§5.5)
  "draft_finalized", // the orchestrator finalized the draft for review (§5.6)
  "approve_draft", // the user approved the draft; workers may start (§5.6)
  "discard_draft", // the user discarded the draft and returned to manual
  "take_control", // "Assumir controle" (§7.1)
  "resume_with_ai", // "Retomar com IA" (§7.3)
  "pause", // pause active execution
  "resume", // resume paused execution
  "block", // a blocker requires human decision (§16.3)
  "unblock", // the human resolved the blocker
  "complete", // the workflow finished
  "orchestrator_failed", // the orchestrator session crashed/failed (§18.2/§18.4)
  "reset" // return a settled canvas to plain manual composition
]);
export type CompositionEvent = z.infer<typeof compositionEventSchema>;

export type CompositionTransitionResult =
  | { readonly ok: true; readonly state: CompositionState }
  | { readonly ok: false; readonly reason: string };

/**
 * The legal transition table. A `${from}` → `{ [event]: to }` map. Anything not listed is illegal and
 * rejected, so new automatic decisions cannot sneak in from an unexpected state (e.g. once the user
 * took control).
 */
const TRANSITIONS: Readonly<
  Record<CompositionState, Partial<Record<CompositionEvent, CompositionState>>>
> = {
  manual: {
    start_orchestrator: "orchestrator_starting",
    resume_with_ai: "orchestrator_starting"
  },
  orchestrator_starting: {
    orchestrator_ready: "orchestrator_ready",
    orchestrator_failed: "blocked",
    take_control: "manual_override"
  },
  orchestrator_ready: {
    begin_draft: "drafting",
    take_control: "manual_override"
  },
  drafting: {
    draft_finalized: "draft_review",
    discard_draft: "manual",
    orchestrator_failed: "blocked",
    take_control: "manual_override"
  },
  draft_review: {
    approve_draft: "executing",
    begin_draft: "drafting",
    discard_draft: "manual",
    take_control: "manual_override"
  },
  executing: {
    pause: "paused",
    block: "blocked",
    complete: "completed",
    take_control: "manual_override"
  },
  paused: {
    resume: "executing",
    take_control: "manual_override"
  },
  blocked: {
    unblock: "manual_override",
    resume_with_ai: "orchestrator_starting",
    take_control: "manual_override"
  },
  manual_override: {
    resume_with_ai: "orchestrator_starting",
    reset: "manual"
  },
  completed: {
    resume_with_ai: "orchestrator_starting",
    reset: "manual"
  }
};

/** Pure transition. Returns the next state or a rejection reason for an illegal move. */
export function nextCompositionState(
  current: CompositionState,
  event: CompositionEvent
): CompositionTransitionResult {
  const to = TRANSITIONS[current][event];
  if (to === undefined) {
    return { ok: false, reason: `Cannot "${event}" from state "${current}".` };
  }
  return { ok: true, state: to };
}

/** States in which the "Assumir controle" action is offered (spec §7). */
const CONTROLLABLE: ReadonlySet<CompositionState> = new Set<CompositionState>([
  "orchestrator_starting",
  "orchestrator_ready",
  "drafting",
  "draft_review",
  "executing",
  "paused",
  "blocked"
]);

export function canTakeControl(state: CompositionState): boolean {
  return CONTROLLABLE.has(state);
}

/** States in which an orchestrator is actively driving the canvas (the automatic axis). */
const AUTOMATIC: ReadonlySet<CompositionState> = new Set<CompositionState>([
  "orchestrator_starting",
  "orchestrator_ready",
  "drafting",
  "draft_review",
  "executing",
  "paused"
]);

/**
 * Bridges the richer lifecycle to the persisted `creationMode` header control. `manual_override`,
 * `blocked` and `completed` all read as `manual` because the user (not an orchestrator) is in charge.
 */
export function creationModeForState(state: CompositionState): CreationMode {
  return AUTOMATIC.has(state) ? "automatic" : "manual";
}
