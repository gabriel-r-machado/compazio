import { useState } from "react";

import { agentAssignmentPresetSchema, toAgentAdapterId } from "@forgedeck/schemas";
import type {
  AgentAdapterId,
  AgentAssignmentPreset,
  AgentDescriptor,
  WorkflowDraft
} from "@forgedeck/schemas";

import { useI18n } from "./i18n";
import { WorkflowAgentInspector } from "./workflow-agent-inspector";

interface WorkflowApprovalPanelProps {
  readonly draft: WorkflowDraft;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onAnswerQuestion: (questionId: string, answer: string) => void;
  /** The live agent catalog. Empty simply hides the agent surface. */
  readonly agents?: readonly AgentDescriptor[];
  readonly onAssignAgent?: (nodeId: string, adapter: AgentAdapterId | null) => void;
  readonly onApplyPreset?: (preset: AgentAssignmentPreset) => void;
}

/**
 * Inline review surface for a composed workflow draft, shown on the canvas (never a separate screen).
 * It summarizes what the orchestrator proposed and lets the user answer open questions and approve.
 * Approval is the single execution gate: it records the approved revision and immediately asks the
 * official activation coordinator to materialize exactly that revision into one run.
 */
export function WorkflowApprovalPanel({
  draft,
  onApprove,
  onCancel,
  onAnswerQuestion,
  agents = [],
  onAssignAgent,
  onApplyPreset
}: WorkflowApprovalPanelProps) {
  const { t } = useI18n();
  const [customizingAgents, setCustomizingAgents] = useState(false);
  const openQuestions = draft.questions.filter((question) => question.answer === null);
  const resolvedProviders = draft.nodes
    .map((node) => node.runtimeRequirement.resolvedRuntimeId)
    .filter((runtimeId): runtimeId is string => runtimeId !== null);
  const parallelSteps = draft.nodes.filter((node) => node.execution.canRunInParallel).length;
  // After the run started the selection is read-only: a canvas edit must never reach an existing run.
  const runStarted = ["activating", "running", "completed", "failed", "cancelled"].includes(
    draft.state
  );
  // Older automatic drafts carry a resolved runtime but predate the persisted agent-assignment
  // field. Match the materializer's narrow migration rule so the review panel never flags a node
  // as unassigned when it is already executable through a known runtime adapter.
  const unassignedNodes = draft.nodes.filter((node) => resolvedAgent(node) === null);
  const canApprove = draft.state === "ready" && draft.blockers.length === 0;

  return (
    <aside className="workflow-approval-panel" aria-label={t("composer.approval.title")}>
      <header className="workflow-approval-header">
        <span className="workflow-approval-badge">{t("composer.auto")}</span>
        <h2>{draft.title.length > 0 ? draft.title : t("composer.approval.title")}</h2>
        <span className={`workflow-approval-state is-${draft.state}`}>
          {t(`composer.state.${draft.state}`)}
        </span>
      </header>

      <p className="workflow-approval-objective">{draft.objective}</p>

      <dl className="workflow-approval-summary">
        <div>
          <dt>{t("composer.approval.agents")}</dt>
          <dd>{draft.nodes.length}</dd>
        </div>
        <div>
          <dt>{t("composer.approval.parallel")}</dt>
          <dd>{parallelSteps}</dd>
        </div>
        <div>
          <dt>{t("composer.approval.profile")}</dt>
          <dd>{t(`execution.${draft.executionProfile}`)}</dd>
        </div>
        <div>
          <dt>{t("composer.approval.providers")}</dt>
          <dd>
            {resolvedProviders.length === 0
              ? t("composer.approval.noProviders")
              : Array.from(new Set(resolvedProviders)).join(", ")}
          </dd>
        </div>
        <div>
          <dt>{t("composer.approval.estimate")}</dt>
          <dd className="is-muted">{t("composer.approval.estimatePlaceholder")}</dd>
        </div>
      </dl>

      <section className="workflow-approval-roles">
        <h3>{t("composer.approval.roles")}</h3>
        <ul>
          {draft.nodes.map((node) => (
            <li key={node.id}>
              <strong>{node.title}</strong>
              <span className="workflow-approval-role">{node.role}</span>
              <span className="workflow-approval-runtime">
                {node.runtimeRequirement.resolvedRuntimeId ??
                  node.runtimeRequirement.resolutionReason ??
                  t("composer.approval.unresolved")}
              </span>
              {node.lock?.lockedByUser === true ? (
                <span className="workflow-approval-locked">{t("composer.locked")}</span>
              ) : null}
              {customizingAgents && agents.length > 0 && onAssignAgent !== undefined ? (
                <WorkflowAgentInspector
                  node={node}
                  agents={agents}
                  readOnly={runStarted}
                  onAssign={onAssignAgent}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {draft.assumptions.length > 0 ? (
        <section className="workflow-approval-assumptions">
          <h3>{t("composer.approval.assumptions")}</h3>
          <ul>
            {draft.assumptions.map((assumption) => (
              <li key={assumption.id}>{assumption.statement}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {draft.blockers.length > 0 ? (
        <section className="workflow-approval-blockers" role="alert">
          <h3>{t("composer.approval.blockers")}</h3>
          <ul>
            {draft.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {openQuestions.length > 0 ? (
        <section className="workflow-approval-questions">
          <h3>{t("composer.approval.questions")}</h3>
          {openQuestions.map((question) => (
            <InlineQuestion
              key={question.id}
              prompt={question.prompt}
              options={question.options}
              onAnswer={(answer) => onAnswerQuestion(question.id, answer)}
            />
          ))}
        </section>
      ) : null}

      {agents.length === 0 || onApplyPreset === undefined ? null : (
        <section className="workflow-approval-agents">
          <button
            type="button"
            className="workflow-approval-customize"
            aria-expanded={customizingAgents}
            onClick={() => setCustomizingAgents((current) => !current)}
          >
            {customizingAgents
              ? t("composer.approval.hideCustomization")
              : t("composer.approval.customizeAgents")}
          </button>
          {customizingAgents ? (
            <>
              <h3>{t("agents.preset")}</h3>
              <label>
                <span className="is-visually-hidden">{t("agents.preset")}</span>
                <select
                  data-testid="workflow-agent-preset"
                  value={draft.agentAssignmentPreset}
                  disabled={runStarted}
                  onChange={(changeEvent) =>
                    onApplyPreset(agentAssignmentPresetSchema.parse(changeEvent.target.value))
                  }
                >
                  {agentAssignmentPresetSchema.options.map((preset) => (
                    <option key={preset} value={preset}>
                      {t(`agents.preset.${preset}`)}
                    </option>
                  ))}
                </select>
              </label>
              {unassignedNodes.length === 0 ? null : (
                <small
                  className="workflow-approval-blockers"
                  role="alert"
                  data-testid="workflow-agent-blocking"
                >
                  {t("agents.needsSelection")}:{" "}
                  {unassignedNodes.map((node) => node.title).join(", ")}
                </small>
              )}
            </>
          ) : null}
        </section>
      )}

      <footer className="workflow-approval-actions">
        <button type="button" className="is-secondary" onClick={onCancel}>
          {t("composer.approval.cancel")}
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={!canApprove}
          title={canApprove ? undefined : t("composer.approval.approveDisabled")}
          onClick={onApprove}
        >
          {t("composer.approval.approve")}
        </button>
      </footer>
    </aside>
  );
}

function resolvedAgent(node: WorkflowDraft["nodes"][number]): AgentAdapterId | null {
  if (node.agentAssignment !== undefined) return node.agentAssignment.assignedAdapter ?? null;
  return toAgentAdapterId(node.runtimeRequirement.resolvedRuntimeId);
}

interface InlineQuestionProps {
  readonly prompt: string;
  readonly options: readonly string[];
  readonly onAnswer: (answer: string) => void;
}

function InlineQuestion({ prompt, options, onAnswer }: InlineQuestionProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  return (
    <div className="workflow-approval-question">
      <p>{prompt}</p>
      {options.length > 0 ? (
        <div className="workflow-approval-options">
          {options.map((option) => (
            <button key={option} type="button" onClick={() => onAnswer(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <form
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            if (value.trim().length > 0) onAnswer(value.trim());
          }}
        >
          <input
            type="text"
            value={value}
            placeholder={t("composer.approval.answerPlaceholder")}
            onChange={(inputEvent) => setValue(inputEvent.target.value)}
          />
          <button type="submit">{t("composer.approval.answer")}</button>
        </form>
      )}
    </div>
  );
}
