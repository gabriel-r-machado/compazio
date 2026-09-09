import { describe, expect, it } from "vitest";

import { orchestratorPlanSchema } from "@forgedeck/schemas";

import {
  describeAnswerEnvelope,
  describeSchemaIssues,
  describeShape,
  formatAnswerDiagnostics
} from "./structured-answer-diagnostics";

/**
 * The diagnostic exists to explain a rejected answer without repeating any of it. These tests are mostly
 * about what must NOT appear: values, prompts, credentials, paths.
 */

const SECRET = "sk-live-DO-NOT-LEAK-0123456789";
const PROMPT = "Implement Supabase auth and do exactly what I say.";

describe("describeShape", () => {
  it("reduces primitives to type names, never values", () => {
    const shape = describeShape({
      title: "Some title nobody should read",
      count: 42,
      enabled: true,
      missing: null,
      absent: undefined
    });
    expect(shape).toEqual({
      type: "object",
      keys: {
        title: "string",
        count: "number",
        enabled: "boolean",
        missing: "null",
        absent: "undefined"
      }
    });
    const rendered = JSON.stringify(shape);
    expect(rendered).not.toContain("Some title");
    expect(rendered).not.toContain("42");
  });

  it("hides sensitive keys and never describes their contents", () => {
    const shape = describeShape({
      prompt: PROMPT,
      apiKey: SECRET,
      authorization: `Bearer ${SECRET}`,
      cookie: "session=abc",
      credentials: { password: "hunter2" },
      adapter: "claude-code"
    });
    const rendered = JSON.stringify(shape);
    expect(rendered).not.toContain("prompt");
    expect(rendered).not.toContain("apiKey");
    expect(rendered).not.toContain("authorization");
    expect(rendered).not.toContain("cookie");
    expect(rendered).not.toContain("credentials");
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(PROMPT);
    expect(rendered).not.toContain("hunter2");
    expect(rendered).toContain("[REDACTED_KEY]");
    expect(rendered).toContain("adapter");
  });

  it("keeps distinct entries when several keys are redacted", () => {
    const shape = describeShape({ prompt: "a", token: "b", secret: "c" });
    if (typeof shape === "string" || shape.type !== "object") throw new Error("expected an object");
    expect(Object.keys(shape.keys)).toHaveLength(3);
    expect(Object.values(shape.keys)).toEqual(["[REDACTED]", "[REDACTED]", "[REDACTED]"]);
  });

  it("reports array length and at most three item shapes", () => {
    const shape = describeShape({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]
    });
    if (typeof shape === "string" || shape.type !== "object") throw new Error("expected an object");
    const nodes = shape.keys["nodes"];
    if (typeof nodes === "string" || nodes?.type !== "array") throw new Error("expected an array");
    expect(nodes.length).toBe(5);
    expect(nodes.itemShapes).toHaveLength(3);
  });

  it("caps the number of described keys and counts the rest", () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 45; index += 1) wide[`field${String(index)}`] = "value";
    const shape = describeShape(wide);
    if (typeof shape === "string" || shape.type !== "object") throw new Error("expected an object");
    expect(Object.keys(shape.keys)).toHaveLength(30);
    expect(shape.omittedKeys).toBe(15);
  });

  it("stops at the maximum depth instead of walking forever", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const rendered = JSON.stringify(describeShape(deep));
    expect(rendered).toContain("[MAX_DEPTH]");
    expect(rendered).not.toContain("too deep");
  });

  it("does not mutate the value it describes", () => {
    const answer = { title: "t", nodes: [{ id: "a", prompt: PROMPT }] };
    const before = JSON.stringify(answer);
    describeShape(answer);
    expect(JSON.stringify(answer)).toBe(before);
  });
});

describe("describeAnswerEnvelope", () => {
  it("recognizes a pure JSON answer", () => {
    const envelope = describeAnswerEnvelope('{"title":"x","nodes":[]}');
    expect(envelope.pureJson).toBe(true);
    expect(envelope.markdownFence).toBe(false);
    expect(envelope.textBeforeJson).toBe(false);
    expect(envelope.textAfterJson).toBe(false);
    expect(envelope.jsonParsed).toBe(true);
    expect(envelope.rootKeys).toEqual(["title", "nodes"]);
  });

  it("detects a markdown fence and surrounding prose without repeating either", () => {
    const raw = `Here is the plan:\n\`\`\`json\n{"title":"x"}\n\`\`\`\nHope it helps!`;
    const envelope = describeAnswerEnvelope(raw);
    expect(envelope.markdownFence).toBe(true);
    expect(envelope.textBeforeJson).toBe(true);
    expect(envelope.textAfterJson).toBe(true);
    expect(envelope.pureJson).toBe(false);
    expect(envelope.jsonParsed).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("Hope it helps");
    expect(envelope.characters).toBe(raw.length);
  });

  it("reports malformed JSON without echoing the raw answer", () => {
    const raw = `{ "title": "x", nodes: [ } ${SECRET}`;
    const envelope = describeAnswerEnvelope(raw);
    expect(envelope.jsonParsed).toBe(false);
    expect(envelope.rootKeys).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
  });

  it("redacts a sensitive root key", () => {
    const envelope = describeAnswerEnvelope(`{"prompt":"${PROMPT}","title":"x"}`);
    expect(envelope.rootKeys).toEqual(["[REDACTED_KEY]", "title"]);
    expect(JSON.stringify(envelope)).not.toContain(PROMPT);
  });

  it("handles an answer with no JSON at all", () => {
    const envelope = describeAnswerEnvelope("I would start by refactoring auth.");
    expect(envelope.jsonParsed).toBe(false);
    expect(envelope.pureJson).toBe(false);
    expect(envelope.rootKeys).toEqual([]);
  });
});

describe("describeSchemaIssues", () => {
  function validPlan(node: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: "Auth",
      summary: "Implement auth.",
      nodes: [
        {
          id: "impl",
          title: "Implement",
          role: "implementer",
          adapter: "claude-code",
          prompt: "Do the thing.",
          ...node
        }
      ]
    };
  }

  it("reports the real field path for a nested issue", () => {
    const result = orchestratorPlanSchema.safeParse(
      validPlan({ adapter: { name: "claude-code" } })
    );
    if (result.success) throw new Error("expected a failure");
    const issues = describeSchemaIssues(result.error.issues);
    const adapter = issues.find((issue) => issue.path === "nodes.0.adapter");
    expect(adapter).toBeDefined();
    expect(adapter?.code).toBe("invalid_type");
    expect(JSON.stringify(issues)).not.toContain("claude-code");
  });

  it("names the root as <root> when the path is empty", () => {
    const result = orchestratorPlanSchema.safeParse("not an object");
    if (result.success) throw new Error("expected a failure");
    const issues = describeSchemaIssues(result.error.issues);
    expect(issues[0]?.path).toBe("<root>");
  });

  it("names a missing required field by path", () => {
    const plan = validPlan({ role: undefined });
    delete plan["summary"];
    const result = orchestratorPlanSchema.safeParse(plan);
    if (result.success) throw new Error("expected a failure");
    const paths = describeSchemaIssues(result.error.issues).map((issue) => issue.path);
    expect(paths).toContain("summary");
    expect(paths).toContain("nodes.0.role");
  });

  it("strips a path out of a custom message and bounds its length", () => {
    const issues = describeSchemaIssues([
      {
        code: "custom",
        path: ["nodes", 0],
        message: "Bad file C:\\Users\\developer\\secret\\notes.md"
      },
      { code: "custom", path: [], message: `Long ${"x".repeat(400)}` }
    ]);
    expect(issues[0]?.message).toContain("[path]");
    expect(issues[0]?.message).not.toContain("developer");
    expect((issues[1]?.message ?? "").length).toBeLessThanOrEqual(201);
  });

  it("tolerates an issue object with nothing usable", () => {
    const issues = describeSchemaIssues([{}]);
    expect(issues[0]).toMatchObject({ index: 1, code: "unknown", path: "<root>", message: "" });
  });
});

describe("formatAnswerDiagnostics", () => {
  it("renders envelope, issues and shape without any value", () => {
    const answer = {
      title: "A title",
      prompt: PROMPT,
      nodes: [{ id: "a", adapter: { nested: SECRET } }]
    };
    const lines = formatAnswerDiagnostics({
      envelope: describeAnswerEnvelope(JSON.stringify(answer)),
      issues: describeSchemaIssues([
        { code: "invalid_type", path: ["nodes", 0, "adapter"], message: "Expected string" }
      ]),
      shape: describeShape(answer),
      schemaValidated: false
    });
    const text = lines.join("\n");
    expect(text).toContain("path: nodes.0.adapter");
    expect(text).toContain("schema validated: false");
    expect(text).toContain("Answer shape (types only, no values):");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain("A title");
  });

  it("omits the shape section when no parsed answer exists", () => {
    const lines = formatAnswerDiagnostics({
      envelope: describeAnswerEnvelope("not json"),
      issues: [],
      shape: null,
      schemaValidated: false
    });
    expect(lines.join("\n")).not.toContain("Answer shape");
  });
});
