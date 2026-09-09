import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  CheckRunner,
  OrchestratorAvailability,
  OrchestratorPlanRequest,
  OrchestratorPlanResult
} from "@forgedeck/orchestration";
import type { SqliteAutomaticRunStore, SqliteWorkflowActivationStore } from "@forgedeck/local-db";
import type { AutomaticEvent, AutomaticWorkflowRequest } from "@forgedeck/schemas";
import { workflowNodeSchema, type WorkflowNode } from "@forgedeck/workflow";
import { createAllowedEnvironment, type ProcessSupervisor } from "@forgedeck/terminal";

import { ExecFileCommandRunner, PathExecutableDetector } from "@forgedeck/agent-adapters";
import type { AgentPlanningDescriptor, OrchestratorPort } from "@forgedeck/orchestration";
import type { RuntimePlatform } from "@forgedeck/agent-sdk";

import type { AgentAdapterRegistry } from "./agent-adapter-registry";
import { AgentDescriptorRegistry } from "./agent-descriptor-registry";
import { AutomaticModeService } from "./automatic-mode-service";
import { ClaudeOrchestratorPort, type RepositoryContext } from "./claude-orchestrator-port";
import { CodexOrchestratorPort } from "./codex-orchestrator-port";
import { OpenCodeOrchestratorPort } from "./opencode-orchestrator-port";
import { createOrchestratorSelection } from "./orchestrator-selection";
import { createPlanningSnapshot, type PlanningIsolation } from "./planning-snapshot";
import { SupervisorPlanningRunner } from "./supervisor-planning-runner";
import { DesktopWorkflowRunPort } from "./desktop-workflow-run-port";
import type { NodeArtifactStore } from "./process-agent-node-executor";
import type { WorkflowRunRuntime } from "./workflow-run-runtime";

/**
 * Builds the automatic-mode service out of the desktop's ALREADY LIVE collaborators. Everything specific
 * to running an analysis turn, fingerprinting a workspace, collecting repository facts and resolving a run
 * root lives here, so the composition root stays a wiring list and this stays testable.
 *
 * It creates no runtime, scheduler, supervisor, executor or second database.
 */

export interface AutomaticModeCompositionDeps {
  /** The single live runtime; passed through to every run port, never re-created. */
  readonly runtime: WorkflowRunRuntime;
  /** The single live supervisor, used only to run the read-only planning turn. */
  readonly supervisor: ProcessSupervisor;
  readonly adapters: AgentAdapterRegistry;
  readonly store: SqliteAutomaticRunStore;
  readonly activations: SqliteWorkflowActivationStore;
  readonly artifacts: NodeArtifactStore;
  /** Absolute project root for a workspace, or null when it cannot be resolved. */
  readonly resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null> | string | null;
  readonly sanitize: (text: string) => string;
  readonly publish: (event: AutomaticEvent) => void;
  /** Runs one allowlisted verification command; the same gate runner the rest of the product uses. */
  readonly checkRunner: CheckRunner;
  /** Builds that same gate runner for a particular local workspace when verification needs a cwd. */
  readonly checkRunnerFor?: (workspaceId: string) => CheckRunner;
  /** Overridable only so tests can observe the snapshot; production always uses the real one. */
  readonly isolation?: PlanningIsolation;
}

const PLANNING_ADAPTER_ID = "claude-code";
const PLANNING_TIMEOUT_MS = 5 * 60 * 1_000;

export function createAutomaticModeService(
  deps: AutomaticModeCompositionDeps
): AutomaticModeService {
  const roots = new Map<string, string>();
  const rootFor = async (workspaceId: string): Promise<string> => {
    const cached = roots.get(workspaceId);
    if (cached !== undefined) return cached;
    const resolved = await deps.resolveWorkspaceRoot(workspaceId);
    if (resolved === null) throw new Error("The automatic workspace root is unavailable");
    roots.set(workspaceId, resolved);
    return resolved;
  };

  const isolation: PlanningIsolation = deps.isolation ?? {
    create: (workspaceRoot) => createPlanningSnapshot({ workspaceRoot })
  };
  const claude = createWorkspaceScopedClaudePort({ deps, rootFor, isolation });
  // Codex joins as a PLANNER only. Which agents execute the nodes is a separate list, passed through
  // untouched, so choosing a planner never moves an executor.
  const selection = createOrchestratorSelection({
    ports: [
      // Claude is registered like any other planner. It happens to also implement the coordinator's
      // analysis seam, so the selection uses it as-is — decided by capability, never by its id.
      claude,
      new CodexOrchestratorPort({
        runner: new SupervisorPlanningRunner(deps.supervisor, "codex"),
        commandRunner: new ExecFileCommandRunner(),
        detector: new PathExecutableDetector(),
        platform: runtimePlatform(),
        environment: process.env
      }),
      new OpenCodeOrchestratorPort({
        runner: new SupervisorPlanningRunner(deps.supervisor, "opencode"),
        commandRunner: new ExecFileCommandRunner(),
        detector: new PathExecutableDetector(),
        platform: runtimePlatform(),
        environment: process.env
      })
    ],
    isolation,
    workspaceRoot: async (request) => rootFor(request.workspaceId),
    projectMetadata: async (request) =>
      collectRepositoryContext(request, await rootFor(request.workspaceId)),
    availableAgents: async () => planningDescriptors(deps)
  });

  return new AutomaticModeService({
    store: deps.store,
    // The default planner stays exactly what it was; selection is additive.
    orchestrator: claude,
    ...(selection === null ? {} : { orchestrators: selection }),
    defaultOrchestrator: PLANNING_ADAPTER_ID,
    createRunPort: (input) =>
      new DesktopWorkflowRunPort({
        runtime: deps.runtime,
        targets: {
          resolveTarget: () => {
            const root = roots.get(input.workspaceId);
            // The root is resolved before the session is driven, so this is always warm.
            if (root === undefined) throw new Error("The automatic workspace root is unavailable");
            return { root };
          }
        },
        prompts: {
          putNodePrompt: (prompt) => deps.store.putNodePrompt(input.automaticRunId, prompt)
        },
        activations: deps.activations,
        artifacts: deps.artifacts,
        expectsArtifact: input.expectsArtifact,
        workspaceId: input.workspaceId
      }),
    checkRunner: deps.checkRunner,
    ...(deps.checkRunnerFor === undefined ? {} : { checkRunnerFor: deps.checkRunnerFor }),
    sanitize: deps.sanitize,
    publish: deps.publish,
    prepareWorkspace: async (workspaceId) => {
      await rootFor(workspaceId);
    }
  });
}

/**
 * Claude owns the established analysis/remediation seam, but the workspace belongs to each request.
 * This adapter resolves the local project lazily and creates the real Claude port only for that project;
 * the desktop application's source directory is never a planning or remediation fallback.
 */
function createWorkspaceScopedClaudePort(input: {
  readonly deps: AutomaticModeCompositionDeps;
  readonly rootFor: (workspaceId: string) => Promise<string>;
  readonly isolation: PlanningIsolation;
}): OrchestratorPort & {
  readonly id: "claude-code";
  detect(): Promise<OrchestratorAvailability>;
  createPlan(
    request: OrchestratorPlanRequest,
    signal?: AbortSignal
  ): Promise<OrchestratorPlanResult>;
  forWorkspace(workspaceId: string): OrchestratorPort;
} {
  const ports = new Map<string, OrchestratorPort>();
  const createPort = (root: string): ClaudeOrchestratorPort =>
    new ClaudeOrchestratorPort({
      runner: {
        run: async (planningInput) => runPlanningTurn(input.deps, planningInput)
      },
      fingerprinter: { fingerprint: fingerprintWorkspace },
      cwd: root,
      // Prevention, not just detection: planning runs in a disposable snapshot of the project.
      isolation: input.isolation,
      context: async (request) => collectRepositoryContext(request, root),
      availability: async () => claudeAvailability(input.deps)
    });
  const forWorkspace = (workspaceId: string): OrchestratorPort => {
    const existing = ports.get(workspaceId);
    if (existing !== undefined) return existing;
    const scoped: OrchestratorPort = {
      analyze: async (request) => {
        if (request.workspaceId !== workspaceId) {
          throw new Error(
            "The selected project changed while the automatic workflow was planning."
          );
        }
        return createPort(await input.rootFor(workspaceId)).analyze(request);
      },
      remediate: async (context) => createPort(await input.rootFor(workspaceId)).remediate(context)
    };
    ports.set(workspaceId, scoped);
    return scoped;
  };

  return {
    id: PLANNING_ADAPTER_ID,
    detect: async () => {
      const availability = await claudeAvailability(input.deps);
      return {
        id: PLANNING_ADAPTER_ID,
        hasImplementation: true,
        available: availability.available,
        version: availability.version,
        issue: availability.available
          ? null
          : {
              code: "planner_unavailable",
              path: null,
              message: availability.message ?? "Claude Code is not available.",
              structuralShape: null
            }
      };
    },
    // Selection dispatches this port through `analyze`, its declared established capability. Keeping
    // a neutral method satisfies the common registry contract while preventing a request without a
    // workspace id from choosing an arbitrary local project.
    createPlan: async () => {
      throw new Error("Claude planning requires a workspace-scoped automatic request.");
    },
    analyze: async (request) => forWorkspace(request.workspaceId).analyze(request),
    remediate: async () => {
      throw new Error("Automatic remediation requires the session's selected project.");
    },
    forWorkspace
  };
}

async function claudeAvailability(deps: AutomaticModeCompositionDeps): Promise<{
  readonly available: boolean;
  readonly version: string | null;
  readonly message?: string;
}> {
  const probe = await deps.adapters.detect(PLANNING_ADAPTER_ID);
  return {
    available: probe.available,
    version: probe.version,
    ...(probe.issue === null ? {} : { message: probe.issue.message })
  };
}

/**
 * Runs ONE read-only planning turn through the registered Claude Code adapter over the pipe transport, on
 * the same supervisor as everything else. It is single-shot and non-interactive: no pty, no shell, and the
 * prompt travels on stdin so it never reaches argv.
 */
async function runPlanningTurn(
  deps: AutomaticModeCompositionDeps,
  input: { readonly prompt: string; readonly cwd: string; readonly timeoutMs: number }
): Promise<{ readonly stdout: string; readonly exitCode: number | null }> {
  const sessionId = `automatic-planning-${globalThis.crypto.randomUUID()}`;
  const plan = await deps.adapters.resolve({
    node: planningNode(),
    role: "orchestrator",
    task: input.prompt,
    cwd: input.cwd,
    runId: sessionId,
    attempt: 1,
    statePath: join(input.cwd, ".forgedeck", `${sessionId}.state`),
    outputPath: join(input.cwd, ".forgedeck", `${sessionId}.out`),
    inputs: []
  });
  if (plan === null) {
    throw new Error("Claude Code is not available for automatic planning");
  }
  await deps.supervisor.start({
    sessionId,
    adapterId: PLANNING_ADAPTER_ID,
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
    // The supervisor validates the launch env against its own allowlist, so the adapter's extra keys must
    // be declared here as well as folded into the environment above.
    additionalAllowedEnvKeys: [...(plan.additionalAllowedEnvKeys ?? [])]
  });
  const snapshot = await deps.supervisor.waitForTerminal(
    sessionId,
    Math.min(input.timeoutMs, PLANNING_TIMEOUT_MS)
  );
  return { stdout: deps.supervisor.getBuffer(sessionId), exitCode: snapshot.exitCode };
}

function runtimePlatform(): RuntimePlatform {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported platform");
}

/**
 * The agents a plan may assign to its NODES, with their current execution availability. This is the
 * executor question, answered by the execution registries — the planner only reads it.
 */
async function planningDescriptors(
  deps: AutomaticModeCompositionDeps
): Promise<readonly AgentPlanningDescriptor[]> {
  const descriptors = await new AgentDescriptorRegistry(deps.adapters).refresh();
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    displayName: descriptor.displayName,
    capabilities: [...descriptor.capabilities],
    available: descriptor.available && descriptor.hasImplementation
  }));
}

/** The synthetic node the planning turn is launched as. It is never part of any workflow definition. */
function planningNode(): WorkflowNode {
  return workflowNodeSchema.parse({
    id: "automatic-planning",
    type: "agent",
    role: "orchestrator",
    adapter: PLANNING_ADAPTER_ID,
    title: "Automatic mode planning",
    permissions: {}
  });
}

/**
 * A fingerprint of the workspace's own tracked files (name, size, mtime), bounded in breadth and depth so
 * it stays cheap. Planning must not change any of it; a different fingerprint afterwards proves it did.
 */
export async function fingerprintWorkspace(cwd: string): Promise<string> {
  const hash = createHash("sha256");
  const skip = new Set([".git", "node_modules", "dist", "out", ".forgedeck", ".turbo"]);
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: { readonly name: string; readonly directory: boolean }[];
    try {
      entries = (await readdir(directory, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory()
      }));
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
      if (skip.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.directory) {
        await walk(full, depth + 1);
        continue;
      }
      try {
        const info = await stat(full);
        hash.update(`${full}:${info.size}:${info.mtimeMs}\n`);
      } catch {
        // A file that vanished mid-walk is itself a change; record its absence deterministically.
        hash.update(`${full}:missing\n`);
      }
    }
  };
  await walk(cwd, 0);
  return hash.digest("hex");
}

/**
 * The repository facts the planner may see: a short summary, the available package scripts, whether the
 * tree is clean, and CLAUDE.md when present. It never ships the whole repository or any secret file.
 */
export async function collectRepositoryContext(
  request: AutomaticWorkflowRequest,
  cwd: string
): Promise<RepositoryContext> {
  const scripts = await readPackageScripts(cwd);
  const documentation = await readDocumentation(cwd);
  return {
    summary: `Workspace ${request.workspaceId} at ${cwd}.`,
    availableScripts: scripts,
    // The tree state is reported as a fact, not as a diff: no file content ever leaves this way.
    gitStatus: "The working tree state is reported by the product, not read from git output here.",
    documentation,
    acceptanceCriteria: []
  };
}

async function readPackageScripts(cwd: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const scripts =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { readonly scripts?: Record<string, unknown> }).scripts
        : undefined;
    if (scripts === undefined) return [];
    return Object.keys(scripts)
      .slice(0, 40)
      .map((name) => `pnpm ${name}`);
  } catch {
    return [];
  }
}

async function readDocumentation(
  cwd: string
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const documents: { path: string; content: string }[] = [];
  for (const candidate of ["CLAUDE.md", "README.md"]) {
    try {
      const content = await readFile(join(cwd, candidate), "utf8");
      documents.push({ path: candidate, content: content.slice(0, 8_000) });
    } catch {
      // A missing document is simply not offered to the planner.
    }
  }
  return documents;
}
