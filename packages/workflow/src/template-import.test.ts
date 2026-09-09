import { describe, expect, it } from "vitest";

import { previewWorkflowTemplateImport, workflowTemplateChecksum } from "./template-import";

function template() {
  return {
    format_version: "1.1",
    id: "safe-review",
    name: "Safe review",
    questionnaire: [
      {
        id: "goal",
        prompt: "What should be reviewed?",
        required: true,
        answer_type: "text",
        options: []
      }
    ],
    materials: {
      required: [{ id: "brief", label: "Approved brief", kind: "context" }],
      optional: []
    },
    agents: [{ id: "reviewer", role: "review", required: true }],
    contracts: [
      {
        id: "delivery",
        name: "Review delivery",
        inputs: ["Approved brief"],
        outputs: ["Review report"],
        criteria: ["Covers the requested scope"],
        evidence: ["Written report"]
      }
    ],
    gates: [{ id: "tests", preset: "test", required: true }],
    permissions: { process: true },
    workflow: {
      schema_version: "1.0",
      id: "safe-review",
      name: "Safe review",
      concurrency: 1,
      permissions: { process: true },
      nodes: [
        { id: "review", type: "agent", permissions: { process: true } },
        { id: "report", type: "artifact", depends_on: ["review"], permissions: {} }
      ]
    }
  };
}

describe("workflow template import preview", () => {
  it("produces a stable sanitized current document and checksum without executing it", async () => {
    const preview = await previewWorkflowTemplateImport(template());

    expect(preview).toMatchObject({
      source_format_version: "1.1",
      document: { id: "safe-review", workflow: { id: "safe-review" } },
      warnings: []
    });
    expect(preview.checksum).toBe(await workflowTemplateChecksum(preview.document));
    expect(preview.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("migrates the bounded legacy format for preview", async () => {
    const legacy = template() as Record<string, unknown>;
    legacy.format_version = "1.0";
    legacy.questions = ["What should be reviewed?"];
    delete legacy.questionnaire;
    legacy.requiredMaterials = ["Approved brief"];
    delete legacy.materials;

    const preview = await previewWorkflowTemplateImport(legacy);

    expect(preview.source_format_version).toBe("1.0");
    expect(preview.document.questionnaire[0]).toMatchObject({
      id: "question-1",
      answer_type: "text"
    });
    expect(preview.document.materials.required[0]).toMatchObject({ id: "required-1" });
    expect(preview.warnings).toHaveLength(1);
  });

  it("verifies a supplied current-format checksum", async () => {
    const input = template() as Record<string, unknown>;
    input.checksum = "0".repeat(64);

    await expect(previewWorkflowTemplateImport(input)).rejects.toThrow("checksum does not match");
  });

  it.each([
    ["command", { executable: "pnpm", args: ["test"] }],
    ["path", "C:\\Users\\person\\secret.txt"],
    ["apiKey", "sk-not-a-real-key"],
    ["workflow permissions", { process: true, workspace_write: true }]
  ])("rejects unsafe imported template %s", async (field, value) => {
    const input = template() as Record<string, unknown>;
    if (field === "workflow permissions") {
      (input.workflow as { permissions: unknown }).permissions = value;
    } else {
      input[field] = value;
    }

    await expect(previewWorkflowTemplateImport(input)).rejects.toThrow();
  });
});
