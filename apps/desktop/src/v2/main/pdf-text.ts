const defaultMaximumCharacters = 36_000;
const maximumPages = 200;

export interface ExtractedPdfText {
  readonly pages: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly hasExtractableText: boolean;
}

/**
 * Extracts a bounded, provider-neutral text representation from a local PDF.
 *
 * PDF.js is loaded lazily so ordinary terminal and canvas startup never pays its cost. Font
 * rendering is disabled because this path only needs the public text layer.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  maximumCharacters = defaultMaximumCharacters
): Promise<ExtractedPdfText> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true
  });
  let document: Awaited<typeof loading.promise> | undefined;
  try {
    document = await loading.promise;
    const pageCount = Math.min(document.numPages, maximumPages);
    const pieces: string[] = [];
    let characterCount = 0;
    let truncated = document.numPages > maximumPages;
    for (let pageNumber = 1; pageNumber <= pageCount && !truncated; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .flatMap((item) => ("str" in item && item.str.trim() !== "" ? [item.str] : []))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (pageText === "") continue;
        const heading = `Página ${pageNumber}: `;
        const remaining = maximumCharacters - characterCount - heading.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const visible = pageText.slice(0, remaining);
        pieces.push(`${heading}${visible}`);
        characterCount += heading.length + visible.length + 1;
        if (visible.length < pageText.length) truncated = true;
      } finally {
        page.cleanup();
      }
    }
    const text = pieces.join("\n");
    return {
      pages: document.numPages,
      text,
      truncated,
      hasExtractableText: text.length > 0
    };
  } finally {
    await loading.destroy();
  }
}
