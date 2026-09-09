import { describe, expect, it, vi } from "vitest";

import { createDefaultCanvas } from "../renderer/ui/canvas-store";
import { handleCanvasLoad, handleCanvasSave } from "./canvas-ipc";

describe("canvas IPC handlers", () => {
  it("loads a canvas only through the fixed typed request", () => {
    const snapshot = createDefaultCanvas();
    const repository = { load: vi.fn(() => snapshot) };

    expect(handleCanvasLoad(repository, { canvasId: "default" }).snapshot?.id).toBe("default");
    expect(repository.load).toHaveBeenCalledWith("default");
    expect(() =>
      handleCanvasLoad(repository, { canvasId: "default", path: "C:/secret" })
    ).toThrow();
  });

  it("validates snapshots before persistence", () => {
    const repository = {
      save: vi.fn(() => ({ revision: 1, updatedAt: new Date().toISOString() }))
    };
    const snapshot = createDefaultCanvas();

    expect(handleCanvasSave(repository, { snapshot }).revision).toBe(1);
    expect(() =>
      handleCanvasSave(repository, {
        snapshot: { ...snapshot, edges: [{ id: "bad", source: "missing", target: "gate-sample" }] }
      })
    ).toThrow();
  });
});
