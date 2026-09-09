import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AutomaticRunRecord,
  SqliteAutomaticRunStore,
  SqliteWorkflowActivationStore
} from "@forgedeck/local-db";
import type { ProcessSessionSnapshot } from "@forgedeck/terminal";

import type { AgentAdapterRegistry } from "./agent-adapter-registry";
import { createAutomaticModeService } from "./automatic-mode-composition";
import type { NodeArtifactStore } from "./process-agent-node-executor";
import { createPlanningSnapshot, isInsideWorkspace } from "./planning-snapshot";
import type { WorkflowRunRuntime } from "./workflow-run-runtime";

/**
 * Proves the composition keeps the planning turn away from the real project: the launch's cwd and its
 * allowed roots are the disposable snapshot, and the real workspace appears in neither.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

/** Captures exactly what the supervisor was asked to launch. */
class CapturingSupervisor {
  public starts: {
    cwd: string;
    allowedCwdRoots: readonly string[];
    stdin: string | undefined;
  }[] = [];

  public async start(input: {
    launch: { cwd: string; initialInput?: { data: string } };
    allowedCwdRoots: readonly string[];
  }): Promise<void> {
    this.starts.push({
      cwd: input.launch.cwd,
      allowedCwdRoots: [...input.allowedCwdRoots],
      stdin: input.launch.initialInput?.data
    });
  }

  public async waitForTerminal(): Promise<ProcessSessionSnapshot> {
    return { exitCode: 0 } as unknown as ProcessSessionSnapshot;
  }

  public getBuffer(): string {
    // A plan the coordinator will accept, so the turn completes and the snapshot is disposed.
    return JSON.stringify({
      title: "Planned",
      summary: "One safe step.",
      nodes: [
        {
          id: "step",
          title: "Step",
          role: "implementer",
          adapter: "claude-code",
          prompt: "Do the thing."
        }
      ]
    });
  }

  public listSessions(): readonly unknown[] {
    return [];
  }
}

class MemoryStore {
  private record: AutomaticRunRecord | null = null;
  public create(input: {
    workspaceId: string;
    objective: string;
    mode: string;
    draftId: string;
    state: unknown;
  }): AutomaticRunRecord {
    this.record = {
      automaticRunId: "11111111-1111-4111-8111-111111111111",
      workspaceId: input.workspaceId,
      objective: input.objective,
      mode: input.mode,
      status: "planning",
      draftId: input.draftId,
      currentRunId: null,
      remediationCycle: 0,
      stopReason: null,
      result: null,
      state: input.state,
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z"
    };
    return this.record;
  }
  public save(input: { status: AutomaticRunRecord["status"]; state: unknown }): AutomaticRunRecord {
    if (this.record === null) throw new Error("no record");
    this.record = { ...this.record, status: input.status, state: input.state };
    return this.record;
  }
  public get(): AutomaticRunRecord | null {
    return this.record;
  }
  public listApprovals(): readonly unknown[] {
    return [];
  }
  public requireApproval(): unknown {
    return null;
  }
  public prompts = 0;
  public putNodePrompt(): void {
    this.prompts += 1;
  }
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forgedeck-composition-"));
  directories.push(root);
  await writeFile(join(root, "CLAUDE.md"), "# Instructions\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "p" }), "utf8");
  await writeFile(join(root, ".env"), "API_KEY=leak\n", "utf8");
  return root;
}

describe("automatic mode composition", () => {
  it("launches planning in the snapshot and never allows the real workspace", async () => {
    const root = await createWorkspace();
    const supervisor = new CapturingSupervisor();
    const store = new MemoryStore();
    let snapshotPath: string | null = null;
    let resolvedWorkspaceId: string | null = null;
    let disposals = 0;

    const service = createAutomaticModeService({
      runtime: {} as unknown as WorkflowRunRuntime,
      supervisor: supervisor as unknown as Parameters<
        typeof createAutomaticModeService
      >[0]["supervisor"],
      // The registered adapter is asked for a launch plan; a minimal pipe launch is enough here. It is
      // also asked whether the CLI is installed, because the planner picker reports availability.
      adapters: {
        detect: async () => ({
          id: "claude-code" as const,
          available: true,
          version: "claude 2.1.220",
          issue: null
        }),
        resolve: async () => ({
          executable: { path: process.execPath, kind: "native" as const },
          args: ["--version"],
          stdin: "prompt",
          transport: "pipe" as const,
          producesArtifact: false,
          artifactType: "none",
          artifactFilename: "none.json",
          mediaType: "application/json"
        })
      } as unknown as AgentAdapterRegistry,
      store: store as unknown as SqliteAutomaticRunStore,
      activations: {} as unknown as SqliteWorkflowActivationStore,
      artifacts: {} as unknown as NodeArtifactStore,
      resolveWorkspaceRoot: (workspaceId) => {
        resolvedWorkspaceId = workspaceId;
        return root;
      },
      sanitize: (text) => text,
      publish: () => undefined,
      checkRunner: { run: async (command) => ({ command, exitCode: 0, ok: true, summary: "ok" }) },
      isolation: {
        create: async (workspaceRoot) => {
          const snapshot = await createPlanningSnapshot({ workspaceRoot });
          snapshotPath = snapshot.path;
          return {
            path: snapshot.path,
            files: snapshot.files,
            dispose: async () => {
              disposals += 1;
              await snapshot.dispose();
            }
          };
        }
      }
    });

    const created = await service.create({
      workspaceId: "ws-1",
      objective: "Plan something safe",
      mode: "economic",
      acceptanceCriteria: []
    });
    expect(created.planTitle).toBe("Planned");
    expect(resolvedWorkspaceId).toBe("ws-1");

    const launch = supervisor.starts[0];
    expect(launch).toBeDefined();
    expect(snapshotPath).not.toBeNull();
    // The turn ran in the snapshot…
    expect(launch?.cwd).toBe(snapshotPath);
    // …the real workspace is not the cwd and not an allowed root…
    expect(launch?.cwd).not.toBe(root);
    expect(launch?.allowedCwdRoots).toEqual([snapshotPath]);
    expect(launch?.allowedCwdRoots).not.toContain(root);
    expect(
      (launch?.allowedCwdRoots ?? []).every((allowed) => !isInsideWorkspace(root, allowed))
    ).toBe(true);
    // …and the snapshot was removed once the turn finished.
    expect(disposals).toBe(1);
  });
});
