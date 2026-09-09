import { describe, expect, it } from "vitest";

import { terminalCreateRequestSchema, terminalEventSchema } from "./terminal";

const projectId = "d092aaa1-7eaf-4e98-9fa4-76f688df121c";
const sessionId = "a0c0bab2-8eaf-4e98-9fa4-76f688df121c";

describe("terminal IPC schemas", () => {
  it("accepts only a project, adapter and terminal dimensions when creating a session", () => {
    expect(
      terminalCreateRequestSchema.parse({
        projectId,
        adapterId: "claude-code",
        cols: 132,
        rows: 42
      })
    ).toEqual({ projectId, adapterId: "claude-code", cols: 132, rows: 42 });
  });

  it("rejects executable, arguments, paths, environment and shell data from the renderer", () => {
    expect(
      terminalCreateRequestSchema.safeParse({
        projectId,
        adapterId: "shell",
        executable: "cmd.exe",
        args: ["/c", "whoami"],
        cwd: "C:\\Users",
        environment: { SECRET: "value" },
        shell: "cmd.exe"
      }).success
    ).toBe(false);
  });

  it("validates bounded output events before the renderer consumes them", () => {
    expect(
      terminalEventSchema.parse({
        type: "session.output",
        sessionId,
        sequence: 1,
        data: "hello",
        timestamp: "2026-07-17T16:00:00.000Z"
      })
    ).toMatchObject({ type: "session.output", data: "hello" });
  });
});
