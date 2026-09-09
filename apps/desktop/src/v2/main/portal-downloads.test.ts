import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  downloadExtension,
  isDestinationInside,
  resolveDownloadDestination,
  sanitizeDownloadFilename,
  sanitizeDownloadOrigin,
  sanitizeDownloadUrl,
  suggestDownloadDestination,
  uniqueDestination,
  type PortalDownloadOffer
} from "./portal-downloads";

const root = resolve("C:/tmp/compazio-downloads");

function offer(overrides: Partial<PortalDownloadOffer> = {}): PortalDownloadOffer {
  return {
    id: "d1",
    workspaceId: "w1",
    portalId: "p1",
    filename: "fixture.txt",
    extension: "txt",
    mimeType: "text/plain",
    totalBytes: 16,
    origin: "http://127.0.0.1:4100",
    url: "http://127.0.0.1:4100/download",
    suggestedDestination: join(root, "fixture.txt"),
    destinationExists: false,
    ...overrides
  };
}

describe("portal download policy", () => {
  it("never lets the page choose a path", () => {
    expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFilename("C:\\Windows\\System32\\drivers\\etc\\hosts")).toBe("hosts");
    expect(sanitizeDownloadFilename("..")).toBe("download");
    expect(sanitizeDownloadFilename("....//..//x.txt")).toBe("x.txt");
    expect(sanitizeDownloadFilename("")).toBe("download");
  });

  it("removes characters Windows cannot store and device names", () => {
    expect(sanitizeDownloadFilename('re<port>:"|?*.csv')).toBe("re_port______.csv");
    expect(sanitizeDownloadFilename("CON.txt")).toBe("arquivo-CON.txt");
    expect(sanitizeDownloadFilename("lpt1")).toBe("arquivo-lpt1");
    expect(sanitizeDownloadFilename("nome.txt ")).toBe("nome.txt");
    expect(sanitizeDownloadFilename(".oculto")).toBe("oculto");
  });

  it("keeps the name bounded and preserves the extension", () => {
    const long = sanitizeDownloadFilename(`${"a".repeat(500)}.zip`);
    expect(long.length).toBeLessThanOrEqual(124);
    expect(long.endsWith(".zip")).toBe(true);
    expect(downloadExtension("relatório.PDF")).toBe("pdf");
    expect(downloadExtension("sem-extensao")).toBe("");
  });

  it("shows a sanitized origin instead of the full address", () => {
    expect(sanitizeDownloadOrigin("http://127.0.0.1:4100/download?token=abc")).toBe(
      "http://127.0.0.1:4100"
    );
    expect(sanitizeDownloadUrl("http://127.0.0.1:4100/download?token=abc")).toBe(
      "http://127.0.0.1:4100/download"
    );
    expect(sanitizeDownloadOrigin("nada")).toBe("origem desconhecida");
    expect(sanitizeDownloadUrl("nada")).toBe("endereço inválido");
  });

  it("refuses a download the user cancelled", () => {
    expect(
      resolveDownloadDestination({
        decision: { accepted: false },
        offer: offer(),
        allowedRoot: root,
        exists: () => false
      })
    ).toEqual({ accepted: false, reason: "Download cancelado." });
  });

  it("accepts the suggested destination inside the authorized folder", () => {
    expect(
      resolveDownloadDestination({
        decision: { accepted: true },
        offer: offer(),
        allowedRoot: root,
        exists: () => false
      })
    ).toEqual({ accepted: true, destination: join(root, "fixture.txt") });
  });

  it("refuses a destination outside the authorized folder", () => {
    const result = resolveDownloadDestination({
      decision: { accepted: true, destination: "C:/Windows/System32/evil.txt" },
      offer: offer(),
      allowedRoot: root,
      exists: () => false
    });
    expect(result).toMatchObject({ accepted: false });
  });

  it("does not overwrite an existing file without confirmation", () => {
    const existing = join(root, "fixture.txt");
    const renamed = resolveDownloadDestination({
      decision: { accepted: true },
      offer: offer({ destinationExists: true }),
      allowedRoot: root,
      exists: (candidate) => candidate === existing
    });
    expect(renamed).toEqual({ accepted: true, destination: join(root, "fixture (2).txt") });
    const overwritten = resolveDownloadDestination({
      decision: { accepted: true, overwrite: true },
      offer: offer({ destinationExists: true }),
      allowedRoot: root,
      exists: (candidate) => candidate === existing
    });
    expect(overwritten).toEqual({ accepted: true, destination: existing });
  });

  it("keeps searching for a free name when several already exist", () => {
    const taken = new Set([join(root, "a.txt"), join(root, "a (2).txt")]);
    expect(uniqueDestination(join(root, "a.txt"), (candidate) => taken.has(candidate))).toBe(
      join(root, "a (3).txt")
    );
  });

  it("recognizes what is inside the authorized folder", () => {
    expect(isDestinationInside(root, join(root, "x.txt"))).toBe(true);
    expect(isDestinationInside(root, join(root, "sub", "x.txt"))).toBe(true);
    expect(isDestinationInside(root, resolve(root, "..", "x.txt"))).toBe(false);
    expect(isDestinationInside(root, "relativo.txt")).toBe(false);
    expect(isDestinationInside(root, root)).toBe(false);
  });

  it("suggests a destination built from the sanitized name", () => {
    expect(suggestDownloadDestination(root, "../x/y.txt")).toBe(join(root, "y.txt"));
  });
});
