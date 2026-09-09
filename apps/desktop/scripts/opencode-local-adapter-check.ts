import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { ExecFileCommandRunner, PathExecutableDetector } from "@forgedeck/agent-adapters";
import {
  PipeProcessFactory,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import {
  SqliteArtifactRegistry,
  SqliteWorkflowRunStore,
  runLocalMigrations
} from "@forgedeck/local-db";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { workflowSchema } from "@forgedeck/workflow";

import { AgentAdapterRegistry } from "../src/main/agent-adapter-registry";
import { AgentNodeExecutorRouter } from "../src/main/agent-node-executor-router";
import { OpenCodeAgentAdapter } from "../src/main/opencode-agent-adapter";
import { ProcessAgentNodeExecutor } from "../src/main/process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "../src/main/workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "../src/main/workflow-run-runtime";

/**
 * OPT-IN acceptance check against the REAL, locally installed and authenticated OpenCode CLI.
 *
 * It is deliberately not part of any gate and never runs in CI: it starts one real agent turn, which
 * consumes the user's own OpenCode provider credits. It refuses to run without an explicit flag.
 *
 * What it does, and nothing more: create a throwaway workspace outside the repository, ask OpenCode for
 * one minimal task with a controlled expected output, publish the result as an official artifact
 * through the same runtime every other flow uses, verify the hash, and delete everything in `finally`.
 * It never touches this repository, never commits, pushes, deploys or installs anything, and never
 * reads or stores a credential.
 */

const ENABLED = process.env.COMPAZIO_OPENCODE_LOCAL === "1";

if (!ENABLED) {
  process.stdout.write(
    [
      "OpenCode real-adapter check is DISABLED.",
      "",
      "This check starts ONE real OpenCode turn and therefore consumes your own OpenCode provider credits.",
      "It uses the OpenCode CLI you already installed and authenticated; Compazio never asks for,",
      "reads or stores a credential.",
      "",
      "To run it deliberately:",
      "  COMPAZIO_OPENCODE_LOCAL=1 pnpm test:adapter:opencode-local",
      ""
    ].join("\n")
  );
  process.exit(0);
}

const EXPECTED = "compazio-opencode-ok";
const TASK = [
  "Create a file named result.txt in the current working directory.",
  `Its entire content must be exactly this single line: ${EXPECTED}`,
  "Do not create, modify or delete any other file. Do not run git. Then stop.",
  // OpenCode has no --output-last-message equivalent, so the official result is this managed file.
  "Also write that same single line to the file named by the COMPAZIO_RESULT_PATH environment variable."
].join("\n");

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

const checks: { readonly name: string; readonly ok: boolean; readonly detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail ?? ""}`}\n`);
}

async function main(): Promise<number> {
  process.stdout.write(
    "Running ONE real OpenCode turn. This consumes your own OpenCode provider credits.\n\n"
  );
  // A throwaway workspace, deliberately outside this repository so the real agent cannot reach it.
  const workspace = await mkdtemp(join(tmpdir(), "compazio-opencode-real-"));
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
    { platform: platform(), batchIntervalMs: 16, maxBufferLines: 200 }
  );
  const adapters = new AgentAdapterRegistry([
    new OpenCodeAgentAdapter({
      detector: new PathExecutableDetector(),
      commandRunner: new ExecFileCommandRunner(),
      platform: platform(),
      environment: process.env,
      config: { timeoutMs: 300_000 }
    })
  ]);
  const runtime = new WorkflowRunRuntime(
    new SafeWorkflowNodeExecutor(
      null,
      new AgentNodeExecutorRouter(
        adapters,
        new ProcessAgentNodeExecutor(supervisor, artifacts, roots, adapters, process.env, {
          getNodePrompt: () => TASK
        }),
        null
      ),
      null
    ),
    store,
    artifacts,
    roots
  );

  try {
    const availability = await adapters.detect("opencode");
    check(
      "the real OpenCode CLI is installed and reports a version",
      availability.available,
      availability.issue?.message
    );
    if (!availability.available) return 1;
    process.stdout.write(`OpenCode version: ${availability.version ?? "unknown"}\n`);

    const handle = runtime.startMaterialized({
      workflow: workflowSchema.parse({
        schema_version: "1.0",
        id: "opencode-local-check",
        name: "OpenCode local check",
        concurrency: 1,
        permissions: { workspace_write: true },
        nodes: [
          {
            id: "write-result",
            type: "agent",
            role: "implementer",
            adapter: "opencode",
            title: "Write the controlled result",
            permissions: { workspace_write: true }
          }
        ]
      }),
      target: { root: workspace, agentNodeId: "write-result" }
    });
    const result = await handle.completion;
    check(
      "the run succeeded through the official runtime",
      result.state === "succeeded",
      result.state
    );

    const artifact = artifacts.getNodeArtifact(result.id, "write-result");
    check("OpenCode published an official artifact", artifact !== null);
    if (artifact === null) return 1;

    const content = await readFile(artifacts.resolveArtifactPath(artifact), "utf8");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    check(
      "the published artifact hash matches its recorded sha256",
      sha256 === artifact.sha256,
      `${sha256} vs ${artifact.sha256}`
    );
    check(
      "the agent's own result mentions the controlled content",
      content.includes(EXPECTED),
      content.slice(0, 200)
    );
    check(
      "no orphan session remains",
      supervisor.listSessions().every((session) => session.state !== "running")
    );
  } finally {
    // Everything the check created is removed, on success and on failure alike.
    await runtime.close().catch(() => undefined);
    await supervisor.close().catch(() => undefined);
    artifacts.close();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(
    `\nOPENCODE LOCAL CHECK: ${checks.length - failed.length}/${checks.length}\n`
  );
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `OpenCode local check crashed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
