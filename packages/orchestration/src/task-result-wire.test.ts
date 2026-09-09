import { describe, expect, it } from "vitest";

import { createTaskResultParser } from "./orchestrator-wire";

const OPEN = "⟦compasso:result⟧";
const CLOSE = "⟦/compasso⟧";
function envelope(json: string): string {
  return `${OPEN}${json}${CLOSE}`;
}

const validResult = JSON.stringify({
  taskId: "fe",
  dispatchId: "d1",
  status: "completed",
  summary: "Implemented the sections",
  filesModified: ["src/hero.tsx"],
  completedAt: "2026-07-23T00:00:00.000Z"
});

describe("createTaskResultParser", () => {
  it("extracts a valid TaskResult from a full envelope", () => {
    const parser = createTaskResultParser();
    const results = parser.push(`Trabalho concluído.\n${envelope(validResult)}`);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ taskId: "fe", dispatchId: "d1", status: "completed" });
  });

  it("reassembles a result split across chunks", () => {
    const parser = createTaskResultParser();
    const full = envelope(validResult);
    const mid = Math.floor(full.length / 2);
    expect(parser.push(full.slice(0, mid))).toHaveLength(0);
    expect(parser.push(full.slice(mid))).toHaveLength(1);
  });

  it("ignores chatter and malformed or schema-invalid payloads", () => {
    const parser = createTaskResultParser();
    expect(parser.push("apenas texto do terminal\n")).toEqual([]);
    expect(parser.push(envelope("not json"))).toEqual([]);
    expect(parser.push(envelope('{"taskId":"x"}'))).toEqual([]);
  });

  it("does not confuse a composition envelope for a result", () => {
    const parser = createTaskResultParser();
    const composition = `⟦compasso:draft⟧{"type":"start_workflow_draft","objective":"x"}⟦/compasso⟧`;
    expect(parser.push(composition)).toEqual([]);
  });
});
