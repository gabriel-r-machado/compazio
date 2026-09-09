type ResponseHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export const viteReactPreambleHash = "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

export function createRendererContentSecurityPolicy(isDevelopment: boolean): string {
  // xterm's safe DOM renderer applies dynamic cell colours and dimensions through inline styles.
  // Keep script execution locked to application assets, but allow those presentation-only styles
  // so a machine without WebGL still gets ANSI/true-colour output and correct glyph geometry.
  const styleSources = "'self' 'unsafe-inline'";
  const scriptSources = isDevelopment ? `'self' ${viteReactPreambleHash}` : "'self'";
  const connectSources = isDevelopment ? "'self' ws://localhost:* ws://127.0.0.1:*" : "'self'";

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSources}`,
    `style-src ${styleSources}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`
  ].join("; ");
}

export function withRendererContentSecurityPolicy(
  responseHeaders: ResponseHeaders,
  policy: string
): Record<string, string | string[]> {
  const headers = Object.fromEntries(
    Object.entries(responseHeaders).filter(
      ([name, value]) => name.toLowerCase() !== "content-security-policy" && value !== undefined
    )
  ) as Record<string, string | string[]>;
  headers["Content-Security-Policy"] = [policy];
  return headers;
}
