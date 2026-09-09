import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "./logger";
import { redactTerminalText, redactText, redactValue } from "./redact";

const markedSecret = "FORGEDECK_TEST_SECRET_do-not-log";

describe("logger redaction", () => {
  it("redacts sensitive keys and token patterns recursively", () => {
    const input = {
      authorization: "Bearer abc.def.ghi",
      nested: {
        apiKey: "sk_1234567890abcdef",
        message: `failed with ${markedSecret}`
      }
    };

    const output = JSON.stringify(redactValue(input));

    expect(output).not.toContain("abc.def.ghi");
    expect(output).not.toContain("1234567890abcdef");
    expect(output).not.toContain(markedSecret);
    expect(output).toContain("[REDACTED]");
  });

  it("redacts marked secrets surrounded by terminal control sequences", () => {
    const terminalText = `\u001b[2J\u001b[31m${markedSecret}\u001b[0m\u0007`;
    const output = redactText(terminalText);
    expect(output).toBe("[REDACTED]");
  });

  it("redacts terminal secrets without removing cursor and line-editing controls", () => {
    const terminalText = `\u001b[?25l\u001b[93mc\bco\u001b[6;58Hcod ${markedSecret}\u001b[?25h`;
    const output = redactTerminalText(terminalText);

    expect(output).not.toContain(markedSecret);
    expect(output).toContain("\u001b[?25l");
    expect(output).toContain("\bco");
    expect(output).toContain("\u001b[6;58Hcod");
  });

  it("redacts environment and structured secret assignments in plain output", () => {
    const output = redactText(
      'API_KEY=plain-value AWS_SECRET_ACCESS_KEY="aws-value" {"password":"json-value"}'
    );
    expect(output).not.toContain("plain-value");
    expect(output).not.toContain("aws-value");
    expect(output).not.toContain("json-value");
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("redacts message and context before writing a structured log", async () => {
    const destination = new PassThrough();
    destination.setEncoding("utf8");
    const chunks: string[] = [];
    destination.on("data", (chunk: string) => chunks.push(chunk));

    const logger = createLogger({ destination });
    logger.info(`request failed: ${markedSecret}`, { password: "plain-text-password" });
    await new Promise<void>((resolve) => destination.end(resolve));

    const output = chunks.join("");
    expect(output).not.toContain(markedSecret);
    expect(output).not.toContain("plain-text-password");
    expect(output).toContain("[REDACTED]");
  });
});
