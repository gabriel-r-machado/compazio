import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import type { RuntimePlatform } from "@forgedeck/agent-sdk";
import { ExecFileCommandRunner } from "@forgedeck/agent-adapters";
import {
  SqliteArtifactRegistry,
  SqliteAutomaticRunStore,
  SqliteWorkflowActivationStore,
  SqliteWorkflowRunStore
} from "@forgedeck/local-db";
import type { ProcessSupervisor } from "@forgedeck/terminal";
import {
  AUTOMATIC_CREATE_CHANNEL,
  AUTOMATIC_ORCHESTRATORS_CHANNEL,
  AUTOMATIC_START_CHANNEL,
  automaticOrchestratorListResponseSchema,
  automaticRunSnapshotSchema,
  type AutomaticOrchestratorListResponse,
  type AutomaticRunSnapshotDto
} from "@forgedeck/schemas";

import type { AgentAdapterRegistry } from "../agent-adapter-registry";
import { AgentDescriptorRegistry } from "../agent-descriptor-registry";
import { registerAutomaticIpc } from "../automatic-ipc";
import { AutomaticModeService } from "../automatic-mode-service";
import { ClaudeOrchestratorPort } from "../claude-orchestrator-port";
import { CodexOrchestratorPort } from "../codex-orchestrator-port";
import { OpenCodeOrchestratorPort } from "../opencode-orchestrator-port";
import { DesktopWorkflowRunPort } from "../desktop-workflow-run-port";
import { createOrchestratorSelection } from "../orchestrator-selection";
import { createPlanningSnapshot } from "../planning-snapshot";
import { SupervisorPlanningRunner } from "../supervisor-planning-runner";
import type { WorkflowRunRuntime } from "../workflow-run-runtime";

/**
 * The selectable-orchestrator journey inside the real Electron main process, end to end and without a
 * single real CLI: the picker is read through the guarded IPC, OpenCode is chosen to WRITE the plan,
 * three different agents EXECUTE the nodes, one run completes, and a reload of the same database
 * shows who planned without planning again.
 *
 * Every planner and every executor here is a deterministic fixture. The renderer surface used is the
 * same `automatic` IPC production registers — the scenario never reaches the registry or the service
 * directly for the parts a renderer would ask for.
 */

export const ORCHESTRATOR_SMOKE_ID = "orchestrator" as const;
const WORKSPACE_ID = "workspace-orchestrator" as const;
const OBJECTIVE = "Deliver the vertical slice. #planner:smoke";

interface SmokeState {
  readonly automaticRunId: string;
  readonly runId: string;
  readonly planHash: string;
  readonly draftHash: string;
  readonly materializedDraftHash: string;
  readonly version: string | null;
  readonly plannedAt: string | null;
  readonly strategy: string | null;
  readonly adapters: readonly string[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly plannerCalls: number;
}

export interface OrchestratorSmokeDeps {
  readonly scenarioDirectory: string;
  readonly runtime: WorkflowRunRuntime;
  readonly adapters: AgentAdapterRegistry;
  readonly artifacts: SqliteArtifactRegistry;
  readonly supervisor: ProcessSupervisor;
  readonly platform: RuntimePlatform;
  readonly nodeExecutablePath: string;
  /** The controlled stand-in for `codex exec` in planning mode. Never the real Codex. */
  readonly codexPlannerFixturePath: string;
  /** The controlled stand-in for `opencode run` in planning mode. Never the real OpenCode. */
  readonly openCodePlannerFixturePath: string;
  readonly check: (name: string, ok: boolean, detail?: string) => void;
}

/** The session belongs to a workspace, like every other local record. */
function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const projectId = "88888888-8888-4888-8888-888888888888";
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Orchestrator smoke', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, root, root, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-orchestrator', 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, 'canvas-orchestrator', 'Principal', 0, 1, ?, ?)`
      )
      .run(WORKSPACE_ID, projectId, now, now);
  } finally {
    sqlite.close();
  }
}

/** A minimal ipcMain stand-in: the scenario invokes the very handlers production registers. */
function ipcHarness(service: AutomaticModeService): {
  readonly invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  readonly dispose: () => void;
} {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const dispose = registerAutomaticIpc(
    {
      handle: (
        channel: string,
        handler: (event: unknown, payload: unknown) => Promise<unknown>
      ) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      }
    } as unknown as Parameters<typeof registerAutomaticIpc>[0],
    service
  );
  return {
    invoke: async (channel, payload) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`No handler for ${channel}`);
      return handler({}, payload);
    },
    dispose
  };
}

export async function runOrchestratorSmokeScenario(deps: OrchestratorSmokeDeps): Promise<void> {
  const filename = join(deps.scenarioDirectory, "forgedeck.db");
  await mkdir(deps.scenarioDirectory, { recursive: true });
  seedWorkspace(filename, deps.scenarioDirectory);
  const store = new SqliteAutomaticRunStore(filename);
  const activations = new SqliteWorkflowActivationStore(filename);
  const runStore = new SqliteWorkflowRunStore(filename);

  // Counts every planning process the scenario starts, per planner. It is the proof that ONLY the
  // chosen planner ran, and later that a reload started none at all.
  let plannerCalls = 0;
  const planningRunner = new SupervisorPlanningRunner(deps.supervisor, "codex");

  const codexPlanner = new CodexOrchestratorPort({
    runner: {
      run: async (input) => {
        plannerCalls += 1;
        if (plannerCalls > 1) {
          // A second planning turn is the defect this scenario exists to catch: the session already
          // has a reviewed plan, so asking again would spend another paid turn and could execute a
          // plan nobody approved. Failing loudly here is the whole point.
          throw new Error(
            `The planner was asked to plan ${String(plannerCalls)} times; a reviewed session must plan once.`
          );
        }
        return planningRunner.run({
          ...input,
          executable: { path: deps.nodeExecutablePath, kind: "native" },
          args: [deps.codexPlannerFixturePath, ...input.args]
        });
      }
    },
    // Availability is probed the same way production probes it — `--version` on the resolved binary.
    // Node is the native binary here and the fixture script is its first controlled argument.
    commandRunner: {
      run: async (input) =>
        new ExecFileCommandRunner().run({
          ...input,
          executable: { path: deps.nodeExecutablePath, kind: "native" },
          args: [deps.codexPlannerFixturePath, ...input.args]
        })
    },
    detector: { find: async () => ({ path: deps.codexPlannerFixturePath, kind: "native" }) },
    platform: deps.platform,
    environment: process.env,
    executablePath: deps.codexPlannerFixturePath,
    fileExists: async () => true
  });

  // The planner this session chooses. Like every other one it is registered in the same registry and
  // resolved by id alone; what makes it usable here is only that a port exists for it.
  let openCodeCalls = 0;
  const openCodeRunner = new SupervisorPlanningRunner(deps.supervisor, "opencode");
  const openCodePlanner = new OpenCodeOrchestratorPort({
    runner: {
      run: async (input) => {
        openCodeCalls += 1;
        if (openCodeCalls > 1) {
          throw new Error(
            `The planner was asked to plan ${String(openCodeCalls)} times; a reviewed session must plan once.`
          );
        }
        return openCodeRunner.run({
          ...input,
          executable: { path: deps.nodeExecutablePath, kind: "native" },
          args: [deps.openCodePlannerFixturePath, ...input.args]
        });
      }
    },
    commandRunner: {
      run: async (input) =>
        new ExecFileCommandRunner().run({
          ...input,
          executable: { path: deps.nodeExecutablePath, kind: "native" },
          args: [deps.openCodePlannerFixturePath, ...input.args]
        })
    },
    detector: { find: async () => ({ path: deps.openCodePlannerFixturePath, kind: "native" }) },
    platform: deps.platform,
    environment: process.env,
    executablePath: deps.openCodePlannerFixturePath,
    fileExists: async () => true
  });

  // Claude and Codex are registered and available, and must NOT be asked to plan when OpenCode is
  // chosen. Their runners record any call, so a silent fallback would be visible instead of invisible.
  let claudeCalls = 0;
  const claudePlanner = new ClaudeOrchestratorPort({
    runner: {
      run: async () => {
        claudeCalls += 1;
        return { stdout: "{}", exitCode: 0 };
      }
    },
    fingerprinter: { fingerprint: async () => "stable" },
    cwd: deps.scenarioDirectory,
    isolation: { create: (workspaceRoot) => createPlanningSnapshot({ workspaceRoot }) },
    context: async () => ({
      summary: "",
      availableScripts: [],
      gitStatus: "",
      documentation: [],
      acceptanceCriteria: []
    }),
    availability: async () => ({ available: true, version: "claude-code-fixture 0.0.1" })
  });

  const service = new AutomaticModeService({
    store,
    orchestrator: claudePlanner,
    defaultOrchestrator: "claude-code",
    orchestrators: createOrchestratorSelection({
      ports: [claudePlanner, codexPlanner, openCodePlanner],
      isolation: { create: (workspaceRoot) => createPlanningSnapshot({ workspaceRoot }) },
      workspaceRoot: () => deps.scenarioDirectory,
      projectMetadata: () => ({ summary: "The smoke workspace." }),
      availableAgents: async () =>
        (await new AgentDescriptorRegistry(deps.adapters).refresh()).map((descriptor) => ({
          id: descriptor.id,
          displayName: descriptor.displayName,
          capabilities: [...descriptor.capabilities],
          available: descriptor.available && descriptor.hasImplementation
        }))
    }),
    createRunPort: (input) =>
      new DesktopWorkflowRunPort({
        runtime: deps.runtime,
        targets: { resolveTarget: () => ({ root: deps.scenarioDirectory }) },
        prompts: { putNodePrompt: (prompt) => store.putNodePrompt(input.automaticRunId, prompt) },
        activations,
        artifacts: deps.artifacts,
        expectsArtifact: input.expectsArtifact,
        workspaceId: input.workspaceId
      }),
    checkRunner: { run: async (command) => ({ command, exitCode: 0, ok: true, summary: "ok" }) },
    publish: () => undefined,
    sanitize: (text) => text
  });
  const ipc = ipcHarness(service);

  try {
    // 2/3/4: the picker is read through the guarded IPC, and reports each planner honestly.
    const listed = automaticOrchestratorListResponseSchema.parse(
      await ipc.invoke(AUTOMATIC_ORCHESTRATORS_CHANNEL)
    ) satisfies AutomaticOrchestratorListResponse;
    const byId = new Map(listed.orchestrators.map((entry) => [entry.id, entry]));
    deps.check(
      "orchestrator: all three agents are offered as planners",
      byId.get("claude-code")?.available === true &&
        byId.get("codex")?.available === true &&
        byId.get("opencode")?.available === true,
      JSON.stringify(listed.orchestrators.map((entry) => `${entry.id}=${String(entry.available)}`))
    );
    deps.check(
      "orchestrator: OpenCode plans but declares no remediation",
      byId.get("opencode")?.supportsPlanning === true &&
        byId.get("opencode")?.supportsRemediation === false
    );
    deps.check(
      "orchestrator: remediation capability is stated per planner, not assumed",
      byId.get("claude-code")?.supportsRemediation === true &&
        byId.get("codex")?.supportsRemediation === false
    );
    deps.check(
      "orchestrator: listing planners never started a planning turn",
      plannerCalls === 0 && claudeCalls === 0 && openCodeCalls === 0
    );

    // 5/6/7: Codex is chosen to plan, under a preset that must not change that choice.
    const created = automaticRunSnapshotSchema.parse(
      await ipc.invoke(AUTOMATIC_CREATE_CHANNEL, {
        workspaceId: WORKSPACE_ID,
        objective: OBJECTIVE,
        mode: "standard",
        orchestratorAdapter: "opencode",
        acceptanceCriteria: []
      })
    ) satisfies AutomaticRunSnapshotDto;
    deps.check(
      "orchestrator: the preset did not change the chosen planner",
      created.orchestrator?.adapter === "opencode" && created.orchestrator.strategy === "standard",
      JSON.stringify(created.orchestrator)
    );
    // 8: only the Codex planner fixture ran.
    deps.check(
      "orchestrator: only the chosen planner was asked to plan",
      openCodeCalls === 1 && plannerCalls === 0 && claudeCalls === 0,
      `opencode=${String(openCodeCalls)} codex=${String(plannerCalls)} claude=${String(claudeCalls)}`
    );
    // 9/10: a neutral three-node plan, with three different executors.
    deps.check(
      "orchestrator: the plan has three nodes assigned to three different agents",
      created.nodes.length === 3,
      created.nodes.map((node) => node.nodeId).join(",")
    );

    // 4: revising WHO EXECUTES a node is not planning. The counter must not move.
    const revised = service.updateAssignments({
      automaticRunId: created.automaticRunId,
      assignments: { tests: "codex" }
    });
    deps.check(
      "orchestrator: revising an assignment did not call the planner",
      openCodeCalls === 1 && revised.orchestrator?.planHash === created.orchestrator?.planHash,
      `calls=${String(openCodeCalls)}`
    );

    // 11/12/13: exactly one official run, executed by the executor fixtures, to completion.
    const started = automaticRunSnapshotSchema.parse(
      await ipc.invoke(AUTOMATIC_START_CHANNEL, { automaticRunId: created.automaticRunId })
    );
    deps.check("orchestrator: the session started", started.status !== "rejected", started.status);
    // 6: starting materializes the reviewed revision; it never asks the planner again.
    deps.check(
      "orchestrator: starting the session did not call the planner",
      openCodeCalls === 1 && plannerCalls === 0 && claudeCalls === 0,
      `opencode=${String(openCodeCalls)}`
    );
    await service.waitForIdle();
    const finished = service.show(created.automaticRunId);
    deps.check(
      "orchestrator: the session completed on one official run",
      finished.status === "completed" && finished.runIds.length === 1,
      `${finished.status} runs=${String(finished.runIds.length)}`
    );
    const runId = finished.currentRunId;
    if (runId === null) return;

    const definition = runStore.getWorkflow(runId);
    deps.check(
      "orchestrator: each node executes on the agent the plan assigned",
      definition?.nodes.map((node) => node.adapter).join(",") === "claude-code,opencode,codex",
      definition?.nodes.map((node) => `${node.id}=${node.adapter ?? "none"}`).join(",")
    );
    const snapshot = runStore.get(runId);
    deps.check(
      "orchestrator: every node succeeded on its first attempt",
      snapshot?.nodeRuns.every((node) => node.state === "succeeded" && node.attempt === 1) === true,
      snapshot?.nodeRuns
        .map((node) => `${node.nodeId}=${node.state}/${String(node.attempt)}`)
        .join(",")
    );
    deps.check(
      "orchestrator: no orphan session remains",
      deps.supervisor.listSessions().every((session) => session.state !== "running")
    );

    const artifacts: Record<string, string> = {};
    for (const node of definition?.nodes ?? []) {
      const artifact = deps.artifacts.getNodeArtifact(runId, node.id);
      if (artifact !== null) artifacts[node.id] = artifact.sha256;
    }
    deps.check(
      "orchestrator: every node published an official artifact",
      Object.keys(artifacts).length === 3,
      Object.keys(artifacts).join(",")
    );

    await writeFile(
      join(deps.scenarioDirectory, "orchestrator-state.json"),
      JSON.stringify({
        automaticRunId: created.automaticRunId,
        runId,
        planHash: created.orchestrator?.planHash ?? "",
        draftHash: service.show(created.automaticRunId).orchestrator?.draftHash ?? "",
        materializedDraftHash:
          service.show(created.automaticRunId).orchestrator?.materializedDraftHash ?? "",
        version: created.orchestrator?.version ?? null,
        plannedAt: created.orchestrator?.plannedAt ?? null,
        strategy: created.orchestrator?.strategy ?? null,
        adapters: definition?.nodes.map((node) => node.adapter ?? "none") ?? [],
        artifacts,
        plannerCalls: openCodeCalls
      } satisfies SmokeState),
      "utf8"
    );
  } finally {
    ipc.dispose();
    await service.close();
    activations.close();
    runStore.close();
    store.close();
  }
}

/**
 * 14–17, in a SECOND Electron process over the same database: everything about who planned is read
 * back, nothing is planned again, and nothing is duplicated.
 */
export async function assertOrchestratorSmokeReload(deps: {
  readonly scenarioDirectory: string;
  readonly check: (name: string, ok: boolean, detail?: string) => void;
}): Promise<void> {
  const statePath = join(deps.scenarioDirectory, "orchestrator-state.json");
  if (!existsSync(statePath)) {
    deps.check("orchestrator reload: state persisted", false, "missing orchestrator-state.json");
    return;
  }
  const state = JSON.parse(await readFile(statePath, "utf8")) as SmokeState;
  const filename = join(deps.scenarioDirectory, "forgedeck.db");
  const store = new SqliteAutomaticRunStore(filename);
  const runStore = new SqliteWorkflowRunStore(filename);
  const artifacts = new SqliteArtifactRegistry(
    filename,
    join(deps.scenarioDirectory, "compasso-artifacts")
  );
  try {
    const record = store.get(state.automaticRunId);
    const provenance = (record?.state as { readonly orchestrator?: Record<string, unknown> })
      ?.orchestrator;
    deps.check(
      "orchestrator reload: planner, version, time, strategy, plan hash and revision hashes came back",
      provenance?.["adapter"] === "opencode" &&
        provenance["version"] === state.version &&
        provenance["plannedAt"] === state.plannedAt &&
        provenance["strategy"] === state.strategy &&
        provenance["planHash"] === state.planHash &&
        provenance["draftHash"] === state.draftHash &&
        provenance["materializedDraftHash"] === state.materializedDraftHash,
      JSON.stringify(provenance ?? null)
    );
    deps.check(
      "orchestrator reload: the per-node assignments survived",
      runStore
        .getWorkflow(state.runId)
        ?.nodes.map((node) => node.adapter ?? "none")
        .join(",") === state.adapters.join(","),
      runStore
        .getWorkflow(state.runId)
        ?.nodes.map((node) => node.adapter ?? "none")
        .join(",")
    );
    const snapshot = runStore.get(state.runId);
    deps.check(
      "orchestrator reload: the run, its attempts and its states survived",
      snapshot?.state === "succeeded" &&
        snapshot.nodeRuns.every((node) => node.state === "succeeded" && node.attempt === 1),
      snapshot?.state
    );
    deps.check(
      "orchestrator reload: every artifact and hash survived",
      Object.entries(state.artifacts).every(
        ([nodeId, sha256]) => artifacts.getNodeArtifact(state.runId, nodeId)?.sha256 === sha256
      )
    );
    deps.check(
      "orchestrator reload: no second run, no new attempt, nothing resurrected",
      runStore.list({}).length === 1 && runStore.recoverInterruptedRuns() === 0,
      String(runStore.list({}).length)
    );
    // Nothing in THIS phase constructed a planner at all: reopening a session shows who planned, it
    // never asks anyone to plan again. The recorded count is the run phase's, carried over untouched.
    deps.check(
      "orchestrator reload: reopening planned nothing and re-executed nothing",
      state.plannerCalls === 1 &&
        record?.status === "completed" &&
        runStore.get(state.runId)?.nodeRuns.every((node) => node.attempt === 1) === true,
      `planner turns in the whole run phase: ${String(state.plannerCalls)}`
    );
  } finally {
    artifacts.close();
    runStore.close();
    store.close();
  }
}
