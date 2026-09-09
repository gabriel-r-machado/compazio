import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecFileCommandRunner } from "@forgedeck/agent-adapters";
import { PipeProcessFactory, ProcessSupervisor } from "@forgedeck/terminal";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { resolveAutomaticModeStrategy } from "@forgedeck/orchestration";
import type { AgentPlanningDescriptor, OrchestratorPlanRequest } from "@forgedeck/orchestration";
import { AUTOMATIC_MODE_DEFAULT_LIMITS } from "@forgedeck/schemas";

import { OpenCodeOrchestratorPort } from "./opencode-orchestrator-port";
import type { PlanningProcessRunner } from "./codex-orchestrator-port";
import { fingerprintWorkspace } from "./automatic-mode-composition";
import { createPlanningSnapshot } from "./planning-snapshot";
import { SupervisorPlanningRunner } from "./supervisor-planning-runner";

/**
 * The OpenCode planner over the real transport, against a deterministic fixture. No real OpenCode is ever
 * called here. The fixture speaks the real protocol — `run`, `--format json`, `--dir`, the managed plan path in the
 * prompt, prompt on stdin, no positional — so a change that breaks the contract fails
 * here rather than later against the installed CLI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const plannerFixture = resolve(here, "..", "..", "e2e", "fixtures", "opencode-planner-fixture.mjs");

function platform(): RuntimePlatform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported test platform");
}

const AGENTS: readonly AgentPlanningDescriptor[] = [
  { id: "claude-code", displayName: "Claude Code", capabilities: ["planning"], available: true },
  { id: "opencode", displayName: "OpenCode", capabilities: ["backend"], available: true },
  { id: "codex", displayName: "Codex", capabilities: ["testing"], available: true }
];

/**
 * Runs the fixture through the SAME SupervisorPlanningRunner production uses, replacing only the
 * executable: Node is the native binary here, the fixture script is its first controlled argument, and
 * every other argument the port built travels untouched.
 */
function fixtureRunner(supervisor: ProcessSupervisor): PlanningProcessRunner {
  const inner = new SupervisorPlanningRunner(supervisor, "opencode");
  return {
    run: async (input) =>
      inner.run({
        ...input,
        executable: { path: process.execPath, kind: "native" },
        args: [plannerFixture, ...input.args]
      })
  };
}

interface Harness {
  readonly port: OpenCodeOrchestratorPort;
  readonly supervisor: ProcessSupervisor;
  readonly close: () => Promise<void>;
}

function compose(options: { readonly timeoutMs?: number } = {}): Harness {
  const supervisor = new ProcessSupervisor(new PipeProcessFactory(), {
    platform: platform(),
    batchIntervalMs: 8,
    maxBufferLines: 200
  });
  const port = new OpenCodeOrchestratorPort({
    runner: fixtureRunner(supervisor),
    commandRunner: new ExecFileCommandRunner(),
    detector: { find: async () => ({ path: plannerFixture, kind: "native" }) },
    platform: platform(),
    environment: process.env,
    // The port resolves this path as the Codex binary; the runner above is what actually launches it.
    executablePath: plannerFixture,
    fileExists: async () => true,
    ...(options.timeoutMs === undefined ? {} : { planningTimeoutMs: options.timeoutMs })
  });
  return {
    port,
    supervisor,
    close: async () => {
      await supervisor.close();
    }
  };
}

function planRequest(
  snapshotPath: string,
  directive: string,
  overrides: Partial<OrchestratorPlanRequest> = {}
): OrchestratorPlanRequest {
  return {
    objective: `Deliver the vertical slice. #planner:${directive}`,
    planningSnapshotPath: snapshotPath,
    projectMetadata: { summary: "A test workspace." },
    limits: AUTOMATIC_MODE_DEFAULT_LIMITS.standard,
    availableAgents: AGENTS,
    strategy: resolveAutomaticModeStrategy("standard", AUTOMATIC_MODE_DEFAULT_LIMITS.standard),
    ...overrides
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("OpenCodeOrchestratorPort (fixture only, never the real Codex)", () => {
  let workspace: string;
  let snapshot: { readonly path: string; dispose: () => Promise<void> };

  beforeAll(async () => {
    // A "real workspace" that must never be reachable from planning, and the disposable snapshot that
    // is. The snapshot is built by the same approved isolation the Claude planner uses.
    workspace = await mkdtemp(join(tmpdir(), "opencode-planner-workspace-"));
    await writeFile(join(workspace, "package.json"), '{"name":"x","scripts":{"test":"vitest"}}\n');
    await writeFile(join(workspace, "README.md"), "# Test workspace\n");
    await writeFile(join(workspace, ".env"), "SECRET=must-never-be-copied\n");
    snapshot = await createPlanningSnapshot({ workspaceRoot: workspace });
  });
  afterAll(async () => {
    await snapshot.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  it(
    "4. produces the official plan schema, naming all three executors",
    { timeout: 60_000 },
    async () => {
      const harness = compose();
      try {
        const result = await harness.port.createPlan(planRequest(snapshot.path, "valid"));
        expect(result.diagnostics).toEqual([]);
        expect(result.adapterId).toBe("opencode");
        expect(result.plan?.nodes.map((node) => node.adapter)).toEqual([
          "claude-code",
          "opencode",
          "codex"
        ]);
        // 23: a plan written by Codex may assign any available executor, including other agents.
        expect(result.plan?.nodes.map((node) => node.role)).toEqual([
          "designer",
          "implementer",
          "qa"
        ]);
        expect(result.plan?.title).toBe("Deliver the slice");
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "6/7/8. keeps the prompt off argv, uses no shell, and runs in the snapshot",
    { timeout: 60_000 },
    async () => {
      const supervisor = new ProcessSupervisor(new PipeProcessFactory(), {
        platform: platform(),
        batchIntervalMs: 8,
        maxBufferLines: 200
      });
      const seen: { args: readonly string[]; cwd: string; stdin: string }[] = [];
      const port = new OpenCodeOrchestratorPort({
        runner: {
          run: async (input) => {
            seen.push({ args: input.args, cwd: input.cwd, stdin: input.stdin });
            return fixtureRunner(supervisor).run(input);
          }
        },
        commandRunner: new ExecFileCommandRunner(),
        detector: { find: async () => ({ path: plannerFixture, kind: "native" }) },
        platform: platform(),
        environment: process.env,
        executablePath: plannerFixture,
        fileExists: async () => true
      });
      try {
        const result = await port.createPlan(planRequest(snapshot.path, "valid"));
        expect(result.plan).not.toBeNull();
        const launch = seen[0];
        // OpenCode offers no read-only sandbox this port could rely on, so nothing claims one. The
        // protection is isolation: the cwd is the disposable snapshot, the only write the turn needs
        // is the managed plan file inside it, and the permission bypass is never passed.
        expect(launch?.args).toEqual(["run", "--format", "json", "--dir", snapshot.path]);
        expect(launch?.args).not.toContain("--dangerously-skip-permissions");
        // The managed destination travels in the PROMPT, as a literal path, and never on argv.
        expect(launch?.stdin).toContain("COMPAZIO_PLAN_PATH");
        expect(launch?.stdin).toContain("Use the literal path directly.");
        expect(launch?.args.join(" ")).not.toContain("COMPAZIO_PLAN_PATH");
        // 6: the objective and the whole contract live on stdin, never on the command line.
        expect(launch?.stdin).toContain("Deliver the vertical slice");
        expect(launch?.args.join(" ")).not.toContain("Deliver the vertical slice");
        expect(launch?.args.some((argument) => argument.includes("Required answer"))).toBe(false);
        // 8/9: the cwd is the snapshot, and the real workspace is neither the cwd nor a root.
        expect(launch?.cwd).toBe(snapshot.path);
        expect(launch?.cwd).not.toBe(workspace);
        expect(launch?.args.join(" ")).not.toContain(workspace);
      } finally {
        await supervisor.close();
      }
    }
  );

  it(
    "9/11. never reaches the real workspace, and leaves its fingerprint unchanged",
    { timeout: 60_000 },
    async () => {
      const harness = compose();
      const before = await fingerprintWorkspace(workspace);
      try {
        const forbidden = join(workspace, "planner-escaped.txt");
        const result = await harness.port.createPlan(
          planRequest(snapshot.path, "escape-workspace", {
            objective: "Deliver the slice. #planner:escape-workspace"
          })
        );
        // The fixture reports its own escape attempt in the plan it returns.
        expect(result.plan?.summary ?? "").toContain("Escape attempt succeeded:");
        expect(existsSync(forbidden)).toBe(false);
        expect(await fingerprintWorkspace(workspace)).toBe(before);
        // The snapshot never carried the secret file in the first place.
        expect(await readdir(snapshot.path)).not.toContain(".env");
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "10. absorbs a write inside the disposable snapshot without touching the project",
    { timeout: 60_000 },
    async () => {
      const harness = compose();
      const scratch = await createPlanningSnapshot({ workspaceRoot: workspace });
      const before = await fingerprintWorkspace(workspace);
      try {
        const result = await harness.port.createPlan(planRequest(scratch.path, "mutate-snapshot"));
        expect(result.plan).not.toBeNull();
        expect(existsSync(join(scratch.path, "planner-touched-the-snapshot.txt"))).toBe(true);
        expect(await fingerprintWorkspace(workspace)).toBe(before);
      } finally {
        await scratch.dispose();
        await harness.close();
      }
    }
  );

  it(
    "12/13/14/15/16. rejects every malformed answer with a structured diagnostic",
    { timeout: 120_000 },
    async () => {
      const cases: readonly { readonly directive: string; readonly code: string }[] = [
        { directive: "invalid-json", code: "result_not_json" },
        { directive: "markdown", code: "result_wrapped_in_markdown" },
        { directive: "missing-field", code: "schema_invalid" },
        { directive: "invalid-role", code: "invalid_role" },
        { directive: "invalid-adapter", code: "invalid_adapter" },
        { directive: "missing-dependency", code: "invalid_dependency" },
        { directive: "cycle", code: "dependency_cycle" },
        { directive: "limit", code: "limit_exceeded" },
        { directive: "empty", code: "result_empty" },
        { directive: "no-file", code: "result_missing" },
        { directive: "stdout-only", code: "result_missing" },
        { directive: "huge", code: "limit_exceeded" }
      ];
      for (const entry of cases) {
        const harness = compose();
        try {
          const result = await harness.port.createPlan(planRequest(snapshot.path, entry.directive));
          // 20: no partial plan is ever returned, whatever the failure was.
          expect(result.plan, entry.directive).toBeNull();
          expect(
            result.diagnostics.map((d) => d.code),
            entry.directive
          ).toContain(entry.code);
          // 9 (diagnostics): the shape is reported, never the value.
          expect(JSON.stringify(result.diagnostics)).not.toContain("Deliver the vertical slice");
          expect(JSON.stringify(result.diagnostics)).not.toContain("must-never-be-copied");
        } finally {
          await harness.close();
        }
      }
    }
  );

  it(
    "17. reports a timeout as a structured failure and leaves nothing running",
    { timeout: 60_000 },
    async () => {
      const harness = compose({ timeoutMs: 1_000 });
      try {
        const result = await harness.port.createPlan(planRequest(snapshot.path, "hang"));
        expect(result.plan).toBeNull();
        expect(result.diagnostics.map((d) => d.code)).toEqual(["timeout"]);
        expect(harness.supervisor.listSessions().every((s) => s.state !== "running")).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "18/19. cancels the turn and terminates the whole process tree",
    { timeout: 60_000 },
    async () => {
      const harness = compose();
      const controller = new AbortController();
      try {
        const pending = harness.port.createPlan(
          planRequest(snapshot.path, "child"),
          controller.signal
        );
        await waitFor(() =>
          harness.supervisor
            .listSessions()
            .some((session) => session.state === "running" && bufferOf(harness, session.id) !== "")
        );
        const session = harness.supervisor.listSessions()[0];
        const childPid = Number.parseInt(
          /CHILD_PID:(\d+)/u.exec(bufferOf(harness, session?.id ?? ""))?.[1] ?? "",
          10
        );
        expect(Number.isInteger(childPid)).toBe(true);
        controller.abort();
        const result = await pending;
        expect(result.plan).toBeNull();
        expect(result.diagnostics.map((d) => d.code)).toEqual(["cancelled"]);
        await waitFor(() => !isAlive(childPid), 15_000);
        expect(harness.supervisor.listSessions().every((s) => s.state !== "running")).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it("preserves Unicode in the plan it returns", { timeout: 60_000 }, async () => {
    const harness = compose();
    try {
      const result = await harness.port.createPlan(planRequest(snapshot.path, "unicode"));
      expect(result.plan?.title).toBe("Entrega da fatia — 日本語 ✅");
      expect(result.plan?.summary).toContain("Ünïcödé");
    } finally {
      await harness.close();
    }
  });

  it("24/25. plans and stops: the port exposes no way to execute a node", async () => {
    const harness = compose();
    try {
      expect(typeof harness.port.createPlan).toBe("function");
      expect(typeof harness.port.detect).toBe("function");
      expect("execute" in harness.port).toBe(false);
      expect("materializeAndStart" in harness.port).toBe(false);
      expect("start" in harness.port).toBe(false);
      expect("retryNode" in harness.port).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("cleans its managed answer file out of the snapshot", { timeout: 60_000 }, async () => {
    const harness = compose();
    const scratch = await createPlanningSnapshot({ workspaceRoot: workspace });
    try {
      await harness.port.createPlan(planRequest(scratch.path, "valid"));
      expect(await readdir(scratch.path)).not.toContain(".compazio");
    } finally {
      await scratch.dispose();
      await harness.close();
    }
  });
});

function bufferOf(harness: Harness, sessionId: string): string {
  try {
    return harness.supervisor.getBuffer(sessionId);
  } catch {
    return "";
  }
}
