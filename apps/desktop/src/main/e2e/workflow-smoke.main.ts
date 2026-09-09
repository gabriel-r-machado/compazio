import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { app, BrowserWindow, ipcMain } from "electron";

import {
  FakeShellExecutionAdapter,
  ShellWorkflowNodeExecutor,
  type AgentAssignmentCatalog,
  type WorkflowExecutionCheckpointReference,
  type WorkflowRunExecutionContext,
  type WorkflowRunSnapshot
} from "@forgedeck/orchestration";
import {
  NodePtyFactory,
  PipeProcessFactory,
  ProcessSupervisor,
  PtyProcessFactory,
  TransportProcessFactory
} from "@forgedeck/terminal";
import {
  SqliteAutomaticRunStore,
  SqliteArtifactRegistry,
  SqliteWorkflowActivationStore,
  SqliteWorkflowRunStore,
  runLocalMigrations
} from "@forgedeck/local-db";
import {
  WORKFLOW_RUN_EVENTS_CHANNEL,
  WORKFLOW_RUN_GRAPH_CHANNEL,
  WORKFLOW_RUN_SHOW_CHANNEL,
  workflowDraftSchema,
  workflowRunControlRequestSchema,
  workflowRunEventSchema,
  workflowRunGraphSchema,
  workflowRunSnapshotSchema
} from "@forgedeck/schemas";
import type { WorkflowDraft } from "@forgedeck/schemas";

import { ExecFileCommandRunner } from "@forgedeck/agent-adapters";
import { workflowSchema } from "@forgedeck/workflow";

import { ActivationCoordinator } from "../activation-coordinator";
import { AgentAdapterRegistry } from "../agent-adapter-registry";
import { AgentNodeExecutorRouter } from "../agent-node-executor-router";
import { ClaudeCodeFixtureAdapter } from "../claude-code-fixture-adapter";
import { CodexFixtureAdapter } from "../codex-fixture-adapter";
import { OpenCodeFixtureAdapter } from "../opencode-fixture-adapter";
import { createFakeAgentLaunchResolver } from "../fake-agent-launch-resolver";
import { ProcessAgentNodeExecutor } from "../process-agent-node-executor";
import { InMemoryWorkflowRunRootRegistry } from "../workflow-shell-execution-adapter";
import { SafeWorkflowNodeExecutor, WorkflowRunRuntime } from "../workflow-run-runtime";
import {
  assertAutomaticSmokeReload,
  AUTOMATIC_SMOKE_ID,
  runAutomaticSmokeScenario
} from "./automatic-smoke";
import {
  assertMultiAgentBlocksUnassigned,
  assertMultiAgentSmokeReload,
  MULTI_AGENT_SMOKE_ID,
  runMultiAgentSmokeScenario
} from "./multi-agent-smoke";
import {
  assertOrchestratorSmokeReload,
  ORCHESTRATOR_SMOKE_ID,
  runOrchestratorSmokeScenario
} from "./orchestrator-smoke";
import { AgentDescriptorRegistry } from "../agent-descriptor-registry";
import { ElectronQaDriver } from "./electron-qa-driver";

/**
 * Dedicated Electron composition root for the workflow smoke. It reuses the exact production classes
 * (WorkflowRunRuntime, SafeWorkflowNodeExecutor, ProcessAgentNodeExecutor, ShellWorkflowNodeExecutor,
 * the real SQLite stores and ProcessSupervisor) and only overrides the agent adapter registration —
 * injecting the deterministic fake-agent resolver here, never in production `index.ts`. The
 * fake-agent runs through a real Node binary (Electron's own binary is not Node), whose path the
 * driver provides. Nothing writes to SQLite directly to simulate state; every state is produced by
 * the official runtime, and projection is read back through the official IPC channel.
 */
const phase = requireEnv("FORGEDECK_WORKFLOW_SMOKE_PHASE");
const rootDirectory = requireEnv("FORGEDECK_WORKFLOW_SMOKE_USER_DATA");
const fakeAgentPath = requireEnv("FORGEDECK_FAKE_AGENT_PATH");
const claudeFixturePath = requireEnv("FORGEDECK_CLAUDE_FIXTURE_PATH");
const codexFixturePath = requireEnv("FORGEDECK_CODEX_FIXTURE_PATH");
const openCodeFixturePath = requireEnv("FORGEDECK_OPENCODE_FIXTURE_PATH");
const nodeExecutablePath = requireEnv("FORGEDECK_SMOKE_NODE_PATH");
const codexPlannerFixturePath = requireEnv("FORGEDECK_CODEX_PLANNER_FIXTURE_PATH");
const openCodePlannerFixturePath = requireEnv("FORGEDECK_OPENCODE_PLANNER_FIXTURE_PATH");
const migrationsFolder = requireEnv("FORGEDECK_SMOKE_MIGRATIONS_DIR");
const preloadPath =
  process.env.FORGEDECK_SMOKE_PRELOAD_PATH ??
  join(dirname(fileURLToPath(import.meta.url)), "../../preload/index.cjs");
const harnessPath =
  process.env.FORGEDECK_SMOKE_HARNESS_PATH ??
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../out-e2e/renderer/workflow-overlay-harness.html"
  );

interface ScenarioSpec {
  readonly id: string;
  readonly templateId: string;
}

const scenarios: readonly ScenarioSpec[] = [
  { id: "success", templateId: "vertical-slice-reference" },
  { id: "failure", templateId: "vertical-slice-reference-blocked" },
  { id: "cancel", templateId: "vertical-slice-reference-cancel" }
];

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"} [${phase}] ${name}${ok ? "" : ` — ${detail ?? ""}`}\n`
  );
}

interface ScenarioResources {
  readonly runtime: WorkflowRunRuntime;
  readonly registry: SqliteArtifactRegistry;
  readonly store: SqliteWorkflowRunStore;
  readonly supervisor: ProcessSupervisor;
  readonly close: () => Promise<void>;
}

function composeScenario(id: string): ScenarioResources {
  const scenarioDirectory = join(rootDirectory, id);
  const filename = join(scenarioDirectory, "forgedeck.db");
  const registryRoot = join(scenarioDirectory, "compasso-artifacts");
  const store = new SqliteWorkflowRunStore(filename);
  const registry = new SqliteArtifactRegistry(filename, registryRoot);
  const roots = new InMemoryWorkflowRunRootRegistry();
  const supervisor = new ProcessSupervisor(new NodePtyFactory(), {
    platform: runtimePlatform(),
    batchIntervalMs: 8,
    maxBufferLines: 100
  });
  // The one and only override: the agent adapter. Everything else is the production composition.
  const executor = new SafeWorkflowNodeExecutor(
    new ShellWorkflowNodeExecutor(new FakeShellExecutionAdapter()),
    new ProcessAgentNodeExecutor(
      supervisor,
      registry,
      roots,
      createFakeAgentLaunchResolver(fakeAgentPath, nodeExecutablePath)
    ),
    null
  );
  const runtime = new WorkflowRunRuntime(executor, store, registry, roots);
  return {
    runtime,
    registry,
    store,
    supervisor,
    close: closeResources(runtime, supervisor, registry, store)
  };
}

/**
 * The official shutdown order: the runtime stops accepting runs and drains every terminal transition
 * to the database first, then the processes are closed, and only then the stores. Nothing here waits
 * on a timer, and nothing observes the scheduler's in-memory snapshot.
 */
function closeResources(
  runtime: WorkflowRunRuntime,
  supervisor: ProcessSupervisor,
  registry: SqliteArtifactRegistry,
  store: SqliteWorkflowRunStore
): () => Promise<void> {
  return async () => {
    await runtime.close();
    await supervisor.shutdown();
    registry.close();
    store.close();
  };
}

async function runPhase(): Promise<void> {
  for (const scenario of scenarios) {
    const scenarioDirectory = join(rootDirectory, scenario.id);
    await mkdir(scenarioDirectory, { recursive: true });
    runLocalMigrations({ filename: join(scenarioDirectory, "forgedeck.db"), migrationsFolder });
    const resources = composeScenario(scenario.id);
    try {
      const handle = resources.runtime.startTemplate(scenario.templateId, false, {
        root: scenarioDirectory,
        agentNodeId: "planner"
      });
      if (scenario.id === "cancel") {
        await waitFor(() =>
          resources.runtime
            .events(handle.runId)
            .some((event) => event.type === "node.started" && event.nodeRunId !== null)
        );
        await resources.runtime.cancel(handle.runId);
      }
      const result = await handle.completion;
      await assertRunOutcome(scenario, result, resources);
      await writeFile(
        join(scenarioDirectory, "smoke-state.json"),
        JSON.stringify({ runId: handle.runId }),
        "utf8"
      );
    } finally {
      await resources.close();
    }
  }
  await runMaterializationScenario();
  await runClaudeAdapterScenario();
  await runAutomaticScenario();
  await runMultiAgentScenario();
  await runOrchestratorScenario();
}

/**
 * Selectable orchestrators end to end: the picker is read through the guarded IPC, Codex is chosen to
 * WRITE the plan, three different agents EXECUTE the nodes, and one official run completes. No real
 * CLI is involved: the planner and every executor are deterministic fixtures.
 */
async function runOrchestratorScenario(): Promise<void> {
  const scenarioDirectory = join(rootDirectory, ORCHESTRATOR_SMOKE_ID);
  await mkdir(scenarioDirectory, { recursive: true });
  runLocalMigrations({ filename: join(scenarioDirectory, "forgedeck.db"), migrationsFolder });
  const adapters = new AgentAdapterRegistry([
    new ClaudeCodeFixtureAdapter({
      fixtureScriptPath: claudeFixturePath,
      nodeExecutablePath,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 20_000
    }),
    new CodexFixtureAdapter({
      fixtureScriptPath: codexFixturePath,
      nodeExecutablePath,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 20_000
    }),
    new OpenCodeFixtureAdapter({
      fixtureScriptPath: openCodeFixturePath,
      nodeExecutablePath,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 20_000
    })
  ]);
  const resources = composeMultiAgentScenario(ORCHESTRATOR_SMOKE_ID, adapters);
  try {
    await runOrchestratorSmokeScenario({
      scenarioDirectory,
      runtime: resources.runtime,
      adapters,
      artifacts: resources.registry,
      supervisor: resources.supervisor,
      platform:
        process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux",
      nodeExecutablePath,
      codexPlannerFixturePath,
      openCodePlannerFixturePath,
      check
    });
  } finally {
    await resources.close();
  }
}

/**
 * The neutral agent model end to end: the three agents are catalogued, only the installed one is
 * runnable, a per-node choice becomes the definition's executable adapter, and an unassigned node
 * blocks the run before anything is created. The only executable adapter is the Claude fixture.
 */
async function runMultiAgentScenario(): Promise<void> {
  const scenarioDirectory = join(rootDirectory, MULTI_AGENT_SMOKE_ID);
  await mkdir(scenarioDirectory, { recursive: true });
  runLocalMigrations({ filename: join(scenarioDirectory, "forgedeck.db"), migrationsFolder });
  // Both fixtures are registered on the SAME adapter registry, so one run drives two agents through
  // one runtime, one scheduler and one supervisor. Neither real CLI is ever called.
  const adapters = new AgentAdapterRegistry([
    new ClaudeCodeFixtureAdapter({
      fixtureScriptPath: claudeFixturePath,
      nodeExecutablePath,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 20_000
    }),
    new CodexFixtureAdapter({
      fixtureScriptPath: codexFixturePath,
      nodeExecutablePath,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 20_000
    }),
    new OpenCodeFixtureAdapter({
      fixtureScriptPath: openCodeFixturePath,
      nodeExecutablePath,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 20_000
    })
  ]);
  const resources = composeMultiAgentScenario(MULTI_AGENT_SMOKE_ID, adapters);
  const activations = new SqliteWorkflowActivationStore(join(scenarioDirectory, "forgedeck.db"));
  const composeCoordinator = (agents: () => Promise<AgentAssignmentCatalog>) =>
    new ActivationCoordinator({
      onDispatch: () => undefined,
      newId: () => globalThis.crypto.randomUUID(),
      materialization: {
        ledger: activations,
        agents,
        resolveProjectRoot: () => scenarioDirectory,
        starter: {
          startMaterializedWorkflow: async (input) => {
            const handle = resources.runtime.startMaterialized({
              workflow: input.workflow,
              target: { root: input.root, agentNodeId: input.agentNodeId }
            });
            return resources.runtime.get(handle.runId);
          }
        }
      }
    });
  try {
    await runMultiAgentSmokeScenario({
      scenarioDirectory,
      runtime: resources.runtime,
      adapters,
      artifacts: resources.registry,
      supervisor: resources.supervisor,
      composeCoordinator,
      check
    });
    await assertMultiAgentBlocksUnassigned({
      composeCoordinator,
      catalog: await new AgentDescriptorRegistry(adapters).refresh(),
      runtime: resources.runtime,
      check
    });
  } finally {
    activations.close();
    await resources.close();
  }
}

// --- Increment A: approve a canvas draft → materialize → one official WorkflowRunRuntime run. ---

const MATERIALIZE_ID = "materialize" as const;
const MATERIALIZE_WORKSPACE = "workspace-materialize" as const;

function materializationDraft(): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: "55555555-5555-4555-8555-555555555555",
    version: 1,
    workspaceId: MATERIALIZE_WORKSPACE,
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Smoke landing page",
    objective: "Build the smoke landing page",
    state: "approved",
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    nodes: [
      {
        id: "planner",
        title: "Planner",
        role: "planner",
        runtimeRequirement: { resolvedRuntimeId: "fake-agent" }
      },
      {
        id: "implementer",
        title: "Implementer",
        role: "implementer",
        runtimeRequirement: { resolvedRuntimeId: "fake-agent" }
      }
    ],
    edges: [
      {
        id: "planner__implementer",
        sourceNodeId: "planner",
        targetNodeId: "implementer",
        type: "dependency"
      }
    ]
  });
}

function composeMaterializationCoordinator(
  scenarioDirectory: string,
  runtime: WorkflowRunRuntime,
  activations: SqliteWorkflowActivationStore
): ActivationCoordinator {
  return new ActivationCoordinator({
    onDispatch: () => undefined,
    newId: () => globalThis.crypto.randomUUID(),
    materialization: {
      ledger: activations,
      resolveProjectRoot: () => scenarioDirectory,
      starter: {
        startMaterializedWorkflow: async (input) => {
          const checkpoint: WorkflowExecutionCheckpointReference = {
            checkpointId: globalThis.crypto.randomUUID(),
            snapshotId: globalThis.crypto.randomUUID(),
            sha256: input.definitionSha256,
            createdAt: new Date().toISOString()
          };
          const context: WorkflowRunExecutionContext = {
            workspaceId: input.workspaceId,
            agentNodeId: input.agentNodeId,
            task: input.task,
            contractId: null,
            profileVersion: 1,
            missionVersion: null,
            memoryVersion: null,
            contractVersion: null,
            functionCheckpoint: checkpoint,
            deliveryCheckpoint: null
          };
          const handle = runtime.startMaterialized({
            workflow: input.workflow,
            target: { root: input.root, agentNodeId: input.agentNodeId },
            executionContext: { context, createDeliveryCheckpoint: async () => checkpoint }
          });
          return runtime.get(handle.runId);
        }
      }
    }
  });
}

async function runMaterializationScenario(): Promise<void> {
  const scenarioDirectory = join(rootDirectory, MATERIALIZE_ID);
  const filename = join(scenarioDirectory, "forgedeck.db");
  await mkdir(scenarioDirectory, { recursive: true });
  runLocalMigrations({ filename, migrationsFolder });
  seedMaterializationWorkspace(filename, scenarioDirectory);
  const resources = composeScenario(MATERIALIZE_ID);
  const activations = new SqliteWorkflowActivationStore(filename);
  try {
    const coordinator = composeMaterializationCoordinator(
      scenarioDirectory,
      resources.runtime,
      activations
    );
    const draft = materializationDraft();
    const activation = await coordinator.materialize(draft);
    check(
      "materialize: approval returned an activation with a run id",
      activation.status === "started" &&
        activation.runId !== null &&
        (activation.workflowId ?? "").startsWith("draft-"),
      JSON.stringify(activation)
    );
    const runId = activation.runId;
    if (runId === null) return;

    // The run is a real WorkflowRunRuntime run whose nodes preserve the canvas workflowNodeIds.
    check(
      "materialize: exactly one official run was created",
      resources.runtime.list().length === 1
    );
    const created = resources.runtime.show(runId);
    check(
      "materialize: run nodes preserve the workflowNodeIds",
      created.nodeRuns
        .map((node) => node.nodeId)
        .sort()
        .join(",") === "implementer,planner"
    );
    check(
      "materialize: execution context carries the workspace id",
      created.executionContext?.workspaceId === MATERIALIZE_WORKSPACE
    );

    // A repeated approval is idempotent — no second run.
    const again = await coordinator.materialize(draft);
    check(
      "materialize: a repeated approval returns the same run",
      again.runId === runId && resources.runtime.list().length === 1
    );

    await waitFor(() =>
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        resources.runtime.show(runId).state
      )
    );
    const done = resources.runtime.show(runId);
    check(
      "materialize: run succeeded through the official scheduler",
      done.state === "succeeded",
      done.state
    );
    const planner = done.nodeRuns.find((node) => node.nodeId === "planner");
    check(
      "materialize: planner ran with the expected attempt",
      planner?.attempt === 1,
      `attempt=${planner?.attempt}`
    );

    await writeFile(
      join(scenarioDirectory, "smoke-state.json"),
      JSON.stringify({ runId, draftId: draft.id, draftVersion: draft.version }),
      "utf8"
    );
  } finally {
    activations.close();
    await resources.close();
  }
}

// --- First real restricted adapter: Claude Code, single-shot, driven by the controlled fixture. ---

const CLAUDE_ID = "claude-adapter" as const;

/** Composes the production Claude adapter path (registry → ProcessAgentNodeExecutor → ProcessSupervisor),
 * swapping only the executable for the deterministic fixture. It never calls the real Claude. */
/**
 * Composes a scenario around a caller-supplied adapter registry, so one scenario can drive several
 * agents through the SAME runtime, scheduler, supervisor and artifact registry.
 */
function composeMultiAgentScenario(id: string, adapterRegistry: AgentAdapterRegistry) {
  return composeClaudeScenario(id, undefined, adapterRegistry);
}

function composeClaudeScenario(
  id: string,
  prompts?: { getNodePrompt(runId: string, nodeId: string): string | null },
  injectedAdapters?: AgentAdapterRegistry
): ScenarioResources {
  const scenarioDirectory = join(rootDirectory, id);
  const filename = join(scenarioDirectory, "forgedeck.db");
  const registry = new SqliteArtifactRegistry(
    filename,
    join(scenarioDirectory, "compasso-artifacts")
  );
  const store = new SqliteWorkflowRunStore(filename);
  const roots = new InMemoryWorkflowRunRootRegistry();
  const supervisor = new ProcessSupervisor(
    new TransportProcessFactory({
      pty: new PtyProcessFactory(runtimePlatform()),
      pipe: new PipeProcessFactory()
    }),
    {
      platform: runtimePlatform(),
      batchIntervalMs: 8,
      maxBufferLines: 100
    }
  );
  const adapterRegistry =
    injectedAdapters ??
    new AgentAdapterRegistry([
      new ClaudeCodeFixtureAdapter({
        fixtureScriptPath: claudeFixturePath,
        nodeExecutablePath,
        commandRunner: new ExecFileCommandRunner(),
        environment: process.env,
        timeoutMs: 20_000
      })
    ]);
  const executor = new SafeWorkflowNodeExecutor(
    null,
    new AgentNodeExecutorRouter(
      adapterRegistry,
      new ProcessAgentNodeExecutor(
        supervisor,
        registry,
        roots,
        adapterRegistry,
        process.env,
        prompts
      ),
      null
    ),
    null
  );
  const runtime = new WorkflowRunRuntime(executor, store, registry, roots);
  return {
    runtime,
    registry,
    store,
    supervisor,
    close: closeResources(runtime, supervisor, registry, store)
  };
}

function claudeWorkflow() {
  return workflowSchema.parse({
    schema_version: "1.0",
    id: "claude-smoke-flow",
    name: "Claude smoke flow",
    concurrency: 1,
    permissions: {},
    nodes: [
      {
        id: "planner",
        type: "agent",
        role: "planner",
        adapter: "claude-code",
        title: "Plan #fixture:success",
        permissions: {}
      },
      {
        id: "implementer",
        type: "agent",
        role: "implementer",
        adapter: "claude-code",
        title: "Build #fixture:success",
        depends_on: ["planner"],
        permissions: {}
      }
    ]
  });
}

async function runClaudeAdapterScenario(): Promise<void> {
  const scenarioDirectory = join(rootDirectory, CLAUDE_ID);
  await mkdir(scenarioDirectory, { recursive: true });
  runLocalMigrations({ filename: join(scenarioDirectory, "forgedeck.db"), migrationsFolder });
  const resources = composeClaudeScenario(CLAUDE_ID);
  try {
    const handle = resources.runtime.startMaterialized({
      workflow: claudeWorkflow(),
      target: { root: scenarioDirectory, agentNodeId: "planner" }
    });
    const result = await handle.completion;
    check(
      "claude-code: run succeeded through the official scheduler and fixture process",
      result.state === "succeeded",
      result.state
    );
    check(
      "claude-code: exactly one official run was created",
      resources.runtime.list().length === 1
    );
    const plannerArtifact = resources.registry.getNodeArtifact(result.id, "planner");
    check("claude-code: planner published an official artifact", plannerArtifact !== null);
    check(
      "claude-code: implementer published an official artifact",
      resources.registry.getNodeArtifact(result.id, "implementer") !== null
    );
    const implementer = result.nodeRuns.find((node) => node.nodeId === "implementer");
    const consumed = implementer?.evidence.find((item) => item.id === "consumed-planner");
    check(
      "claude-code: dependent consumed the upstream artifact by official hash",
      plannerArtifact !== null && consumed?.metadata?.["sha256"] === plannerArtifact.sha256
    );
    check(
      "claude-code: no orphan sessions remain",
      resources.supervisor.listSessions().every((session) => session.state !== "running")
    );
    await writeFile(
      join(scenarioDirectory, "smoke-state.json"),
      JSON.stringify({ runId: result.id }),
      "utf8"
    );
  } finally {
    await resources.close();
  }
}

async function reloadClaudeAdapterScenario(window: BrowserWindow): Promise<void> {
  const scenarioDirectory = join(rootDirectory, CLAUDE_ID);
  const statePath = join(scenarioDirectory, "smoke-state.json");
  if (!existsSync(statePath)) {
    check("claude-code reload: state persisted", false, "missing smoke-state.json");
    return;
  }
  const { runId } = JSON.parse(await readFile(statePath, "utf8")) as { runId: string };
  const resources = composeClaudeScenario(CLAUDE_ID);
  try {
    check(
      "claude-code reload: run recovered",
      resources.store.get(runId)?.state === "succeeded",
      resources.store.get(runId)?.state
    );
    check(
      "claude-code reload: no second run and no new attempt",
      resources.store.list({}).length === 1 &&
        resources.store.get(runId)?.nodeRuns.find((node) => node.nodeId === "planner")?.attempt ===
          1
    );
    check(
      "claude-code reload: terminal run not resurrected",
      resources.store.recoverInterruptedRuns() === 0
    );
    registerRunIpc(resources.runtime);
    await assertMaterializedOverlay(window, runId);
  } finally {
    await resources.close();
  }
}

async function reloadMaterializationScenario(window: BrowserWindow): Promise<void> {
  const scenarioDirectory = join(rootDirectory, MATERIALIZE_ID);
  const filename = join(scenarioDirectory, "forgedeck.db");
  const statePath = join(scenarioDirectory, "smoke-state.json");
  if (!existsSync(statePath)) {
    check("materialize reload: state persisted", false, "missing smoke-state.json");
    return;
  }
  const { runId, draftId, draftVersion } = JSON.parse(await readFile(statePath, "utf8")) as {
    runId: string;
    draftId: string;
    draftVersion: number;
  };
  const resources = composeScenario(MATERIALIZE_ID);
  const activations = new SqliteWorkflowActivationStore(filename);
  try {
    // The run and the activation association both recover from the same database — no re-approval.
    check(
      "materialize reload: run recovered",
      resources.store.get(runId)?.state === "succeeded",
      resources.store.get(runId)?.state
    );
    check(
      "materialize reload: activation association recovered",
      activations.getByDraft(draftId, draftVersion)?.runId === runId
    );
    check(
      "materialize reload: no second run and no new attempt",
      resources.store.list({}).length === 1 &&
        resources.store.get(runId)?.nodeRuns.find((node) => node.nodeId === "planner")?.attempt ===
          1
    );
    check(
      "materialize reload: terminal run not resurrected",
      resources.store.recoverInterruptedRuns() === 0
    );

    // The renderer harness projects the recovered materialized run onto the real cards and edges.
    registerRunIpc(resources.runtime);
    await assertMaterializedOverlay(window, runId);
  } finally {
    activations.close();
    await resources.close();
  }
}

/** Mounts the overlay harness for a materialized run and asserts the DOM projection of its cards/edges. */
async function assertMaterializedOverlay(window: BrowserWindow, runId: string): Promise<void> {
  if (!existsSync(harnessPath)) {
    check("materialize reload: overlay harness present", false, `missing ${harnessPath}`);
    return;
  }
  await window.loadFile(harnessPath);
  await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 10000;
      while (typeof window.__mountWorkflowOverlay !== "function") {
        if (Date.now() > deadline) throw new Error("mount hook missing");
        await new Promise((r) => setTimeout(r, 25));
      }
    })()`
  );
  await window.webContents.executeJavaScript(
    `window.__mountWorkflowOverlay(${JSON.stringify(runId)})`
  );
  const planner = await queryAttributes(window, '[data-workflow-node-id="planner"]', [
    "data-runtime-state"
  ]);
  check(
    "materialize reload: bound planner card shows the official run state",
    planner["data-runtime-state"] === "succeeded",
    planner["data-runtime-state"] ?? undefined
  );
  const edge = await queryAttributes(window, "[data-edge-runtime-state]", [
    "data-edge-runtime-state"
  ]);
  check(
    "materialize reload: bound edge shows an official edge state",
    edge["data-edge-runtime-state"] !== null && edge["data-edge-runtime-state"] !== undefined,
    JSON.stringify(edge)
  );
}

function seedMaterializationWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const now = Date.parse("2026-07-24T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at) VALUES ('project-materialize', 'Compasso', ?, ?, 'main', 'abc', ?, ?)"
      )
      .run(root, root, now, now);
    sqlite
      .prepare(
        "INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at) VALUES ('canvas-materialize', 'Main', '', 1, '{}', ?, ?)"
      )
      .run(now, now);
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, project_id, canvas_id, title, position, is_open, created_at, updated_at) VALUES (?, 'project-materialize', 'canvas-materialize', 'Main', 0, 1, ?, ?)"
      )
      .run(MATERIALIZE_WORKSPACE, now, now);
  } finally {
    sqlite.close();
  }
}

async function assertRunOutcome(
  scenario: ScenarioSpec,
  result: WorkflowRunSnapshot,
  resources: ScenarioResources
): Promise<void> {
  const runId = result.id;
  const planner = result.nodeRuns.find((node) => node.nodeId === "planner");
  const executor = result.nodeRuns.find((node) => node.nodeId === "executor");
  if (scenario.id === "success") {
    check("success run succeeded", result.state === "succeeded", result.state);
    check(
      "planner retried to a second attempt",
      planner?.attempt === 2,
      `attempt=${planner?.attempt}`
    );
    check(
      "official retry event recorded",
      resources.runtime.events(runId).some((event) => event.type === "node.retry_scheduled")
    );
    const plannerArtifact = resources.registry.getNodeArtifact(runId, "planner");
    check("planner published an official artifact", plannerArtifact !== null);
    const consumed = executor?.evidence.find((item) => item.id === "consumed-planner");
    check(
      "executor consumed the artifact by official hash",
      plannerArtifact !== null &&
        consumed?.metadata?.["consumedArtifactId"] === plannerArtifact.id &&
        consumed?.metadata?.["sha256"] === plannerArtifact.sha256
    );
    check(
      "executor published its own official artifact",
      resources.registry.getNodeArtifact(runId, "executor") !== null
    );
    check("final report produced", result.reportArtifact !== null);
    check(
      "success driven by structured evidence, not PTY text",
      (executor?.evidence.length ?? 0) > 0 && executor?.state === "succeeded"
    );
  } else if (scenario.id === "failure") {
    check("failure run failed officially", result.state === "failed", result.state);
    check("planner failed", planner?.state === "failed", planner?.state);
    check("dependent executor stayed blocked", executor?.state !== "succeeded", executor?.state);
    check(
      "no downstream artifact was published",
      resources.registry.getNodeArtifact(runId, "executor") === null
    );
  } else {
    check(
      "cancel run cancelled officially",
      ["cancelled", "failed"].includes(result.state),
      result.state
    );
    check(
      "dependent executor stayed blocked after cancel",
      executor?.state !== "succeeded",
      executor?.state
    );
    check(
      "no downstream artifact after cancel",
      resources.registry.getNodeArtifact(runId, "executor") === null
    );
    check(
      "no orphan sessions remain after cancel",
      resources.supervisor.listSessions().every((session) => session.state !== "running")
    );
  }
}

async function reloadPhase(window: BrowserWindow): Promise<void> {
  for (const scenario of scenarios) {
    const scenarioDirectory = join(rootDirectory, scenario.id);
    const statePath = join(scenarioDirectory, "smoke-state.json");
    if (!existsSync(statePath)) {
      check(`${scenario.id}: run state persisted for reload`, false, "missing smoke-state.json");
      continue;
    }
    const { runId } = JSON.parse(await readFile(statePath, "utf8")) as { runId: string };
    const resources = composeScenario(scenario.id);
    try {
      const rehydrated = resources.store.get(runId);
      check(`${scenario.id}: run recovered after reload`, rehydrated !== null);
      if (rehydrated === null) continue;
      const planner = rehydrated.nodeRuns.find((node) => node.nodeId === "planner");
      const executor = rehydrated.nodeRuns.find((node) => node.nodeId === "executor");
      check(`${scenario.id}: events recovered`, resources.store.listEvents(runId).length > 0);
      // A completed run must never be resurrected or re-executed on reopen.
      check(
        `${scenario.id}: terminal run not resurrected`,
        resources.store.recoverInterruptedRuns() === 0
      );
      if (scenario.id === "success") {
        check(
          "reload: attempts preserved (planner attempt=2, no new attempt)",
          planner?.attempt === 2,
          `attempt=${planner?.attempt}`
        );
        check(
          "reload: final states preserved",
          executor?.state === "succeeded" && rehydrated.state === "succeeded"
        );
        check("reload: report recovered", rehydrated.reportArtifact !== null);
        check(
          "reload: consumed artifact hash recovered",
          resources.registry.getNodeArtifact(runId, "planner") !== null
        );
        // Official IPC projection round-trip through the real preload/renderer.
        registerRunIpc(resources.runtime);
        const projected = await projectThroughIpc(window, runId);
        check(
          "reload: renderer projects the recovered run via official IPC",
          projected.snapshot?.state === "succeeded"
        );
        check(
          "reload: renderer projects the recovered report",
          projected.snapshot?.reportArtifact !== null
        );
        check(
          "reload: renderer projects the run graph nodes",
          (projected.graph?.nodes ?? []).some((node) => node.id === "planner") &&
            (projected.graph?.nodes ?? []).some((node) => node.id === "executor")
        );
        // Mount the real canvas components in the real renderer and assert the projected DOM.
        await assertRendererOverlay(window, runId);
      } else if (scenario.id === "failure") {
        check(
          "reload: failure and block persisted",
          rehydrated.state === "failed" && executor?.state !== "succeeded"
        );
        check(
          "reload: dependent gained no attempt",
          (executor?.attempt ?? 0) === 0,
          `attempt=${executor?.attempt}`
        );
      } else {
        check(
          "reload: cancellation and block persisted",
          ["cancelled", "failed"].includes(rehydrated.state) && executor?.state !== "succeeded"
        );
        check(
          "reload: dependent gained no attempt after cancel",
          (executor?.attempt ?? 0) === 0,
          `attempt=${executor?.attempt}`
        );
      }
    } finally {
      await resources.close();
    }
  }
  await reloadMaterializationScenario(window);
  await reloadClaudeAdapterScenario(window);
}

/**
 * Registers the official run show/graph/events IPC against the reopened runtime, mirroring the
 * production handlers (schema-normalized on the main side before crossing IPC). Both the projection
 * round-trip and the renderer overlay harness read only through these channels — never from SQLite
 * directly or from terminal output.
 */
function registerRunIpc(runtime: WorkflowRunRuntime): void {
  ipcMain.removeHandler(WORKFLOW_RUN_SHOW_CHANNEL);
  ipcMain.removeHandler(WORKFLOW_RUN_GRAPH_CHANNEL);
  ipcMain.removeHandler(WORKFLOW_RUN_EVENTS_CHANNEL);
  ipcMain.handle(WORKFLOW_RUN_SHOW_CHANNEL, (_event, payload: unknown) =>
    workflowRunSnapshotSchema.parse(
      runtime.show(workflowRunControlRequestSchema.parse(payload).runId)
    )
  );
  ipcMain.handle(WORKFLOW_RUN_GRAPH_CHANNEL, (_event, payload: unknown) =>
    workflowRunGraphSchema.parse(
      runtime.graph(workflowRunControlRequestSchema.parse(payload).runId)
    )
  );
  ipcMain.handle(WORKFLOW_RUN_EVENTS_CHANNEL, (_event, payload: unknown) =>
    workflowRunEventSchema
      .array()
      .parse(runtime.events(workflowRunControlRequestSchema.parse(payload).runId))
  );
}

/** Asks the real renderer (through the real preload) to project the recovered run. */
async function projectThroughIpc(
  window: BrowserWindow,
  runId: string
): Promise<{
  snapshot: WorkflowRunSnapshot | null;
  graph: { nodes: readonly { id: string }[] } | null;
}> {
  const [snapshot, graph]: unknown[] = await window.webContents.executeJavaScript(
    `Promise.all([
      window.forgedeck.workflows.show({ runId: ${JSON.stringify(runId)} }),
      window.forgedeck.workflows.graph({ runId: ${JSON.stringify(runId)} })
    ])`
  );
  return {
    snapshot: snapshot as WorkflowRunSnapshot,
    graph: graph as { nodes: readonly { id: string }[] }
  };
}

/**
 * Loads the renderer overlay harness, mounts the SAME production canvas components against the
 * official recovered run, and asserts the projected DOM in the real renderer: the bound cards expose
 * `data-runtime-state`/`data-run-attempt` from the snapshot, the bound edge exposes
 * `data-edge-runtime-state`, and selecting a card opens the inspector for the correct workflowNodeId.
 * No screenshots or visual comparison — only stable structural attributes.
 */
async function assertRendererOverlay(window: BrowserWindow, runId: string): Promise<void> {
  if (!existsSync(harnessPath)) {
    check("reload: renderer overlay harness present", false, `missing ${harnessPath}`);
    return;
  }
  await window.loadFile(harnessPath);
  await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 10000;
      while (typeof window.__mountWorkflowOverlay !== "function") {
        if (Date.now() > deadline) throw new Error("mount hook missing");
        await new Promise((r) => setTimeout(r, 25));
      }
    })()`
  );
  const counts = (await window.webContents.executeJavaScript(
    `window.__mountWorkflowOverlay(${JSON.stringify(runId)})`
  )) as { nodeCount: number; edgeCount: number };
  check(
    "reload: harness mounted the projected canvas",
    counts.nodeCount >= 2 && counts.edgeCount >= 1,
    JSON.stringify(counts)
  );

  const planner = await queryAttributes(window, '[data-workflow-node-id="planner"]', [
    "data-runtime-state",
    "data-run-attempt"
  ]);
  check(
    "reload: bound planner card shows the official runtime state",
    planner["data-runtime-state"] === "succeeded",
    planner["data-runtime-state"] ?? undefined
  );
  check(
    "reload: planner card preserves attempt 2 (no new attempt)",
    planner["data-run-attempt"] === "2",
    planner["data-run-attempt"] ?? undefined
  );

  const executor = await queryAttributes(window, '[data-workflow-node-id="executor"]', [
    "data-runtime-state"
  ]);
  check(
    "reload: bound executor card shows the official runtime state",
    executor["data-runtime-state"] === "succeeded",
    executor["data-runtime-state"] ?? undefined
  );

  const edge = await queryAttributes(window, "[data-edge-runtime-state]", [
    "data-edge-runtime-state",
    "data-edge-id"
  ]);
  check(
    "reload: bound edge shows the official edge runtime state",
    edge["data-edge-runtime-state"] === "context-consumed",
    JSON.stringify(edge)
  );

  const inspectorNodeId = (await window.webContents.executeJavaScript(
    `(async () => {
      window.__selectCard("planner");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const el = document.querySelector('[data-testid="harness-inspector"] [data-node-id]');
        if (el) return el.getAttribute("data-node-id");
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    })()`
  )) as string | null;
  check(
    "reload: selecting the card opens the inspector for the correct workflowNodeId",
    inspectorNodeId === "planner",
    String(inspectorNodeId)
  );
}

/** Polls the renderer for `selector` and returns the requested attributes (empty if it never appears). */
async function queryAttributes(
  window: BrowserWindow,
  selector: string,
  attributes: readonly string[]
): Promise<Record<string, string | null>> {
  const result = (await window.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          const out = {};
          for (const a of ${JSON.stringify(attributes)}) out[a] = el.getAttribute(a);
          return out;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    })()`
  )) as Record<string, string | null> | null;
  return result ?? {};
}

async function main(): Promise<void> {
  app.setPath("userData", join(rootDirectory, "electron-user-data"));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath
    }
  });
  const finishedLoading = new Promise<boolean>((resolvePromise) => {
    window.webContents.once("did-finish-load", () => resolvePromise(true));
    window.webContents.once("did-fail-load", () => resolvePromise(false));
  });
  await window.loadURL("data:text/html,<title>workflow-smoke</title><body>ready</body>");
  const loaded = await finishedLoading;
  const qa = new ElectronQaDriver(window);
  check(
    "main window opened and renderer finished loading",
    loaded && (await qa.waitForSelector("body"))
  );

  if (phase === "run") {
    await runPhase();
  } else if (phase === "reload") {
    await reloadPhase(window);
    // The same automatic session must come back, with no run, attempt or cycle duplicated.
    await assertAutomaticSmokeReload({
      scenarioDirectory: join(rootDirectory, AUTOMATIC_SMOKE_ID),
      check
    });
    // The neutral agent model must survive a reload with every choice intact and nothing duplicated.
    await assertMultiAgentSmokeReload({
      scenarioDirectory: join(rootDirectory, MULTI_AGENT_SMOKE_ID),
      check
    });
    // Who planned the session must come back from the same database, with nothing planned again.
    await assertOrchestratorSmokeReload({
      scenarioDirectory: join(rootDirectory, ORCHESTRATOR_SMOKE_ID),
      check
    });
  } else {
    check(`unknown phase: ${phase}`, false);
  }

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(
    `SMOKE ${phase} SUMMARY: ${checks.length - failed.length}/${checks.length} passed\n`
  );
  app.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Workflow smoke crashed: ${error instanceof Error ? error.stack : String(error)}\n`
  );
  app.exit(1);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a run condition");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    process.stderr.write(`Workflow smoke requires ${name}\n`);
    app.exit(1);
    throw new Error(`missing ${name}`);
  }
  return value;
}

function runtimePlatform(): "win32" | "darwin" | "linux" {
  if (
    process.platform === "win32" ||
    process.platform === "darwin" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  throw new Error("Unsupported smoke platform");
}

async function runAutomaticScenario(): Promise<void> {
  const scenarioDirectory = join(rootDirectory, AUTOMATIC_SMOKE_ID);
  await mkdir(scenarioDirectory, { recursive: true });
  runLocalMigrations({ filename: join(scenarioDirectory, "forgedeck.db"), migrationsFolder });
  const automaticStore = new SqliteAutomaticRunStore(join(scenarioDirectory, "forgedeck.db"));
  // The executor must be able to read automatic-mode prompts, exactly as the production composition does.
  const resources = composeClaudeScenario(AUTOMATIC_SMOKE_ID, automaticStore);
  const adapters = new AgentAdapterRegistry([
    new ClaudeCodeFixtureAdapter({
      fixtureScriptPath: claudeFixturePath,
      nodeExecutablePath,
      commandRunner: new ExecFileCommandRunner(),
      environment: process.env,
      timeoutMs: 20_000
    })
  ]);
  try {
    await runAutomaticSmokeScenario({
      scenarioDirectory,
      migrationsFolder,
      runtime: resources.runtime,
      supervisor: resources.supervisor,
      registry: resources.registry,
      adapters,
      store: automaticStore,
      check
    });
  } finally {
    automaticStore.close();
    await resources.close();
  }
}
