import { describe, expect, it } from "vitest";

import {
  AttachmentTooLargeError,
  MAX_INLINE_PREVIEW_BYTES,
  importContextFile
} from "./context-file-import";

function fileOf(name: string, type: string, bytes: Uint8Array): File {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new File([buffer], name, { type });
}

describe("importContextFile", () => {
  it("inlines a small image as a data URI preview with a checksum", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await importContextFile(fileOf("diagram.png", "image/png", png));

    expect(result.kind).toBe("image");
    expect(result.title).toBe("diagram.png");
    expect(result.source.kind).toBe("image");
    expect(result.source.mediaType).toBe("image/png");
    expect(result.source.byteSize).toBe(png.byteLength);
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.source.previewDataUri).toMatch(/^data:image\/png;base64,/);
  });

  it("attaches a non-image file as metadata without an inline preview", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await importContextFile(fileOf("notes.txt", "text/plain", bytes));

    expect(result.kind).toBe("file");
    expect(result.source.kind).toBe("file");
    expect(result.source.previewDataUri).toBeUndefined();
    expect(result.source.filename).toBe("notes.txt");
  });

  it("falls back to a generic media type when the browser reports none", async () => {
    const result = await importContextFile(fileOf("blob", "", new Uint8Array([9])));
    expect(result.source.mediaType).toBe("application/octet-stream");
  });

  it("skips the inline preview for images above the preview ceiling", async () => {
    const big = new Uint8Array(MAX_INLINE_PREVIEW_BYTES + 1);
    const result = await importContextFile(fileOf("huge.png", "image/png", big));

    expect(result.kind).toBe("image");
    expect(result.source.previewDataUri).toBeUndefined();
    expect(result.source.byteSize).toBe(big.byteLength);
  });

  it("rejects files over the maximum size", async () => {
    const bytes = new Uint8Array(64);
    await expect(
      importContextFile(fileOf("x.bin", "application/octet-stream", bytes), 32)
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
  });
});
