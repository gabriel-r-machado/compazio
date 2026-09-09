import { useCallback, useEffect, useState } from "react";

import type { AgentMessage } from "@forgedeck/schemas";

import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { toUserFacingErrorMessage } from "./user-facing-error";

export function AgentInboxPanel({
  workspaceId,
  agentNodeId,
  agentTitle,
  open,
  onClose
}: {
  readonly workspaceId: string | null;
  readonly agentNodeId: string | null;
  readonly agentTitle: string | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [messages, setMessages] = useState<readonly AgentMessage[]>([]);
  const [busyMessageId, setBusyMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (workspaceId === null || agentNodeId === null) {
      setMessages([]);
      return;
    }
    try {
      setMessages(await window.forgedeck.agentMessages.listInbox({ workspaceId, agentNodeId }));
      setError(null);
    } catch (cause: unknown) {
      setError(toUserFacingErrorMessage(cause, t("messages.loadFailed")));
    }
  }, [agentNodeId, t, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const refreshTimer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(refreshTimer);
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    return window.forgedeck.workspaceActivity.onEvent((event) => {
      if (
        event.subject === "message" &&
        event.workspaceId === workspaceId &&
        event.agentNodeId === agentNodeId
      ) {
        void refresh();
      }
    });
  }, [agentNodeId, open, refresh, workspaceId]);

  const update = useCallback(
    async (message: AgentMessage, action: "cancel" | "retry") => {
      if (workspaceId === null) return;
      setBusyMessageId(message.id);
      try {
        const next = await window.forgedeck.agentMessages[action]({
          workspaceId,
          messageId: message.id
        });
        setMessages((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
        setError(null);
      } catch (cause: unknown) {
        setError(toUserFacingErrorMessage(cause, t("messages.updateFailed")));
      } finally {
        setBusyMessageId(null);
      }
    },
    [t, workspaceId]
  );

  if (!open) return null;
  return (
    <aside aria-label={t("messages.inbox")} className="handoff-history agent-inbox" role="dialog">
      <header>
        <div>
          <p className="fd-eyebrow">{t("messages.localInbox")}</p>
          <h2>
            {agentTitle === null ? t("messages.inbox") : `${t("messages.inbox")}: ${agentTitle}`}
          </h2>
        </div>
        <div>
          <button
            aria-label={t("messages.refresh")}
            title={t("messages.refresh")}
            type="button"
            onClick={() => void refresh()}
          >
            <Icon name="redo" />
          </button>
          <button
            aria-label={t("common.close")}
            title={t("common.close")}
            type="button"
            onClick={onClose}
          >
            Ã—
          </button>
        </div>
      </header>
      {error === null ? null : <p className="review-notice is-error">{error}</p>}
      {messages.length === 0 ? (
        <div className="handoff-history-empty">
          <strong>{t("messages.empty")}</strong>
          <p>{t("messages.emptyBody")}</p>
        </div>
      ) : (
        <ol aria-label={t("messages.inbox")}>
          {messages.map((message) => (
            <li key={message.id}>
              <article>
                <div className="agent-inbox-meta">
                  <span className={`agent-message-status is-${message.status}`}>
                    {t(messageStatusTranslationKeys[message.status])}
                  </span>
                  <time dateTime={message.createdAt}>
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: "short",
                      timeStyle: "short"
                    }).format(new Date(message.createdAt))}
                  </time>
                </div>
                <p>{message.content}</p>
                <small>
                  {t("messages.from")}: {message.senderNodeId ?? t("messages.user")}
                </small>
                <div className="agent-inbox-actions">
                  {message.status === "queued" ? (
                    <button
                      disabled={busyMessageId === message.id}
                      type="button"
                      onClick={() => void update(message, "cancel")}
                    >
                      {t("messages.cancel")}
                    </button>
                  ) : null}
                  {canRetry(message) ? (
                    <button
                      disabled={busyMessageId === message.id}
                      type="button"
                      onClick={() => void update(message, "retry")}
                    >
                      {t("messages.retry")}
                    </button>
                  ) : null}
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function canRetry(message: AgentMessage): boolean {
  return (
    message.status === "failed" ||
    message.status === "delivery_unknown" ||
    message.status === "cancelled"
  );
}

const messageStatusTranslationKeys = {
  queued: "messages.queued",
  delivering: "messages.delivering",
  sent: "messages.sent",
  failed: "messages.failed",
  delivery_unknown: "messages.deliveryUnknown",
  cancelled: "messages.cancelled"
} as const;
