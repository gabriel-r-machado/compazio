import { useI18n } from "./i18n";
import type { ProjectedCanvasNode } from "./workflow-run-projection";

/**
 * Full per-node official detail: blocking dependencies, attempts, produced/consumed artifacts and
 * their hashes, plus the failure reason. It is a pure projection of one {@link ProjectedCanvasNode},
 * shared by the Runs monitoring panel and the canvas selection so both surfaces show the same
 * evidence for the same node — never a second, divergent inspector.
 */
export function WorkflowNodeInspector({ node }: { readonly node: ProjectedCanvasNode }) {
  const { t } = useI18n();
  return (
    <details
      className="workflow-node-inspector"
      data-testid="workflow-run-node-inspector"
      data-node-id={node.nodeId}
    >
      <summary>{t("workflowRuns.nodeInspector")}</summary>
      <small data-testid="workflow-run-node-attempt">
        {t("workflowRuns.attempt", { attempt: node.attempt })}
      </small>
      {node.shortError === null ? null : (
        <small className="workflow-node-error" role="status">
          {t("workflowRuns.failure", { reason: node.shortError })}
        </small>
      )}
      <small>
        {t("workflowRuns.blockedBy", {
          nodes:
            node.blockingDependencies.length === 0
              ? t("workflowRuns.none")
              : node.blockingDependencies.join(", ")
        })}
      </small>
      <small data-testid="workflow-run-node-produced">
        {t("workflowRuns.producedArtifacts")}:{" "}
        {node.producedArtifacts.length === 0
          ? t("workflowRuns.none")
          : node.producedArtifacts.map((artifact) => artifact.artifactId).join(", ")}
      </small>
      <small data-testid="workflow-run-node-consumed">
        {t("workflowRuns.consumedArtifacts")}:{" "}
        {node.consumedArtifacts.length === 0
          ? t("workflowRuns.none")
          : node.consumedArtifacts
              .map((artifact) => `${artifact.artifactId} (${shortHash(artifact.sha256)})`)
              .join(", ")}
      </small>
    </details>
  );
}

function shortHash(sha256: string | null): string {
  return sha256 === null ? "—" : sha256.slice(0, 12);
}
