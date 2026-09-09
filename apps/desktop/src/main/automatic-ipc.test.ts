import { describe, expect, it, vi } from "vitest";

import {
  AUTOMATIC_APPROVE_CHANNEL,
  AUTOMATIC_CANCEL_CHANNEL,
  AUTOMATIC_CREATE_CHANNEL,
  AUTOMATIC_LIST_CHANNEL,
  AUTOMATIC_PAUSE_CHANNEL,
  AUTOMATIC_REJECT_CHANNEL,
  AUTOMATIC_RESUME_CHANNEL,
  AUTOMATIC_SHOW_CHANNEL,
  AUTOMATIC_START_CHANNEL,
  type AutomaticRunSnapshotDto
} from "@forgedeck/schemas";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { AUTOMATIC_IPC_CHANNELS, registerAutomaticIpc } from "./automatic-ipc";
import type { AutomaticModeService } from "./automatic-mode-service";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const FINGERPRINT = "a".repeat(64);

function snapshot(overrides: Partial<AutomaticRunSnapshotDto> = {}): AutomaticRunSnapshotDto {
  return {
    automaticRunId: RUN_ID,
    workspaceId: "ws-1",
    objective: "Add auth",
    mode: "standard",
    status: "planning",
    planTitle: "Auth",
    planSummary: "Implement auth.",
    nodes: [],
    runIds: [],
    currentRunId: null,
    limits: {
      remediationCyclesUsed: 0,
      remediationCyclesTotal: 2,
      maxAttemptsPerNode: 2,
      maxWorkflowNodes: 8,
      timeoutMs: 2_700_000
    },
    pendingApprovals: [],
    stopReason: null,
    result: null,
    issues: [],
    orchestrator: null,
    planStale: false,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides
  };
}

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>;

function harness(): {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  service: { [K in keyof AutomaticModeService]?: unknown };
  calls: string[];
  dispose: () => void;
} {
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  const record = <T>(name: string, value: T) => {
    calls.push(name);
    return value;
  };
  const service = {
    create: vi.fn(async () => record("create", snapshot())),
    start: vi.fn(async () => record("start", snapshot({ status: "running" }))),
    show: vi.fn(() => record("show", snapshot())),
    list: vi.fn(() => record("list", [snapshot()])),
    pause: vi.fn(async () => record("pause", snapshot({ stopReason: "paused" }))),
    resume: vi.fn(async () => record("resume", snapshot({ status: "running" }))),
    cancel: vi.fn(async () => record("cancel", snapshot({ status: "stopped" }))),
    decide: vi.fn(async () => record("decide", snapshot()))
  };
  const ipc = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
  const dispose = registerAutomaticIpc(ipc, service as unknown as AutomaticModeService);
  return {
    invoke: async (channel, payload) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler for ${channel}`);
      return handler({} as IpcMainInvokeEvent, payload);
    },
    service,
    calls,
    dispose
  };
}

describe("automatic mode IPC", () => {
  it("registers every automatic channel and removes them all on dispose", () => {
    const { invoke, dispose } = harness();
    expect(AUTOMATIC_IPC_CHANNELS).toHaveLength(10);
    dispose();
    return expect(invoke(AUTOMATIC_CREATE_CHANNEL, {})).rejects.toThrow(/no handler/u);
  });

  it("accepts a well-formed create request and returns a validated snapshot", async () => {
    const { invoke } = harness();
    const result = await invoke(AUTOMATIC_CREATE_CHANNEL, {
      workspaceId: "ws-1",
      objective: "Add Supabase auth",
      mode: "standard",
      acceptanceCriteria: ["Build passes"]
    });
    expect((result as AutomaticRunSnapshotDto).automaticRunId).toBe(RUN_ID);
  });

  it.each([
    ["an empty objective", { workspaceId: "ws-1", objective: "   ", mode: "standard" }],
    ["an unknown mode", { workspaceId: "ws-1", objective: "do it", mode: "turbo" }],
    ["a missing workspace", { objective: "do it", mode: "standard" }],
    [
      "an unknown extra field",
      { workspaceId: "ws-1", objective: "do it", mode: "standard", danger: true }
    ],
    ["a non-object payload", "just do it"],
    ["a null payload", null]
  ])("rejects create with %s before the service is touched", async (_label, payload) => {
    const { invoke, calls } = harness();
    await expect(invoke(AUTOMATIC_CREATE_CHANNEL, payload)).rejects.toThrow();
    // The service was never reached, so an invalid payload has no side effect at all.
    expect(calls).toEqual([]);
  });

  it.each([
    [AUTOMATIC_START_CHANNEL],
    [AUTOMATIC_SHOW_CHANNEL],
    [AUTOMATIC_PAUSE_CHANNEL],
    [AUTOMATIC_RESUME_CHANNEL],
    [AUTOMATIC_CANCEL_CHANNEL]
  ])("rejects %s when the session id is not a uuid", async (channel) => {
    const { invoke, calls } = harness();
    await expect(invoke(channel, { automaticRunId: "run-1" })).rejects.toThrow();
    await expect(invoke(channel, {})).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it.each([[AUTOMATIC_APPROVE_CHANNEL], [AUTOMATIC_REJECT_CHANNEL]])(
    "rejects %s without a well-formed action fingerprint",
    async (channel) => {
      const { invoke, calls } = harness();
      // A decision must name the exact action; a missing or malformed fingerprint is refused.
      await expect(invoke(channel, { automaticRunId: RUN_ID, nodeId: "impl" })).rejects.toThrow();
      await expect(
        invoke(channel, { automaticRunId: RUN_ID, nodeId: "impl", actionFingerprint: "nope" })
      ).rejects.toThrow();
      expect(calls).toEqual([]);

      const accepted = await invoke(channel, {
        automaticRunId: RUN_ID,
        nodeId: "impl",
        actionFingerprint: FINGERPRINT
      });
      expect((accepted as AutomaticRunSnapshotDto).automaticRunId).toBe(RUN_ID);
    }
  );

  it("treats an absent list payload as the empty filter and rejects a bad one", async () => {
    const { invoke } = harness();
    const listed = await invoke(AUTOMATIC_LIST_CHANNEL, undefined);
    expect((listed as { runs: unknown[] }).runs).toHaveLength(1);
    await expect(invoke(AUTOMATIC_LIST_CHANNEL, { limit: 0 })).rejects.toThrow();
    await expect(invoke(AUTOMATIC_LIST_CHANNEL, { limit: 9_999 })).rejects.toThrow();
  });

  it("refuses to return a projection that carries anything outside the contract", async () => {
    const handlers = new Map<string, Handler>();
    const ipc = {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: () => undefined
    } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
    // A service that leaks a prompt into the projection must not be able to reach the renderer.
    const leaky = {
      show: () => ({ ...snapshot(), prompt: "Implement Supabase auth." })
    } as unknown as AutomaticModeService;
    registerAutomaticIpc(ipc, leaky);
    const handler = handlers.get(AUTOMATIC_SHOW_CHANNEL);
    await expect(handler?.({} as IpcMainInvokeEvent, { automaticRunId: RUN_ID })).rejects.toThrow();
  });
});
