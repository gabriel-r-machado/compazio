const FREE_WORKSPACE_LIMIT_CODE = "FREE_WORKSPACE_LIMIT_REACHED";

/**
 * Electron serializes an exception thrown by `ipcMain.handle` into a renderer Error and drops
 * custom fields such as `code`. Keep the UI decision based on the stable product code when it is
 * present and on the equivalent public message after Electron has flattened it.
 */
export function isFreeWorkspaceLimitError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === FREE_WORKSPACE_LIMIT_CODE
  )
    return true;
  return /FREE_WORKSPACE_LIMIT_REACHED|beta gratuito permite um workspace/i.test(
    userFacingIpcError(error, "")
  );
}

/** Removes Electron transport framing and never renders a stack trace to the person. */
export function userFacingIpcError(error: unknown, fallback: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : "";
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:[A-Za-z]+)?Error:\s*/, "")
    .split(/\r?\n/, 1)[0]
    ?.trim();
  return message && message.length > 0 ? message : fallback;
}
