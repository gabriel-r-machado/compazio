/**
 * OPT-IN minimal END-TO-END acceptance for AUTOMATIC MODE against the REAL Claude Code. It is NOT part of
 * CI and not part of any gate, because it consumes the user's own credits. It only runs when explicitly
 * enabled:
 *
 *   COMPAZIO_AUTOMATIC_E2E_LOCAL=1 pnpm test:automatic:e2e-local
 *
 * It drives the production composition — the same coordinator, runtime, scheduler, supervisor, artifact
 * registry, activation ledger and local database — with one controlled objective, and proves the result by
 * STRUCTURE, never by text: the file exists, its bytes are exactly right, the node exited zero, an official
 * artifact was published with a hash, and the run snapshot says succeeded.
 *
 * Bounds, all enforced here: one real plan, one real execution, at most two nodes, no dependency install,
 * no commit/push/deploy, no extra remediation, a short global timeout, and cleanup in `finally`.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { ExecFileCommandRunner, PathExecutableDetector } from "@forgedeck/agent-adapters";
import {
  PipeProcessFactory,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import {
  runLocalMigrations,
  SqliteArtifactRegistry,
  SqliteAutomaticRunStore,
  SqliteWorkflowActivationStore,
  SqliteWorkflowRunStore
} from "@forgedeck/local-db";

import { AgentAdapterRegistry } from "../src/main/agent-adapter-registry";
import { AgentNodeExecutorRouter } from "../src/main/agent-node-executor-router";
import { createAutomaticModeService } from "../src/main/automatic-mode-composition";
import { ClaudeCodeAgentAdapter } from "../src/main/claude-code-agent-adapter";
import { ProcessAgentNodeExecutor } from "../src/main/process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "../src/main/workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "../src/main/workflow-run-runtime";

const GUARD = "COMPAZIO_AUTOMATIC_E2E_LOCAL";
const EXPECTED_CONTENT = "COMPAZIO_OK";
const RESULT_FILENAME = "result.txt";
const OBJECTIVE = `Create a file named ${RESULT_FILENAME} containing exactly ${EXPECTED_CONTENT}.`;
const WORKSPACE_ID = "automatic-e2e-local";
const GLOBAL_TIMEOUT_MS = 8 * 60 * 1_000;
const MAX_NODES = 2;

const checks: { readonly name: string; readonly ok: boolean; readonly detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}\n`);
}

function platform(): "win32" | "darwin" | "linux" {
  if (process.platform === "win32" || process.platform === "darwin") return process.platform;
  return "linux";
}

async function main(): Promise<void> {
  if (process.env[GUARD] !== "1") {
    process.stderr.write(
      [
        `Refusing to run: set ${GUARD}=1 to opt in.`,
        "",
        "This check calls the REAL Claude Code and CONSUMES YOUR CREDITS.",
        "It is not part of CI and not part of pnpm lint/typecheck/test/test:integration/build.",
        ""
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    [
      "",
      "  ⚠  This check calls the REAL Claude Code and WILL CONSUME YOUR CREDITS.",
      "     One plan and one execution, in a temporary directory, touching no file",
      "     of this repository.",
      ""
    ].join("\n")
  );

  const workspace = await mkdtemp(join(tmpdir(), "forgedeck-automatic-e2e-"));
  const filename = join(workspace, "forgedeck.db");
  const supervisor = new ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PtyProcessFactory(platform()),
      pipe: new PipeProcessFactory()
    }),
    { platform: platform(), batchIntervalMs: 16, maxBufferLines: 4_000 }
  );
  let registry: SqliteArtifactRegistry | null = null;
  let runStore: SqliteWorkflowRunStore | null = null;
  let automaticStore: SqliteAutomaticRunStore | null = null;
  let activations: SqliteWorkflowActivationStore | null = null;
  const deadline = setTimeout(() => {
    process.stderr.write("The end-to-end check exceeded its global timeout.\n");
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);
  deadline.unref?.();

  try {
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({ name: "automatic-e2e-local", private: true, scripts: {} }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(workspace, "CLAUDE.md"),
      `# Instructions\n\nWrite ${RESULT_FILENAME} with exactly ${EXPECTED_CONTENT} and nothing else.\n`,
      "utf8"
    );
    runLocalMigrations({ filename, backupBeforeMigration: false });
    seedWorkspace(filename, workspace);

    const adapters = new AgentAdapterRegistry([
      new ClaudeCodeAgentAdapter({
        detector: new PathExecutableDetector(),
        commandRunner: new ExecFileCommandRunner(),
        platform: platform(),
        environment: process.env
      })
    ]);
    const availability = await adapters.detect("claude-code");
    check("claude-code is available", availability.available, availability.version ?? "");
    if (!availability.available) {
      process.exitCode = 1;
      return;
    }

    registry = new SqliteArtifactRegistry(filename, join(workspace, "compasso-artifacts"));
    runStore = new SqliteWorkflowRunStore(filename);
    automaticStore = new SqliteAutomaticRunStore(filename);
    activations = new SqliteWorkflowActivationStore(filename);
    const roots = new InMemoryWorkflowRunRootRegistry();
    const runtime = new WorkflowRunRuntime(
      new SafeWorkflowNodeExecutor(
        null,
        new AgentNodeExecutorRouter(
          adapters,
          new ProcessAgentNodeExecutor(supervisor, registry, roots, adapters, process.env, {
            getNodePrompt: (runId, nodeId) => automaticStore?.getNodePrompt(runId, nodeId) ?? null
          }),
          null
        ),
        null
      ),
      runStore,
      registry,
      roots
    );

    const service = createAutomaticModeService({
      runtime,
      supervisor,
      adapters,
      store: automaticStore,
      activations,
      artifacts: registry,
      resolveWorkspaceRoot: () => workspace,
      sanitize: (text) => text,
      publish: () => undefined,
      // Verification is by exit code only; the file itself is checked below, structurally.
      checkRunner: { run: async (command) => ({ command, exitCode: 0, ok: true, summary: "ok" }) },
      planningCwd: workspace
    });

    // ONE real plan.
    const created = await service.create({
      workspaceId: WORKSPACE_ID,
      objective: OBJECTIVE,
      mode: "economic",
      acceptanceCriteria: [`${RESULT_FILENAME} contains exactly ${EXPECTED_CONTENT}`]
    });
    check(
      "a real plan validated against the official schema",
      created.planTitle !== null,
      created.issues.join("; ")
    );
    if (created.planTitle === null) {
      process.exitCode = 1;
      return;
    }
    check(
      `the plan has at most ${String(MAX_NODES)} nodes`,
      created.nodes.length <= MAX_NODES,
      String(created.nodes.length)
    );
    check("the plan needs no human decision", created.pendingApprovals.length === 0);
    if (created.nodes.length > MAX_NODES || created.pendingApprovals.length > 0) {
      process.exitCode = 1;
      return;
    }

    // ONE real execution.
    await service.start(created.automaticRunId);
    await service.waitForIdle();
    const finished = service.show(created.automaticRunId);

    // --- The authority is structure, never text. ---
    const produced = await readFile(join(workspace, RESULT_FILENAME), "utf8").catch(() => null);
    check(`${RESULT_FILENAME} was created by the agent`, produced !== null);
    check(
      `${RESULT_FILENAME} contains exactly ${EXPECTED_CONTENT}`,
      produced !== null && produced.trim() === EXPECTED_CONTENT,
      produced === null ? "missing" : `${String(produced.trim().length)} chars`
    );

    const runId = finished.currentRunId;
    check(
      "exactly one official run was created",
      finished.runIds.length === 1,
      finished.runIds.join(",")
    );
    check("no extra remediation cycle was spent", finished.limits.remediationCyclesUsed === 0);
    check(
      "the automatic run completed",
      finished.status === "completed",
      `${finished.status} ${finished.stopReason ?? ""}`
    );

    if (runId !== null) {
      const snapshot = runStore.get(runId);
      check(
        "the run snapshot says succeeded",
        snapshot?.state === "succeeded",
        snapshot?.state ?? "missing"
      );
      const nodeRuns = snapshot?.nodeRuns ?? [];
      check(
        "every node run exited successfully",
        nodeRuns.length > 0 && nodeRuns.every((node) => node.state === "succeeded"),
        nodeRuns.map((node) => `${node.nodeId}=${node.state}`).join(" ")
      );
      // An official artifact with a real content hash, published by the runtime.
      const artifacts = nodeRuns
        .map((node) => registry?.getNodeArtifact(runId, node.nodeId) ?? null)
        .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null);
      check("an official artifact was published", artifacts.length > 0, String(artifacts.length));
      const first = artifacts[0];
      if (first !== undefined && registry !== null) {
        check(
          "the artifact carries a sha256",
          /^[a-f0-9]{64}$/u.test(first.sha256),
          first.sha256.slice(0, 12)
        );
        const stored = await readFile(registry.resolveArtifactPath(first), "utf8").catch(
          () => null
        );
        const recomputed =
          stored === null ? "" : createHash("sha256").update(stored, "utf8").digest("hex");
        check("the artifact hash matches its stored bytes", recomputed === first.sha256);
      }
      // The prompt reached the executor out of band, with no manual copying.
      const prompts = automaticStore.listNodePrompts(created.automaticRunId);
      check(
        "each node received its prompt automatically",
        prompts.length > 0,
        String(prompts.length)
      );
    }

    check(
      "no session was left running",
      supervisor.listSessions().every((session) => session.state !== "running")
    );

    await service.close();
  } finally {
    clearTimeout(deadline);
    // Always: no process outlives the check and the workspace never survives.
    await supervisor.close();
    registry?.close();
    runStore?.close();
    automaticStore?.close();
    activations?.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    process.stdout.write("Supervisor closed and temporary workspace removed.\n");
  }

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(
    `E2E SUMMARY: ${String(checks.length - failed.length)}/${String(checks.length)} passed\n`
  );
  if (failed.length > 0) process.exitCode = 1;
}

/** The session belongs to a workspace, like every other local record. */
function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const projectId = "77777777-7777-4777-8777-777777777777";
  const now = Date.now();
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Automatic e2e', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, root, root, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-e2e', 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, 'canvas-e2e', 'Principal', 0, 1, ?, ?)`
      )
      .run(WORKSPACE_ID, projectId, now, now);
  } finally {
    sqlite.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "The end-to-end check failed."}\n`
  );
  process.exitCode = 1;
});
