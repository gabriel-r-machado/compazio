import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  SqliteAutomaticRunStore,
  SqliteWorkflowActivationStore,
  SqliteWorkflowRunStore
} from "@forgedeck/local-db";
import type { ProcessSupervisor } from "@forgedeck/terminal";
import type { SqliteArtifactRegistry } from "@forgedeck/local-db";

import type { AgentAdapterRegistry } from "../agent-adapter-registry";
import { createAutomaticModeService } from "../automatic-mode-composition";
import type { WorkflowRunRuntime } from "../workflow-run-runtime";

/**
 * Automatic mode inside the real Electron smoke: objective → plan → materialize → run → verify →
 * remediate → complete, then reload and prove nothing was duplicated.
 *
 * The orchestrator is the deterministic fixture over the real pipe transport, so no real Claude is ever
 * called. The planned node fails on its first attempt for real, the remediation supplies a corrected
 * prompt, and the next run of the lineage passes. Everything else is the production composition: the same
 * runtime, scheduler, supervisor, artifact registry, activation ledger and local database.
 */

export const AUTOMATIC_SMOKE_ID = "automatic" as const;
const AUTOMATIC_WORKSPACE = "workspace-automatic" as const;
const OBJECTIVE = "Build the smoke thing. #fixture:orchestrator";

export interface AutomaticSmokeDeps {
  readonly scenarioDirectory: string;
  readonly migrationsFolder: string;
  readonly runtime: WorkflowRunRuntime;
  readonly supervisor: ProcessSupervisor;
  readonly registry: SqliteArtifactRegistry;
  readonly adapters: AgentAdapterRegistry;
  /** The same store the executor reads prompts from, so a run always finds the prompt it must deliver. */
  readonly store: SqliteAutomaticRunStore;
  readonly check: (name: string, ok: boolean, detail?: string) => void;
}

export async function runAutomaticSmokeScenario(deps: AutomaticSmokeDeps): Promise<void> {
  const filename = join(deps.scenarioDirectory, "forgedeck.db");
  await mkdir(deps.scenarioDirectory, { recursive: true });
  seedWorkspace(filename, deps.scenarioDirectory);

  const automaticStore = deps.store;
  const activations = new SqliteWorkflowActivationStore(filename);
  const service = createAutomaticModeService({
    runtime: deps.runtime,
    supervisor: deps.supervisor,
    adapters: deps.adapters,
    store: automaticStore,
    activations,
    artifacts: deps.registry,
    resolveWorkspaceRoot: () => deps.scenarioDirectory,
    sanitize: (text) => text,
    publish: () => undefined,
    // No verification command runs here: the verdict comes from the structural node result alone.
    checkRunner: { run: async (command) => ({ command, exitCode: 0, ok: true, summary: "ok" }) }
  });

  try {
    // The objective and the budget are all the user supplies; the directive routes the fixture.
    const created = await service.create({
      workspaceId: AUTOMATIC_WORKSPACE,
      objective: OBJECTIVE,
      mode: "standard",
      acceptanceCriteria: []
    });
    deps.check(
      "automatic: a structured plan was produced from the objective",
      created.planTitle !== null,
      created.issues.join("; ")
    );
    deps.check(
      "automatic: a safe plan needs no human decision",
      created.pendingApprovals.length === 0 && created.status !== "rejected",
      created.status
    );

    await service.start(created.automaticRunId);
    await service.waitForIdle();
    const finished = service.show(created.automaticRunId);
    deps.check(
      "automatic: the session completed after remediation",
      finished.status === "completed",
      `${finished.status} ${finished.stopReason ?? ""} ${finished.result ?? ""}`
    );
    // Each run of the lineage kept its own verdict: the first failed for real, the retry passed.
    deps.check(
      "automatic: the lineage shows a real failure then a real success",
      deps.runtime.show(finished.runIds[0] ?? "").state === "failed" &&
        deps.runtime.show(finished.runIds[1] ?? "").state === "succeeded",
      finished.runIds.map((runId) => deps.runtime.show(runId).state).join(" -> ")
    );
    deps.check(
      "automatic: remediation produced a second run in the lineage",
      finished.runIds.length === 2,
      finished.runIds.join(",")
    );
    deps.check(
      "automatic: at least one remediation cycle was spent",
      finished.limits.remediationCyclesUsed >= 1,
      String(finished.limits.remediationCyclesUsed)
    );

    // Prompts reached the executors with no manual copying, and each run kept the prompt it used.
    const prompts = automaticStore.listNodePrompts(created.automaticRunId);
    deps.check(
      "automatic: every run received its node prompt out of band",
      prompts.length >= 2,
      String(prompts.length)
    );
    deps.check(
      "automatic: the retry carried the corrected prompt and history kept the original",
      prompts.some((entry) => entry.prompt.includes("#fixture:fail")) &&
        prompts.some((entry) => entry.prompt.includes("#fixture:success"))
    );
    deps.check(
      "automatic: no orphan sessions remain",
      deps.supervisor.listSessions().every((session) => session.state !== "running")
    );

    await writeFile(
      join(deps.scenarioDirectory, "smoke-state.json"),
      JSON.stringify({
        automaticRunId: created.automaticRunId,
        runIds: finished.runIds,
        remediationCycle: finished.limits.remediationCyclesUsed
      }),
      "utf8"
    );
  } finally {
    await service.close();
    activations.close();
  }
}

/** Reload assertions: the same session comes back, with nothing duplicated. */
export async function assertAutomaticSmokeReload(deps: {
  readonly scenarioDirectory: string;
  readonly check: (name: string, ok: boolean, detail?: string) => void;
}): Promise<void> {
  const statePath = join(deps.scenarioDirectory, "smoke-state.json");
  if (!existsSync(statePath)) {
    deps.check("automatic: session state persisted for reload", false, "missing smoke-state.json");
    return;
  }
  const expected = JSON.parse(await readFile(statePath, "utf8")) as {
    readonly automaticRunId: string;
    readonly runIds: readonly string[];
    readonly remediationCycle: number;
  };
  const filename = join(deps.scenarioDirectory, "forgedeck.db");
  const store = new SqliteAutomaticRunStore(filename);
  const runStore = new SqliteWorkflowRunStore(filename);
  try {
    const record = store.get(expected.automaticRunId);
    deps.check("automatic: the same session was recovered after reload", record !== null);
    if (record === null) return;
    deps.check(
      "automatic: the recovered session is still complete",
      record.status === "completed",
      record.status
    );
    deps.check(
      "automatic: the remediation cycle count did not grow on reload",
      record.remediationCycle === expected.remediationCycle,
      `${record.remediationCycle} vs ${expected.remediationCycle}`
    );
    // A terminal session is never resumed, so no run, attempt or cycle can be duplicated.
    deps.check(
      "automatic: a completed session is not offered for resume",
      store.listResumable(AUTOMATIC_WORKSPACE).length === 0
    );
    deps.check(
      "automatic: the official run lineage was not duplicated",
      runStore.list().length === expected.runIds.length,
      `${runStore.list().length} vs ${expected.runIds.length}`
    );
    for (const runId of expected.runIds) {
      deps.check(`automatic: run ${runId} survived the reload`, runStore.get(runId) !== null);
    }
    const prompts = store.listNodePrompts(expected.automaticRunId);
    deps.check(
      "automatic: node prompts survived the reload unchanged",
      prompts.length >= 2 &&
        prompts.some((entry) => entry.prompt.includes("#fixture:fail")) &&
        prompts.some((entry) => entry.prompt.includes("#fixture:success"))
    );
  } finally {
    store.close();
    runStore.close();
  }
}

/** The session belongs to a workspace, like every other local record. */
function seedWorkspace(filename: string, root: string): void {
  const sqlite = new Database(filename);
  const projectId = "66666666-6666-4666-8666-666666666666";
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  try {
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, name, root_path, canonical_root_path, default_branch, head_commit, created_at, updated_at)
         VALUES (?, 'Automatic smoke', ?, ?, 'main', 'abc123', ?, ?)`
      )
      .run(projectId, root, root, now, now);
    sqlite
      .prepare(
        `INSERT INTO canvases (id, title, mission, revision, viewport_json, created_at, updated_at)
         VALUES ('canvas-automatic', 'Principal', '', 1, '{"x":0,"y":0,"zoom":1}', ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO workspaces
           (id, project_id, canvas_id, title, position, is_open, created_at, updated_at)
         VALUES (?, ?, 'canvas-automatic', 'Principal', 0, 1, ?, ?)`
      )
      .run(AUTOMATIC_WORKSPACE, projectId, now, now);
  } finally {
    sqlite.close();
  }
}
