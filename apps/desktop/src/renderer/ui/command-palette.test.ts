import { describe, expect, it } from "vitest";

import { paletteCommands } from "./palette-commands";

describe("paletteCommands", () => {
  it("keeps quick-add presets without a translation mapping renderable", () => {
    const commands = paletteCommands((key) => `translated:${key}`);

    expect(commands.find((command) => command.id === "terminal")?.label).toBe(
      "translated:palette.terminal"
    );
    expect(commands.find((command) => command.id === "text")).toMatchObject({
      label: "Text source",
      description: "Keep bounded text available only through an explicit context connection."
    });
  });
});
