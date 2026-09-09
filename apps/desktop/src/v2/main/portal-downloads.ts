import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface PortalDownloadOffer {
  readonly id: string;
  readonly workspaceId: string;
  readonly portalId: string;
  readonly filename: string;
  readonly extension: string;
  readonly mimeType: string;
  /** -1 when the server does not announce a length. */
  readonly totalBytes: number;
  readonly origin: string;
  readonly url: string;
  readonly suggestedDestination: string;
  readonly destinationExists: boolean;
}

export type PortalDownloadDecision =
  | { readonly accepted: false; readonly reason?: string }
  | { readonly accepted: true; readonly destination?: string; readonly overwrite?: boolean };

export type PortalDownloadState =
  "requested" | "cancelled" | "accepted" | "completed" | "failed" | "interrupted";

const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * The page proposes a name; it never proposes a path. Separators, traversal, control characters and
 * Windows device names are removed here so a download cannot decide where on the machine it lands.
 */
export function sanitizeDownloadFilename(value: string): string {
  const withoutPath = String(value).split(/[\\/]/).pop() ?? "";
  const cleaned = [...withoutPath]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "download";
  const safe = windowsReserved.test(cleaned) ? `arquivo-${cleaned}` : cleaned;
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  return `${stem.slice(0, 120) || "download"}${extension.slice(0, 16)}`;
}

export function downloadExtension(filename: string): string {
  return extname(sanitizeDownloadFilename(filename)).replace(/^\./, "").toLowerCase();
}

export function sanitizeDownloadOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "origem desconhecida";
  }
}

export function sanitizeDownloadUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 512);
  } catch {
    return "endereço inválido";
  }
}

export function suggestDownloadDestination(directory: string, filename: string): string {
  return join(directory, sanitizeDownloadFilename(filename));
}

/** A chosen destination must stay inside a directory the user picked, symlink games included. */
export function isDestinationInside(root: string, destination: string): boolean {
  if (!isAbsolute(destination)) return false;
  const relation = relative(resolve(root), resolve(destination));
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

/** Used only when the user accepts without confirming an overwrite: `nome (2).txt`. */
export function uniqueDestination(
  destination: string,
  exists: (candidate: string) => boolean
): string {
  if (!exists(destination)) return destination;
  const directory = dirname(destination);
  const extension = extname(destination);
  const stem = basename(destination, extension);
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`);
    if (!exists(candidate)) return candidate;
  }
  return join(directory, `${stem}-${Date.now()}${extension}`);
}

/**
 * Turns a decision into the path that will be written, or refuses it. Accepting an existing file
 * without `overwrite` renames instead of destroying what is already there.
 */
export function resolveDownloadDestination(input: {
  readonly decision: PortalDownloadDecision;
  readonly offer: PortalDownloadOffer;
  readonly allowedRoot: string;
  readonly exists: (candidate: string) => boolean;
}):
  | { readonly accepted: false; readonly reason: string }
  | { readonly accepted: true; readonly destination: string } {
  if (!input.decision.accepted)
    return { accepted: false, reason: input.decision.reason ?? "Download cancelado." };
  const requested = input.decision.destination ?? input.offer.suggestedDestination;
  const directory = dirname(resolve(requested));
  const filename = sanitizeDownloadFilename(basename(requested));
  const destination = join(directory, filename);
  if (!isDestinationInside(input.allowedRoot, destination))
    return { accepted: false, reason: "O destino está fora da pasta autorizada." };
  if (!input.exists(destination)) return { accepted: true, destination };
  if (input.decision.overwrite === true) return { accepted: true, destination };
  return { accepted: true, destination: uniqueDestination(destination, input.exists) };
}
