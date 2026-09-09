import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  SqliteArtifactRegistry,
  SqliteWorkflowDraftStore,
  SqliteWorkflowRunStore
} from "@forgedeck/local-db";
import type { ProcessSupervisor } from "@forgedeck/terminal";
import { applyDraftCommand, suggestAgentAssignments } from "@forgedeck/orchestration";
import type { AgentAssignmentCatalog } from "@forgedeck/orchestration";
import { workflowDraftSchema } from "@forgedeck/schemas";
import type { AgentDescriptor, WorkflowDraft } from "@forgedeck/schemas";

import type { AgentAdapterRegistry } from "../agent-adapter-registry";
import { AgentDescriptorRegistry } from "../agent-descriptor-registry";
import type { ActivationCoordinator } from "../activation-coordinator";
import type { WorkflowRunRuntime } from "../workflow-run-runtime";

/**
 * The neutral agent model inside the real Electron smoke: the three agents Compazio knows are
 * catalogued, only the installed one is runnable, the user's per-node choice is what materializes into
 * the executable definition, and a reload brings every choice back without duplicating anything.
 *
 * No real CLI is ever called: the only executable adapter registered is the deterministic Claude
 * fixture, and Codex and OpenCode are exercised precisely as what they are in this milestone —
 * known agents with no implementation.
 */

export const MULTI_AGENT_SMOKE_ID = "multi-agent" as const;
const MULTI_AGENT_WORKSPACE = "workspace-multi-agent" as const;
const DRAFT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as const;

export interface MultiAgentSmokeDeps {
  readonly scenarioDirectory: string;
  readonly runtime: WorkflowRunRuntime;
  readonly adapters: AgentAdapterRegistry;
  /** The official artifact surface; the scenario reads published artifacts and hashes from it. */
  readonly artifacts: SqliteArtifactRegistry;
  readonly supervisor: ProcessSupervisor;
  /** Builds the coordinator over the live runtime, with the agent catalog supplied by this scenario. */
  readonly composeCoordinator: (
    agents: () => Promise<AgentAssignmentCatalog>
  ) => ActivationCoordinator;
  readonly check: (name: string, ok: boolean, detail?: string) => void;
}

function multiAgentDraft(): WorkflowDraft {
  return workflowDraftSchema.parse({
    id: DRAFT_ID,
    version: 1,
    workspaceId: MULTI_AGENT_WORKSPACE,
    sourceTerminalId: "terminal-1",
    creationMode: "automatic",
    executionProfile: "balanced",
    title: "Neutral agent workflow",
    objective: "Build the neutral agent slice",
    // The plan recommends agents; it never assigns one, and it is not bound to any single vendor.
    orchestratorAdapter: "claude-code",
    state: "ready",
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    nodes: [
      {
        id: "planner",
        title: "Plan #fixture:success",
        role: "planner",
        agentAssignment: {
          requiredCapabilities: ["planning"],
          recommendedAdapters: ["claude-code", "codex"]
        }
      },
      {
        id: "implementer",
        // The OpenCode fixture verifies it can read the upstream artifact at the path given in the
        // prompt AND that the bytes hash to the value Compazio recorded.
        title: "Build #fixture:consume",
        role: "implementer",
        agentAssignment: {
          requiredCapabilities: ["backend"],
          recommendedAdapters: ["opencode", "codex"]
        }
      },
      {
        id: "reviewer",
        // Codex then verifies OpenCode's own artifact, so the chain crosses three different agents.
        title: "Review #fixture:consume",
        role: "reviewer",
        agentAssignment: {
          requiredCapabilities: ["review"],
          recommendedAdapters: ["codex"]
        }
      }
    ],
    edges: [
      {
        id: "planner__implementer",
        sourceNodeId: "planner",
        targetNodeId: "implementer",
        type: "dependency"
      },
      {
        id: "implementer__reviewer",
        sourceNodeId: "implementer",
        targetNodeId: "reviewer",
        type: "dependency"
      }
    ]
  });
}

const reducerContext = {
  now: "2026-07-25T12:00:00.000Z",
  newId: () => DRAFT_ID,
  capabilities: [],
  identity: {
    workspaceId: MULTI_AGENT_WORKSPACE,
    sourceTerminalId: "terminal-1",
    creationMode: "automatic" as const,
    executionProfile: "balanced" as const,
    draftId: DRAFT_ID
  }
};

export async function runMultiAgentSmokeScenario(deps: MultiAgentSmokeDeps): Promise<void> {
  const filename = join(deps.scenarioDirectory, "forgedeck.db");
  await mkdir(deps.scenarioDirectory, { recursive: true });
  seedWorkspace(filename, deps.scenarioDirectory);

  const descriptors = new AgentDescriptorRegistry(deps.adapters);
  const catalog: AgentDescriptor[] = [...(await descriptors.refresh())];
  deps.check(
    "multi-agent: all three agents are catalogued",
    catalog.map((agent) => agent.id).join(",") === "claude-code,codex,opencode",
    catalog.map((agent) => agent.id).join(",")
  );
  deps.check(
    "multi-agent: the installed agent is available and executable",
    catalog[0]?.available === true && catalog[0].hasImplementation,
    JSON.stringify(catalog[0]?.unavailability)
  );
  const codex = catalog.find((agent) => agent.id === "codex");
  deps.check(
    "multi-agent: Codex is available and executable",
    codex?.available === true && codex.hasImplementation && codex.supportsExecution,
    JSON.stringify(codex?.unavailability)
  );
  deps.check(
    "multi-agent: Codex cannot plan yet, and that is stated honestly",
    codex?.supportsPlanning === false && codex.supportsInteractive === false
  );
  const openCode = catalog.find((agent) => agent.id === "opencode");
  deps.check(
    "multi-agent: OpenCode is available and executable",
    openCode?.available === true && openCode.hasImplementation && openCode.supportsExecution,
    JSON.stringify(openCode?.unavailability)
  );
  deps.check(
    "multi-agent: all three agents are runnable, and none claims planning it cannot do",
    catalog.every((agent) => agent.available && agent.hasImplementation) &&
      codex?.supportsPlanning === false &&
      openCode?.supportsPlanning === false,
    catalog.map((agent) => `${agent.id}=${agent.supportsPlanning}`).join(",")
  );
  deps.check(
    "multi-agent: no credential material is exposed by the catalog",
    !/token|secret|cookie|password|api[_-]?key/i.test(JSON.stringify(catalog)) &&
      catalog.every((agent) => agent.authenticated === null)
  );

  const store = new SqliteWorkflowDraftStore(filename);
  try {
    const draft = multiAgentDraft();
    // A preset may only ever choose among agents that are genuinely usable.
    const suggested = suggestAgentAssignments({
      nodes: draft.nodes,
      preset: "automatic",
      catalog: { descriptors: catalog }
    });
    const byNode = new Map(suggested.map((entry) => [entry.nodeId, entry.assignedAdapter]));
    deps.check(
      "multi-agent: the preset assigned every node to an available agent",
      suggested.every((entry) => entry.assignedAdapter !== null),
      suggested.map((entry) => `${entry.nodeId}=${entry.assignedAdapter}`).join(",")
    );
    deps.check(
      "multi-agent: the preset honours each node's recommendation order",
      byNode.get("planner") === "claude-code" &&
        byNode.get("implementer") === "opencode" &&
        byNode.get("reviewer") === "codex",
      [byNode.get("planner"), byNode.get("implementer"), byNode.get("reviewer")].join(" / ")
    );

    const assigned = applyDraftCommand(
      draft,
      {
        kind: "assign_agents",
        preset: "automatic",
        assignments: suggested.map((entry) => ({
          nodeId: entry.nodeId,
          assignedAdapter: entry.assignedAdapter,
          reason: entry.reason
        }))
      },
      reducerContext
    );
    if (assigned.draft === null) {
      deps.check("multi-agent: agents were assigned", false, assigned.message);
      return;
    }
    const persisted = store.persist(assigned.draft, [...assigned.events]);
    deps.check(
      "multi-agent: the choice is recorded on the draft's own audit log",
      store.listEvents(DRAFT_ID).some((entry) => entry.type === "workflow.node.adapter_assigned")
    );

    // Approval materializes ONE official run whose nodes execute on the chosen agent.
    const coordinator = deps.composeCoordinator(async () => ({ descriptors: catalog }));
    const approved = workflowDraftSchema.parse({ ...persisted.draft, state: "approved" });
    const activation = await coordinator.materialize(approved);
    deps.check(
      "multi-agent: approval created exactly one official run",
      activation.status === "started" && activation.runId !== null,
      JSON.stringify(activation.issues)
    );
    const runId = activation.runId;
    if (runId === null) return;

    const definition = deps.runtime.definition(runId);
    deps.check(
      "multi-agent: three different agents run inside one official definition",
      definition.nodes.find((node) => node.id === "planner")?.adapter === "claude-code" &&
        definition.nodes.find((node) => node.id === "implementer")?.adapter === "opencode" &&
        definition.nodes.find((node) => node.id === "reviewer")?.adapter === "codex",
      definition.nodes.map((node) => `${node.id}=${node.adapter ?? "none"}`).join(",")
    );

    await waitFor(() =>
      ["succeeded", "failed", "cancelled", "interrupted"].includes(deps.runtime.show(runId).state)
    );
    const done = deps.runtime.show(runId);
    deps.check(
      "multi-agent: the mixed-agent run succeeded",
      done.state === "succeeded",
      done.state
    );
    const plannerArtifact = deps.artifacts.getNodeArtifact(runId, "planner");
    const openCodeArtifact = deps.artifacts.getNodeArtifact(runId, "implementer");
    const codexArtifact = deps.artifacts.getNodeArtifact(runId, "reviewer");
    deps.check("multi-agent: Claude published its official artifact", plannerArtifact !== null);
    deps.check(
      "multi-agent: OpenCode published its own official artifact",
      openCodeArtifact !== null
    );
    deps.check("multi-agent: Codex published its own official artifact", codexArtifact !== null);
    const implementer = done.nodeRuns.find((node) => node.nodeId === "implementer");
    const consumedByOpenCode = implementer?.evidence.find((item) => item.id === "consumed-planner");
    deps.check(
      "multi-agent: OpenCode consumed Claude's artifact by its official hash",
      plannerArtifact !== null &&
        consumedByOpenCode?.metadata?.["sha256"] === plannerArtifact.sha256,
      JSON.stringify(consumedByOpenCode?.metadata ?? null)
    );
    const reviewer = done.nodeRuns.find((node) => node.nodeId === "reviewer");
    const consumedByCodex = reviewer?.evidence.find((item) => item.id === "consumed-implementer");
    deps.check(
      "multi-agent: Codex consumed OpenCode's artifact by its official hash",
      openCodeArtifact !== null &&
        consumedByCodex?.metadata?.["sha256"] === openCodeArtifact.sha256,
      JSON.stringify(consumedByCodex?.metadata ?? null)
    );
    deps.check(
      "multi-agent: no orphan sessions remain after the mixed run",
      deps.supervisor.listSessions().every((session) => session.state !== "running")
    );

    await writeFile(
      join(deps.scenarioDirectory, "smoke-state.json"),
      JSON.stringify({
        runId,
        draftId: DRAFT_ID,
        plannerSha256: plannerArtifact?.sha256 ?? null,
        openCodeSha256: openCodeArtifact?.sha256 ?? null,
        codexSha256: codexArtifact?.sha256 ?? null
      }),
      "utf8"
    );
  } finally {
    store.close();
  }
}

/** A node with no agent must block the run before anything is created. */
export async function assertMultiAgentBlocksUnassigned(deps: {
  readonly composeCoordinator: (
    agents: () => Promise<AgentAssignmentCatalog>
  ) => ActivationCoordinator;
  readonly catalog: readonly AgentDescriptor[];
  readonly runtime: WorkflowRunRuntime;
  readonly check: (name: string, ok: boolean, detail?: string) => void;
}): Promise<void> {
  const before = deps.runtime.list().length;
  const unassigned = workflowDraftSchema.parse({
    ...multiAgentDraft(),
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    state: "approved"
  });
  const coordinator = deps.composeCoordinator(async () => ({ descriptors: [...deps.catalog] }));
  const activation = await coordinator.materialize(unassigned);
  deps.check(
    "multi-agent: a node with no agent blocks the run",
    activation.status === "invalid" && activation.runId === null,
    activation.status
  );
  deps.check(
    "multi-agent: the block names the nodes that need attention",
    activation.issues.length === 3 &&
      activation.issues.every(
        (issue) => issue.code === "missing_agent_assignment" && issue.nodeId !== null
      ),
    JSON.stringify(activation.issues)
  );
  deps.check(
    "multi-agent: no partial run was created",
    deps.runtime.list().length === before,
    String(deps.runtime.list().length)
  );
}

/** Reload assertions: the choices come back, and nothing is duplicated or re-executed. */
export async function assertMultiAgentSmokeReload(deps: {
  readonly scenarioDirectory: string;
  readonly check: (name: string, ok: boolean, detail?: string) => void;
}): Promise<void> {
  const statePath = join(deps.scenarioDirectory, "smoke-state.json");
  if (!existsSync(statePath)) {
    deps.check("multi-agent reload: state persisted", false, "missing smoke-state.json");
    return;
  }
  const { runId, draftId, plannerSha256, openCodeSha256, codexSha256 } = JSON.parse(
    await readFile(statePath, "utf8")
  ) as {
    readonly runId: string;
    readonly draftId: string;
    readonly plannerSha256: string | null;
    readonly openCodeSha256: string | null;
    readonly codexSha256: string | null;
  };
  const filename = join(deps.scenarioDirectory, "forgedeck.db");
  const drafts = new SqliteWorkflowDraftStore(filename);
  const runs = new SqliteWorkflowRunStore(filename);
  const artifacts = new SqliteArtifactRegistry(
    filename,
    join(deps.scenarioDirectory, "compasso-artifacts")
  );
  try {
    const draft = drafts.getById(draftId);
    deps.check("multi-agent reload: the draft came back", draft !== null);
    deps.check(
      "multi-agent reload: every agent choice was preserved across all three agents",
      draft?.nodes.find((node) => node.id === "planner")?.agentAssignment?.assignedAdapter ===
        "claude-code" &&
        draft?.nodes.find((node) => node.id === "implementer")?.agentAssignment?.assignedAdapter ===
          "opencode" &&
        draft?.nodes.find((node) => node.id === "reviewer")?.agentAssignment?.assignedAdapter ===
          "codex",
      draft?.nodes.map((node) => node.agentAssignment?.assignedAdapter ?? "none").join(",")
    );
    deps.check(
      "multi-agent reload: the definition still names all three agents",
      runs
        .getWorkflow(runId)
        ?.nodes.map((node) => node.adapter)
        .join(",") === "claude-code,opencode,codex"
    );
    deps.check(
      "multi-agent reload: the preset and the orchestrator were preserved",
      draft?.agentAssignmentPreset === "automatic" && draft.orchestratorAdapter === "claude-code",
      `${draft?.agentAssignmentPreset} / ${draft?.orchestratorAdapter}`
    );
    deps.check(
      "multi-agent reload: the recommendation of an unavailable agent survived unchanged",
      draft?.nodes
        .find((node) => node.id === "implementer")
        ?.agentAssignment?.recommendedAdapters.join(",") === "opencode,codex"
    );
    deps.check(
      "multi-agent reload: every artifact and hash was preserved",
      artifacts.getNodeArtifact(runId, "planner")?.sha256 === plannerSha256 &&
        artifacts.getNodeArtifact(runId, "implementer")?.sha256 === openCodeSha256 &&
        artifacts.getNodeArtifact(runId, "reviewer")?.sha256 === codexSha256 &&
        plannerSha256 !== null &&
        openCodeSha256 !== null &&
        codexSha256 !== null
    );

    const run = runs.get(runId);
    deps.check("multi-agent reload: the run recovered", run?.state === "succeeded", run?.state);
    deps.check(
      "multi-agent reload: no second run and no new attempt",
      runs.list({}).length === 1 && run?.nodeRuns.every((node) => node.attempt === 1) === true
    );
    deps.check(
      "multi-agent reload: the terminal run was not resurrected",
      runs.recoverInterruptedRuns() === 0
    );
  } finally {
    artifacts.close();
    drafts.close();
    runs.close();
  }
}

function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const projectId = "77777777-7777-4777-8777-777777777777";
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Multi agent smoke', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, root, root, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-multi-agent', 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, 'canvas-multi-agent', 'Principal', 0, 1, ?, ?)`
      )
      .run(MULTI_AGENT_WORKSPACE, projectId, now, now);
  } finally {
    sqlite.close();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a run condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
