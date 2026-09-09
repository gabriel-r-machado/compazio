import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "./i18n";
import { MENTION_TRIGGER, composeTerminalPrompt } from "./prompt-composition";
import type { ComposerMention } from "./prompt-composition";

/**
 * A writing surface for one instruction, addressed to one terminal.
 *
 * It exists because typing a real instruction straight into a PTY is hostile: no wrapping, no editing
 * a line you already passed, and every stray Enter is a submission. Nothing here forwards keys to the
 * terminal — the box owns the keyboard while it is open, and closing it (Esc) hands the session back
 * untouched, which is why it stays a deliberate mode rather than a permanent overlay.
 *
 * The draft is owned by the caller, so it survives closing the box and switching nodes.
 */
export function PromptComposer({
  nodeTitle,
  draft,
  mentions,
  disabledReason,
  onDraftChange,
  onSend,
  onClose
}: {
  readonly nodeTitle: string;
  readonly draft: string;
  readonly mentions: readonly ComposerMention[];
  /** Set when this terminal cannot receive a composed prompt; the box explains instead of failing. */
  readonly disabledReason: string | null;
  readonly onDraftChange: (draft: string) => void;
  readonly onSend: (content: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  useEffect(() => {
    // The box itself takes focus when the field is refused, so Esc still closes a blocked composer.
    // A disabled textarea cannot hold focus, and without this the only way out would be the × .
    if (disabledReason === null) inputRef.current?.focus();
    else surfaceRef.current?.focus();
  }, [disabledReason]);

  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const needle = mentionQuery.toLocaleLowerCase();
    return mentions
      .filter((mention) => mention.label.toLocaleLowerCase().includes(needle))
      .slice(0, 6);
  }, [mentionQuery, mentions]);

  const insertMention = (mention: ComposerMention) => {
    onDraftChange(`${draft.replace(MENTION_TRIGGER, "")}@${mention.label} `);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const submit = () => {
    const content = composeTerminalPrompt(draft, mentions, nodeTitle);
    if (content === null || disabledReason !== null) return;
    onSend(content);
  };

  return (
    // Keys are handled here rather than on the field so they work no matter what inside has focus,
    // and so a keystroke never escapes to the canvas shortcuts behind the box.
    <div
      aria-label={t("composer.title")}
      className="prompt-composer"
      ref={surfaceRef}
      role="dialog"
      tabIndex={-1}
      onKeyDown={(event) => {
        const firstSuggestion = suggestions[0];
        if (event.key === "Escape") {
          event.preventDefault();
          // An open list is the innermost thing to dismiss; closing the whole box on the same key
          // would throw away the paragraph's worth of typing behind it.
          if (firstSuggestion === undefined) onClose();
          else setMentionQuery(null);
          return;
        }
        // Escape closes from anywhere; the rest is field behaviour. Every button in the box keeps its
        // own Enter and Space, or reaching × by keyboard would send the draft instead of closing.
        if (event.target !== inputRef.current) return;
        if (firstSuggestion !== undefined && (event.key === "Tab" || event.key === "Enter")) {
          // Completing beats sending while a name is half-typed: submitting `@Bri` would ship text
          // that names nothing, and the reference block would come out empty.
          event.preventDefault();
          insertMention(firstSuggestion);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <header>
        <strong>{nodeTitle}</strong>
        <button
          aria-label={t("common.close")}
          title={`${t("common.close")} (Esc)`}
          type="button"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {disabledReason === null ? null : (
        <p className="prompt-composer-blocked" role="alert">
          {disabledReason}
        </p>
      )}
      {suggestions.length === 0 ? null : (
        <ul aria-label={t("composer.mentions")} className="prompt-composer-mentions">
          {suggestions.map((mention) => (
            <li key={mention.nodeId}>
              <button type="button" onMouseDown={() => insertMention(mention)}>
                <span>{mention.label}</span>
                <small>{t(`composer.kind.${mention.kind}`)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        aria-label={t("composer.title")}
        data-testid="prompt-composer-input"
        disabled={disabledReason !== null}
        placeholder={t("composer.placeholder")}
        ref={inputRef}
        rows={3}
        value={draft}
        onChange={(event) => {
          const value = event.target.value;
          onDraftChange(value);
          const trigger = MENTION_TRIGGER.exec(value);
          setMentionQuery(trigger?.[1] ?? null);
        }}
      />
      <footer>
        <small>{t("composer.hint")}</small>
        <button
          className="primary-button"
          data-testid="prompt-composer-send"
          disabled={disabledReason !== null || draft.trim().length === 0}
          type="button"
          onClick={submit}
        >
          {t("composer.send")}
        </button>
      </footer>
    </div>
  );
}
