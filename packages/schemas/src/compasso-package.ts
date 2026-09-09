import { z } from "zod";

import { previewWorkflowTemplateImport, workflowTemplateDocumentSchema } from "@forgedeck/workflow";

import { canvasSnapshotSchema } from "./ipc/canvas";

const packageKindSchema = z.enum(["template", "workspace", "flow", "fragment"]);
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);

const workspacePackageSchema = z
  .object({
    title: z.string().min(1).max(160),
    flow: canvasSnapshotSchema
  })
  .strict();

export const compassoPackageSchema = z
  .object({
    format_version: z.literal("1.0"),
    kind: packageKindSchema,
    template: workflowTemplateDocumentSchema.optional(),
    workspace: workspacePackageSchema.optional(),
    flow: canvasSnapshotSchema.optional(),
    checksum: checksumSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "template" && value.template === undefined) {
      context.addIssue({ code: "custom", message: "Template packages require a template" });
    }
    if (value.kind === "workspace" && value.workspace === undefined) {
      context.addIssue({ code: "custom", message: "Workspace packages require a workspace" });
    }
    if ((value.kind === "flow" || value.kind === "fragment") && value.flow === undefined) {
      context.addIssue({ code: "custom", message: "Flow packages require a flow" });
    }
  });

export const compassoPackagePreviewSchema = z
  .object({
    package: compassoPackageSchema,
    warnings: z.array(z.string().max(500)).max(100)
  })
  .strict();

export type CompassoPackage = z.infer<typeof compassoPackageSchema>;
export type CompassoPackagePreview = z.infer<typeof compassoPackagePreviewSchema>;

/**
 * Creates an inert `.compasso` package. Canvas terminal sessions, artifact paths, free-form
 * content and contextual bytes are intentionally omitted; this function neither writes nor runs.
 */
export async function exportCompassoPackage(input: unknown): Promise<CompassoPackage> {
  const source = packageRecord(input);
  assertPackageKeys(source);
  if (source.format_version !== "1.0") throw new Error("Compasso package format is unsupported");
  const kind = packageKindSchema.parse(source.kind);
  const draft = await sanitizePackage(kind, source);
  return compassoPackageSchema.parse({
    ...draft,
    checksum: await compassoPackageChecksum(draft)
  });
}

/** Validates a package from an untrusted source and returns only its inert sanitized preview. */
export async function previewCompassoPackageImport(
  input: unknown
): Promise<CompassoPackagePreview> {
  const source = packageRecord(input);
  assertPackageKeys(source);
  const suppliedChecksum = source.checksum;
  const value = await exportCompassoPackage(withoutChecksum(source));
  if (suppliedChecksum !== undefined && suppliedChecksum !== value.checksum) {
    throw new Error("Compasso package checksum does not match the sanitized package");
  }
  return compassoPackagePreviewSchema.parse({
    package: value,
    warnings: ["Package preview is inert and must be explicitly applied in a later action."]
  });
}

export async function compassoPackageChecksum(
  value: Omit<CompassoPackage, "checksum">
): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function sanitizePackage(
  kind: z.infer<typeof packageKindSchema>,
  source: Record<string, unknown>
): Promise<Omit<CompassoPackage, "checksum">> {
  if (kind === "template") {
    return {
      format_version: "1.0",
      kind,
      template: (await previewWorkflowTemplateImport(source.template)).document
    };
  }
  if (kind === "workspace") {
    const workspace = packageRecord(source.workspace, "Workspace package requires a workspace");
    assertExactKeys(workspace, ["title", "snapshot", "flow"], "workspace");
    const snapshot = workspace.snapshot ?? workspace.flow;
    return {
      format_version: "1.0",
      kind,
      workspace: {
        title: "Imported workspace",
        flow: sanitizeCanvasFlow(snapshot, "Imported workspace flow")
      }
    };
  }
  return {
    format_version: "1.0",
    kind,
    flow: sanitizeCanvasFlow(source.flow ?? source.fragment, `Imported ${kind}`)
  };
}

function sanitizeCanvasFlow(value: unknown, title: string) {
  const snapshot = canvasSnapshotSchema.parse(value);
  const allowedTypes = new Set(["agent", "task", "gate", "shape", "frame", "comment"]);
  const nodes = snapshot.nodes
    .filter((node) => allowedTypes.has(node.type))
    .map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      ...(node.width === undefined ? {} : { width: node.width }),
      ...(node.height === undefined ? {} : { height: node.height }),
      ...(node.zIndex === undefined ? {} : { zIndex: node.zIndex }),
      data: {
        title: `Imported ${node.type}`,
        state: "idle" as const,
        summary: "",
        retryMaxAttempts: 1,
        permissions: [],
        ...(node.type === "shape" && node.data.shape !== undefined
          ? { shape: node.data.shape }
          : {}),
        ...(node.type === "frame" && node.data.frame !== undefined
          ? {
              frame: {
                memberNodeIds: node.data.frame.memberNodeIds.filter((member) =>
                  snapshot.nodes.some(
                    (candidate) => candidate.id === member && allowedTypes.has(candidate.type)
                  )
                )
              }
            }
          : {})
      }
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return canvasSnapshotSchema.parse({
    id: "compasso-flow",
    title,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: snapshot.edges
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        contract: {
          schemaVersion: "1.0",
          kind: edge.contract.kind,
          label: "",
          requiredEvidenceTypes: []
        }
      }))
  });
}

function packageRecord(value: unknown, message = "Compasso package must be an object") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertPackageKeys(value: Record<string, unknown>): void {
  assertExactKeys(
    value,
    ["format_version", "kind", "template", "workspace", "flow", "fragment", "checksum"],
    "package"
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Compasso ${label} field is not allowed: ${key}`);
  }
}

function withoutChecksum(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "checksum"));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
