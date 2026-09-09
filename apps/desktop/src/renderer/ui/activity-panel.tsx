import { useEffect, useState } from "react";

import type { WorkspaceIncident, WorkspaceIncidentKind } from "@forgedeck/schemas";

import { Icon } from "./icons";
import { useI18n } from "./i18n";

const kindLabelKeys: Readonly<
  Record<
    WorkspaceIncidentKind,
    | "activity.policyDenied"
    | "activity.lifecycleFailed"
    | "activity.messageFailed"
    | "activity.spawnFailed"
  >
> = {
  policy_denied: "activity.policyDenied",
  lifecycle_failed: "activity.lifecycleFailed",
  message_failed: "activity.messageFailed",
  spawn_failed: "activity.spawnFailed"
};

/**
 * Every failure the runtime recorded, newest first, for as long as the row exists.
 *
 * This panel exists because the product used to answer "why did that not work?" with an alert that
 * cleared itself after a few seconds. A denial you missed because you were looking at a terminal was
 * gone; a failure that happened while the app was closed had never been visible at all. Nothing here
 * expires, and nothing here is transient — it is a query over durable rows, so reopening the app
 * shows exactly the same list.
 *
 * It shows structure, never content: which node, which permission, which action. Terminal output and
 * message bodies stay out on purpose — observability is not a reason to widen what leaves the store.
 */
export function ActivityPanel({
  workspaceId,
  open,
  onClose,
  onSelectNode
}: {
  readonly workspaceId: string | null;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Focuses the node an incident concerns, so a failure is one click from the thing that failed. */
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const { locale, t } = useI18n();
  // `null` means "not read yet", which is a different thing from "read, and there is nothing" — the
  // panel must never flash "no failures" at someone whose failures are still being loaded.
  const [incidents, setIncidents] = useState<readonly WorkspaceIncident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!open || workspaceId === null) return;
    let cancelled = false;
    void window.forgedeck.incidents
      .list({ workspaceId, limit: 50 })
      .then((response) => {
        if (cancelled) return;
        setIncidents(response.incidents);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError(t("activity.loadFailed"));
      });
    return () => {
      // A panel closed mid-flight, or a workspace switched under it, must not apply the answer to
      // the question it is no longer asking.
      cancelled = true;
    };
  }, [open, reloadNonce, t, workspaceId]);

  if (!open) return null;

  return (
    <aside aria-label={t("activity.title")} className="activity-panel" role="dialog">
      <header>
        <div>
          <p className="fd-eyebrow">{t("activity.eyebrow")}</p>
          <h2>{t("activity.title")}</h2>
        </div>
        <div>
          <button
            aria-label={t("activity.refresh")}
            title={t("activity.refresh")}
            type="button"
            onClick={() => setReloadNonce((value) => value + 1)}
          >
            <Icon name="redo" />
          </button>
          <button
            aria-label={t("common.close")}
            title={t("common.close")}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>
      {error !== null ? (
        <p className="activity-status is-error" role="alert">
          {error}
        </p>
      ) : null}
      {error === null && (incidents?.length ?? 0) === 0 ? (
        <p className="activity-status" role="status">
          {incidents === null ? t("common.loading") : t("activity.empty")}
        </p>
      ) : null}
      <ol data-testid="activity-list">
        {(incidents ?? []).map((incident) => (
          <li className={`activity-item is-${incident.severity}`} key={incident.id}>
            <div className="activity-item-head">
              <strong>{t(kindLabelKeys[incident.kind])}</strong>
              <time dateTime={incident.occurredAt}>
                {new Date(incident.occurredAt).toLocaleString(locale)}
              </time>
            </div>
            <code>
              {incident.detail}
              {incident.context === null ? null : ` · ${incident.context}`}
            </code>
            {incident.nodeId === null ? null : (
              <button type="button" onClick={() => onSelectNode(incident.nodeId ?? "")}>
                {t("activity.openNode")}
              </button>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
