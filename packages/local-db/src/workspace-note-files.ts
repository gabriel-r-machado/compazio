import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Notes as real markdown files on disk.
 *
 * A note is the notebook agents and the person share, so it has to be something an agent can open
 * with the tools it already has — not a row only this product can read. The file is therefore the
 * authority for a note's *content*; SQLite stays the authority for its existence, identity, position
 * on the canvas and audit trail, and keeps a mirror of the text for readers that have no project
 * root to look in.
 *
 * The files live under `<project>/.compazio/notes/` and are deliberately NOT ignored by the staging
 * ignore rule: a briefing or a spec is the user's content, and hiding it from their version control
 * by default would be a surprising thing for this product to decide on their behalf.
 */

export const NOTES_DIRECTORY = "notes" as const;
const STAGING_ROOT = ".compazio" as const;

/**
 * Only the ephemeral parts of the staging root are ignored. Written next to them so every project is
 * protected without this product editing a `.gitignore` the user owns.
 */
export const STAGING_IGNORE_CONTENTS = ["runs/", ""].join("\n");

export function notesDirectory(projectRoot: string): string {
  return join(projectRoot, STAGING_ROOT, NOTES_DIRECTORY);
}

/**
 * A note's file name carries a readable slug so a person browsing the folder recognises it, plus the
 * note's own id so two notes titled "Briefing" cannot collide and so renaming a note never orphans
 * its file.
 */
export function noteFileName(noteId: string, title: string): string {
  return `${slugify(title)}-${noteId.slice(0, 8)}.md`;
}

export function noteFilePath(projectRoot: string, noteId: string, title: string): string {
  const path = join(notesDirectory(projectRoot), noteFileName(noteId, title));
  if (!isPathInside(notesDirectory(projectRoot), path)) {
    throw new Error("Workspace note path escapes the notes directory");
  }
  return path;
}

export function writeNoteFile(input: {
  readonly projectRoot: string;
  readonly noteId: string;
  readonly title: string;
  readonly content: string;
}): string {
  const path = noteFilePath(input.projectRoot, input.noteId, input.title);
  mkdirSync(notesDirectory(input.projectRoot), { recursive: true });
  ensureStagingIgnore(input.projectRoot);
  writeFileSync(path, input.content, "utf8");
  return path;
}

export function appendNoteFile(input: {
  readonly projectRoot: string;
  readonly noteId: string;
  readonly title: string;
  readonly content: string;
}): string {
  const path = noteFilePath(input.projectRoot, input.noteId, input.title);
  if (!existsSync(path)) {
    return writeNoteFile(input);
  }
  const existing = readFileSync(path, "utf8");
  // Appending to a note someone else has been editing must not glue two paragraphs together.
  appendFileSync(path, existing.endsWith("\n") ? input.content : `\n${input.content}`, "utf8");
  return path;
}

/** Returns the note's content from disk, or null when this project has no file for it. */
export function readNoteFile(input: {
  readonly projectRoot: string;
  readonly noteId: string;
  readonly title: string;
}): string | null {
  const path = noteFilePath(input.projectRoot, input.noteId, input.title);
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function removeNoteFile(input: {
  readonly projectRoot: string;
  readonly noteId: string;
  readonly title: string;
}): void {
  rmSync(noteFilePath(input.projectRoot, input.noteId, input.title), { force: true });
}

/** Recovers the note id a file name carries, for projecting an edit made outside the product. */
export function noteIdPrefixFromFileName(fileName: string): string | null {
  const match = /-(?<prefix>[0-9a-f]{8})\.md$/.exec(fileName);
  return match?.groups?.prefix ?? null;
}

function ensureStagingIgnore(projectRoot: string): void {
  const ignorePath = join(projectRoot, STAGING_ROOT, ".gitignore");
  if (existsSync(ignorePath)) return;
  writeFileSync(ignorePath, STAGING_IGNORE_CONTENTS, "utf8");
}

function slugify(title: string): string {
  const cleaned = title
    .normalize("NFD")
    // Strip combining marks so "Especificação" becomes "especificacao" rather than "especifica-o".
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "nota";
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== "" &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    pathFromRoot !== ".." &&
    !isAbsolute(pathFromRoot)
  );
}
