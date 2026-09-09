import { workflowSchema } from "./contracts";
import type { Workflow } from "./contracts";

export const blueprintToPrTemplate: Workflow = workflowSchema.parse({
  schema_version: "1.0",
  id: "blueprint-to-pr",
  name: "Blueprint to PR",
  description: "Turns an approved blueprint into an evidenced delivery report.",
  concurrency: 2,
  permissions: { process: true, workspace_write: true },
  nodes: [
    { id: "spec", type: "agent", role: "specification", permissions: { process: true } },
    { id: "approve-plan", type: "human_approval", depends_on: ["spec"] },
    {
      id: "implement",
      type: "agent",
      role: "implementation",
      depends_on: ["approve-plan"],
      isolation: "git_worktree",
      permissions: { process: true, workspace_write: true },
      retry: { max_attempts: 2, backoff_ms: 1000, retry_on: ["transient_error"] }
    },
    {
      id: "quality",
      type: "quality_gate",
      depends_on: ["implement"],
      permissions: { process: true }
    },
    { id: "report", type: "artifact", depends_on: ["quality"] }
  ]
});

export const bugfixTemplate: Workflow = workflowSchema.parse({
  schema_version: "1.0",
  id: "bugfix",
  name: "Bugfix",
  description: "Reproduce, fix, verify, and report a defect.",
  concurrency: 2,
  permissions: { process: true, workspace_write: true },
  nodes: [
    { id: "reproduce", type: "shell", permissions: { process: true } },
    {
      id: "fix",
      type: "agent",
      depends_on: ["reproduce"],
      isolation: "git_worktree",
      permissions: { process: true, workspace_write: true }
    },
    {
      id: "regression",
      type: "quality_gate",
      depends_on: ["fix"],
      permissions: { process: true },
      retry: { max_attempts: 2, backoff_ms: 500, retry_on: ["transient_error"] }
    },
    { id: "report", type: "artifact", depends_on: ["regression"] }
  ]
});

export const builtInWorkflowTemplates: readonly Workflow[] = [
  blueprintToPrTemplate,
  bugfixTemplate
];
