import { describe, expect, it } from "vitest";

import { createCompositionActionParser } from "./orchestrator-wire";

const OPEN = "⟦compasso:draft⟧";
const CLOSE = "⟦/compasso⟧";
const LINE_PREFIX = "COMPASSO_DRAFT:";

function envelope(json: string): string {
  return `${OPEN}${json}${CLOSE}`;
}

describe("createCompositionActionParser", () => {
  it("extracts a valid composition action from a full envelope", () => {
    const parser = createCompositionActionParser();
    const actions = parser.push(
      envelope(
        '{"type":"add_draft_node","ref":"frontend","title":"Front-end","role":"implementer"}'
      )
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "add_draft_node", ref: "frontend" });
  });

  it("reassembles an envelope split across chunks", () => {
    const parser = createCompositionActionParser();
    const full = envelope('{"type":"start_workflow_draft","objective":"landing page"}');
    const mid = Math.floor(full.length / 2);
    expect(parser.push(full.slice(0, mid))).toHaveLength(0);
    const actions = parser.push(full.slice(mid));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "start_workflow_draft", objective: "landing page" });
  });

  it("ignores ordinary terminal chatter and malformed envelopes (untrusted output)", () => {
    const parser = createCompositionActionParser();
    expect(parser.push("Vou planejar a equipe agora...\n")).toEqual([]);
    expect(parser.push(envelope("not json"))).toEqual([]);
    expect(parser.push(envelope('{"type":"not_a_real_action"}'))).toEqual([]);
  });

  it("survives ANSI styling around the sentinels", () => {
    const parser = createCompositionActionParser();
    const styled = `[32m${envelope('{"type":"connect_draft_nodes","from":"a","to":"b"}')}[0m`;
    const actions = parser.push(styled);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "connect_draft_nodes", from: "a", to: "b" });
  });

  it("emits multiple actions from one chunk in order", () => {
    const parser = createCompositionActionParser();
    const actions = parser.push(
      envelope('{"type":"start_workflow_draft","objective":"x"}') +
        "texto entre ações\n" +
        envelope('{"type":"add_draft_node","ref":"ux","title":"UX","role":"designer"}')
    );
    expect(actions.map((action) => action.type)).toEqual([
      "start_workflow_draft",
      "add_draft_node"
    ]);
  });

  it("accepts the ASCII one-line protocol used by real interactive CLIs", () => {
    const parser = createCompositionActionParser();
    const actions = parser.push(
      `${LINE_PREFIX} {"type":"start_workflow_draft","objective":"landing premium"}\n` +
        `${LINE_PREFIX} {"type":"finalize_workflow_draft"}\n`
    );
    expect(actions.map((action) => action.type)).toEqual([
      "start_workflow_draft",
      "finalize_workflow_draft"
    ]);
  });

  it("never turns an echoed protocol instruction without JSON into a draft action", () => {
    const parser = createCompositionActionParser();
    expect(parser.push(`${LINE_PREFIX} seguido por um objeto JSON estrito\n`)).toEqual([]);
  });

  it("reassembles a line command split across terminal chunks", () => {
    const parser = createCompositionActionParser();
    expect(parser.push(`${LINE_PREFIX} {"type":"add_draft_node",`)).toEqual([]);
    const actions = parser.push('"ref":"lp","title":"Landing premium","role":"implementer"}\n');
    expect(actions).toMatchObject([{ type: "add_draft_node", ref: "lp" }]);
  });
});
