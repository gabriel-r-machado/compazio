import type {
  WorkflowExecutionCheckpointReference,
  WorkflowRunExecutionContext
} from "@forgedeck/orchestration";
import type { ExecutionCheckpoint } from "@forgedeck/schemas";

/**
 * Produces the small, safe run projection of an immutable checkpoint. Full context text,
 * connected source content and artifact metadata stay in `execution_context_snapshots`.
 */
export function createWorkflowRunExecutionContext(
  checkpoint: ExecutionCheckpoint
): WorkflowRunExecutionContext {
  const context = checkpoint.snapshot.context;
  return {
    workspaceId: checkpoint.workspaceId,
    agentNodeId: checkpoint.agentNodeId,
    task: checkpoint.task,
    contractId: checkpoint.contractId,
    profileVersion: context.profile.version,
    missionVersion: context.mission?.version ?? null,
    memoryVersion: context.memory?.version ?? null,
    contractVersion: context.deliveryContract?.version ?? null,
    ...(context.contextSelection === undefined
      ? {}
      : {
          contextMode: context.contextSelection.mode,
          contextSelectionSha256: context.contextSelection.selectionSha256,
          estimatedContextTokens: context.contextSelection.metrics.estimatedTokens,
          actualContextTokens: context.contextSelection.metrics.actualTokens,
          contextCostStatus: context.contextSelection.metrics.costStatus
        }),
    functionCheckpoint: createWorkflowExecutionCheckpointReference(checkpoint),
    deliveryCheckpoint: null
  };
}

export function createWorkflowExecutionCheckpointReference(
  checkpoint: ExecutionCheckpoint
): WorkflowExecutionCheckpointReference {
  return {
    checkpointId: checkpoint.id,
    snapshotId: checkpoint.snapshot.id,
    sha256: checkpoint.snapshot.sha256,
    createdAt: checkpoint.createdAt
  };
}
