/** Allows only inert, user-visible link protocols in formatted notes. */
export function safeMarkdownUrl(value: string): string | null {
  try {
    const url = new URL(value, "https://compazio.invalid");
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") {
      return value;
    }
    if (value.startsWith("/") || value.startsWith("./")) return value;
  } catch {
    return null;
  }
  return null;
}
