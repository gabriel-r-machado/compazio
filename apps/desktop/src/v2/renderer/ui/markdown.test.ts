import { describe, expect, it } from "vitest";

import { safeMarkdownUrl } from "./markdown-safety";

describe("safeMarkdownUrl", () => {
  it("allows inert links and blocks active protocols", () => {
    expect(safeMarkdownUrl("https://example.test/a")).toBe("https://example.test/a");
    expect(safeMarkdownUrl("mailto:help@example.test")).toBe("mailto:help@example.test");
    expect(safeMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(safeMarkdownUrl("file:///C:/secret.txt")).toBeNull();
  });
});
