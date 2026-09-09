import { describe, expect, it } from "vitest";

import {
  canTakeControl,
  compositionEventSchema,
  compositionStateSchema,
  creationModeForState,
  creationOriginSchema,
  nextCompositionState
} from "./composition-state";
import type { CompositionState } from "./composition-state";

describe("composition-state schemas", () => {
  it("defines the full spec §8 state vocabulary", () => {
    expect(compositionStateSchema.options).toEqual([
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
  });

  it("defines the creation-origin vocabulary", () => {
    expect(creationOriginSchema.options).toEqual(["user", "orchestrator", "template", "system"]);
  });
});

describe("nextCompositionState", () => {
  it("walks the happy path manual → executing → completed", () => {
    const steps: [CompositionState, Parameters<typeof nextCompositionState>[1]][] = [
      ["manual", "start_orchestrator"],
      ["orchestrator_starting", "orchestrator_ready"],
      ["orchestrator_ready", "begin_draft"],
      ["drafting", "draft_finalized"],
      ["draft_review", "approve_draft"],
      ["executing", "complete"]
    ];
    const reached = steps.map(([from, event]) => {
      const result = nextCompositionState(from, event);
      expect(result.ok).toBe(true);
      return result.ok ? result.state : from;
    });
    expect(reached).toEqual([
      "orchestrator_starting",
      "orchestrator_ready",
      "drafting",
      "draft_review",
      "executing",
      "completed"
    ]);
  });

  it("take_control moves any automatic state into manual_override (spec §7)", () => {
    for (const from of [
      "orchestrator_starting",
      "orchestrator_ready",
      "drafting",
      "draft_review",
      "executing",
      "paused",
      "blocked"
    ] as const) {
      const result = nextCompositionState(from, "take_control");
      expect(result.ok).toBe(true);
      expect(result.ok && result.state).toBe("manual_override");
    }
  });

  it("resume_with_ai continues from manual_override without rebuilding (spec §7.3)", () => {
    const result = nextCompositionState("manual_override", "resume_with_ai");
    expect(result.ok && result.state).toBe("orchestrator_starting");
  });

  it("preserves the draft when the orchestrator fails mid-draft (spec §18.2)", () => {
    const result = nextCompositionState("drafting", "orchestrator_failed");
    expect(result.ok && result.state).toBe("blocked");
  });

  it("rejects illegal transitions instead of silently changing state", () => {
    const result = nextCompositionState("manual", "approve_draft");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/manual/i);
  });

  it("only a ready draft can be approved into execution", () => {
    expect(nextCompositionState("draft_review", "approve_draft").ok).toBe(true);
    expect(nextCompositionState("drafting", "approve_draft").ok).toBe(false);
  });

  it("validates its inputs", () => {
    expect(compositionEventSchema.safeParse("take_control").success).toBe(true);
    expect(compositionEventSchema.safeParse("nonsense").success).toBe(false);
  });
});

describe("canTakeControl", () => {
  it("is available while an orchestrator is active and not in a plain manual state", () => {
    expect(canTakeControl("executing")).toBe(true);
    expect(canTakeControl("drafting")).toBe(true);
    expect(canTakeControl("manual")).toBe(false);
    expect(canTakeControl("manual_override")).toBe(false);
    expect(canTakeControl("completed")).toBe(false);
  });
});

describe("creationModeForState", () => {
  it("bridges the lifecycle to the persisted creationMode axis", () => {
    expect(creationModeForState("manual")).toBe("manual");
    expect(creationModeForState("manual_override")).toBe("manual");
    expect(creationModeForState("blocked")).toBe("manual");
    expect(creationModeForState("completed")).toBe("manual");
    expect(creationModeForState("orchestrator_starting")).toBe("automatic");
    expect(creationModeForState("drafting")).toBe("automatic");
    expect(creationModeForState("executing")).toBe("automatic");
    expect(creationModeForState("paused")).toBe("automatic");
  });
});
