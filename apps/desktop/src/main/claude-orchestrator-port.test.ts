import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_MODE_DEFAULT_LIMITS,
  ORCHESTRATOR_PLAN_EXAMPLE,
  ORCHESTRATOR_PLAN_NODE_FIELDS,
  ORCHESTRATOR_PLAN_REQUIRED_NODE_FIELDS,
  ORCHESTRATOR_PLAN_REQUIRED_ROOT_FIELDS,
  ORCHESTRATOR_PLAN_ROLES,
  orchestratorPlanSchema,
  type AutomaticWorkflowRequest
} from "@forgedeck/schemas";

import {
  ClaudeOrchestratorPort,
  PlanningMutatedWorkspaceError,
  type OrchestratorAgentRunner,
  type RepositoryContext,
  type WorkspaceFingerprinter
} from "./claude-orchestrator-port";
import type { PlanningIsolation, PlanningSnapshot } from "./planning-snapshot";

const PLAN = {
  title: "Auth",
  summary: "Implement auth and verify the build.",
  nodes: [
    {
      id: "impl",
      title: "Implement",
      role: "implementer",
      adapter: "claude-code",
      prompt: "Implement Supabase auth."
    }
  ]
};

const CONTEXT: RepositoryContext = {
  summary: "A pnpm monorepo.",
  availableScripts: ["pnpm build", "pnpm test"],
  gitStatus: "clean",
  documentation: [{ path: "CLAUDE.md", content: "Read the docs first." }],
  acceptanceCriteria: ["The build passes"]
};

/** Never a real Claude: a scripted stdout, plus the prompt and cwd it received for inspection. */
class FakeRunner implements OrchestratorAgentRunner {
  public prompts: string[] = [];
  public cwds: string[] = [];
  public constructor(
    private readonly stdout: string,
    private readonly onRun?: () => void
  ) {}
  public async run(input: {
    prompt: string;
    cwd: string;
  }): Promise<{ stdout: string; exitCode: number | null }> {
    this.prompts.push(input.prompt);
    this.cwds.push(input.cwd);
    this.onRun?.();
    return { stdout: this.stdout, exitCode: 0 };
  }
}

/** Stands in for the disposable analysis copy and records how it was used. */
class FakeIsolation implements PlanningIsolation {
  public created: string[] = [];
  public disposals = 0;
  public readonly snapshotPath = "/snapshot-of-workspace";
  public constructor(private readonly onCreate?: () => void) {}
  public async create(workspaceRoot: string): Promise<PlanningSnapshot> {
    this.created.push(workspaceRoot);
    this.onCreate?.();
    return {
      path: this.snapshotPath,
      files: ["CLAUDE.md", "package.json"],
      dispose: async () => {
        this.disposals += 1;
      }
    };
  }
}

class FakeFingerprinter implements WorkspaceFingerprinter {
  public constructor(private readonly values: string[]) {}
  public async fingerprint(): Promise<string> {
    return this.values.shift() ?? "stable";
  }
}

function request(): AutomaticWorkflowRequest {
  return {
    workspaceId: "ws-1",
    objective: "Add Supabase auth",
    mode: "standard",
    limits: AUTOMATIC_MODE_DEFAULT_LIMITS.standard
  };
}

const WORKSPACE = "/workspace";

function makePort(
  runner: OrchestratorAgentRunner,
  fingerprints: string[] = ["same", "same"],
  isolation: PlanningIsolation = new FakeIsolation()
): ClaudeOrchestratorPort {
  return new ClaudeOrchestratorPort({
    runner,
    fingerprinter: new FakeFingerprinter(fingerprints),
    cwd: WORKSPACE,
    isolation,
    context: async () => CONTEXT
  });
}

describe("ClaudeOrchestratorPort", () => {
  it("returns the structured plan and states the read-only contract, budget and repository facts", async () => {
    const runner = new FakeRunner(JSON.stringify(PLAN));
    const result = await makePort(runner).analyze(request());
    expect(result).toEqual(PLAN);

    const prompt = runner.prompts[0] ?? "";
    // The read-only contract is stated to the model, not merely assumed.
    expect(prompt).toContain("Do not edit, create, move or delete any file.");
    expect(prompt).toContain("Do not commit, push, tag, merge or rebase.");
    expect(prompt).toContain("Do not install, update or remove dependencies.");
    // The product's budget is given as a fixed constraint the model cannot widen.
    expect(prompt).toContain("At most 8 nodes.");
    expect(prompt).toContain("At most 2 automatic remediation cycles");
    // The workspace facts the planner is allowed to see.
    expect(prompt).toContain("A pnpm monorepo.");
    expect(prompt).toContain("pnpm build");
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("The build passes");
  });

  it("runs the planning turn in the snapshot, never in the real workspace", async () => {
    const runner = new FakeRunner(JSON.stringify(PLAN));
    const isolation = new FakeIsolation();
    await makePort(runner, ["same", "same"], isolation).analyze(request());

    // The snapshot was built from the real workspace…
    expect(isolation.created).toEqual([WORKSPACE]);
    // …and the turn's cwd is the snapshot, so the real project is not where the agent runs.
    expect(runner.cwds).toEqual([isolation.snapshotPath]);
    expect(runner.cwds).not.toContain(WORKSPACE);
  });

  it("disposes the snapshot after a successful analysis", async () => {
    const isolation = new FakeIsolation();
    await makePort(new FakeRunner(JSON.stringify(PLAN)), ["same", "same"], isolation).analyze(
      request()
    );
    expect(isolation.disposals).toBe(1);
  });

  it("disposes the snapshot when the answer is not a JSON plan", async () => {
    const isolation = new FakeIsolation();
    await expect(
      makePort(new FakeRunner("no json here"), ["same", "same"], isolation).analyze(request())
    ).rejects.toThrow();
    // Failure never leaks a snapshot: it is removed on the way out either way.
    expect(isolation.disposals).toBe(1);
  });

  it("disposes the snapshot when the workspace was mutated anyway", async () => {
    const isolation = new FakeIsolation();
    await expect(
      makePort(new FakeRunner(JSON.stringify(PLAN)), ["before", "after"], isolation).analyze(
        request()
      )
    ).rejects.toThrow(PlanningMutatedWorkspaceError);
    expect(isolation.disposals).toBe(1);
  });

  it("disposes nothing it never created, and fails loudly when isolation is unavailable", async () => {
    const runner = new FakeRunner(JSON.stringify(PLAN));
    const failing: PlanningIsolation = {
      create: async () => {
        throw new Error("no space left for a planning snapshot");
      }
    };
    await expect(makePort(runner, ["same", "same"], failing).analyze(request())).rejects.toThrow(
      /planning snapshot/u
    );
    // Without a snapshot the turn never ran, so the real workspace was never handed to an agent.
    expect(runner.cwds).toEqual([]);
  });

  it("states the contract from the schema's own constants, not a hand-written list", async () => {
    const runner = new FakeRunner(JSON.stringify(PLAN));
    await makePort(runner).analyze(request());
    const prompt = runner.prompts[0] ?? "";

    // Every role the schema accepts is offered, and the model is told not to invent one.
    for (const role of ORCHESTRATOR_PLAN_ROLES) expect(prompt).toContain(role);
    expect(prompt).toContain("Never invent a role or an adapter");
    // Every adapter allowed in this milestone is named.
    expect(prompt).toContain("adapter MUST be exactly one of: claude-code");
    // Every required node key is demanded explicitly — these are what the real run omitted.
    for (const field of ORCHESTRATOR_PLAN_REQUIRED_NODE_FIELDS) {
      expect(prompt).toContain(`- ${field}`);
    }
    expect(ORCHESTRATOR_PLAN_REQUIRED_NODE_FIELDS).toEqual(
      expect.arrayContaining(["id", "title", "role", "adapter", "prompt"])
    );
    // Every node key is listed, so optional ones are not mistaken for forbidden.
    for (const field of ORCHESTRATOR_PLAN_NODE_FIELDS) expect(prompt).toContain(field);
    // Root keys come from the schema too.
    for (const field of ORCHESTRATOR_PLAN_REQUIRED_ROOT_FIELDS) expect(prompt).toContain(field);
  });

  it("forbids fences and surrounding prose, and states the structural rules", async () => {
    const runner = new FakeRunner(JSON.stringify(PLAN));
    await makePort(runner).analyze(request());
    const prompt = runner.prompts[0] ?? "";
    expect(prompt).toContain("EXACTLY ONE JSON object");
    expect(prompt).toContain("No markdown fence");
    expect(prompt).toContain("No text before the JSON and no text after it");
    expect(prompt).toContain("Every node id is unique");
    expect(prompt).toContain("names an existing node id");
    expect(prompt).toContain("NO cycle");
    // The silent checklist is requested, and its output is not.
    expect(prompt).toContain("Check silently before answering");
    expect(prompt).toContain("Do not report this checklist");
  });

  it("carries an example that genuinely satisfies the official schema", async () => {
    const runner = new FakeRunner(JSON.stringify(PLAN));
    await makePort(runner).analyze(request());
    const prompt = runner.prompts[0] ?? "";

    // The example is validated here, not merely asserted to exist: a broken example would teach the
    // model a shape the validator refuses.
    const revalidated = orchestratorPlanSchema.safeParse(ORCHESTRATOR_PLAN_EXAMPLE);
    expect(revalidated.success).toBe(true);
    expect(ORCHESTRATOR_PLAN_EXAMPLE.nodes.length).toBeGreaterThanOrEqual(2);
    const [first, second] = ORCHESTRATOR_PLAN_EXAMPLE.nodes;
    expect(first?.title.length).toBeGreaterThan(0);
    expect(ORCHESTRATOR_PLAN_ROLES).toContain(first?.role);
    expect(first?.adapter).toBe("claude-code");
    expect(first?.prompt.length).toBeGreaterThan(0);
    expect(first?.acceptanceCriteria.length).toBeGreaterThan(0);
    // The second node demonstrates a dependency on the first.
    expect(second?.dependsOn).toEqual([first?.id]);
    // And the whole example is what the prompt actually shows.
    expect(prompt).toContain(JSON.stringify(ORCHESTRATOR_PLAN_EXAMPLE, null, 2));
  });

  it("accepts a plan wrapped in a fenced block or prose, since only JSON counts", async () => {
    const runner = new FakeRunner(
      `Here is the plan you asked for:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`\nHope it helps!`
    );
    expect(await makePort(runner).analyze(request())).toEqual(PLAN);
  });

  it("fails when the answer carries no JSON at all (prose is never a plan)", async () => {
    const runner = new FakeRunner("I would start by refactoring the auth module.");
    await expect(makePort(runner).analyze(request())).rejects.toThrow(
      /did not return a JSON plan/u
    );
  });

  it("fails when the JSON is malformed instead of guessing at a plan", async () => {
    const runner = new FakeRunner('{ "title": "Auth", nodes: [ }');
    await expect(makePort(runner).analyze(request())).rejects.toThrow(/not valid JSON/u);
  });

  it("rejects the plan when the planning turn modified the workspace", async () => {
    // The fingerprint differs before and after: the analysis edited the project, which it may never do.
    const runner = new FakeRunner(JSON.stringify(PLAN));
    await expect(makePort(runner, ["before", "after"]).analyze(request())).rejects.toThrow(
      PlanningMutatedWorkspaceError
    );
  });

  it("asks for a remediation from the failure alone, never from raw history", async () => {
    const remediation = {
      action: "retry_node",
      targetNodeId: "impl",
      reason: "The build failed on a type error.",
      updatedPrompt: "Fix the type error."
    };
    const runner = new FakeRunner(JSON.stringify(remediation));
    const result = await makePort(runner).remediate({
      objective: "Add Supabase auth",
      targetNodeId: "impl",
      failedCriteria: ["Build passes"],
      sanitizedError: "tsc exited 2: [REDACTED]",
      allowedAreas: ["apps/web/src/auth"],
      priorAttempts: 1
    });
    expect(result).toEqual(remediation);

    const prompt = runner.prompts[0] ?? "";
    expect(prompt).toContain("impl");
    expect(prompt).toContain("Build passes");
    expect(prompt).toContain("tsc exited 2: [REDACTED]");
    expect(prompt).toContain("Attempts already made on this node: 1");
    // The remediation is bound to the failed node and forbidden from undoing verified work.
    expect(prompt).toContain("must address impl and no other node");
    expect(prompt).toContain("Never undo work that already passed verification");
  });
});

/**
 * The schema is the authority, and this milestone does not bend it. These cases pin that: the payload the
 * REAL run produced stays rejected, each individual omission stays rejected, and a complete answer passes.
 */
describe("orchestrator plan contract is not relaxed", () => {
  /** The shape Claude actually returned in the real acceptance run, reconstructed from its diagnostics. */
  const REAL_REJECTED_ANSWER = {
    title: "Add a Purpose section",
    summary: "Update NOTES.md with a Purpose section.",
    nodes: [
      { id: "edit-notes", role: "editor", dependsOn: [], operationRisk: "safe" },
      { id: "verify-notes", role: "verifier", dependsOn: ["edit-notes"], operationRisk: "safe" }
    ],
    needsHumanApproval: false
  };

  function completeNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "implement",
      title: "Implement",
      role: "implementer",
      adapter: "claude-code",
      prompt: "Do the thing completely.",
      ...overrides
    };
  }

  function planWith(node: Record<string, unknown>): Record<string, unknown> {
    return { title: "Plan", summary: "A summary.", nodes: [node] };
  }

  it("still rejects the exact payload the real planning turn produced", () => {
    const result = orchestratorPlanSchema.safeParse(REAL_REJECTED_ANSWER);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    // The same failures the safe diagnostic reported: missing node fields and roles outside the enum.
    expect(paths).toContain("nodes.0.title");
    expect(paths).toContain("nodes.0.adapter");
    expect(paths).toContain("nodes.0.prompt");
    expect(paths).toContain("nodes.0.role");
  });

  it("rejects a role outside the enum", () => {
    const result = orchestratorPlanSchema.safeParse(planWith(completeNode({ role: "editor" })));
    expect(result.success).toBe(false);
    expect(ORCHESTRATOR_PLAN_ROLES).not.toContain("editor");
  });

  it.each([["adapter"], ["title"], ["prompt"], ["id"], ["role"]])(
    "rejects a node missing %s",
    (field) => {
      // Rebuilt without the field rather than deleted, so the omission is explicit.
      const node = Object.fromEntries(
        Object.entries(completeNode()).filter(([key]) => key !== field)
      );
      const result = orchestratorPlanSchema.safeParse(planWith(node));
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        `nodes.0.${field}`
      );
    }
  );

  it("accepts a complete answer, so the contract is satisfiable as stated", () => {
    const result = orchestratorPlanSchema.safeParse(
      planWith(
        completeNode({
          dependsOn: [],
          allowedAreas: ["src"],
          expectedArtifacts: ["the module"],
          acceptanceCriteria: ["It works"],
          verificationCommands: ["pnpm test"],
          operationRisk: "safe",
          requiresHumanApproval: false
        })
      )
    );
    expect(result.success).toBe(true);
  });

  it("keeps every required field required: none gained a silent default", () => {
    // If a default were added to any of these, the empty-object probe would stop reporting it and the
    // prompt would silently stop demanding it.
    expect(ORCHESTRATOR_PLAN_REQUIRED_NODE_FIELDS).toEqual([
      "adapter",
      "id",
      "prompt",
      "role",
      "title"
    ]);
    expect(ORCHESTRATOR_PLAN_REQUIRED_ROOT_FIELDS).toEqual(["nodes", "summary", "title"]);
  });
});
