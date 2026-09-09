import { addNoteNode, addTerminalNode, createWorkspace } from "@forgedeck/compazio-v2-domain";
import { describe, expect, it } from "vitest";

import { connectionFor } from "./connection-capabilities";

const dependencies = {
  createId: (() => {
    let sequence = 0;
    return () => `id-${++sequence}`;
  })(),
  now: () => "2026-08-13T00:00:00.000Z"
};

describe("canvas connection capabilities", () => {
  it("grants messaging only between terminals", () => {
    let workspace = createWorkspace(
      { name: "Conexões", workingDirectory: "C:\\project" },
      dependencies
    );
    workspace = addTerminalNode(workspace, { title: "Claude" }, dependencies);
    workspace = addTerminalNode(workspace, { title: "Codex" }, dependencies);
    const [first, second] = workspace.nodes;
    if (first === undefined || second === undefined) throw new Error("fixture missing");
    expect(connectionFor(first, second)).toMatchObject({
      capabilities: ["send-message", "share-context"]
    });
  });

  it("makes terminal-note access explicit and note-note links context-only", () => {
    let workspace = createWorkspace(
      { name: "Notas", workingDirectory: "C:\\project" },
      dependencies
    );
    workspace = addTerminalNode(workspace, { title: "Claude" }, dependencies);
    workspace = addNoteNode(workspace, { title: "Plano" }, dependencies);
    workspace = addNoteNode(workspace, { title: "Decisões" }, dependencies);
    const [terminal, firstNote, secondNote] = workspace.nodes;
    if (terminal === undefined || firstNote === undefined || secondNote === undefined)
      throw new Error("fixture missing");
    expect(connectionFor(firstNote, terminal)).toMatchObject({
      sourceNodeId: terminal.id,
      targetNodeId: firstNote.id,
      capabilities: ["read-note", "write-note", "share-context"]
    });
    expect(connectionFor(firstNote, secondNote).capabilities).toEqual(["share-context"]);
  });
});
