import { describe, expect, it } from "vitest";

import { extractPdfText } from "./pdf-text";

describe("extractPdfText", () => {
  it("extracts bounded text with page metadata", async () => {
    const result = await extractPdfText(simplePdf("COMPAZIO_PDF_OK"));
    expect(result).toMatchObject({
      pages: 1,
      truncated: false,
      hasExtractableText: true
    });
    expect(result.text).toContain("Página 1: COMPAZIO_PDF_OK");
  });

  it("marks a semantic preview as truncated at the requested boundary", async () => {
    const result = await extractPdfText(simplePdf("ABCDEFGHIJKLMN"), 12);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(12);
  });
});

function simplePdf(text: string): Uint8Array {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
