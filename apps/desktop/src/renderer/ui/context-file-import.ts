import type { CanvasContextSource } from "@forgedeck/schemas";

/**
 * Largest file we accept as a managed attachment. Mirrors the `byteSize` ceiling in
 * {@link canvasContextSourceSchema} so a picked or dropped file never fails validation later.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Images below this size are inlined as a `data:` preview so the canvas can render them without
 * re-reading disk. Larger images are still attached (checksum + metadata) but without a thumbnail,
 * keeping the persisted snapshot from ballooning.
 */
export const MAX_INLINE_PREVIEW_BYTES = 5 * 1024 * 1024;

export interface ImportedContextFile {
  readonly kind: "image" | "file";
  readonly title: string;
  readonly source: CanvasContextSource;
}

export class AttachmentTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Attachment exceeds ${maxBytes} bytes`);
    this.name = "AttachmentTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Reads a picked or dropped {@link File} into a managed context source. The local filesystem path
 * is never touched — only the bytes the browser hands us — which keeps attachments consistent with
 * the local-first rule that paths never cross into canvas data.
 */
export async function importContextFile(
  file: File,
  maxBytes: number = MAX_ATTACHMENT_BYTES
): Promise<ImportedContextFile> {
  if (file.size > maxBytes) {
    throw new AttachmentTooLargeError(maxBytes);
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new AttachmentTooLargeError(maxBytes);
  }
  const bytes = new Uint8Array(buffer);
  const mediaType = file.type === "" ? "application/octet-stream" : file.type;
  const isImage = mediaType.startsWith("image/");
  const sha256 = await sha256Hex(buffer);
  const previewDataUri =
    isImage && bytes.byteLength <= MAX_INLINE_PREVIEW_BYTES
      ? `data:${mediaType};base64,${bytesToBase64(bytes)}`
      : undefined;
  const kind = isImage ? "image" : "file";
  const source: CanvasContextSource = {
    kind,
    filename: file.name,
    mediaType,
    byteSize: bytes.byteLength,
    sha256,
    ...(previewDataUri === undefined ? {} : { previewDataUri })
  };
  return { kind, title: file.name, source };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
