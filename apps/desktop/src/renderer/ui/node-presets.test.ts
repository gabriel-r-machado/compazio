import { describe, expect, it } from "vitest";

import { addNodePresets, getAddNodePreset, quickAddNodePresets } from "./node-presets";

describe("canvas add-node presets", () => {
  it("maps visible agent choices to declared adapters without executable data", () => {
    expect(getAddNodePreset("claude-code")).toMatchObject({
      nodeType: "agent",
      data: { adapterId: "claude-code" }
    });
    expect(getAddNodePreset("codex")).toMatchObject({
      nodeType: "agent",
      data: { adapterId: "codex" }
    });
    expect(getAddNodePreset("opencode")).toMatchObject({
      nodeType: "agent",
      data: { adapterId: "opencode" }
    });
  });

  it("offers the full user-facing add menu", () => {
    expect(addNodePresets.map((preset) => preset.id)).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "terminal",
      "note",
      "text",
      "link",
      "file",
      "folder",
      "image",
      "drawing",
      "page",
      "rectangle",
      "ellipse",
      "diamond",
      "frame",
      "comment",
      "files",
      "preview",
      "tests",
      "approval",
      "git-review"
    ]);
  });

  it("keeps the canvas-first menu limited to terminal, agent and lightweight context choices", () => {
    expect(quickAddNodePresets.map((preset) => preset.id)).toEqual([
      "terminal",
      "claude-code",
      "codex",
      "opencode",
      "note",
      "text",
      "link",
      "comment"
    ]);
    expect(quickAddNodePresets.every((preset) => preset.data.adapterId !== "custom")).toBe(true);
  });

  it("keeps context-source presets metadata-first and never includes a local path", () => {
    const link = getAddNodePreset("link");
    const file = getAddNodePreset("file");
    expect(link.data.contextSource).toEqual({ kind: "link" });
    expect(file.data.contextSource).toEqual({ kind: "file" });
    expect(JSON.stringify(addNodePresets)).not.toContain("C:\\\\");
  });

  it("declares visual shapes, frames and comments without a runtime adapter", () => {
    expect(getAddNodePreset("diamond")).toMatchObject({
      nodeType: "shape",
      data: { shape: { kind: "diamond" } }
    });
    expect(getAddNodePreset("frame")).toMatchObject({
      nodeType: "frame",
      data: { frame: { memberNodeIds: [] } }
    });
    expect(getAddNodePreset("comment")).toMatchObject({
      nodeType: "comment",
      data: { content: "" }
    });
  });
});
