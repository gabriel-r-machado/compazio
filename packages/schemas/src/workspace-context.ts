import { z } from "zod";

import {
  canvasAgentRoleSchema,
  canvasContextSourceKindSchema,
  canvasMissionSchema,
  edgeContractSchema
} from "./ipc/canvas";
import { contextInclusionSchema } from "./context-selection";

export const workspaceContextReferenceSchema = z
  .object({
    kind: canvasContextSourceKindSchema,
    url: z.string().url().max(2_048).optional(),
    filename: z.string().min(1).max(255).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mediaType: z.string().min(1).max(160).optional(),
    /** Inline image bytes already stored on the canvas node; never a filesystem path. */
    previewDataUri: z
      .string()
      .max(8_000_000)
      .regex(/^data:image\//)
      .optional()
  })
  .strict();

export const workspaceContextSourceSchema = z
  .object({
    nodeId: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    kind: z.enum(["note", "artifact", ...canvasContextSourceKindSchema.options]),
    content: z.string().max(100_000).optional(),
    artifact: z
      .object({
        id: z.string().uuid(),
        kind: z.string().min(1).max(64),
        relativePath: z.string().min(1).max(4_096),
        filename: z.string().min(1).max(255),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteSize: z
          .number()
          .int()
          .nonnegative()
          .max(20 * 1024 * 1024),
        mediaType: z.string().min(1).max(160)
      })
      .strict()
      .optional(),
    reference: workspaceContextReferenceSchema.optional(),
    inclusion: contextInclusionSchema.default("relevant"),
    edgeId: z.string().min(1).max(160),
    contract: edgeContractSchema
  })
  .strict()
  .superRefine((source, context) => {
    if (source.kind === "note" && source.content !== undefined && source.artifact === undefined) {
      return;
    }
    if (
      source.kind === "artifact" &&
      source.artifact !== undefined &&
      source.content === undefined &&
      source.reference === undefined
    ) {
      return;
    }
    if (
      source.kind !== "note" &&
      source.kind !== "artifact" &&
      source.artifact === undefined &&
      source.reference?.kind === source.kind
    ) {
      return;
    }
    {
      context.addIssue({
        code: "custom",
        message: "Context source payload does not match its declared kind"
      });
    }
  });

export const workspaceAgentContextSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    agentNodeId: z.string().min(1).max(160),
    mission: canvasMissionSchema,
    /**
     * The responsibility assigned to this agent on the canvas. Absent when the user has not given
     * the terminal a role — never substituted by a default, because inventing a responsibility is
     * how an agent ends up confidently doing the wrong job.
     */
    role: canvasAgentRoleSchema.optional(),
    /**
     * The structural permissions granted to this agent's canvas node. Carried here so a session can
     * be told what it is allowed to do — an orchestrator that is never told it can recruit will only
     * ever describe a team instead of building one. Mirrors `canvasNodeDataSchema.permissions`; the
     * Policy Engine remains the only thing that authorizes an action.
     */
    permissions: z.array(z.string().max(160)).max(32).default([]),
    sources: z.array(workspaceContextSourceSchema).max(1_000)
  })
  .strict();

export type WorkspaceContextSource = z.infer<typeof workspaceContextSourceSchema>;
export type WorkspaceAgentContext = z.infer<typeof workspaceAgentContextSchema>;
export type WorkspaceContextReference = z.infer<typeof workspaceContextReferenceSchema>;
