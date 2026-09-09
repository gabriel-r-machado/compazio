export function nodeScreenPlacement(
  viewportWidth: number,
  viewportHeight: number,
  ordinal: number
): { readonly x: number; readonly y: number } {
  const offset = (ordinal % 6) * 28;
  return {
    x: Math.max(36, viewportWidth / 2 - 280 + offset),
    y: Math.max(80, viewportHeight / 2 - 190 + offset)
  };
}
