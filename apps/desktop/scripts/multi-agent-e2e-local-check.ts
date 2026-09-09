import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecFileCommandRunner, PathExecutableDetector } from "@forgedeck/agent-adapters";
import {
  PipeProcessFactory,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import type { ProcessSessionSnapshot } from "@forgedeck/terminal";
import {
  SqliteArtifactRegistry,
  SqliteWorkflowRunStore,
  runLocalMigrations
} from "@forgedeck/local-db";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { workflowSchema } from "@forgedeck/workflow";

import { AgentAdapterRegistry } from "../src/main/agent-adapter-registry";
import { AgentNodeExecutorRouter } from "../src/main/agent-node-executor-router";
import { ClaudeCodeAgentAdapter } from "../src/main/claude-code-agent-adapter";
import { CodexAgentAdapter } from "../src/main/codex-agent-adapter";
import { OpenCodeAgentAdapter } from "../src/main/opencode-agent-adapter";
import {
  ProcessAgentNodeExecutor,
  type AgentProcessSupervisor
} from "../src/main/process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "../src/main/workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "../src/main/workflow-run-runtime";

/**
 * OPT-IN acceptance for the MULTI-AGENT chain against the REAL, locally installed and authenticated
 * Claude Code, OpenCode and Codex CLIs.
 *
 * It is deliberately not part of any gate and never runs in CI: it starts THREE real agent turns —
 * one per agent, no planning call, no retry, no remediation — and therefore consumes the user's own
 * provider credits. It refuses to run without an explicit flag.
 *
 * The chain is Claude Code → OpenCode → Codex inside ONE official run: Claude writes design.txt,
 * OpenCode consumes Claude's official artifact by hash and writes implementation.txt, and Codex
 * consumes both and writes verification.txt. Authority is structural at every step — exit code,
 * exact file bytes, official artifacts, recomputed sha256, consumption recorded by hash, the final
 * run snapshot and a reload of the same persistence. Terminal text is never evidence.
 *
 * Everything happens in a throwaway workspace outside this repository, and it is deleted in
 * `finally`. Nothing is installed, committed, pushed or deployed, and no credential is read.
 */

const GUARD = "COMPAZIO_MULTI_AGENT_LOCAL" as const;
const GLOBAL_TIMEOUT_MS = 20 * 60 * 1_000;
const AGENT_TIMEOUT_MS = 6 * 60 * 1_000;
const EXPECTED_STARTS = 3;

const DESIGN_FILE = "design.txt" as const;
const IMPLEMENTATION_FILE = "implementation.txt" as const;
const VERIFICATION_FILE = "verification.txt" as const;
const DESIGN_CONTENT = "COMPAZIO_DESIGN" as const;
const IMPLEMENTATION_CONTENT = "COMPAZIO_IMPLEMENTATION" as const;
const VERIFICATION_CONTENT = "COMPAZIO_VERIFIED" as const;

/** One controlled objective per node. Each adapter wraps it with its own result-file instruction. */
const PROMPTS: ReadonlyMap<string, string> = new Map([
  [
    "design",
    [
      `Create a file named ${DESIGN_FILE} in the current working directory.`,
      "Its entire content must be exactly this single line:",
      DESIGN_CONTENT,
      "",
      // "project file" is deliberate: it does not forbid the managed evidence file the adapter's own
      // protocol requires. The objective describes project work only — it never names the managed
      // path or its environment variable, and this check never reconstructs the staging convention.
      "Do not create, modify, or delete any other project file.",
      "Do not run git.",
      "Do not include explanations or additional content. Then stop."
    ].join("\n")
  ],
  [
    "implementation",
    [
      `Read the upstream artifact listed below and confirm the design step produced ${DESIGN_CONTENT}.`,
      `Then create a file named ${IMPLEMENTATION_FILE} in the current working directory.`,
      `Its entire content must be exactly this single line: ${IMPLEMENTATION_CONTENT}`,
      `Do not modify ${DESIGN_FILE}. Do not create, modify or delete any other file.`,
      "Do not run git. Then stop.",
      `Also write ${IMPLEMENTATION_CONTENT} to the file named by the COMPAZIO_RESULT_PATH environment variable.`
    ].join("\n")
  ],
  [
    "verification",
    [
      `Verify that ${DESIGN_FILE} contains exactly ${DESIGN_CONTENT} and that ${IMPLEMENTATION_FILE}`,
      `contains exactly ${IMPLEMENTATION_CONTENT}, reading both from the current working directory.`,
      "The upstream artifacts and their official sha256 hashes are listed below.",
      `Only if both are correct, create a file named ${VERIFICATION_FILE} whose entire content is`,
      `exactly this single line: ${VERIFICATION_CONTENT}`,
      `Read ${VERIFICATION_FILE} back and confirm it exists before giving the final answer.`,
      "Do not modify any other file. Do not run git.",
      `Then stop and answer with the single word ${VERIFICATION_CONTENT}.`
    ].join("\n")
  ]
]);

const checks: { readonly name: string; readonly ok: boolean; readonly detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail ?? ""}`}\n`);
}

function platform(): RuntimePlatform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported platform");
}

type StartInput = Parameters<AgentProcessSupervisor["start"]>[0];

/**
 * Counts and records every process the runtime starts, and the exit code each one reached. It adds no
 * behaviour: it is the structural proof that exactly three real agent turns happened, one per agent,
 * with no extra planning call, retry or fallback.
 */
class RecordingSupervisor implements AgentProcessSupervisor {
  public readonly starts: StartInput[] = [];
  public readonly exits = new Map<string, number | null>();

  public constructor(private readonly inner: ProcessSupervisor) {}

  public async start(input: StartInput): Promise<ProcessSessionSnapshot> {
    this.starts.push(input);
    return this.inner.start(input);
  }

  public async waitForTerminal(
    sessionId: string,
    timeoutMs: number
  ): Promise<ProcessSessionSnapshot> {
    const snapshot = await this.inner.waitForTerminal(sessionId, timeoutMs);
    this.exits.set(sessionId, snapshot.exitCode);
    return snapshot;
  }

  public async cancel(sessionId: string): Promise<ProcessSessionSnapshot> {
    return this.inner.cancel(sessionId);
  }

  public adapterFor(nodeId: string): string | null {
    return this.starts.find((start) => start.sessionId.includes(`-${nodeId}-`))?.adapterId ?? null;
  }

  public exitFor(nodeId: string): number | null | undefined {
    const sessionId = this.starts.find((start) =>
      start.sessionId.includes(`-${nodeId}-`)
    )?.sessionId;
    return sessionId === undefined ? undefined : this.exits.get(sessionId);
  }
}

if (process.env[GUARD] !== "1") {
  process.stdout.write(
    [
      "Multi-agent real end-to-end check is DISABLED.",
      "",
      "This check starts THREE real agent turns — one Claude Code, one OpenCode and one Codex — and",
      "therefore consumes your own provider credits. It uses the CLIs you already installed and",
      "authenticated; Compazio never asks for, reads or stores a credential.",
      "",
      "To run it deliberately:",
      `  ${GUARD}=1 pnpm test:multi-agent:e2e-local`,
      ""
    ].join("\n")
  );
  process.exit(0);
}

async function main(): Promise<number> {
  process.stdout.write(
    [
      "",
      "  ⚠  Running THREE real agent turns (Claude Code, OpenCode, Codex).",
      "     This CONSUMES YOUR OWN PROVIDER CREDITS. One run, three nodes, no retry,",
      "     in a temporary directory that touches no file of this repository.",
      ""
    ].join("\n")
  );

  // A throwaway workspace, deliberately outside this repository so no real agent can reach it.
  const workspace = await mkdtemp(join(tmpdir(), "compazio-multi-agent-real-"));
  const filename = join(workspace, "local.db");
  runLocalMigrations({ filename });
  const store = new SqliteWorkflowRunStore(filename);
  const artifacts = new SqliteArtifactRegistry(filename, join(workspace, "artifacts"));
  const roots = new InMemoryWorkflowRunRootRegistry();
  const supervisor = new ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PtyProcessFactory(platform()),
      pipe: new PipeProcessFactory()
    }),
    { platform: platform(), batchIntervalMs: 16, maxBufferLines: 400 }
  );
  const recorder = new RecordingSupervisor(supervisor);
  const adapters = new AgentAdapterRegistry([
    new ClaudeCodeAgentAdapter({
      detector: new PathExecutableDetector(),
      commandRunner: new ExecFileCommandRunner(),
      platform: platform(),
      environment: process.env,
      config: { timeoutMs: AGENT_TIMEOUT_MS }
    }),
    new CodexAgentAdapter({
      detector: new PathExecutableDetector(),
      commandRunner: new ExecFileCommandRunner(),
      platform: platform(),
      environment: process.env,
      config: { timeoutMs: AGENT_TIMEOUT_MS }
    }),
    new OpenCodeAgentAdapter({
      detector: new PathExecutableDetector(),
      commandRunner: new ExecFileCommandRunner(),
      platform: platform(),
      environment: process.env,
      config: { timeoutMs: AGENT_TIMEOUT_MS }
    })
  ]);
  const runtime = new WorkflowRunRuntime(
    new SafeWorkflowNodeExecutor(
      null,
      new AgentNodeExecutorRouter(
        adapters,
        new ProcessAgentNodeExecutor(recorder, artifacts, roots, adapters, process.env, {
          getNodePrompt: (_runId, nodeId) => PROMPTS.get(nodeId) ?? null
        }),
        null
      ),
      null
    ),
    store,
    artifacts,
    roots
  );

  const deadline = setTimeout(() => {
    process.stderr.write("The multi-agent end-to-end check exceeded its global timeout.\n");
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);
  deadline.unref?.();

  let closed = false;
  const closeServices = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await runtime.close().catch(() => undefined);
    await supervisor.close().catch(() => undefined);
    artifacts.close();
    store.close();
  };

  try {
    for (const id of ["claude-code", "opencode", "codex"] as const) {
      const availability = await adapters.detect(id);
      check(
        `the real ${id} CLI is installed and reports a version`,
        availability.available,
        availability.issue?.message
      );
      if (!availability.available) return 1;
      process.stdout.write(`${id} version: ${availability.version ?? "unknown"}\n`);
    }

    // ONE official run, three nodes, one agent each, chained by dependency. No retry policy is set,
    // so `max_attempts` stays 1 and a failure can never be silently re-attempted.
    const handle = runtime.startMaterialized({
      workflow: workflowSchema.parse({
        schema_version: "1.0",
        id: "multi-agent-local-check",
        name: "Multi-agent local check",
        concurrency: 1,
        permissions: { workspace_write: true },
        nodes: [
          {
            id: "design",
            type: "agent",
            role: "planner",
            adapter: "claude-code",
            title: "Write the controlled design",
            permissions: { workspace_write: true }
          },
          {
            id: "implementation",
            type: "agent",
            role: "implementer",
            adapter: "opencode",
            title: "Write the controlled implementation",
            depends_on: ["design"],
            permissions: { workspace_write: true }
          },
          {
            id: "verification",
            type: "agent",
            role: "reviewer",
            adapter: "codex",
            title: "Verify the controlled result",
            depends_on: ["implementation"],
            permissions: { workspace_write: true }
          }
        ]
      }),
      target: { root: workspace, agentNodeId: "design" }
    });
    const result = await handle.completion;
    check(
      "the multi-agent run succeeded through the official runtime",
      result.state === "succeeded",
      `${result.state} — ${result.nodeRuns.map((node) => `${node.nodeId}=${node.state}`).join(",")}`
    );

    // --- Exactly three real calls, one per agent, each exiting zero. ---
    check(
      "exactly three real agent processes were started",
      recorder.starts.length === EXPECTED_STARTS,
      String(recorder.starts.length)
    );
    check(
      "each node ran on the agent it declared",
      recorder.adapterFor("design") === "agent:claude-code" &&
        recorder.adapterFor("implementation") === "agent:opencode" &&
        recorder.adapterFor("verification") === "agent:codex",
      [
        recorder.adapterFor("design"),
        recorder.adapterFor("implementation"),
        recorder.adapterFor("verification")
      ].join(" / ")
    );
    check(
      "every agent process exited with code 0",
      ["design", "implementation", "verification"].every((node) => recorder.exitFor(node) === 0),
      ["design", "implementation", "verification"]
        .map((node) => `${node}=${String(recorder.exitFor(node))}`)
        .join(",")
    );
    check(
      "no prompt was placed on the command line",
      recorder.starts.every((start) =>
        start.launch.args.every((argument) => !argument.includes(DESIGN_CONTENT))
      )
    );
    check(
      "every node ran inside the temporary workspace",
      recorder.starts.every((start) => start.launch.cwd === workspace)
    );

    // --- The controlled files, by exact bytes. ---
    for (const [file, expected] of [
      [DESIGN_FILE, DESIGN_CONTENT],
      [IMPLEMENTATION_FILE, IMPLEMENTATION_CONTENT],
      [VERIFICATION_FILE, VERIFICATION_CONTENT]
    ] as const) {
      const produced = await readFile(join(workspace, file), "utf8").catch(() => null);
      check(
        `${file} contains exactly ${expected}`,
        produced !== null && produced.trim() === expected,
        produced === null ? "missing" : `${String(produced.trim().length)} chars`
      );
    }

    // --- Official artifacts, recomputed hashes and the recorded consumption chain. ---
    const published = new Map<string, { readonly id: string; readonly sha256: string }>();
    for (const nodeId of ["design", "implementation", "verification"]) {
      const artifact = artifacts.getNodeArtifact(result.id, nodeId);
      check(`${nodeId} published an official artifact`, artifact !== null);
      if (artifact === null) return 1;
      const content = await readFile(artifacts.resolveArtifactPath(artifact), "utf8");
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      check(
        `${nodeId}'s artifact hash matches the bytes actually stored`,
        sha256 === artifact.sha256,
        `${sha256} vs ${artifact.sha256}`
      );
      published.set(nodeId, { id: artifact.id, sha256: artifact.sha256 });
    }
    for (const [nodeId, upstreamId] of [
      ["implementation", "design"],
      ["verification", "implementation"]
    ] as const) {
      const evidence = result.nodeRuns
        .find((node) => node.nodeId === nodeId)
        ?.evidence.find((item) => item.id === `consumed-${upstreamId}`);
      check(
        `${nodeId} consumed ${upstreamId}'s artifact by its official hash`,
        evidence?.metadata?.["sha256"] === published.get(upstreamId)?.sha256,
        JSON.stringify(evidence?.metadata ?? null)
      );
    }
    const lineage = runtime.definition(result.id).nodes.map((node) => ({
      id: node.id,
      adapter: node.adapter ?? null,
      dependsOn: [...node.depends_on]
    }));
    check(
      "the official lineage is design → implementation → verification",
      JSON.stringify(lineage) ===
        JSON.stringify([
          { id: "design", adapter: "claude-code", dependsOn: [] },
          { id: "implementation", adapter: "opencode", dependsOn: ["design"] },
          { id: "verification", adapter: "codex", dependsOn: ["implementation"] }
        ]),
      JSON.stringify(lineage)
    );

    // --- The run snapshot itself. ---
    check(
      "every node run succeeded on its first attempt",
      result.nodeRuns.length === 3 &&
        result.nodeRuns.every((node) => node.state === "succeeded" && node.attempt === 1),
      result.nodeRuns
        .map((node) => `${node.nodeId}=${node.state}/${String(node.attempt)}`)
        .join(",")
    );
    check(
      "exactly one official run exists",
      runtime.list().length === 1,
      String(runtime.list().length)
    );
    check(
      "no orphan session remains",
      supervisor.listSessions().every((session) => session.state !== "running")
    );

    // --- Close everything, then reopen the SAME persistence. ---
    await closeServices();
    const reopenedStore = new SqliteWorkflowRunStore(filename);
    const reopenedArtifacts = new SqliteArtifactRegistry(filename, join(workspace, "artifacts"));
    try {
      const snapshot = reopenedStore.get(result.id);
      check(
        "the run came back as succeeded after reload",
        snapshot?.state === "succeeded",
        snapshot?.state
      );
      check(
        "every per-node agent assignment survived the reload",
        reopenedStore
          .getWorkflow(result.id)
          ?.nodes.map((node) => node.adapter)
          .join(",") === "claude-code,opencode,codex",
        reopenedStore
          .getWorkflow(result.id)
          ?.nodes.map((node) => node.adapter ?? "none")
          .join(",")
      );
      check(
        "every attempt and node state survived the reload",
        snapshot?.nodeRuns.every((node) => node.state === "succeeded" && node.attempt === 1) ===
          true
      );
      check(
        "every artifact and hash survived the reload",
        [...published].every(
          ([nodeId, artifact]) =>
            reopenedArtifacts.getNodeArtifact(result.id, nodeId)?.sha256 === artifact.sha256
        )
      );
      check(
        "the reload created no second run and re-executed nothing",
        reopenedStore.list({}).length === 1 &&
          reopenedStore.recoverInterruptedRuns() === 0 &&
          recorder.starts.length === EXPECTED_STARTS,
        `${String(reopenedStore.list({}).length)} runs, ${String(recorder.starts.length)} processes`
      );
    } finally {
      reopenedArtifacts.close();
      reopenedStore.close();
    }
  } finally {
    clearTimeout(deadline);
    // Everything the check created is removed, on success and on failure alike.
    await closeServices();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    process.stdout.write("\nServices closed and temporary workspace removed.\n");
  }

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(
    `MULTI-AGENT LOCAL CHECK: ${String(checks.length - failed.length)}/${String(checks.length)}\n`
  );
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `Multi-agent local check crashed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
