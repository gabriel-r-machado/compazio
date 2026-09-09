import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "agent"
  | "artifact"
  | "branch"
  | "canvas"
  | "center"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "compose"
  | "fit"
  | "folder"
  | "handoff"
  | "copy"
  | "cut"
  | "edit"
  | "more"
  | "moon"
  | "note"
  | "organize"
  | "plus"
  | "redo"
  | "runs"
  | "search"
  | "settings"
  | "terminal"
  | "trash"
  | "undo"
  | "sun";

const iconPaths: Record<IconName, ReactNode> = {
  agent: (
    <>
      <circle cx="12" cy="8" r="3" />
      <path d="M5.8 19.1a6.5 6.5 0 0 1 12.4 0" />
    </>
  ),
  artifact: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10M8 9h4a6 6 0 0 0 6-6v2" />
    </>
  ),
  canvas: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1.5" />
      <rect x="14" y="14" width="6" height="6" rx="1.5" />
      <path d="M10 7h3.5A3.5 3.5 0 0 1 17 10.5V14M14 17h-3.5A3.5 3.5 0 0 1 7 13.5V10" />
    </>
  ),
  center: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    </>
  ),
  chevronDown: <path d="m8 10 4 4 4-4" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  // Written lines inside a speech bubble: an instruction addressed to this agent, which is a
  // different act from renaming a node (edit) or forwarding a delivery (handoff).
  compose: (
    <>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </>
  ),
  fit: (
    <>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
      <path d="m3 8 5-5m8 0 5 5M3 16l5 5m8 0 5-5" />
    </>
  ),
  folder: (
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
  ),
  handoff: <path d="M4 12h14M13 7l5 5-5 5M4 7v10" />,
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="7" r="3" />
      <circle cx="6" cy="17" r="3" />
      <path d="m8.5 8.5 11 7.5M8.5 15.5l11-7.5" />
    </>
  ),
  edit: (
    <>
      <path d="m14 5 5 5L9 20H4v-5zM12 7l5 5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  moon: <path d="M20.3 15.3A8.6 8.6 0 0 1 8.7 3.7 8.6 8.6 0 1 0 20.3 15.3Z" />,
  note: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5M9 12h6M9 16h6" />
    </>
  ),
  organize: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  redo: <path d="M20 7v5h-5M4 17a8 8 0 0 1 13.7-5.6L20 12" />,
  runs: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 5 4-5 4z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="4" />
      <path d="m7 9 3 3-3 3M13 16h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
    </>
  ),
  undo: <path d="M4 7v5h5M20 17a8 8 0 0 0-13.7-5.6L4 12" />
};

export function Icon({ name, ...props }: { readonly name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      {iconPaths[name]}
    </svg>
  );
}

export function CompazioLogo({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span className={`compasso-logo${compact ? " is-compact" : ""}`} aria-hidden="true">
      <svg fill="none" viewBox="0 0 52 36">
        <rect x="1" y="1" width="50" height="34" rx="10" stroke="currentColor" strokeWidth="2" />
        <path
          d="m12 11 7 7-7 7M40 11l-7 7 7 7M22 26h8"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.4"
        />
      </svg>
      {compact ? null : <strong>COMPAZIO</strong>}
    </span>
  );
}
