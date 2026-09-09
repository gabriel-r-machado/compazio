import { describe, expect, it } from "vitest";

import { exportCompassoPackage, previewCompassoPackageImport } from "./compasso-package";

function snapshot() {
  return {
    id: "canvas-1",
    title: "Private workspace",
    mission: "Do not export this private mission",
    revision: 7,
    viewport: { x: 12, y: 24, zoom: 1.2 },
    nodes: [
      {
        id: "agent",
        type: "agent",
        position: { x: 0, y: 0 },
        data: {
          title: "secret name",
          state: "running",
          summary: "secret summary",
          adapterId: "codex",
          permissions: ["execute_tasks"]
        }
      },
      {
        id: "note",
        type: "note",
        position: { x: 300, y: 0 },
        data: {
          title: "Do not keep",
          state: "idle",
          summary: "C:\\Users\\person\\private.txt",
          content: "sk-not-a-real-key",
          permissions: []
        }
      },
      {
        id: "shape",
        type: "shape",
        position: { x: 600, y: 0 },
        data: {
          title: "Decorative",
          state: "idle",
          summary: "",
          shape: { kind: "rectangle" },
          permissions: []
        }
      }
    ],
    edges: [
      {
        id: "agent-note",
        source: "agent",
        target: "note",
        contract: {
          schemaVersion: "1.0",
          kind: "context",
          label: "secret label",
          requiredEvidenceTypes: []
        }
      },
      {
        id: "agent-shape",
        source: "agent",
        target: "shape",
        contract: {
          schemaVersion: "1.0",
          kind: "dependency",
          label: "safe structurally",
          requiredEvidenceTypes: []
        }
      }
    ]
  };
}

describe("Compasso package preview", () => {
  it("exports a sanitized inert workspace flow with a stable checksum", async () => {
    const packageDocument = await exportCompassoPackage({
      format_version: "1.0",
      kind: "workspace",
      workspace: { title: "Private workspace", snapshot: snapshot() }
    });
    const flow = packageDocument.workspace?.flow;

    expect(packageDocument.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(flow?.nodes.map((node) => node.id)).toEqual(["agent", "shape"]);
    expect(flow?.edges.map((edge) => edge.id)).toEqual(["agent-shape"]);
    expect(JSON.stringify(packageDocument)).not.toContain("C:\\Users");
    expect(JSON.stringify(packageDocument)).not.toContain("sk-not-a-real-key");
    expect(JSON.stringify(packageDocument)).not.toContain("secret name");
  });

  it("verifies the package checksum and remains preview-only", async () => {
    const exported = await exportCompassoPackage({
      format_version: "1.0",
      kind: "flow",
      flow: snapshot()
    });
    const preview = await previewCompassoPackageImport(exported);

    expect(preview.package).toEqual(exported);
    expect(preview.warnings[0]).toContain("inert");
    await expect(
      previewCompassoPackageImport({ ...exported, checksum: "0".repeat(64) })
    ).rejects.toThrow("checksum does not match");
  });

  it("exports templates through the same sanitized format", async () => {
    const packageDocument = await exportCompassoPackage({
      format_version: "1.0",
      kind: "template",
      template: templateDocument()
    });

    expect(packageDocument.template).toMatchObject({
      id: "safe-review",
      workflow: { id: "safe-review" }
    });
  });

  it("rejects unrecognized package fields instead of trusting them", async () => {
    await expect(
      exportCompassoPackage({
        format_version: "1.0",
        kind: "flow",
        flow: snapshot(),
        command: "pnpm test"
      })
    ).rejects.toThrow("field is not allowed");
  });
});

function templateDocument() {
  return {
    format_version: "1.1",
    id: "safe-review",
    name: "Safe review",
    questionnaire: [],
    materials: { required: [], optional: [] },
    agents: [],
    contracts: [],
    gates: [],
    permissions: {},
    workflow: {
      schema_version: "1.0",
      id: "safe-review",
      name: "Safe review",
      concurrency: 1,
      permissions: {},
      nodes: [{ id: "report", type: "artifact", permissions: {} }]
    }
  };
}
