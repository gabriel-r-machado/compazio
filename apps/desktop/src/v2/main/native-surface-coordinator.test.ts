import { describe, expect, it } from "vitest";

import {
  NativeSurfaceCoordinator,
  clip,
  type NativeSurfaceDecision,
  type NativeSurfaceOverlay
} from "./native-surface-coordinator";

const viewport = { x: 0, y: 48, width: 1_200, height: 800 };

function coordinator(): NativeSurfaceCoordinator {
  const surfaces = new NativeSurfaceCoordinator();
  surfaces.setWindowState({ activeWorkspaceId: "w1", canvasViewport: viewport });
  surfaces.track({
    surfaceId: "w1:p1",
    workspaceId: "w1",
    nodeVisible: true,
    bounds: { x: 100, y: 100, width: 400, height: 300 }
  });
  return surfaces;
}

function only(decisions: readonly NativeSurfaceDecision[]): NativeSurfaceDecision {
  const decision = decisions[0];
  if (decision === undefined) throw new Error("decision fixture missing");
  return decision;
}

describe("native surface coordinator", () => {
  it("shows a Portal of the active workspace inside the canvas viewport", () => {
    const decision = only(coordinator().decisions());
    expect(decision).toMatchObject({
      attached: true,
      visible: true,
      reason: "visible",
      bounds: { x: 100, y: 100, width: 400, height: 300 }
    });
  });

  it("hides the Portal under every React surface that must stay on top", () => {
    const overlays: NativeSurfaceOverlay[] = [
      "modal",
      "menu",
      "command-palette",
      "prompt-composer",
      "popover",
      "dialog",
      "settings",
      "destructive-confirmation",
      "inspector"
    ];
    for (const overlay of overlays) {
      const surfaces = coordinator();
      const opened = only(surfaces.openOverlay(overlay));
      expect(opened).toMatchObject({ attached: true, visible: false, reason: "overlay" });
      const closed = only(surfaces.closeOverlay(overlay));
      expect(closed).toMatchObject({ attached: true, visible: true, reason: "visible" });
    }
  });

  it("keeps the runtime attached while an overlay is open so it is not recreated", () => {
    const surfaces = coordinator();
    surfaces.openOverlay("menu");
    surfaces.openOverlay("modal");
    expect(only(surfaces.decisions()).attached).toBe(true);
    expect(only(surfaces.closeOverlay("menu")).visible).toBe(false);
    expect(only(surfaces.closeOverlay("modal")).visible).toBe(true);
  });

  it("restores visibility once every overlay is closed at once", () => {
    const surfaces = coordinator();
    surfaces.openOverlay("command-palette");
    surfaces.openOverlay("popover");
    expect(only(surfaces.closeAllOverlays())).toMatchObject({ visible: true });
  });

  it("detaches a Portal that belongs to another workspace", () => {
    const surfaces = coordinator();
    const decision = only(surfaces.setWindowState({ activeWorkspaceId: "w2" }));
    expect(decision).toMatchObject({
      attached: false,
      visible: false,
      reason: "workspace-inactive"
    });
    expect(only(surfaces.setWindowState({ activeWorkspaceId: "w1" })).attached).toBe(true);
  });

  it("hides a Portal while the window is minimized", () => {
    const surfaces = coordinator();
    expect(only(surfaces.setWindowState({ minimized: true }))).toMatchObject({
      visible: false,
      reason: "window-minimized"
    });
    expect(only(surfaces.setWindowState({ minimized: false })).visible).toBe(true);
  });

  it("hides a Portal whose node is not visible on the canvas", () => {
    const surfaces = coordinator();
    const decision = only(
      surfaces.track({
        surfaceId: "w1:p1",
        workspaceId: "w1",
        nodeVisible: false,
        bounds: { x: 100, y: 100, width: 400, height: 300 }
      })
    );
    expect(decision).toMatchObject({ visible: false, reason: "node-hidden" });
  });

  it("clips a Portal to the canvas viewport instead of painting over the shell", () => {
    const surfaces = coordinator();
    const decision = only(
      surfaces.track({
        surfaceId: "w1:p1",
        workspaceId: "w1",
        nodeVisible: true,
        bounds: { x: -50, y: 0, width: 400, height: 300 }
      })
    );
    expect(decision.bounds).toEqual({ x: 0, y: 48, width: 350, height: 252 });
  });

  it("hides a Portal scrolled completely outside the viewport", () => {
    const surfaces = coordinator();
    const decision = only(
      surfaces.track({
        surfaceId: "w1:p1",
        workspaceId: "w1",
        nodeVisible: true,
        bounds: { x: 4_000, y: 4_000, width: 400, height: 300 }
      })
    );
    expect(decision).toMatchObject({ visible: false, reason: "outside-viewport" });
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const surfaces = coordinator();
    const seen: number[] = [];
    const unsubscribe = surfaces.subscribe((decisions) => seen.push(decisions.length));
    surfaces.openOverlay("modal");
    unsubscribe();
    surfaces.closeOverlay("modal");
    expect(seen).toEqual([1]);
  });

  it("forgets surfaces on untrack and by workspace", () => {
    const surfaces = coordinator();
    surfaces.track({
      surfaceId: "w2:p9",
      workspaceId: "w2",
      nodeVisible: true,
      bounds: { x: 0, y: 0, width: 10, height: 10 }
    });
    expect(surfaces.size()).toBe(2);
    surfaces.untrack("w1:p1");
    expect(surfaces.size()).toBe(1);
    surfaces.untrackWorkspace("w2");
    expect(surfaces.size()).toBe(0);
    expect(surfaces.decisionFor("w1:p1")).toBeNull();
  });

  it("repeats an overlay open or close without changing the outcome", () => {
    const surfaces = coordinator();
    surfaces.openOverlay("menu");
    surfaces.openOverlay("menu");
    expect(surfaces.windowState().overlays).toEqual(["menu"]);
    surfaces.closeOverlay("menu");
    surfaces.closeOverlay("menu");
    expect(surfaces.windowState().overlays).toEqual([]);
    expect(only(surfaces.decisions()).visible).toBe(true);
  });

  it("clips without a viewport and rejects an empty rectangle", () => {
    expect(clip({ x: 1.4, y: 2.6, width: 10, height: 10 }, null)).toEqual({
      x: 1,
      y: 3,
      width: 10,
      height: 10
    });
    expect(clip({ x: 0, y: 0, width: 0, height: 10 }, null)).toBeNull();
  });
});
