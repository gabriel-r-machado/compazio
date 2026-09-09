const electronRemotePrefix = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i;
const genericErrorPrefix = /^Error:\s*/i;

export function toUserFacingErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const message = raw.replace(electronRemotePrefix, "").replace(genericErrorPrefix, "").trim();
  return message.length > 0 ? message : fallback;
}
