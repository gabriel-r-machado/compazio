import { builtInWorkflowTemplates, validateWorkflowDag } from "@forgedeck/workflow";
import type { AgentPermission, OrchestrationProposal } from "@forgedeck/schemas";

import type { AgentDirectoryEntry } from "./agent-message-store";
import type { SqliteOrchestrationProposalStore } from "./orchestration-proposal-store";
import type {
  SqliteWorkflowRunCommandStore,
  WorkflowRunCommand
} from "./workflow-run-command-store";

type ProposalStore = Pick<SqliteOrchestrationProposalStore, "get">;
type CommandStore = Pick<SqliteWorkflowRunCommandStore, "getForProposal" | "requestStart">;

export interface ProposalExecutionAgentDirectory {
  listAgents(workspaceId: string): readonly AgentDirectoryEntry[];
}

export interface ProposalExecutionPolicy {
  assertAllowed(input: {
    readonly workspaceId: string;
    readonly actorNodeId: string | null;
    readonly permission: AgentPermission;
  }): unknown;
}

/**
 * Materializes a human-approved proposal as one durable command for the existing desktop
 * dispatcher. It never starts a second scheduler and accepts no command, path or workflow JSON.
 */
export class OrchestrationProposalExecutionService {
  public constructor(
    private readonly proposals: ProposalStore,
    private readonly commands: CommandStore,
    private readonly agents: ProposalExecutionAgentDirectory,
    private readonly policy: ProposalExecutionPolicy
  ) {}

  public request(input: {
    readonly workspaceId: string;
    readonly proposalId: string;
  }): WorkflowRunCommand {
    const existing = this.commands.getForProposal(input.workspaceId, input.proposalId);
    if (existing !== null) return existing;

    const proposal = this.proposals.get(input.workspaceId, input.proposalId);
    this.assertExecutable(proposal);
    const agentNodeId = proposal.executionAgentNodeId;
    if (agentNodeId === null) throw new Error("Approved proposal requires an execution agent");
    if (!proposal.suggestedTeam.some((member) => member.nodeId === agentNodeId)) {
      throw new Error("Execution agent must be part of the suggested team");
    }
    if (!this.agents.listAgents(input.workspaceId).some((agent) => agent.nodeId === agentNodeId)) {
      throw new Error("Execution agent was not found in this workspace");
    }

    const requiredPermissions: AgentPermission[] = [
      "execute_tasks",
      ...proposal.requestedPermissions,
      ...(requiresGitWorktree(proposal.workflowTemplateId ?? "")
        ? ["manage_worktrees" as const]
        : [])
    ];
    for (const permission of unique(requiredPermissions)) {
      this.policy.assertAllowed({
        workspaceId: input.workspaceId,
        actorNodeId: agentNodeId,
        permission
      });
    }

    return this.commands.requestStart({
      templateId: proposal.workflowTemplateId ?? "",
      workspaceId: input.workspaceId,
      agentNodeId,
      task: proposal.objective,
      dryRun: false,
      requestedBy: "desktop-proposal-review",
      proposalId: proposal.id
    });
  }

  private assertExecutable(proposal: OrchestrationProposal): void {
    if (proposal.status !== "approved") throw new Error("Only approved proposals can be executed");
    if (proposal.workflowTemplateId === null || !isTrustedTemplate(proposal.workflowTemplateId)) {
      throw new Error("Approved proposal requires a trusted workflow template");
    }
    if (!proposal.gates.includes("human_approval")) {
      throw new Error("Approved proposal requires the human approval gate");
    }
    if (proposal.requestedPermissions.includes("merge_changes")) {
      throw new Error("Proposal execution cannot request merge permissions");
    }
    const template = builtInWorkflowTemplates.find(
      (item) => item.id === proposal.workflowTemplateId
    );
    if (template === undefined || !validateWorkflowDag(template).valid) {
      throw new Error("Approved proposal workflow is not a valid DAG");
    }
  }
}

function isTrustedTemplate(templateId: string): boolean {
  return builtInWorkflowTemplates.some((template) => template.id === templateId);
}

function requiresGitWorktree(templateId: string): boolean {
  return (
    builtInWorkflowTemplates
      .find((template) => template.id === templateId)
      ?.nodes.some((node) => node.isolation === "git_worktree") ?? false
  );
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}
