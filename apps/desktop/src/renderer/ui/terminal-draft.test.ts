import { describe, expect, it } from "vitest";

import {
  hasTerminalDraftIntent,
  terminalDraftRectangle,
  terminalGeometryFromDrag
} from "./terminal-draft";

describe("right-drag terminal drafting", () => {
  it("normalizes a drag in any direction and preserves the requested usable size", () => {
    expect(terminalDraftRectangle({ x: 900, y: 700 }, { x: 260, y: 240 })).toEqual({
      left: 260,
      top: 240,
      width: 640,
      height: 460
    });
    expect(terminalGeometryFromDrag({ x: 900, y: 700 }, { x: 260, y: 240 })).toEqual({
      position: { x: 260, y: 240 },
      width: 640,
      height: 460
    });
  });

  it("ignores a right click and clamps terminal dimensions to safe canvas limits", () => {
    expect(hasTerminalDraftIntent({ x: 10, y: 10 }, { x: 20, y: 20 })).toBe(false);
    expect(hasTerminalDraftIntent({ x: 10, y: 10 }, { x: 80, y: 10 })).toBe(true);
    expect(terminalGeometryFromDrag({ x: 0, y: 0 }, { x: 30, y: 40 })).toMatchObject({
      width: 480,
      height: 300
    });
    expect(terminalGeometryFromDrag({ x: 0, y: 0 }, { x: 2_000, y: 2_000 })).toMatchObject({
      width: 1_200,
      height: 1_200
    });
  });
});
