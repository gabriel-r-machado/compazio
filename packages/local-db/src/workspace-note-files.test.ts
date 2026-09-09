import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendNoteFile,
  noteFileName,
  noteFilePath,
  noteIdPrefixFromFileName,
  readNoteFile,
  removeNoteFile,
  writeNoteFile
} from "./workspace-note-files";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true }));
});

function tempProjectRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "compazio-notes-"));
  directories.push(directory);
  return directory;
}

const noteId = "8f14e45f-ceea-467a-9c3d-5a2b7e1f0c44";

describe("noteFileName", () => {
  it("keeps a readable slug so a person browsing the folder recognises the note", () => {
    expect(noteFileName(noteId, "Briefing da landing page")).toBe(
      "briefing-da-landing-page-8f14e45f.md"
    );
  });

  it("folds accents instead of dropping the letters", () => {
    expect(noteFileName(noteId, "Especificação")).toBe("especificacao-8f14e45f.md");
  });

  it("keeps two notes with the same title apart", () => {
    const other = "1a2b3c4d-ceea-467a-9c3d-5a2b7e1f0c44";
    expect(noteFileName(noteId, "Briefing")).not.toBe(noteFileName(other, "Briefing"));
  });

  it("still produces a usable name for a title with no usable characters", () => {
    expect(noteFileName(noteId, "★★★")).toBe("nota-8f14e45f.md");
  });

  it("cannot be steered out of the notes directory by a crafted title", () => {
    const projectRoot = tempProjectRoot();
    const path = noteFilePath(projectRoot, noteId, "../../etc/passwd");
    expect(path.startsWith(join(projectRoot, ".compazio", "notes"))).toBe(true);
  });
});

describe("note files", () => {
  it("writes the note as a real markdown file an agent can open", () => {
    const projectRoot = tempProjectRoot();

    const path = writeNoteFile({
      projectRoot,
      noteId,
      title: "Briefing",
      content: "# Briefing\n\nEntregar o login."
    });

    expect(path).toBe(join(projectRoot, ".compazio", "notes", "briefing-8f14e45f.md"));
    expect(readFileSync(path, "utf8")).toBe("# Briefing\n\nEntregar o login.");
  });

  it("leaves notes visible to the user's version control", () => {
    const projectRoot = tempProjectRoot();

    writeNoteFile({ projectRoot, noteId, title: "Briefing", content: "conteúdo" });

    // Only the ephemeral staging is ignored: a briefing is the user's own content.
    const ignore = readFileSync(join(projectRoot, ".compazio", ".gitignore"), "utf8");
    expect(ignore.trim()).toBe("runs/");
  });

  it("reads back what an agent wrote to the file directly", () => {
    const projectRoot = tempProjectRoot();
    writeNoteFile({ projectRoot, noteId, title: "Briefing", content: "original" });

    writeFileSync(
      join(projectRoot, ".compazio", "notes", "briefing-8f14e45f.md"),
      "editado por fora",
      "utf8"
    );

    expect(readNoteFile({ projectRoot, noteId, title: "Briefing" })).toBe("editado por fora");
  });

  it("reports no file rather than inventing empty content", () => {
    expect(readNoteFile({ projectRoot: tempProjectRoot(), noteId, title: "Briefing" })).toBeNull();
  });

  it("does not glue an appended entry onto the previous line", () => {
    const projectRoot = tempProjectRoot();
    writeNoteFile({ projectRoot, noteId, title: "Diário", content: "primeira entrada" });

    const path = appendNoteFile({
      projectRoot,
      noteId,
      title: "Diário",
      content: "segunda entrada"
    });

    expect(readFileSync(path, "utf8")).toBe("primeira entrada\nsegunda entrada");
  });

  it("creates the file when appending to a note that has none yet", () => {
    const projectRoot = tempProjectRoot();

    const path = appendNoteFile({ projectRoot, noteId, title: "Diário", content: "primeira" });

    expect(readFileSync(path, "utf8")).toBe("primeira");
  });

  it("never overwrites an ignore file the user already wrote", () => {
    const projectRoot = tempProjectRoot();
    mkdirSync(join(projectRoot, ".compazio"), { recursive: true });
    writeFileSync(join(projectRoot, ".compazio", ".gitignore"), "*\n", "utf8");

    writeNoteFile({ projectRoot, noteId, title: "Briefing", content: "conteúdo" });

    expect(readFileSync(join(projectRoot, ".compazio", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("removes a note's file", () => {
    const projectRoot = tempProjectRoot();
    const path = writeNoteFile({ projectRoot, noteId, title: "Briefing", content: "conteúdo" });

    removeNoteFile({ projectRoot, noteId, title: "Briefing" });

    expect(existsSync(path)).toBe(false);
  });
});

describe("noteIdPrefixFromFileName", () => {
  it("recovers the note a file belongs to, for projecting an edit made outside the product", () => {
    expect(noteIdPrefixFromFileName("briefing-8f14e45f.md")).toBe("8f14e45f");
  });

  it("ignores a file this product did not name", () => {
    expect(noteIdPrefixFromFileName("README.md")).toBeNull();
    expect(noteIdPrefixFromFileName("briefing.md")).toBeNull();
  });
});
