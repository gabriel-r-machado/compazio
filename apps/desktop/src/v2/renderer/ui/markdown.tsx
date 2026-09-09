import { Fragment, type ReactNode } from "react";

import { safeMarkdownUrl } from "./markdown-safety";

export function MarkdownPreview({ source }: { readonly source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.split("\n");
  let code: string[] | null = null;
  lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      if (code === null) code = [];
      else {
        blocks.push(
          <pre key={`code-${index}`}>
            <code>{code.join("\n")}</code>
          </pre>
        );
        code = null;
      }
      return;
    }
    if (code !== null) {
      code.push(line);
      return;
    }
    if (/^#{1,6}\s+/.test(line)) {
      const title = inline(line.replace(/^#{1,6}\s+/, ""));
      if (line.startsWith("# ")) blocks.push(<h1 key={`h-${index}`}>{title}</h1>);
      else if (line.startsWith("## ")) blocks.push(<h2 key={`h-${index}`}>{title}</h2>);
      else blocks.push(<h3 key={`h-${index}`}>{title}</h3>);
    } else if (/^- \[[ xX]\]\s+/.test(line)) {
      const checked = /^- \[[xX]\]/.test(line);
      blocks.push(
        <label key={`check-${index}`}>
          <input type="checkbox" checked={checked} readOnly />{" "}
          {inline(line.replace(/^- \[[ xX]\]\s+/, ""))}
        </label>
      );
    } else if (/^(?:[-*+]|\d+\.)\s+/.test(line)) {
      blocks.push(<li key={`li-${index}`}>{inline(line.replace(/^(?:[-*+]|\d+\.)\s+/, ""))}</li>);
    } else if (line.startsWith("> ")) {
      blocks.push(<blockquote key={`quote-${index}`}>{inline(line.slice(2))}</blockquote>);
    } else if (line.trim() !== "") {
      blocks.push(<p key={`p-${index}`}>{inline(line)}</p>);
    }
  });
  if (code !== null) {
    blocks.push(
      <pre key="unterminated">
        <code>{code.join("\n")}</code>
      </pre>
    );
  }
  return <div className="v2-markdown-preview">{blocks}</div>;
}

function inline(value: string): ReactNode {
  const parts = value.split(/(\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (match === null) return <Fragment key={index}>{part}</Fragment>;
    const href = safeMarkdownUrl(match[2] ?? "");
    return href === null ? (
      <Fragment key={index}>{match[1]}</Fragment>
    ) : (
      <a key={index} href={href} target="_blank" rel="noreferrer">
        {match[1]}
      </a>
    );
  });
}
