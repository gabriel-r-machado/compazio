import { describe, expect, it } from "vitest";

import {
  createRendererContentSecurityPolicy,
  viteReactPreambleHash,
  withRendererContentSecurityPolicy
} from "./content-security-policy";

describe("renderer content security policy", () => {
  it("keeps production script execution strict while allowing xterm cell styles", () => {
    const policy = createRendererContentSecurityPolicy(false);

    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("ws://");
  });

  it("allows only Vite's hashed preamble, styles, and local websocket requirements", () => {
    const policy = createRendererContentSecurityPolicy(true);

    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self' ws://localhost:* ws://127.0.0.1:*");
    expect(policy).toContain(`script-src 'self' ${viteReactPreambleHash}`);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("replaces a pre-existing CSP header instead of layering policies", () => {
    const headers = withRendererContentSecurityPolicy(
      {
        "content-security-policy": ["default-src *"],
        "X-Frame-Options": ["DENY"]
      },
      "default-src 'self'"
    );

    expect(headers["content-security-policy"]).toBeUndefined();
    expect(headers["Content-Security-Policy"]).toEqual(["default-src 'self'"]);
    expect(headers["X-Frame-Options"]).toEqual(["DENY"]);
  });
});
