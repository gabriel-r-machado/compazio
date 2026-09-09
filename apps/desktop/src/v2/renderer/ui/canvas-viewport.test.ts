import { describe, expect, it } from "vitest";

import {
  ZOOM_MAX,
  ZOOM_MIN,
  boundsOf,
  cablePath,
  centerOn,
  clampZoom,
  connectionGeometry,
  detailLevel,
  fitViewport,
  minimapProjection,
  nodesInRect,
  normalizeRect,
  panBy,
  snapToGrid,
  toCanvasPoint,
  toScreenPoint,
  unionRect,
  visibleRect,
  viewportInsertionPoint,
  zoomAtCenter,
  zoomAtPoint,
  consumesWheelScroll
} from "./canvas-viewport";

const nodes = [
  { id: "a", position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
  { id: "b", position: { x: 400, y: 300 }, size: { width: 100, height: 100 } }
];

describe("canvas viewport", () => {
  it("keeps zoom inside the range a person can still work in", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(12)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(1.4)).toBe(1.4);
  });

  it("converts between screen and canvas coordinates without drift", () => {
    const viewport = { x: 120, y: -40, zoom: 1.5 };
    const canvas = toCanvasPoint(viewport, { x: 300, y: 200 });
    expect(toScreenPoint(viewport, canvas)).toEqual({ x: 300, y: 200 });
  });

  it("pans by the pointer delta", () => {
    expect(panBy({ x: 10, y: 10, zoom: 1 }, -30, 45)).toEqual({ x: -20, y: 55, zoom: 1 });
  });

  it("anchors the point under the pointer while zooming", () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    const anchor = { x: 640, y: 360 };
    const before = toCanvasPoint(viewport, anchor);
    const zoomed = zoomAtPoint(viewport, 1.2, anchor);
    expect(zoomed.zoom).toBeCloseTo(1.2);
    expect(toCanvasPoint(zoomed, anchor).x).toBeCloseTo(before.x);
    expect(toCanvasPoint(zoomed, anchor).y).toBeCloseTo(before.y);
  });

  it("returns the same viewport when zoom is already at the limit", () => {
    const viewport = { x: 5, y: 5, zoom: ZOOM_MAX };
    expect(zoomAtPoint(viewport, 1.4, { x: 10, y: 10 })).toBe(viewport);
  });

  it("zooms around the centre of the visible area", () => {
    const size = { width: 800, height: 600 };
    const viewport = { x: 0, y: 0, zoom: 1 };
    const centre = toCanvasPoint(viewport, { x: 400, y: 300 });
    const zoomed = zoomAtCenter(viewport, 0.8, size);
    expect(toCanvasPoint(zoomed, { x: 400, y: 300 }).x).toBeCloseTo(centre.x);
  });

  it("fits bounds inside the visible area with padding", () => {
    const viewport = fitViewport(
      { x: 0, y: 0, width: 1000, height: 500 },
      {
        width: 800,
        height: 600
      }
    );
    expect(viewport.zoom).toBeLessThanOrEqual(1);
    const visible = visibleRect(viewport, { width: 800, height: 600 });
    expect(visible.x).toBeLessThanOrEqual(0);
    expect(visible.y).toBeLessThanOrEqual(0);
    expect(visible.x + visible.width).toBeGreaterThanOrEqual(1000);
    expect(visible.y + visible.height).toBeGreaterThanOrEqual(500);
  });

  it("never zooms past the readable limits when fitting a tiny node", () => {
    const viewport = fitViewport(
      { x: 0, y: 0, width: 10, height: 10 },
      {
        width: 1200,
        height: 800
      }
    );
    expect(viewport.zoom).toBe(ZOOM_MAX);
  });

  it("centres a canvas point without changing zoom", () => {
    const viewport = centerOn(
      { x: 0, y: 0, zoom: 2 },
      { x: 100, y: 50 },
      {
        width: 800,
        height: 600
      }
    );
    expect(viewport.zoom).toBe(2);
    expect(toScreenPoint(viewport, { x: 100, y: 50 })).toEqual({ x: 400, y: 300 });
  });

  it("measures the bounds of every node", () => {
    expect(boundsOf(nodes)).toEqual({ x: 0, y: 0, width: 500, height: 400 });
    expect(boundsOf([])).toBeNull();
  });

  it("normalizes a marquee drawn in any direction", () => {
    expect(normalizeRect({ x: 100, y: 80 }, { x: 20, y: 200 })).toEqual({
      x: 20,
      y: 80,
      width: 80,
      height: 120
    });
  });

  it("selects every node the marquee touches", () => {
    expect(nodesInRect(nodes, { x: -10, y: -10, width: 60, height: 60 })).toEqual(["a"]);
    expect(nodesInRect(nodes, { x: -10, y: -10, width: 600, height: 600 })).toEqual(["a", "b"]);
    expect(nodesInRect(nodes, { x: 250, y: 150, width: 20, height: 20 })).toEqual([]);
  });

  it("drops node detail when the canvas is too far out to read", () => {
    expect(detailLevel(1)).toBe("full");
    expect(detailLevel(0.6)).toBe("full");
    expect(detailLevel(0.4)).toBe("full");
    expect(detailLevel(0.2)).toBe("compact");
  });

  it("connects the nearest walls with a cable curve", () => {
    const first = nodes[0];
    const second = nodes[1];
    if (first === undefined || second === undefined)
      throw new Error("canvas fixture is incomplete");
    const geometry = connectionGeometry(first, second);
    expect(geometry.from).toEqual({ x: 200, y: 50 });
    expect(geometry.to).toEqual({ x: 400, y: 350 });
    expect(geometry.path).toMatch(/^M 200 50 C /);
    expect(cablePath({ x: 0, y: 0 }, { x: 100, y: 0 })).toContain("C 50");
  });

  it("projects canvas rects into the minimap frame", () => {
    const projection = minimapProjection(
      { x: 0, y: 0, width: 1000, height: 500 },
      {
        width: 200,
        height: 120
      }
    );
    const projected = projection.project({ x: 0, y: 0, width: 1000, height: 500 });
    expect(projected.width).toBeLessThanOrEqual(200);
    expect(projected.height).toBeLessThanOrEqual(120);
    expect(projected.x).toBeGreaterThanOrEqual(0);
    expect(projected.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps nodes and viewport together in the minimap", () => {
    expect(
      unionRect(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 200, y: -50, width: 100, height: 100 }
      )
    ).toEqual({ x: 0, y: -50, width: 300, height: 150 });
  });

  it("snaps created nodes to the canvas grid", () => {
    expect(snapToGrid({ x: 101, y: 37 })).toEqual({ x: 96, y: 48 });
  });

  it("inserts toolbar creations in the visible canvas instead of at a fixed origin", () => {
    const viewport = { x: -720, y: 160, zoom: 0.8 };
    const size = { width: 1200, height: 800 };
    const point = viewportInsertionPoint(viewport, size, []);
    const screen = toScreenPoint(viewport, point);

    expect(screen.x).toBeGreaterThan(0);
    expect(screen.x).toBeLessThan(size.width);
    expect(screen.y).toBeGreaterThan(0);
    expect(screen.y).toBeLessThan(size.height);
  });

  it("uses another visible slot when the centre is occupied", () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    const size = { width: 1200, height: 800 };
    const centre = viewportInsertionPoint(viewport, size, []);
    const next = viewportInsertionPoint(viewport, size, [
      { id: "occupied", position: centre, size: { width: 320, height: 220 } }
    ]);

    expect(next).not.toEqual(centre);
  });
});

describe("conflito entre rolar a nota e dar zoom no canvas", () => {
  const area = (scrollTop: number, overflowY = "auto") => ({
    scrollTop,
    scrollHeight: 900,
    clientHeight: 300,
    overflowY
  });

  it("a nota fica com a roda enquanto ainda tem para onde rolar", () => {
    expect(consumesWheelScroll(area(0), 120)).toBe(true);
    expect(consumesWheelScroll(area(300), -120)).toBe(true);
    expect(consumesWheelScroll(area(300), 120)).toBe(true);
  });

  it("devolve o gesto ao canvas nas extremidades, para o zoom nunca ficar inacessível", () => {
    expect(consumesWheelScroll(area(0), -120)).toBe(false);
    expect(consumesWheelScroll(area(600), 120)).toBe(false);
  });

  it("um elemento sem área de rolagem nunca rouba a roda", () => {
    expect(consumesWheelScroll({ ...area(0), scrollHeight: 300 }, 120)).toBe(false);
    expect(consumesWheelScroll(area(0, "visible"), 120)).toBe(false);
    expect(consumesWheelScroll(area(0, "hidden"), 120)).toBe(false);
  });
});
