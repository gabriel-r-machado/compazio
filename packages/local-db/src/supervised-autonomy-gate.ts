import type {
  AutonomyGate,
  AutonomyGateDecision,
  AutonomyGateRequest
} from "@forgedeck/orchestration";
import type { AutonomyConfig } from "@forgedeck/schemas";

import type { SqliteSupervisedAutonomyStore } from "./supervised-autonomy-store";

/**
 * Binds the deterministic scheduler's AutonomyGate port to the durable supervised-autonomy store
 * for one run. It carries the workspace, the reviewed (and thus immutable for this run) autonomy
 * config, and the run id, so the scheduler only reports sanitized state numbers and can never widen
 * limits or permissions. Every assessment records an audit decision and merges the durable kill
 * switch inside the store.
 */
export class SupervisedAutonomyGate implements AutonomyGate {
  public constructor(
    private readonly store: Pick<SqliteSupervisedAutonomyStore, "assess">,
    private readonly binding: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly config: AutonomyConfig;
      readonly proposalId?: string | null;
    }
  ) {}

  public async assess(request: AutonomyGateRequest): Promise<AutonomyGateDecision> {
    const decision = this.store.assess({
      workspaceId: this.binding.workspaceId,
      runId: this.binding.runId,
      proposalId: this.binding.proposalId ?? null,
      actor: "runtime",
      action: request.action,
      config: this.binding.config,
      state: {
        nodeAttempts: request.state.nodeAttempts,
        concurrentAgents: request.state.concurrentAgents,
        spawnedAgents: request.state.spawnedAgents,
        elapsedMinutes: request.state.elapsedMinutes
      }
    });
    return { outcome: decision.outcome, rule: decision.rule };
  }
}
