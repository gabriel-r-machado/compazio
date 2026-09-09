import { toAgentAdapterId } from "@forgedeck/schemas";
import type { AgentAdapterId, AgentDescriptor, WorkflowNodeDraft } from "@forgedeck/schemas";

import { useI18n } from "./i18n";

/**
 * The per-node agent surface: the selector plus the full detail the card deliberately leaves out —
 * required capabilities, ordered recommendations, declared fallbacks, the reason behind the current
 * choice, the detected version and why an agent cannot be used.
 *
 * Every agent the product knows is offered, including the ones that are not installed: they are shown
 * with their reason so the user understands the option exists and why it is not selectable. An
 * unavailable agent is never presented as a working choice. Once the run has started the whole
 * surface is read-only — changing the agent of a running workflow belongs to a later milestone with
 * its own attempt and audit.
 */
export function WorkflowAgentInspector({
  node,
  agents,
  readOnly,
  onAssign
}: {
  readonly node: WorkflowNodeDraft;
  readonly agents: readonly AgentDescriptor[];
  readonly readOnly: boolean;
  readonly onAssign: (nodeId: string, adapter: AgentAdapterId | null) => void;
}) {
  const { t } = useI18n();
  const assignment = node.agentAssignment;
  // Mirrors the main process's deterministic migration: a legacy runtime id counts only when it is
  // exactly a known agent, so the inspector never shows an agent the run would refuse.
  const assigned =
    assignment === undefined
      ? toAgentAdapterId(node.runtimeRequirement.resolvedRuntimeId)
      : (assignment.assignedAdapter ?? null);
  const descriptor = agents.find((agent) => agent.id === assigned) ?? null;
  const usable = descriptor?.available === true && descriptor.hasImplementation;

  return (
    <div
      className="workflow-agent-inspector"
      data-testid="workflow-agent-inspector"
      data-node-id={node.id}
    >
      <label>
        <span>{t("agents.title")}</span>
        <select
          data-testid="workflow-agent-select"
          value={assigned ?? ""}
          disabled={readOnly}
          onChange={(changeEvent) => onAssign(node.id, toAgentAdapterId(changeEvent.target.value))}
        >
          <option value="">{t("agents.unassignedOption")}</option>
          {agents.map((agent) => (
            <option
              key={agent.id}
              value={agent.id}
              disabled={!agent.available || !agent.hasImplementation}
            >
              {agent.displayName} —{" "}
              {agent.available && agent.hasImplementation
                ? t("agents.available")
                : t("agents.unavailable")}
            </option>
          ))}
        </select>
      </label>

      {assigned === null ? (
        <small className="workflow-agent-warning" role="status">
          {t("agents.needsSelection")}
        </small>
      ) : null}
      {descriptor !== null && !usable ? (
        <small className="workflow-agent-warning" role="status" data-testid="workflow-agent-issue">
          {descriptor.unavailability?.message ?? t("agents.notImplemented")}
        </small>
      ) : null}
      {readOnly ? <small className="is-muted">{t("agents.readOnlyAfterStart")}</small> : null}

      <dl className="workflow-agent-detail">
        <div>
          <dt>{t("agents.requiredCapabilities")}</dt>
          <dd>{join(assignment?.requiredCapabilities, t("agents.none"))}</dd>
        </div>
        <div>
          <dt>{t("agents.recommended")}</dt>
          <dd data-testid="workflow-agent-recommended">
            {join(assignment?.recommendedAdapters, t("agents.none"))}
          </dd>
        </div>
        <div>
          <dt>{t("agents.fallbacks")}</dt>
          <dd>{join(assignment?.fallbackAdapters, t("agents.none"))}</dd>
        </div>
        <div>
          <dt>{t("agents.reason")}</dt>
          <dd>
            {assignment?.recommendationReason !== undefined &&
            assignment.recommendationReason.length > 0
              ? assignment.recommendationReason
              : t("agents.none")}
          </dd>
        </div>
        <div>
          <dt>{t("agents.version")}</dt>
          <dd>{descriptor?.version ?? t("agents.none")}</dd>
        </div>
      </dl>
    </div>
  );
}

function join(values: readonly string[] | undefined, empty: string): string {
  return values === undefined || values.length === 0 ? empty : values.join(", ");
}
