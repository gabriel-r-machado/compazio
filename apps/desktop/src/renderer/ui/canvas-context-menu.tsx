import { useEffect, useRef, useState } from "react";

import { ORCHESTRATOR_TEAM_PERMISSIONS, grantsTeamOrchestration } from "@forgedeck/schemas";
import type {
  CanvasAgentRole,
  CanvasHandoff,
  EdgeContract,
  HandoffDraftContent
} from "@forgedeck/schemas";

import { useI18n } from "./i18n";

export interface CanvasMenuAction {
  readonly id: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

interface CanvasContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly actions: readonly CanvasMenuAction[];
  readonly onAction: (id: string) => void;
  readonly onClose: () => void;
}

export function CanvasContextMenu({
  x,
  y,
  label,
  actions,
  onAction,
  onClose
}: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const estimatedHeight = actions.length * 34 + 12;

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as globalThis.Node) !== true) {
        onClose();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <div
      aria-label={label}
      className="canvas-context-menu"
      data-testid="canvas-context-menu"
      ref={menuRef}
      role="menu"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 224)),
        top: Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 8))
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
        ];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : event.key === "ArrowDown"
                ? (current + 1) % buttons.length
                : event.key === "ArrowUp"
                  ? (current - 1 + buttons.length) % buttons.length
                  : null;
        if (nextIndex !== null) {
          event.preventDefault();
          buttons[nextIndex]?.focus();
        }
      }}
    >
      {actions.map((action) => (
        <button
          className={action.danger === true ? "is-danger" : undefined}
          disabled={action.disabled}
          key={action.id}
          aria-label={action.label}
          role="menuitem"
          type="button"
          onClick={() => onAction(action.id)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

interface CanvasEditDialogProps {
  readonly title: string;
  readonly label: string;
  readonly initialValue: string;
  readonly saveLabel: string;
  readonly cancelLabel: string;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly onSave: (value: string) => void;
  readonly onClose: () => void;
}

export function CanvasEditDialog({
  title,
  label,
  initialValue,
  saveLabel,
  cancelLabel,
  multiline = false,
  maxLength = 160,
  onSave,
  onClose
}: CanvasEditDialogProps) {
  return (
    <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        aria-label={title}
        aria-modal="true"
        className="canvas-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = String(data.get("value") ?? "").trim();
          if (value.length > 0) onSave(value.slice(0, maxLength));
        }}
      >
        <h2>{title}</h2>
        <label>
          <span>{label}</span>
          {multiline ? (
            <textarea
              autoFocus
              defaultValue={initialValue}
              maxLength={maxLength}
              name="value"
              required
              rows={12}
            />
          ) : (
            <input
              autoFocus
              defaultValue={initialValue}
              maxLength={maxLength}
              name="value"
              required
            />
          )}
        </label>
        <div className="canvas-dialog-actions">
          <button type="button" onClick={onClose}>
            {cancelLabel}
          </button>
          <button className="primary-button" type="submit">
            {saveLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

interface CanvasRoleDialogProps {
  readonly nodeTitle: string;
  readonly initialRole: CanvasAgentRole | undefined;
  readonly initialPermissions: readonly string[];
  readonly onSave: (role: CanvasAgentRole, permissions: readonly string[]) => void;
  readonly onClose: () => void;
}

export function CanvasRoleDialog({
  nodeTitle,
  initialRole,
  initialPermissions,
  onSave,
  onClose
}: CanvasRoleDialogProps) {
  const { t } = useI18n();
  const rolePresets: Readonly<Record<string, CanvasAgentRole>> = {
    planner: {
      name: t("role.planner"),
      responsibilities: t("role.plannerResponsibilities"),
      constraints: t("role.plannerConstraints"),
      expectedDeliverable: t("role.plannerDeliverable"),
      completionCriteria: t("role.plannerDone")
    },
    implementer: {
      name: t("role.implementer"),
      responsibilities: t("role.implementerResponsibilities"),
      constraints: t("role.implementerConstraints"),
      expectedDeliverable: t("role.implementerDeliverable"),
      completionCriteria: t("role.implementerDone")
    },
    reviewer: {
      name: t("role.reviewer"),
      responsibilities: t("role.reviewerResponsibilities"),
      constraints: t("role.reviewerConstraints"),
      expectedDeliverable: t("role.reviewerDeliverable"),
      completionCriteria: t("role.reviewerDone")
    },
    tester: {
      name: t("role.tester"),
      responsibilities: t("role.testerResponsibilities"),
      constraints: t("role.testerConstraints"),
      expectedDeliverable: t("role.testerDeliverable"),
      completionCriteria: t("role.testerDone")
    }
  };
  const [role, setRole] = useState<CanvasAgentRole>(
    initialRole ?? {
      name: nodeTitle,
      responsibilities: "",
      constraints: "",
      expectedDeliverable: "",
      completionCriteria: ""
    }
  );
  const [orchestrator, setOrchestrator] = useState(grantsTeamOrchestration(initialPermissions));

  return (
    <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        aria-label={t("role.dialogTitle")}
        aria-modal="true"
        className="canvas-dialog canvas-role-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSave(role, orchestrator ? ORCHESTRATOR_TEAM_PERMISSIONS : []);
        }}
      >
        <h2>{t("role.dialogTitle")}</h2>
        <div className="role-presets" role="group" aria-label={t("role.preset")}>
          {(["planner", "implementer", "reviewer", "tester"] as const).map((presetId) => {
            const preset = rolePresets[presetId];
            if (preset === undefined) return null;
            return (
              <button
                aria-pressed={role.name === preset.name}
                className={role.name === preset.name ? "is-active" : undefined}
                key={presetId}
                type="button"
                onClick={() => setRole(preset)}
              >
                {preset.name}
              </button>
            );
          })}
        </div>
        <RoleField
          label={t("role.name")}
          maxLength={80}
          value={role.name}
          onChange={(name) => setRole((current) => ({ ...current, name }))}
        />
        <label className="role-orchestrator">
          <input
            checked={orchestrator}
            data-testid="role-orchestrator"
            type="checkbox"
            onChange={(event) => setOrchestrator(event.target.checked)}
          />
          <span>
            <strong>{t("role.orchestrator")}</strong>
            <small>{t("role.orchestratorHint")}</small>
          </span>
        </label>
        <RoleField
          hint={t("role.instructionsHint")}
          label={t("role.instructions")}
          maxLength={4_000}
          multiline
          value={role.responsibilities}
          onChange={(responsibilities) => setRole((current) => ({ ...current, responsibilities }))}
        />
        {/*
          Constraints, deliverable and completion criteria stay in the document — handoff-service,
          terminal-context-staging and workflow-team-reconciler all read them. They are collapsed
          because a role template already fills them, so the first screen asks for two things instead
          of five. Progressive disclosure, not amputation.
        */}
        <details className="role-advanced">
          <summary>{t("role.advanced")}</summary>
          <small>{t("role.advancedHint")}</small>
          <RoleField
            label={t("role.constraints")}
            maxLength={2_000}
            multiline
            value={role.constraints}
            onChange={(constraints) => setRole((current) => ({ ...current, constraints }))}
          />
          <RoleField
            label={t("role.deliverable")}
            maxLength={2_000}
            multiline
            value={role.expectedDeliverable}
            onChange={(expectedDeliverable) =>
              setRole((current) => ({ ...current, expectedDeliverable }))
            }
          />
          <RoleField
            label={t("role.doneWhen")}
            maxLength={2_000}
            multiline
            value={role.completionCriteria}
            onChange={(completionCriteria) =>
              setRole((current) => ({ ...current, completionCriteria }))
            }
          />
        </details>
        <DialogActions onClose={onClose} />
      </form>
    </div>
  );
}

interface CanvasEdgeContractDialogProps {
  readonly initialContract: EdgeContract;
  readonly onSave: (contract: EdgeContract) => void;
  readonly onClose: () => void;
}

export function CanvasEdgeContractDialog({
  initialContract,
  onSave,
  onClose
}: CanvasEdgeContractDialogProps) {
  const { t } = useI18n();
  const [contract, setContract] = useState<EdgeContract>({
    ...initialContract,
    handoffMode: "manual"
  });
  return (
    <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        aria-label={t("edge.dialogTitle")}
        aria-modal="true"
        className="canvas-dialog canvas-role-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSave(contract);
        }}
      >
        <h2>{t("edge.dialogTitle")}</h2>
        <RoleField
          label={t("edge.label")}
          maxLength={160}
          value={contract.label}
          onChange={(label) => setContract((current) => ({ ...current, label }))}
        />
        <RoleField
          label={t("edge.sourceDeliverable")}
          maxLength={4_000}
          multiline
          value={contract.sourceDeliverable ?? ""}
          onChange={(sourceDeliverable) =>
            setContract((current) => ({ ...current, sourceDeliverable }))
          }
        />
        <RoleField
          label={t("edge.targetInstruction")}
          maxLength={4_000}
          multiline
          value={contract.targetInstruction ?? ""}
          onChange={(targetInstruction) =>
            setContract((current) => ({ ...current, targetInstruction }))
          }
        />
        <p className="dialog-help">{t("edge.manualHelp")}</p>
        <DialogActions onClose={onClose} />
      </form>
    </div>
  );
}

interface CanvasHandoffDialogProps {
  readonly handoff: CanvasHandoff;
  readonly rawOutput: string;
  readonly destinationOutput?: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSave: (content: HandoffDraftContent) => void;
  readonly onSend: (content: HandoffDraftContent) => void;
  readonly onChooseDestination: (content: HandoffDraftContent) => void;
  readonly onStartDestination: (content: HandoffDraftContent) => void;
  readonly onInspectDestination: () => void;
  readonly onMarkSent: () => void;
  readonly onCancelDelivery: () => void;
  readonly onClose: () => void;
}

export function CanvasHandoffDialog({
  handoff,
  rawOutput,
  destinationOutput,
  busy,
  error,
  onSave,
  onSend,
  onChooseDestination,
  onStartDestination,
  onInspectDestination,
  onMarkSent,
  onCancelDelivery,
  onClose
}: CanvasHandoffDialogProps) {
  const { t } = useI18n();
  const [summary, setSummary] = useState(handoff.content.summary);
  const [completedWork, setCompletedWork] = useState(handoff.content.completedWork.join("\n"));
  const [decisions, setDecisions] = useState(handoff.content.decisions.join("\n"));
  const [evidence, setEvidence] = useState(
    handoff.content.evidence.map((item) => `${item.label}: ${item.detail}`).join("\n")
  );
  const [openQuestions, setOpenQuestions] = useState(handoff.content.openQuestions.join("\n"));
  const [risks, setRisks] = useState(handoff.content.risks.join("\n"));
  const editable = handoff.status === "draft";
  const content = (): HandoffDraftContent => ({
    summary: summary.trim(),
    completedWork: lines(completedWork),
    decisions: lines(decisions),
    evidence: evidenceLines(evidence),
    openQuestions: lines(openQuestions),
    risks: lines(risks)
  });
  return (
    <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        aria-label={t("handoff.reviewTitle")}
        aria-modal="true"
        className="canvas-dialog canvas-handoff-dialog"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (summary.trim().length > 0) onSend(content());
        }}
      >
        <header>
          <div>
            <span>{t("handoff.from")}</span>
            <strong>{handoff.source.role.name}</strong>
          </div>
          <div>
            <span>{t("handoff.to")}</span>
            <strong>{handoff.target.role.name}</strong>
          </div>
        </header>
        <div className={`handoff-status is-${handoff.status}`}>
          {t(handoffStatusTranslationKey(handoff))}
        </div>
        <div className="handoff-mission-preview">
          <span>{t("handoff.mission")}</span>
          <p>{handoff.mission}</p>
        </div>
        <div className="handoff-mission-preview">
          <span>{t("handoff.contract")}</span>
          <p>
            {handoff.edge.contract.sourceDeliverable || t("handoff.contractMissing")}
            {"\n→ "}
            {handoff.edge.contract.targetInstruction || t("handoff.contractMissing")}
          </p>
        </div>
        <label>
          <span>{t("handoff.summary")}</span>
          <textarea
            autoFocus
            disabled={!editable || busy}
            maxLength={8_000}
            required
            rows={4}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <div className="handoff-fields-grid">
          <HandoffListField
            disabled={!editable || busy}
            label={t("handoff.completedWork")}
            value={completedWork}
            onChange={setCompletedWork}
          />
          <HandoffListField
            disabled={!editable || busy}
            label={t("handoff.decisions")}
            value={decisions}
            onChange={setDecisions}
          />
          <HandoffListField
            disabled={!editable || busy}
            label={t("handoff.evidence")}
            value={evidence}
            onChange={setEvidence}
          />
          <HandoffListField
            disabled={!editable || busy}
            label={t("handoff.openQuestions")}
            value={openQuestions}
            onChange={setOpenQuestions}
          />
          <HandoffListField
            disabled={!editable || busy}
            label={t("handoff.risks")}
            value={risks}
            onChange={setRisks}
          />
        </div>
        {rawOutput.length === 0 ? null : (
          <details className="handoff-raw-reference">
            <summary>{t("handoff.rawReference")}</summary>
            <p>{t("handoff.rawReferenceHelp")}</p>
            <pre>{rawOutput.slice(-20_000)}</pre>
          </details>
        )}
        {destinationOutput === undefined ? null : (
          <details className="handoff-raw-reference" open>
            <summary>{t("handoff.inspectDestination")}</summary>
            <p>{t("handoff.destinationOutputHelp")}</p>
            <pre>{destinationOutput.slice(-20_000)}</pre>
          </details>
        )}
        {error === null ? null : (
          <p className="handoff-error" role="alert">
            {error}
          </p>
        )}
        <div className="canvas-dialog-actions">
          <button disabled={busy} type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          {editable ? (
            <button disabled={busy} type="button" onClick={() => onSave(content())}>
              {t("handoff.saveDraft")}
            </button>
          ) : null}
          {handoff.status === "delivery_unknown" ? (
            <>
              <button disabled={busy} type="button" onClick={onInspectDestination}>
                {t("handoff.inspectDestination")}
              </button>
              <button disabled={busy} type="button" onClick={onMarkSent}>
                {t("handoff.markSent")}
              </button>
            </>
          ) : null}
          {handoff.status === "awaiting_destination" ? (
            <>
              <button disabled={busy} type="button" onClick={() => onChooseDestination(content())}>
                {t("handoff.chooseOtherDestination")}
              </button>
              <button
                className="primary-button"
                disabled={busy || summary.trim().length === 0}
                type="button"
                onClick={() => onStartDestination(content())}
              >
                {t("handoff.startNewDestination")}
              </button>
            </>
          ) : handoff.status === "delivered" ||
            handoff.status === "delivering" ||
            handoff.status === "rejected" ? null : (
            <button
              className="primary-button"
              disabled={busy || summary.trim().length === 0}
              type="submit"
            >
              {busy
                ? t("handoff.sending")
                : t(
                    handoff.status === "failed" ||
                      handoff.status === "delivery_unknown" ||
                      handoff.status === "cancelled"
                      ? "handoff.retry"
                      : "handoff.approveSend"
                  )}
            </button>
          )}
          {handoff.status === "ready" ||
          handoff.status === "awaiting_destination" ||
          handoff.status === "failed" ||
          handoff.status === "delivery_unknown" ? (
            <button
              className="danger-button"
              disabled={busy}
              type="button"
              onClick={onCancelDelivery}
            >
              {t("handoff.cancelDelivery")}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export function CanvasHandoffTargetDialog({
  routes,
  onSelect,
  onClose
}: {
  readonly routes: readonly {
    readonly edgeId: string;
    readonly targetNodeId: string;
    readonly targetTitle: string;
  }[];
  readonly onSelect: (route: {
    readonly edgeId: string;
    readonly targetNodeId: string;
    readonly targetTitle: string;
  }) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={t("handoff.chooseTarget")}
        aria-modal="true"
        className="canvas-dialog handoff-target-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{t("handoff.chooseTarget")}</h2>
        <p className="dialog-help">{t("handoff.chooseTargetHelp")}</p>
        <div className="handoff-target-list">
          {routes.map((route) => (
            <button key={route.edgeId} type="button" onClick={() => onSelect(route)}>
              {route.targetTitle}
            </button>
          ))}
        </div>
        <div className="canvas-dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </section>
    </div>
  );
}

export function CanvasHandoffDestinationDialog({
  destinations,
  onSelect,
  onClose
}: {
  readonly destinations: readonly { readonly sessionId: string; readonly title: string }[];
  readonly onSelect: (sessionId: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={t("handoff.chooseOtherDestination")}
        aria-modal="true"
        className="canvas-dialog handoff-target-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{t("handoff.chooseOtherDestination")}</h2>
        <p className="dialog-help">{t("handoff.chooseOtherDestinationHelp")}</p>
        <div className="handoff-target-list">
          {destinations.length === 0 ? (
            <p className="dialog-help">{t("handoff.noActiveDestination")}</p>
          ) : (
            destinations.map((destination) => (
              <button
                key={destination.sessionId}
                type="button"
                onClick={() => onSelect(destination.sessionId)}
              >
                {destination.title}
              </button>
            ))
          )}
        </div>
        <div className="canvas-dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </section>
    </div>
  );
}

function HandoffListField({
  label,
  value,
  disabled,
  onChange
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea
        disabled={disabled}
        maxLength={16_000}
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim().slice(0, 2_000))
    .filter((line) => line.length > 0)
    .slice(0, 32);
}

function evidenceLines(value: string): { readonly label: string; readonly detail: string }[] {
  return lines(value).map((line) => {
    const separator = line.indexOf(":");
    if (separator < 1) return { label: "Evidência", detail: line };
    const label = line.slice(0, separator).trim().slice(0, 160);
    const detail = line
      .slice(separator + 1)
      .trim()
      .slice(0, 2_000);
    return { label, detail: detail.length > 0 ? detail : label };
  });
}

const handoffStatusTranslationKeys = {
  draft: "handoff.draft",
  ready: "handoff.ready",
  awaiting_destination: "handoff.awaiting_destination",
  submitting: "handoff.submitting",
  written_to_terminal: "handoff.written_to_terminal",
  submitted_to_agent: "handoff.submitted_to_agent",
  delivering: "handoff.delivering",
  delivered: "handoff.delivered",
  rejected: "handoff.rejected",
  failed: "handoff.failed",
  delivery_unknown: "handoff.delivery_unknown",
  cancelled: "handoff.cancelled"
} as const;

function handoffStatusTranslationKey(handoff: CanvasHandoff) {
  const latestAttempt = handoff.deliveryAttempts.at(-1);
  if (handoff.status === "delivered" && latestAttempt?.confirmation === "manual_marked_sent") {
    return "handoff.manuallyMarkedSent";
  }
  return handoffStatusTranslationKeys[handoff.status];
}

function RoleField({
  label,
  hint,
  value,
  maxLength,
  multiline = false,
  onChange
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly maxLength: number;
  readonly multiline?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      {hint === undefined ? null : <small className="role-field-hint">{hint}</small>}
      {multiline ? (
        <textarea
          maxLength={maxLength}
          rows={3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          maxLength={maxLength}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function DialogActions({ onClose }: { readonly onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="canvas-dialog-actions">
      <button type="button" onClick={onClose}>
        {t("common.cancel")}
      </button>
      <button className="primary-button" type="submit">
        {t("context.save")}
      </button>
    </div>
  );
}
