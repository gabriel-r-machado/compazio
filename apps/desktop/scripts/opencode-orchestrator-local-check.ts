import { readdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecFileCommandRunner, PathExecutableDetector } from "@forgedeck/agent-adapters";
import { PipeProcessFactory, ProcessSupervisor } from "@forgedeck/terminal";
import { runLocalMigrations, SqliteWorkflowRunStore } from "@forgedeck/local-db";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { resolveAutomaticModeStrategy } from "@forgedeck/orchestration";
import type { AgentPlanningDescriptor } from "@forgedeck/orchestration";
import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  orchestratorPlanSchema,
  orchestratorProvenanceSchema
} from "@forgedeck/schemas";

import { fingerprintWorkspace } from "../src/main/automatic-mode-composition";
import { OpenCodeOrchestratorPort } from "../src/main/opencode-orchestrator-port";
import { OrchestratorRegistry } from "../src/main/orchestrator-registry";
import { hashPlan } from "../src/main/planning-port-bridge";
import { createPlanningSnapshot } from "../src/main/planning-snapshot";
import { SupervisorPlanningRunner } from "../src/main/supervisor-planning-runner";

/**
 * OPT-IN acceptance for OPENCODE AS A PLANNER against the REAL, locally installed and configured OpenCode
 * CLI. It is deliberately not part of any gate and never runs in CI: it starts ONE real OpenCode turn and
 * therefore consumes the user's own provider credits. It refuses to run without an explicit flag.
 *
 * It plans and stops. It never materializes a draft, never starts a run, never executes a node, and
 * never installs, commits, pushes or deploys anything. The turn runs inside a disposable
 * snapshot of a throwaway workspace; the real workspace is fingerprinted before and after, and the
 * snapshot is removed in `finally`.
 */

const GUARD = "COMPAZIO_OPENCODE_ORCHESTRATOR_LOCAL" as const;
const GLOBAL_TIMEOUT_MS = 10 * 60 * 1_000;
const PLANNING_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_NODES = 2;

const OBJECTIVE = [
  "Plan the smallest possible change to this toy project: add one function to src/index.js and",
  "cover it with one test. Produce a plan with EXACTLY two nodes: one implementer node and one qa",
  "node that depends on it. Do not perform the work; only plan it."
].join("\n");

const AGENTS: readonly AgentPlanningDescriptor[] = [
  { id: "claude-code", displayName: "Claude Code", capabilities: ["planning"], available: true },
  { id: "opencode", displayName: "OpenCode", capabilities: ["backend"], available: true },
  { id: "codex", displayName: "Codex", capabilities: ["testing"], available: true }
];

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

if (process.env[GUARD] !== "1") {
  process.stdout.write(
    [
      "OpenCode planning check is DISABLED.",
      "",
      "This check starts ONE real OpenCode turn and therefore consumes your own provider credits.",
      "It uses the OpenCode CLI you already installed and authenticated; Compazio never asks for,",
      "reads or stores a credential. It only PLANS: nothing is materialized, started or executed.",
      "",
      "To run it deliberately:",
      `  ${GUARD}=1 pnpm test:orchestrator:opencode-local`,
      ""
    ].join("\n")
  );
  process.exit(0);
}

async function main(): Promise<number> {
  process.stdout.write(
    "Running ONE real OpenCode planning turn. This consumes your own provider credits.\n\n"
  );
  // A throwaway workspace, outside this repository. Planning sees only a disposable snapshot of it.
  const workspace = await mkdtemp(join(tmpdir(), "compazio-opencode-planner-"));
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "opencode-planner-check", private: true, scripts: { test: "node --test" } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(workspace, "README.md"), "# Toy project\n\nOne module, one test.\n", "utf8");

  const supervisor = new ProcessSupervisor(new PipeProcessFactory(), {
    platform: platform(),
    batchIntervalMs: 16,
    maxBufferLines: 200
  });
  // Every real planning process is counted, and a SECOND one fails loudly: a reviewed session must ask
  // the planner exactly once, and a silent second generation is the defect this check guards against.
  let realCalls = 0;
  const supervisorRunner = new SupervisorPlanningRunner(supervisor, "opencode");
  const openCodePort = new OpenCodeOrchestratorPort({
    runner: {
      run: async (input) => {
        realCalls += 1;
        if (realCalls > 1) {
          throw new Error("The planner was called twice; one review must cost one turn.");
        }
        return supervisorRunner.run(input);
      }
    },
    commandRunner: new ExecFileCommandRunner(),
    detector: new PathExecutableDetector(),
    platform: platform(),
    environment: process.env,
    planningTimeoutMs: PLANNING_TIMEOUT_MS
  });
  // Resolution goes through the SAME registry production uses. Nothing here reaches for the port by
  // hand, so this check exercises the real dispatch path and not a shortcut around it.
  const registry = new OrchestratorRegistry([openCodePort]);

  // The official run store, opened only to PROVE nothing was ever run: planning must create no
  // WorkflowRun and no attempt at all.
  const filename = join(workspace, "local.db");
  runLocalMigrations({ filename });
  const runStore = new SqliteWorkflowRunStore(filename);

  const deadline = setTimeout(() => {
    process.stderr.write("The OpenCode planning check exceeded its global timeout.\n");
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);
  deadline.unref?.();

  const snapshot = await createPlanningSnapshot({ workspaceRoot: workspace });
  try {
    const availability = await registry.detect("opencode");
    check(
      "the real OpenCode CLI is installed and reports a version",
      availability.available,
      availability.issue?.message
    );
    check(
      "the planner was resolved through the OrchestratorRegistry",
      registry.has("opencode") && registry.get("opencode") === openCodePort,
      registry.knownIds().join(",")
    );
    if (!availability.available) return 1;
    const port = registry.get("opencode");
    process.stdout.write(`OpenCode version: ${availability.version ?? "unknown"}\n`);

    const before = await fingerprintWorkspace(workspace);
    const result = await port.createPlan({
      objective: OBJECTIVE,
      planningSnapshotPath: snapshot.path,
      projectMetadata: { summary: "A toy project with one module and one test script." },
      limits: AUTOMATIC_MODE_DEFAULT_LIMITS.economic,
      availableAgents: AGENTS,
      strategy: resolveAutomaticModeStrategy("economic", AUTOMATIC_MODE_DEFAULT_LIMITS.economic)
    });

    check(
      "OpenCode produced a schema-valid plan",
      result.plan !== null,
      result.diagnostics
        .map((entry) => `${entry.code}${entry.path === null ? "" : ` @${entry.path}`}`)
        .join("; ")
    );
    const plan = result.plan;
    if (plan === null) return 1;

    check("the plan was written by the planner that was asked", result.adapterId === "opencode");
    check(
      `the plan has at most ${String(MAX_NODES)} nodes`,
      plan.nodes.length <= MAX_NODES,
      String(plan.nodes.length)
    );
    check(
      "every node names an adapter that can actually execute it",
      plan.nodes.every((node) => AGENTS.some((agent) => agent.id === node.adapter)),
      plan.nodes.map((node) => `${node.id}=${node.adapter}`).join(",")
    );
    check(
      "every dependency points at a node of this plan and there is no cycle",
      hasNoCycle(plan.nodes),
      plan.nodes.map((node) => `${node.id}<-${node.dependsOn.join("+")}`).join(" ")
    );
    check(
      "the real workspace is unchanged after planning",
      (await fingerprintWorkspace(workspace)) === before
    );
    check(
      "the snapshot never carried the answer file out of the turn",
      !(await readdir(snapshot.path)).includes(".compazio")
    );
    check("exactly one real OpenCode turn was spent", realCalls === 1, String(realCalls));

    // The plan and WHO WROTE IT are persisted exactly as validated, then read back and re-validated
    // WITHOUT the planner: a reload shows the plan and its provenance, it never regenerates them.
    const planHash = hashPlan(plan);
    const provenance = orchestratorProvenanceSchema.parse({
      adapter: "opencode",
      version: availability.version,
      plannedAt: new Date().toISOString(),
      strategy: "economic",
      planHash,
      draftHash: null,
      materializedDraftHash: null,
      supportsRemediation: false,
      diagnostics: []
    });
    const sessionPath = join(workspace, "session.json");
    await writeFile(
      sessionPath,
      `${JSON.stringify({ plan, orchestrator: provenance })}
`,
      "utf8"
    );

    const reloaded = JSON.parse(await readFile(sessionPath, "utf8")) as {
      readonly plan: unknown;
      readonly orchestrator: unknown;
    };
    const revalidated = orchestratorPlanSchema.safeParse(reloaded.plan);
    check("the persisted plan reloads and still validates", revalidated.success);
    check(
      "the plan hash recomputed from the reloaded plan matches the recorded one",
      revalidated.success && hashPlan(revalidated.data) === planHash,
      planHash.slice(0, 12)
    );
    const reloadedProvenance = orchestratorProvenanceSchema.safeParse(reloaded.orchestrator);
    check(
      "the provenance came back naming OpenCode, with its version and time",
      reloadedProvenance.success &&
        reloadedProvenance.data.adapter === "opencode" &&
        reloadedProvenance.data.version === availability.version &&
        reloadedProvenance.data.plannedAt !== null &&
        reloadedProvenance.data.strategy === "economic",
      JSON.stringify(reloadedProvenance.success ? reloadedProvenance.data : null)
    );
    check("reloading the plan called OpenCode zero more times", realCalls === 1, String(realCalls));
    check(
      "no WorkflowRun and no attempt was ever created",
      runStore.list({}).length === 0,
      String(runStore.list({}).length)
    );
    check(
      "no node was materialized or executed",
      supervisor.listSessions().every((session) => session.state !== "running")
    );
    process.stdout.write(
      `\nPlan: ${plan.title} — ${plan.nodes.map((node) => `${node.id}(${node.role}/${node.adapter})`).join(" → ")}\n`
    );
  } finally {
    clearTimeout(deadline);
    // Nothing this check created outlives it, on success or on failure.
    await snapshot.dispose();
    await supervisor.close().catch(() => undefined);
    runStore.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    process.stdout.write("Snapshot and temporary workspace removed.\n");
  }

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(
    `\nOPENCODE PLANNING CHECK: ${String(checks.length - failed.length)}/${String(checks.length)}\n`
  );
  return failed.length === 0 ? 0 : 1;
}

/** A local cycle check, so the acceptance proves the property itself instead of trusting the validator. */
function hasNoCycle(
  nodes: readonly { readonly id: string; readonly dependsOn: readonly string[] }[]
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === "done") return true;
    if (current === "visiting") return false;
    const node = byId.get(id);
    if (node === undefined) return false;
    state.set(id, "visiting");
    for (const dependency of node.dependsOn) {
      if (!visit(dependency)) return false;
    }
    state.set(id, "done");
    return true;
  };
  return nodes.every((node) => visit(node.id));
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `OpenCode planning check crashed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
