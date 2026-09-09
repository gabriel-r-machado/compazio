/**
 * OPT-IN local acceptance check for AUTOMATIC MODE against the REAL Claude Code installed and
 * authenticated by the user. It is NOT part of the common gates and never runs in CI, because it consumes
 * the user's own credits. It only runs when explicitly enabled:
 *
 *   COMPAZIO_AUTOMATIC_LOCAL=1 pnpm test:automatic:claude-local
 *
 * What it does, and nothing more:
 * - creates a disposable temporary workspace (never this repository);
 * - asks for exactly ONE real plan for a minimal, non-destructive objective;
 * - validates the answer against the official plan schema and reports the nodes;
 * - executes at most ONE simple node, and only when the plan itself is a single safe node;
 * - never commits, pushes, merges, deploys or installs anything;
 * - removes the temporary workspace in `finally`, whatever happened.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecFileCommandRunner, PathExecutableDetector } from "@forgedeck/agent-adapters";
import {
  PipeProcessFactory,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  orchestratorPlanSchema,
  type AutomaticWorkflowRequest
} from "@forgedeck/schemas";

import { AgentAdapterRegistry } from "../src/main/agent-adapter-registry";
import { ClaudeCodeAgentAdapter } from "../src/main/claude-code-agent-adapter";
import { ClaudeOrchestratorPort } from "../src/main/claude-orchestrator-port";
import { fingerprintWorkspace } from "../src/main/automatic-mode-composition";
import { createPlanningSnapshot } from "../src/main/planning-snapshot";
import {
  describeAnswerEnvelope,
  describeSchemaIssues,
  describeShape,
  formatAnswerDiagnostics
} from "../src/main/structured-answer-diagnostics";
import { createAllowedEnvironment } from "@forgedeck/terminal";
import { workflowNodeSchema } from "@forgedeck/workflow";

const GUARD = "COMPAZIO_AUTOMATIC_LOCAL";
const OBJECTIVE =
  "Add a short Purpose section to NOTES.md. Do not create or delete any other file.";

function platform(): "win32" | "darwin" | "linux" {
  if (process.platform === "win32" || process.platform === "darwin") return process.platform;
  return "linux";
}

async function main(): Promise<void> {
  if (process.env[GUARD] !== "1") {
    console.error(
      [
        `Refusing to run: set ${GUARD}=1 to opt in.`,
        "",
        "This check calls the REAL Claude Code on your machine and CONSUMES YOUR CREDITS.",
        "It is not part of CI and not part of pnpm lint/typecheck/test/test:integration/build."
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  console.warn(
    [
      "",
      "  ⚠  This check calls the REAL Claude Code and WILL CONSUME YOUR CREDITS.",
      "     It performs ONE planning turn for a trivial objective inside a temporary",
      "     directory and touches no file of this repository.",
      ""
    ].join("\n")
  );

  const workspace = await mkdtemp(join(tmpdir(), "forgedeck-automatic-local-"));
  const supervisor = new ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PtyProcessFactory(platform()),
      pipe: new PipeProcessFactory()
    }),
    { platform: platform(), batchIntervalMs: 16, maxBufferLines: 4_000 }
  );
  try {
    // A minimal, self-contained project, so the objective is trivially satisfiable and harmless.
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({ name: "automatic-local-check", private: true, scripts: {} }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(join(workspace, "NOTES.md"), "# Notes\n", "utf8");
    // The managed staging directory exists before any launch stages a file into it.
    await mkdir(join(workspace, ".forgedeck"), { recursive: true });

    const adapters = new AgentAdapterRegistry([
      new ClaudeCodeAgentAdapter({
        detector: new PathExecutableDetector(),
        commandRunner: new ExecFileCommandRunner(),
        platform: platform(),
        environment: process.env
      })
    ]);
    const availability = await adapters.detect("claude-code");
    if (!availability.available) {
      console.error("Claude Code is not available on PATH; nothing was spent.");
      process.exitCode = 1;
      return;
    }
    console.log(`Using ${availability.version ?? "claude-code"} in ${workspace}.`);

    let lastAnswer = "";
    const port = new ClaudeOrchestratorPort({
      runner: {
        run: async (input) => {
          const sessionId = `automatic-local-${globalThis.crypto.randomUUID()}`;
          const plan = await adapters.resolve({
            node: workflowNodeSchema.parse({
              id: "automatic-planning",
              type: "agent",
              role: "orchestrator",
              adapter: "claude-code",
              title: "Automatic mode planning",
              permissions: {}
            }),
            role: "orchestrator",
            task: input.prompt,
            cwd: input.cwd,
            runId: sessionId,
            attempt: 1,
            // Managed staging lives under `.forgedeck/`, as the production composition does. The
            // adapter stages a prompt file next to the output path, and the fingerprint skips that
            // directory — otherwise the read-only guard would fire on the port's own staging.
            statePath: join(input.cwd, ".forgedeck", `${sessionId}.state`),
            outputPath: join(input.cwd, ".forgedeck", `${sessionId}.out`),
            inputs: []
          });
          if (plan === null) throw new Error("No launch plan for claude-code");
          await supervisor.start({
            sessionId,
            adapterId: "claude-code",
            launch: {
              executable: plan.executable,
              args: [...plan.args],
              cwd: input.cwd,
              environment: createAllowedEnvironment(process.env, plan.environment ?? {}, [
                ...(plan.additionalAllowedEnvKeys ?? [])
              ]),
              cols: 120,
              rows: 30,
              transport: plan.transport ?? "pipe",
              ...(plan.stdin === undefined
                ? {}
                : { initialInput: { data: plan.stdin, closeAfterWrite: true } })
            },
            allowedCwdRoots: [input.cwd],
            additionalAllowedEnvKeys: [...(plan.additionalAllowedEnvKeys ?? [])]
          });
          const snapshot = await supervisor.waitForTerminal(sessionId, input.timeoutMs);
          // Kept only so a rejected answer can be DESCRIBED (shape, envelope) — never printed raw.
          lastAnswer = supervisor.getBuffer(sessionId);
          return { stdout: lastAnswer, exitCode: snapshot.exitCode };
        }
      },
      fingerprinter: { fingerprint: fingerprintWorkspace },
      cwd: workspace,
      // Planning runs in a disposable snapshot, so the real (already temporary) workspace is never the cwd
      // and never an allowed root. `allowedCwdRoots` below is derived from the cwd the port supplies.
      isolation: {
        create: async (workspaceRoot) => {
          const snapshot = await createPlanningSnapshot({ workspaceRoot });
          console.log(
            `Planning snapshot: ${snapshot.files.length} file(s) copied for analysis ` +
              `(${snapshot.files.join(", ") || "none"}).`
          );
          return snapshot;
        }
      },
      context: async () => ({
        summary: "A throwaway directory with a package.json and a NOTES.md.",
        availableScripts: [],
        gitStatus: "not a git repository",
        documentation: [],
        acceptanceCriteria: ["NOTES.md gains a Purpose section"]
      })
    });

    const request: AutomaticWorkflowRequest = {
      workspaceId: "automatic-local-check",
      objective: OBJECTIVE,
      mode: "economic",
      limits: AUTOMATIC_MODE_DEFAULT_LIMITS.economic
    };
    console.log(`Planning once for: “${OBJECTIVE}”`);
    let raw: unknown;
    try {
      raw = await port.analyze(request);
    } catch (error: unknown) {
      // An answer that never became JSON is still worth describing — by envelope alone, never raw.
      if (lastAnswer.length > 0) {
        console.error("The planning turn produced no usable plan.");
        for (const line of formatAnswerDiagnostics({
          envelope: describeAnswerEnvelope(lastAnswer),
          issues: [],
          shape: null,
          schemaValidated: false
        })) {
          console.error(line);
        }
      }
      throw error;
    }
    const parsed = orchestratorPlanSchema.safeParse(raw);
    if (!parsed.success) {
      // Safe diagnostics: schema field paths, type names and the answer's SHAPE. Never a value, never the
      // raw answer, never a prompt or a filesystem path.
      console.error("The real plan did not validate against the official schema.");
      for (const line of formatAnswerDiagnostics({
        envelope: describeAnswerEnvelope(lastAnswer),
        issues: describeSchemaIssues(parsed.error.issues),
        shape: describeShape(raw),
        schemaValidated: false
      })) {
        console.error(line);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Plan accepted: “${parsed.data.title}” with ${parsed.data.nodes.length} node(s).`);
    for (const node of parsed.data.nodes) {
      console.log(`  - ${node.id}: ${node.title} (risk ${node.operationRisk})`);
    }
    // Executing work is out of scope beyond a single safe node, and even then only structurally.
    if (parsed.data.nodes.length !== 1) {
      console.log("The plan has more than one node; this check executes none of them.");
      return;
    }
    const only = parsed.data.nodes[0];
    if (only === undefined || only.operationRisk !== "safe" || only.requiresHumanApproval) {
      console.log("The single node is not safe/unattended; this check executes nothing.");
      return;
    }
    console.log("Single safe node verified structurally. This check executes no node.");
  } finally {
    // Always: no process outlives the check, and the temporary workspace never survives.
    await supervisor.close();
    await rm(workspace, { recursive: true, force: true });
    console.log("Supervisor closed and temporary workspace removed.");
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The local check failed.");
  process.exitCode = 1;
});
