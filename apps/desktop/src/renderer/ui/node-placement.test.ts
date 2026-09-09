import { describe, expect, it } from "vitest";

import { nodeScreenPlacement } from "./node-placement";

describe("canvas node placement", () => {
  it("places successive terminals inside the visible viewport without stacking exactly", () => {
    const first = nodeScreenPlacement(1_920, 1_080, 0);
    const second = nodeScreenPlacement(1_920, 1_080, 1);

    expect(first).toEqual({ x: 680, y: 350 });
    expect(second).toEqual({ x: 708, y: 378 });
    expect(second).not.toEqual(first);
  });

  it("keeps placement reachable in a compact window", () => {
    expect(nodeScreenPlacement(640, 480, 0)).toEqual({ x: 40, y: 80 });
  });
});
