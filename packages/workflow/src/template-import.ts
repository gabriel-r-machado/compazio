import { z } from "zod";

import { permissionMapSchema, workflowSchema } from "./contracts";
import { permissionsAreSubset, validateWorkflowDag } from "./dag";

const templateIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(160);
const templateItemIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(160);

const templateQuestionSchema = z
  .object({
    id: templateItemIdSchema,
    prompt: z.string().trim().min(1).max(2_000),
    required: z.boolean(),
    answer_type: z.enum(["text", "single_select", "multi_select", "boolean"]),
    options: z.array(z.string().trim().min(1).max(240)).max(50)
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.answer_type === "single_select" || value.answer_type === "multi_select") &&
      value.options.length === 0
    ) {
      context.addIssue({ code: "custom", message: "Select questions require options" });
    }
    if (
      (value.answer_type === "text" || value.answer_type === "boolean") &&
      value.options.length > 0
    ) {
      context.addIssue({ code: "custom", message: "Only select questions can define options" });
    }
  });

const templateMaterialSchema = z
  .object({
    id: templateItemIdSchema,
    label: z.string().trim().min(1).max(240),
    kind: z.enum(["context", "artifact", "contract", "reference"]),
    description: z.string().trim().min(1).max(2_000).optional()
  })
  .strict();

const templateAgentSchema = z
  .object({
    id: templateItemIdSchema,
    role: z.string().trim().min(1).max(160),
    required: z.boolean()
  })
  .strict();

const templateContractSchema = z
  .object({
    id: templateItemIdSchema,
    name: z.string().trim().min(1).max(160),
    inputs: z.array(z.string().trim().min(1).max(240)).max(100),
    outputs: z.array(z.string().trim().min(1).max(240)).max(100),
    criteria: z.array(z.string().trim().min(1).max(1_000)).max(100),
    evidence: z.array(z.string().trim().min(1).max(1_000)).max(100)
  })
  .strict();

const templateGateSchema = z
  .object({
    id: templateItemIdSchema,
    preset: z.enum(["lint", "typecheck", "test", "build", "playwright"]),
    required: z.boolean()
  })
  .strict();

export const workflowTemplateDocumentSchema = z
  .object({
    format_version: z.literal("1.1"),
    id: templateIdSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2_000).optional(),
    questionnaire: z.array(templateQuestionSchema).max(100),
    materials: z
      .object({
        required: z.array(templateMaterialSchema).max(100),
        optional: z.array(templateMaterialSchema).max(100)
      })
      .strict(),
    agents: z.array(templateAgentSchema).max(100),
    contracts: z.array(templateContractSchema).max(100),
    gates: z.array(templateGateSchema).max(100),
    permissions: permissionMapSchema,
    workflow: workflowSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.id !== value.workflow.id) {
      context.addIssue({
        code: "custom",
        path: ["workflow", "id"],
        message: "Template and workflow ids must match"
      });
    }
    for (const [label, values] of [
      ["questionnaire", value.questionnaire],
      ["agents", value.agents],
      ["contracts", value.contracts],
      ["gates", value.gates],
      ["required materials", value.materials.required],
      ["optional materials", value.materials.optional]
    ] as const) {
      const ids = values.map((candidate) => candidate.id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", message: `Duplicate ${label} id` });
      }
    }
    const materialIds = [...value.materials.required, ...value.materials.optional].map(
      (material) => material.id
    );
    if (new Set(materialIds).size !== materialIds.length) {
      context.addIssue({
        code: "custom",
        path: ["materials"],
        message: "Material ids must be unique"
      });
    }
  });

export const workflowTemplateImportPreviewSchema = z
  .object({
    source_format_version: z.enum(["1.0", "1.1"]),
    document: workflowTemplateDocumentSchema,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    warnings: z.array(z.string().max(500)).max(100)
  })
  .strict();

export type WorkflowTemplateDocument = z.infer<typeof workflowTemplateDocumentSchema>;
export type WorkflowTemplateImportPreview = z.infer<typeof workflowTemplateImportPreviewSchema>;

/**
 * Validates and migrates an untrusted template document for inspection only. This function never
 * writes, registers or executes a workflow. It also rejects commands, executables, paths, SQL and
 * secret-shaped fields before accepting the current strict format.
 */
export async function previewWorkflowTemplateImport(
  input: unknown
): Promise<WorkflowTemplateImportPreview> {
  assertSanitizedImport(input);
  const source = record(input, "Template import must be an object");
  const sourceVersion = source.format_version;
  if (sourceVersion !== "1.0" && sourceVersion !== "1.1") {
    throw new Error("Workflow template format version is unsupported");
  }
  const migrated = sourceVersion === "1.0" ? migrateTemplateV1(source) : withoutChecksum(source);
  const document = workflowTemplateDocumentSchema.parse(migrated);
  if (!permissionsAreSubset(document.workflow.permissions, document.permissions)) {
    throw new Error("Workflow template permissions exceed the declared template permissions");
  }
  const validation = validateWorkflowDag(document.workflow, document.permissions);
  if (!validation.valid) {
    throw new Error(
      `Workflow template is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const checksum = await workflowTemplateChecksum(document);
  if (sourceVersion === "1.1" && source.checksum !== undefined && source.checksum !== checksum) {
    throw new Error("Workflow template checksum does not match the sanitized document");
  }
  return workflowTemplateImportPreviewSchema.parse({
    source_format_version: sourceVersion,
    document,
    checksum,
    warnings:
      sourceVersion === "1.0"
        ? ["Template format 1.0 was migrated locally to 1.1 for preview."]
        : []
  });
}

/** Returns the stable checksum of the sanitized current document, excluding any supplied checksum. */
export async function workflowTemplateChecksum(
  document: WorkflowTemplateDocument
): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(document));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function migrateTemplateV1(source: Record<string, unknown>): Record<string, unknown> {
  const workflow = source.workflow;
  const id =
    typeof source.id === "string"
      ? source.id
      : record(workflow, "Template workflow is required").id;
  return {
    format_version: "1.1",
    id,
    name: source.name,
    ...(source.description === undefined ? {} : { description: source.description }),
    questionnaire: normalizeQuestions(source.questionnaire ?? source.questions),
    materials: normalizeMaterials(source),
    agents: source.agents ?? [],
    contracts: source.contracts ?? [],
    gates: source.gates ?? [],
    permissions:
      source.permissions ?? record(workflow, "Template workflow is required").permissions,
    workflow
  };
}

function normalizeQuestions(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return value as unknown[];
  return value.map((question, index) =>
    typeof question === "string"
      ? {
          id: `question-${index + 1}`,
          prompt: question,
          required: true,
          answer_type: "text",
          options: []
        }
      : question
  );
}

function normalizeMaterials(source: Record<string, unknown>): Record<string, unknown> {
  const materials = source.materials;
  if (isRecord(materials) && "required" in materials && "optional" in materials) {
    return {
      required: normalizeMaterialList(materials.required, "required"),
      optional: normalizeMaterialList(materials.optional, "optional")
    };
  }
  return {
    required: normalizeMaterialList(
      source.required_materials ?? source.requiredMaterials,
      "required"
    ),
    optional: normalizeMaterialList(
      source.optional_materials ?? source.optionalMaterials,
      "optional"
    )
  };
}

function normalizeMaterialList(value: unknown, prefix: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return value as unknown[];
  return value.map((material, index) =>
    typeof material === "string"
      ? { id: `${prefix}-${index + 1}`, label: material, kind: "context" }
      : material
  );
}

function withoutChecksum(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => key !== "checksum"));
}

function assertSanitizedImport(value: unknown, path = "template", depth = 0): void {
  if (depth > 20) throw new Error("Workflow template is too deeply nested");
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Workflow template has too many entries");
    value.forEach((entry, index) => assertSanitizedImport(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "string") {
    if (value.length > 20_000) throw new Error("Workflow template text is too long");
    if (isPersonalPath(value) || /(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}/.test(value)) {
      throw new Error("Workflow template contains a personal path or secret-shaped value");
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /^(command|executable|args|cwd|path|sql|secret|token|password|credential|api[_-]?key)$/i.test(
        key
      )
    ) {
      throw new Error(`Workflow template field is not allowed: ${key}`);
    }
    assertSanitizedImport(entry, `${path}.${key}`, depth + 1);
  }
}

function isPersonalPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|file:)/i.test(value.trim());
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
