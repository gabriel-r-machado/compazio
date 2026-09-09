export interface KeyboardTargetLike {
  readonly tagName: string;
  readonly isContentEditable: boolean;
}

export function isEditableKeyboardTarget(target: KeyboardTargetLike | null): boolean {
  if (target === null || target.isContentEditable) {
    return target !== null;
  }
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function nextKeyboardNodeId(
  nodes: readonly { readonly id: string }[],
  selectedNodeId: string | null,
  direction: -1 | 1
): string | null {
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  if (ordered.length === 0) {
    return null;
  }
  const current = ordered.findIndex((node) => node.id === selectedNodeId);
  return ordered[(current + direction + ordered.length) % ordered.length]?.id ?? null;
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string) => {
    const channels = value.match(/[a-f\d]{2}/gi);
    if (channels === null || channels.length !== 3) {
      throw new Error("Contrast colors must use six-digit hexadecimal values");
    }
    const [redHex, greenHex, blueHex] = channels;
    if (redHex === undefined || greenHex === undefined || blueHex === undefined) {
      throw new Error("Contrast colors must use six-digit hexadecimal values");
    }
    const toLinear = (channel: number) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return (
      0.2126 * toLinear(Number.parseInt(redHex, 16) / 255) +
      0.7152 * toLinear(Number.parseInt(greenHex, 16) / 255) +
      0.0722 * toLinear(Number.parseInt(blueHex, 16) / 255)
    );
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export const essentialContrastPairs = [
  ["#edf4f8", "#080c12"],
  ["#92a2b3", "#080c12"],
  ["#8fc7ff", "#080c12"],
  ["#ff8f92", "#080c12"],
  ["#16202a", "#f8fafc"],
  ["#526170", "#f8fafc"],
  ["#07543f", "#ffffff"],
  // Secondary text on a compasso panel and on a raised surface. Guarded because the neighbouring
  // token, `--compasso-subtle`, measures under 4.5 on both — the pair is easy to reach for by
  // accident, and the small print in the composer is where the keyboard contract is written.
  ["#a3a3a3", "#111111"],
  ["#a3a3a3", "#171717"],
  // The composer's blocked notice, in each theme. It is the only text that explains a refusal.
  ["#f4a6a6", "#221718"],
  ["#8d2b36", "#fdf1f1"]
] as const;
