import { quickAddNodePresets } from "./node-presets";

const paletteKeys = {
  terminal: { label: "palette.terminal", description: "palette.terminalBody" },
  "claude-code": { label: "palette.claude", description: "palette.claudeBody" },
  codex: { label: "palette.codex", description: "palette.codexBody" },
  opencode: { label: "palette.opencode", description: "palette.opencodeBody" },
  note: { label: "palette.note", description: "palette.noteBody" }
} as const;

export function paletteCommands(
  t: (key: (typeof paletteKeys)[keyof typeof paletteKeys]["label" | "description"]) => string
) {
  return quickAddNodePresets.map((command) => {
    const keys = paletteKeys[command.id as keyof typeof paletteKeys];
    return {
      ...command,
      // Quick-add presets can grow independently from the translated command
      // catalog. Keep the palette usable while a new preset is being translated.
      label: keys === undefined ? command.label : t(keys.label),
      description: keys === undefined ? command.description : t(keys.description)
    };
  });
}
