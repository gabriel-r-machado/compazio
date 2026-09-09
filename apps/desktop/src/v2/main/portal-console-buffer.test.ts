import { describe, expect, it } from "vitest";

import {
  PortalConsoleBuffer,
  normalizePortalConsoleLevel,
  sanitizePortalConsoleMessage,
  sanitizePortalSource
} from "./portal-console-buffer";

describe("portal console buffer", () => {
  it("keeps only the newest entries and reports what was dropped", () => {
    const buffer = new PortalConsoleBuffer({ capacity: 3 });
    for (const index of [1, 2, 3, 4, 5])
      buffer.record({ level: "log", message: `linha ${index}`, source: "", line: index });
    const result = buffer.query({ limit: 10 });
    expect(result.entries.map((entry) => entry.message)).toEqual(["linha 3", "linha 4", "linha 5"]);
    expect(result.stored).toBe(3);
    expect(result.capacity).toBe(3);
    expect(result.dropped).toBe(2);
    expect(buffer.size()).toBe(3);
  });

  it("filters by level and by substring", () => {
    const buffer = new PortalConsoleBuffer();
    buffer.record({ level: "log", message: "fixture log" });
    buffer.record({ level: "error", message: "fixture error" });
    buffer.record({ level: 2, message: "aviso" });
    expect(buffer.query({ levels: ["error"] }).entries.map((entry) => entry.message)).toEqual([
      "fixture error"
    ]);
    expect(buffer.query({ levels: ["warning"] }).entries[0]?.level).toBe("warning");
    expect(buffer.query({ contains: "fixture" }).entries).toHaveLength(2);
  });

  it("advances a cursor so a second query only returns new entries", () => {
    const buffer = new PortalConsoleBuffer();
    buffer.record({ level: "log", message: "primeira" });
    const first = buffer.query();
    expect(first.entries).toHaveLength(1);
    expect(buffer.query({ since: first.cursor }).entries).toHaveLength(0);
    buffer.record({ level: "log", message: "segunda" });
    const second = buffer.query({ since: first.cursor });
    expect(second.entries.map((entry) => entry.message)).toEqual(["segunda"]);
    expect(second.cursor).toBeGreaterThan(first.cursor);
  });

  it("filters by timestamp", () => {
    let clock = 1_000;
    const buffer = new PortalConsoleBuffer({ now: () => new Date(clock) });
    buffer.record({ level: "log", message: "antiga" });
    clock = 5_000;
    buffer.record({ level: "log", message: "nova" });
    const result = buffer.query({ sinceTimestamp: new Date(3_000).toISOString() });
    expect(result.entries.map((entry) => entry.message)).toEqual(["nova"]);
  });

  it("caps the query limit to the buffer capacity", () => {
    const buffer = new PortalConsoleBuffer({ capacity: 2 });
    buffer.record({ level: "log", message: "a" });
    buffer.record({ level: "log", message: "b" });
    expect(buffer.query({ limit: 10_000 }).entries).toHaveLength(2);
    expect(buffer.query({ limit: 0 }).entries).toHaveLength(1);
  });

  it("never stores credentials, cookies or tokens", () => {
    const buffer = new PortalConsoleBuffer();
    const entry = buffer.record({
      level: "error",
      message:
        'falhou Authorization: Bearer abc.def.ghi cookie: sid=42 {"password":"segredo","access_token":"xyz123456"} sk-ABCDEFGHIJKLMNOPQRSTUV eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      source: "https://exemplo.test/app.js?token=abc"
    });
    expect(entry.message).not.toContain("abc.def.ghi");
    expect(entry.message).not.toContain("segredo");
    expect(entry.message).not.toContain("xyz123456");
    expect(entry.message).not.toContain("sid=42");
    expect(entry.message).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
    expect(entry.message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(entry.message).toContain("[redigido]");
    expect(entry.source).toBe("https://exemplo.test/app.js");
  });

  it("truncates a long message instead of storing it whole", () => {
    const buffer = new PortalConsoleBuffer({ maxMessageChars: 50 });
    const entry = buffer.record({ level: "log", message: "x".repeat(5_000) });
    expect(entry.message).toHaveLength(50);
  });

  it("normalizes numeric and named levels", () => {
    expect(normalizePortalConsoleLevel(0)).toBe("log");
    expect(normalizePortalConsoleLevel(1)).toBe("info");
    expect(normalizePortalConsoleLevel(2)).toBe("warning");
    expect(normalizePortalConsoleLevel(3)).toBe("error");
    expect(normalizePortalConsoleLevel("warn")).toBe("warning");
    expect(normalizePortalConsoleLevel("Error")).toBe("error");
    expect(normalizePortalConsoleLevel("verbose")).toBe("debug");
    expect(normalizePortalConsoleLevel(undefined)).toBe("log");
  });

  it("sanitizes an unparsable source and an empty one", () => {
    expect(sanitizePortalSource("")).toBe("desconhecida");
    expect(sanitizePortalSource("chrome-extension://abc/x.js")).toBe("chrome-extension:");
    expect(sanitizePortalSource("inline script")).toBe("inline script");
  });

  it("clears everything when the Portal goes away", () => {
    const buffer = new PortalConsoleBuffer();
    buffer.record({ level: "log", message: "a" });
    buffer.clear();
    expect(buffer.size()).toBe(0);
    expect(buffer.query().entries).toHaveLength(0);
  });

  it("keeps ordinary messages readable", () => {
    expect(sanitizePortalConsoleMessage("  fixture   log  ")).toBe("fixture log");
  });
});
