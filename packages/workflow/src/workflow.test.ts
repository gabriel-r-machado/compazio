import { describe, expect, it } from "vitest";

import { workflowSchema } from "./contracts";
import { validateWorkflowDag } from "./dag";
import { createDryRunPlan } from "./dry-run";
import { builtInWorkflowTemplates } from "./templates";

function workflow(nodes: unknown[], permissions: Record<string, boolean> = {}) {
  return workflowSchema.parse({
    schema_version: "1.0",
    id: "test-workflow",
    name: "Test workflow",
    concurrency: 2,
    permissions,
    nodes
  });
}

describe("workflow DAG validation", () => {
  it("creates deterministic order and parallel waves", () => {
    const result = validateWorkflowDag(
      workflow([
        { id: "b", type: "shell" },
        { id: "a", type: "shell" },
        { id: "c", type: "artifact", depends_on: ["a", "b"] }
      ])
    );
    expect(result.valid).toBe(true);
    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.waves).toEqual([["a", "b"], ["c"]]);
  });

  it("rejects cycles and missing dependencies", () => {
    const result = validateWorkflowDag(
      workflow([
        { id: "a", type: "shell", depends_on: ["b"] },
        { id: "b", type: "shell", depends_on: ["a"] },
        { id: "c", type: "shell", depends_on: ["missing"] }
      ])
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["cycle_detected", "missing_dependency"])
    );
  });

  it("rejects permission amplification", () => {
    const value = workflow(
      [{ id: "write", type: "agent", permissions: { workspace_write: true } }],
      { process: true }
    );
    const result = validateWorkflowDag(value, value.permissions);
    expect(result.issues[0]?.code).toBe("permission_escalation");
  });

  it("rejects unknown permission keys and shell command strings", () => {
    const result = workflowSchema.safeParse({
      schema_version: "1.0",
      id: "unsafe",
      name: "Unsafe",
      permissions: { root: true },
      nodes: [{ id: "run", type: "shell", command: "pnpm test" }]
    });
    expect(result.success).toBe(false);
  });
});

describe("workflow templates and dry-run", () => {
  it("ships valid blueprint-to-PR and bugfix templates", () => {
    expect(builtInWorkflowTemplates.map((template) => template.id)).toEqual([
      "blueprint-to-pr",
      "bugfix"
    ]);
    for (const template of builtInWorkflowTemplates) {
      expect(validateWorkflowDag(template).valid).toBe(true);
    }
  });

  it("produces a plan without executing nodes", () => {
    const template = builtInWorkflowTemplates[0];
    if (template === undefined) {
      throw new Error("Built-in workflow template is missing");
    }
    const plan = createDryRunPlan(template);
    expect(plan.valid).toBe(true);
    expect(plan.order).toContain("approve-plan");
    expect(plan.requestedPermissions).toContain("workspace_write");
  });
});
