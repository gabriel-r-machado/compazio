import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecFileCommandRunner } from "@forgedeck/agent-adapters";
import {
  SqliteArtifactRegistry,
  SqliteWorkflowRunStore,
  runLocalMigrations
} from "@forgedeck/local-db";
import { PipeProcessFactory, ProcessSupervisor } from "@forgedeck/terminal";
import type { ProcessSessionSnapshot } from "@forgedeck/terminal";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { workflowSchema, type Workflow } from "@forgedeck/workflow";

import { AgentAdapterRegistry } from "./agent-adapter-registry";
import { AgentNodeExecutorRouter } from "./agent-node-executor-router";
import { ClaudeCodeFixtureAdapter } from "./claude-code-fixture-adapter";
import { CodexFixtureAdapter } from "./codex-fixture-adapter";
import { OpenCodeFixtureAdapter } from "./opencode-fixture-adapter";
import {
  ProcessAgentNodeExecutor,
  type AgentProcessSupervisor
} from "./process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "./workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "./workflow-run-runtime";

/**
 * Acceptance for the multi-agent chain Claude Code → OpenCode → Codex inside ONE official run, proved
 * by structure and never by terminal text. Every process start in the harness is recorded, so the
 * suite can state exactly how many processes existed, who started them and what each agent received.
 *
 * All three agents are deterministic fixtures: no real Claude, Codex or OpenCode is called here, and
 * this file is part of the ordinary integration gate. The opt-in real counterpart is
 * `scripts/multi-agent-e2e-local-check.ts`, which is never part of a gate.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "..", "e2e", "fixtures");
const claudeFixture = join(fixturesDir, "claude-code-fixture.mjs");
const codexFixture = join(fixturesDir, "codex-fixture.mjs");
const openCodeFixture = join(fixturesDir, "opencode-fixture.mjs");
const migrationsFolder = resolve(here, "..", "..", "..", "..", "packages", "local-db", "drizzle");

type StartInput = Parameters<AgentProcessSupervisor["start"]>[0];

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

/**
 * Records every process start the executor performs and delegates to the real supervisor. Nothing
 * else in the harness can spawn a workflow process, so the recording is the count of processes the
 * runtime started — an adapter reaching for another agent would appear here as an extra start.
 */
class RecordingSupervisor implements AgentProcessSupervisor {
  public readonly starts: StartInput[] = [];

  public constructor(
    private readonly inner: ProcessSupervisor,
    /** Runs after a node's process reached a terminal state, before the executor verifies evidence. */
    private readonly onTerminal?: (sessionId: string) => Promise<void>
  ) {}

  public async start(input: StartInput): Promise<ProcessSessionSnapshot> {
    this.starts.push(input);
    return this.inner.start(input);
  }

  public async waitForTerminal(
    sessionId: string,
    timeoutMs: number
  ): Promise<ProcessSessionSnapshot> {
    const snapshot = await this.inner.waitForTerminal(sessionId, timeoutMs);
    await this.onTerminal?.(sessionId);
    return snapshot;
  }

  public async cancel(sessionId: string): Promise<ProcessSessionSnapshot> {
    return this.inner.cancel(sessionId);
  }

  public startFor(nodeId: string): StartInput | undefined {
    return this.starts.find((input) => input.sessionId.includes(`-${nodeId}-`));
  }
}

/** design → Claude Code, implementation → OpenCode, verification → Codex. One run, one supervisor. */
function chainWorkflow(input: {
  readonly id: string;
  readonly designToken?: string;
  readonly implementationToken?: string;
  readonly verificationToken?: string;
  readonly implementationAdapter?: string;
}): Workflow {
  return workflowSchema.parse({
    schema_version: "1.0",
    id: input.id,
    name: "Claude Code to OpenCode to Codex",
    concurrency: 1,
    permissions: {},
    nodes: [
      {
        id: "design",
        type: "agent",
        role: "planner",
        adapter: "claude-code",
        title: `Design ${input.designToken ?? "#fixture:success"}`,
        permissions: {}
      },
      {
        id: "implementation",
        type: "agent",
        role: "implementer",
        adapter: input.implementationAdapter ?? "opencode",
        title: `Implement ${input.implementationToken ?? "#fixture:consume"}`,
        depends_on: ["design"],
        permissions: {}
      },
      {
        id: "verification",
        type: "agent",
        role: "reviewer",
        adapter: "codex",
        title: `Verify ${input.verificationToken ?? "#fixture:consume"}`,
        depends_on: ["implementation"],
        permissions: {}
      }
    ]
  });
}

/** One Claude node whose objective asks only for project work; the protocol adds the managed path. */
function designOnlyWorkflow(id: string, token: string): Workflow {
  return workflowSchema.parse({
    schema_version: "1.0",
    id,
    name: "Claude Code protocol path",
    concurrency: 1,
    permissions: {},
    nodes: [
      {
        id: "design",
        type: "agent",
        role: "planner",
        adapter: "claude-code",
        title: `Create design.txt ${token}`,
        permissions: {}
      }
    ]
  });
}

interface Harness {
  readonly runtime: WorkflowRunRuntime;
  readonly registry: SqliteArtifactRegistry;
  readonly supervisor: ProcessSupervisor;
  readonly recorder: RecordingSupervisor;
  readonly adapters: AgentAdapterRegistry;
  readonly filename: string;
  readonly close: () => Promise<void>;
}

async function compose(
  dir: string,
  onTerminal?: (sessionId: string, harness: () => Harness) => Promise<void>
): Promise<Harness> {
  await mkdir(dir, { recursive: true });
  const filename = join(dir, "forgedeck.db");
  runLocalMigrations({ filename, migrationsFolder });
  const store = new SqliteWorkflowRunStore(filename);
  const registry = new SqliteArtifactRegistry(filename, join(dir, "artifacts"));
  const roots = new InMemoryWorkflowRunRootRegistry();
  const supervisor = new ProcessSupervisor(new PipeProcessFactory(), {
    platform: platform(),
    batchIntervalMs: 8,
    maxBufferLines: 200
  });
  let harness: Harness | null = null;
  const recorder = new RecordingSupervisor(
    supervisor,
    onTerminal === undefined
      ? undefined
      : async (sessionId) => {
          await onTerminal(sessionId, () => {
            if (harness === null) throw new Error("The harness is not composed yet");
            return harness;
          });
        }
  );
  const adapters = new AgentAdapterRegistry([
    new ClaudeCodeFixtureAdapter({
      fixtureScriptPath: claudeFixture,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 15_000
    }),
    new CodexFixtureAdapter({
      fixtureScriptPath: codexFixture,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 15_000
    }),
    new OpenCodeFixtureAdapter({
      fixtureScriptPath: openCodeFixture,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 15_000
    })
  ]);
  const runtime = new WorkflowRunRuntime(
    new SafeWorkflowNodeExecutor(
      null,
      new AgentNodeExecutorRouter(
        adapters,
        new ProcessAgentNodeExecutor(recorder, registry, roots, adapters, process.env),
        null
      ),
      null
    ),
    store,
    registry,
    roots
  );
  harness = {
    runtime,
    registry,
    supervisor,
    recorder,
    adapters,
    filename,
    close: async () => {
      await runtime.close();
      await supervisor.close();
      registry.close();
      store.close();
    }
  };
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a run condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function stdinOf(input: StartInput | undefined): string {
  return input?.launch.initialInput?.data ?? "";
}

/** The session buffer, or empty while the session does not exist yet. Observability only. */
function bufferOf(supervisor: ProcessSupervisor, sessionId: string): string {
  try {
    return supervisor.getBuffer(sessionId);
  } catch {
    return "";
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

describe("multi-agent workflow acceptance (fixtures only, never a real CLI)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "multi-agent-acceptance-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "runs Claude Code → OpenCode → Codex as exactly three runtime-started processes",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "chain");
      const harness = await compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: chainWorkflow({ id: "multi-agent-chain" }),
          target: { root: dir, agentNodeId: "design" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");

        // One process per node, started by the runtime alone: no planning call, no retry, no fallback.
        expect(harness.recorder.starts).toHaveLength(3);
        expect(harness.recorder.starts.map((start) => start.adapterId)).toEqual([
          "agent:claude-code",
          "agent:opencode",
          "agent:codex"
        ]);
        expect(harness.recorder.starts.map((start) => start.sessionId)).toEqual([
          `workflow-agent-${result.id}-design-1`,
          `workflow-agent-${result.id}-implementation-1`,
          `workflow-agent-${result.id}-verification-1`
        ]);
        // Each node launched its OWN agent and nothing else: no adapter reached for another one.
        expect(harness.recorder.startFor("design")?.launch.args[0]).toBe(claudeFixture);
        expect(harness.recorder.startFor("implementation")?.launch.args[0]).toBe(openCodeFixture);
        expect(harness.recorder.startFor("verification")?.launch.args[0]).toBe(codexFixture);

        // Every agent received its own objective, on stdin, never on argv.
        expect(stdinOf(harness.recorder.startFor("design"))).toContain("Design #fixture:success");
        expect(stdinOf(harness.recorder.startFor("implementation"))).toContain(
          "Implement #fixture:consume"
        );
        expect(stdinOf(harness.recorder.startFor("verification"))).toContain(
          "Verify #fixture:consume"
        );
        for (const start of harness.recorder.starts) {
          expect(start.launch.args.some((argument) => argument.includes("#fixture:"))).toBe(false);
          expect(start.launch.initialInput?.closeAfterWrite).toBe(true);
          expect(start.launch.transport).toBe("pipe");
        }

        // Each dependent received the upstream artifact by its officially recorded hash.
        const designArtifact = harness.registry.getNodeArtifact(result.id, "design");
        const implementationArtifact = harness.registry.getNodeArtifact(
          result.id,
          "implementation"
        );
        const verificationArtifact = harness.registry.getNodeArtifact(result.id, "verification");
        expect(designArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(implementationArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(verificationArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(stdinOf(harness.recorder.startFor("implementation"))).toContain(
          designArtifact?.sha256 ?? "missing"
        );
        expect(stdinOf(harness.recorder.startFor("verification"))).toContain(
          implementationArtifact?.sha256 ?? "missing"
        );

        // And the runtime recorded that consumption as verified evidence, by hash.
        const implementation = result.nodeRuns.find((node) => node.nodeId === "implementation");
        const verification = result.nodeRuns.find((node) => node.nodeId === "verification");
        expect(
          implementation?.evidence.find((item) => item.id === "consumed-design")?.metadata?.[
            "sha256"
          ]
        ).toBe(designArtifact?.sha256);
        expect(
          verification?.evidence.find((item) => item.id === "consumed-implementation")?.metadata?.[
            "sha256"
          ]
        ).toBe(implementationArtifact?.sha256);

        expect(result.nodeRuns.every((node) => node.attempt === 1)).toBe(true);
        expect(harness.runtime.list()).toHaveLength(1);
        expect(
          harness.supervisor.listSessions().every((session) => session.state !== "running")
        ).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "the objective asks only for a project file; the adapter's protocol supplies the evidence path",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "protocol-path");
      const harness = await compose(dir);
      try {
        // The fixture deliberately never reads COMPAZIO_RESULT_PATH: it takes the managed path from
        // the prompt, exactly like an agent that cannot resolve an environment variable on its own.
        const handle = harness.runtime.startMaterialized({
          workflow: designOnlyWorkflow("protocol-path", "#fixture:protocol-path:design.txt"),
          target: { root: dir, agentNodeId: "design" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");

        // Both files exist: the project file the objective asked for, and the managed evidence.
        expect(await readFile(join(dir, "design.txt"), "utf8")).toBe("PROJECT_FILE\n");
        const artifact = harness.registry.getNodeArtifact(result.id, "design");
        expect(artifact).not.toBeNull();
        if (artifact === null) return;

        // Only the managed result became structural evidence — the project file is not an artifact.
        const stored = await readFile(harness.registry.resolveArtifactPath(artifact), "utf8");
        expect(JSON.parse(stored)).toMatchObject({ status: "ok", mode: "protocol-path" });
        expect(stored).not.toContain("PROJECT_FILE");
        expect(createHash("sha256").update(stored, "utf8").digest("hex")).toBe(artifact.sha256);
        expect(artifact.type).toBe("claude-code-result");
        expect(harness.recorder.starts).toHaveLength(1);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "an upstream artifact whose bytes no longer match its hash blocks the next node",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "tampered");
      // The verified handoff staged for OpenCode is corrupted after its process exits, so the bytes
      // consumed by the agent disagree with the official sha256 exactly when the runtime verifies
      // consumption.
      const harness = await compose(dir, async (sessionId, get) => {
        if (!sessionId.includes("-implementation-")) return;
        const live = get();
        const runId = live.runtime.list()[0]?.id;
        if (runId === undefined) return;
        await appendFile(
          join(dir, ".forgedeck", "staging", runId, "input-0.artifact"),
          "tampered\n",
          "utf8"
        );
      });
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: chainWorkflow({ id: "multi-agent-tampered" }),
          target: { root: dir, agentNodeId: "design" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("failed");

        const implementation = result.nodeRuns.find((node) => node.nodeId === "implementation");
        expect(implementation?.state).toBe("failed");
        expect(implementation?.failureReason).toBe("missing_evidence");
        // Codex was never started, and nothing downstream was published.
        expect(harness.recorder.starts).toHaveLength(2);
        expect(harness.registry.getNodeArtifact(result.id, "implementation")).toBeNull();
        expect(harness.registry.getNodeArtifact(result.id, "verification")).toBeNull();
        expect(result.nodeRuns.find((node) => node.nodeId === "verification")?.state).not.toBe(
          "succeeded"
        );
      } finally {
        await harness.close();
      }
    }
  );

  it("no adapter can execute a node or start a process", async () => {
    const dir = join(root, "authority");
    const harness = await compose(dir);
    try {
      for (const id of ["claude-code", "codex", "opencode"] as const) {
        const adapter = harness.adapters.get(id);
        // An adapter only plans a launch and reports availability. It holds no supervisor, no
        // executor and no reference to another adapter, so it cannot run anything by itself.
        expect(typeof adapter.planLaunch).toBe("function");
        expect(typeof adapter.detect).toBe("function");
        expect("execute" in adapter).toBe(false);
        expect("start" in adapter).toBe(false);
        expect("run" in adapter).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });

  it(
    "an unknown adapter fails the node before any process is started",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "unknown");
      const harness = await compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: chainWorkflow({
            id: "multi-agent-unknown",
            implementationAdapter: "ghost-agent"
          }),
          target: { root: dir, agentNodeId: "design" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("failed");
        expect(
          result.nodeRuns.find((node) => node.nodeId === "implementation")?.failureReason
        ).toBe("adapter_unavailable");
        // Only Claude's node ever ran: an unregistered adapter never reaches the supervisor.
        expect(harness.recorder.starts).toHaveLength(1);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "cancelling the chain terminates the whole process tree and leaves no orphan",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "cancel");
      const harness = await compose(dir);
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: chainWorkflow({
            id: "multi-agent-cancel",
            implementationToken: "#fixture:child"
          }),
          target: { root: dir, agentNodeId: "design" }
        });
        const sessionId = `workflow-agent-${handle.runId}-implementation-1`;
        await waitFor(() => bufferOf(harness.supervisor, sessionId).includes("CHILD_PID:"));
        const childPid = Number.parseInt(
          /CHILD_PID:(\d+)/u.exec(bufferOf(harness.supervisor, sessionId))?.[1] ?? "",
          10
        );
        expect(Number.isInteger(childPid)).toBe(true);
        expect(isAlive(childPid)).toBe(true);

        await harness.runtime.cancel(handle.runId);
        const result = await handle.completion;
        expect(["cancelled", "failed"]).toContain(result.state);
        expect(result.nodeRuns.find((node) => node.nodeId === "verification")?.state).not.toBe(
          "succeeded"
        );
        expect(harness.registry.getNodeArtifact(result.id, "verification")).toBeNull();
        // Codex never started, the grandchild is gone and no session is left running.
        expect(harness.recorder.starts).toHaveLength(2);
        await waitFor(() => !isAlive(childPid), 15_000);
        expect(
          harness.supervisor.listSessions().every((session) => session.state !== "running")
        ).toBe(true);
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "reopening the same persistence preserves assignments, attempts, artifacts and hashes",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "reload");
      const harness = await compose(dir);
      let runId: string;
      const hashes = new Map<string, string>();
      try {
        const handle = harness.runtime.startMaterialized({
          workflow: chainWorkflow({ id: "multi-agent-reload" }),
          target: { root: dir, agentNodeId: "design" }
        });
        const result = await handle.completion;
        expect(result.state).toBe("succeeded");
        runId = result.id;
        for (const nodeId of ["design", "implementation", "verification"]) {
          const sha256 = harness.registry.getNodeArtifact(runId, nodeId)?.sha256;
          expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
          hashes.set(nodeId, sha256 ?? "");
        }
      } finally {
        await harness.close();
      }

      const store = new SqliteWorkflowRunStore(harness.filename);
      const registry = new SqliteArtifactRegistry(harness.filename, join(dir, "artifacts"));
      try {
        // The per-node agent choice survived as the official definition, in order.
        expect(store.getWorkflow(runId)?.nodes.map((node) => node.adapter)).toEqual([
          "claude-code",
          "opencode",
          "codex"
        ]);
        const snapshot = store.get(runId);
        expect(snapshot?.state).toBe("succeeded");
        expect(snapshot?.nodeRuns.every((node) => node.state === "succeeded")).toBe(true);
        expect(snapshot?.nodeRuns.every((node) => node.attempt === 1)).toBe(true);
        for (const [nodeId, sha256] of hashes) {
          expect(registry.getNodeArtifact(runId, nodeId)?.sha256).toBe(sha256);
        }
        // Nothing was duplicated and the terminal run was not resurrected.
        expect(store.list({})).toHaveLength(1);
        expect(store.recoverInterruptedRuns()).toBe(0);
      } finally {
        registry.close();
        store.close();
      }
    }
  );
});
