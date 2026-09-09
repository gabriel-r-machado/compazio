import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  essentialContrastPairs,
  isEditableKeyboardTarget,
  nextKeyboardNodeId
} from "./accessibility";

describe("workspace accessibility", () => {
  it("preserves AA contrast for essential text and focus colors", () => {
    for (const [foreground, background] of essentialContrastPairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves text entry alone and moves focus through canvas nodes predictably", () => {
    expect(isEditableKeyboardTarget({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(nextKeyboardNodeId([{ id: "b" }, { id: "a" }], "a", 1)).toBe("b");
    expect(nextKeyboardNodeId([{ id: "b" }, { id: "a" }], "a", -1)).toBe("b");
  });
});
