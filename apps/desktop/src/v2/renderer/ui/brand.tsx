import type { ReactNode } from "react";

import { COMPAZIO_MARK_IMAGE } from "./compazio-mark-image";

/**
 * Compazio identity, drawn instead of imported: the desktop has to look like itself with no network
 * and no font or image download. Every mark inherits `currentColor`, so one component serves the
 * dark canvas, a light surface and a disabled state without extra assets.
 */

/**
 * O símbolo oficial na versão monocromática. É a única marca que não é desenhada em traço:
 * vem embutida como PNG, então continua valendo a regra de não baixar imagem nem ler o disco.
 * O invólucro segue sendo um `svg.v2-mark[aria-label="Compazio"]`, que é o que o smoke procura.
 */
export function CompazioMark({ size = 28 }: { readonly size?: number }) {
  return (
    <svg
      className="v2-mark"
      width={size}
      height={size}
      viewBox="0 0 128 128"
      role="img"
      aria-label="Compazio"
      focusable="false"
    >
      <image href={COMPAZIO_MARK_IMAGE} width="128" height="128" />
    </svg>
  );
}

export function CompazioWordmark() {
  return (
    <span className="v2-wordmark" aria-hidden="true">
      COMPAZIO
    </span>
  );
}

/** Line icons for the canvas dock. Monochrome and stroke-only, per the identity. */
export function ToolIcon({ name }: { readonly name: ToolIconName }) {
  return (
    <svg
      className="v2-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name]}
    </svg>
  );
}

export type ToolIconName =
  | "terminal"
  | "note"
  | "files"
  | "portal"
  | "link"
  | "group"
  | "compose"
  | "search"
  | "team"
  | "history"
  | "alert"
  | "more"
  | "minus"
  | "plus"
  | "fit"
  | "map"
  | "sidebar"
  | "play"
  | "stop"
  | "restart"
  | "settings"
  | "scissors"
  | "trash"
  | "upload"
  | "copy";

const iconPaths: Record<ToolIconName, ReactNode> = {
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7.5 9.5 2.5 2.5-2.5 2.5M13 15h4" />
    </>
  ),
  note: (
    <>
      <path d="M5 3.8h14v16.4H5z" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </>
  ),
  files: (
    <>
      <path d="M4 6h6l1.6 2H20v10H4z" />
      <path d="M4 11h16" />
    </>
  ),
  portal: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8M12 3.6c2.2 2.4 3.3 5.3 3.3 8.4s-1.1 6-3.3 8.4c-2.2-2.4-3.3-5.3-3.3-8.4S9.8 6 12 3.6Z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.8a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
      <path d="M14 10.2a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </>
  ),
  group: (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" />
    </>
  ),
  compose: (
    <>
      <path d="M4 19.5 8.3 18l10-10a2.1 2.1 0 0 0-3-3l-10 10z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m16 16 4 4" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.6 19.4c.6-3 2.8-4.6 5.4-4.6s4.8 1.6 5.4 4.6" />
      <path d="M16 6.4a3.2 3.2 0 0 1 0 6M17.4 14.6c2.1.4 3.5 2 3.9 4.4" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.4 20.6 19H3.4z" />
      <path d="M12 10v3.6M12 16.4v.1" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <line x1="8.1" y1="7.6" x2="19.5" y2="18.5" />
      <line x1="8.1" y1="16.4" x2="19.5" y2="5.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.4 6.5 7.3 19a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
      <line x1="10.4" y1="10" x2="10.7" y2="17" />
      <line x1="13.6" y1="10" x2="13.3" y2="17" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  minus: <path d="M6 12h12" />,
  plus: <path d="M12 6v12M6 12h12" />,
  fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  map: (
    <>
      <path d="M3.6 6.6 9 4.4l6 2.2 5.4-2.2v13l-5.4 2.2-6-2.2-5.4 2.2z" />
      <path d="M9 4.4v13M15 6.6v13" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4" />
      <path d="M9.6 4.6v14.8" />
    </>
  ),
  play: <path d="M8.4 5.6 18.6 12 8.4 18.4z" />,
  stop: <rect x="6.6" y="6.6" width="10.8" height="10.8" rx="1.8" />,
  restart: (
    <>
      <path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4" />
      <path d="M19.8 4.6v4.2h-4.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.6v2.2M12 18.2v2.2M20.4 12h-2.2M5.8 12H3.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6M17.9 17.9l-1.6-1.6M7.7 7.7 6.1 6.1" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.6V4.8" />
      <path d="m8.2 8.6 3.8-3.8 3.8 3.8" />
      <path d="M4.6 15.2v2.6a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-2.6" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  )
};
