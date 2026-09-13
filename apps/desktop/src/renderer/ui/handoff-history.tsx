import { flushSync } from "react-dom";

import type { CanvasHandoff } from "@forgedeck/schemas";

import { Icon } from "./icons";
import { useI18n } from "./i18n";

export function HandoffHistoryPanel({
  handoffs,
  open,
  onClose,
  onRefresh,
  onReview
}: {
  readonly handoffs: readonly CanvasHandoff[];
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onReview: (handoff: CanvasHandoff) => void;
}) {
  const { locale, t } = useI18n();
  if (!open) return null;
  return (
    <aside aria-label={t("handoff.history")} className="handoff-history" role="dialog">
      <header>
        <div>
          <p className="fd-eyebrow">{t("handoff.localHistory")}</p>
          <h2>{t("handoff.history")}</h2>
        </div>
        <div>
          <button
            aria-label={t("handoff.refresh")}
            title={t("handoff.refresh")}
            type="button"
            onClick={onRefresh}
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
      {handoffs.length === 0 ? (
        <div className="handoff-history-empty">
          <strong>{t("handoff.historyEmpty")}</strong>
          <p>{t("handoff.historyEmptyBody")}</p>
        </div>
      ) : (
        <ol>
          {handoffs.map((handoff) => (
            <li key={handoff.id}>
              <button
                type="button"
                onClick={() => {
                  flushSync(() => onReview(handoff));
                }}
              >
                <span className={`handoff-status is-${handoff.status}`}>
                  {t(handoffStatusTranslationKey(handoff))}
                </span>
                <strong>
                  {handoff.source.role.name} → {handoff.target.role.name}
                </strong>
                <p>{handoff.content.summary || t("handoff.draftWithoutSummary")}</p>
                <time dateTime={handoff.updatedAt}>
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "short",
                    timeStyle: "short"
                  }).format(new Date(handoff.updatedAt))}
                </time>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
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
