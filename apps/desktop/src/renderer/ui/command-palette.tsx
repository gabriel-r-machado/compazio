import { useEffect, useRef, useState } from "react";

import type { AddNodeKind } from "./node-presets";
import { useI18n } from "./i18n";
import { paletteCommands } from "./palette-commands";

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAddNode: (kind: AddNodeKind) => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.open) {
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [props.open]);
  if (!props.open) {
    return null;
  }
  const translatedNodes = paletteCommands(t);
  const filteredNodes = translatedNodes.filter((command) =>
    `${command.label} ${command.description}`.toLowerCase().includes(query.toLowerCase())
  );
  const close = () => {
    setQuery("");
    props.onClose();
  };
  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={close}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label>
          <span className="sr-only">{t("palette.search")}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                close();
              }
            }}
            placeholder={t("palette.placeholder")}
          />
        </label>
        <div className="command-list" role="listbox">
          {filteredNodes.map((command) => (
            <button
              key={command.id}
              data-testid={`palette-add-${command.id}`}
              type="button"
              onClick={() => {
                setQuery("");
                props.onAddNode(command.id);
              }}
            >
              <span>{command.label}</span>
              <small>{command.description}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
