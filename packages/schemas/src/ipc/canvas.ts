import { z } from "zod";

import { agentAdapterIdSchema } from "../agent-capability";
import { contextInclusionSchema } from "../context-selection";
import {
  canvasNodeLifecycleSchema,
  creationModeSchema,
  DEFAULT_CREATION_MODE,
  DEFAULT_EXECUTION_PROFILE,
  executionProfileSchema,
  workflowNodeLockSchema
} from "../workflow-mode";

export const CANVAS_LOAD_CHANNEL = "canvas:load" as const;
export const CANVAS_SAVE_CHANNEL = "canvas:save" as const;

export const canvasMissionSchema = z.string().max(20_000);

export const canvasNodeTypeSchema = z.enum([
  "terminal",
  "agent",
  "note",
  "artifact",
  "text",
  "link",
  "file",
  "folder",
  "image",
  "drawing",
  "page",
  "shape",
  "frame",
  "comment",
  "task",
  "gate"
]);
export const canvasContextSourceKindSchema = z.enum([
  "text",
  "link",
  "file",
  "folder",
  "image",
  "drawing",
  "page"
]);
export const canvasNodeStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "disconnected"
]);

export const canvasPositionSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();

export const canvasAgentRoleSchema = z
  .object({
    name: z.string().min(1).max(80),
    responsibilities: z.string().max(4_000),
    constraints: z.string().max(2_000),
    expectedDeliverable: z.string().max(2_000),
    completionCriteria: z.string().max(2_000)
  })
  .strict();

/** Immutable metadata exposed by an artifact node; it never contains file contents. */
export const canvasArtifactReferenceSchema = z
  .object({
    artifactId: z.string().uuid(),
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
  .strict();

/**
 * A context source is intentionally metadata-first. Local file and folder locations are never
 * stored in canvas data or crossed through IPC; later import services resolve managed bytes behind
 * the node.
 */
/**
 * Managed attachment bytes are never stored as a filesystem path. Image previews are kept as an
 * inline `data:` URI so a local-first canvas can render the picture without re-reading disk, and a
 * SHA-256 checksum plus the original file name keep the reference auditable.
 */
export const canvasContextSourceSchema = z
  .object({
    kind: canvasContextSourceKindSchema,
    content: z.string().max(100_000).optional(),
    url: z.string().url().max(2_048).optional(),
    filename: z.string().min(1).max(255).optional(),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(25 * 1024 * 1024)
      .optional(),
    previewDataUri: z
      .string()
      .max(8_000_000)
      .regex(/^data:image\//)
      .optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mediaType: z.string().min(1).max(160).optional()
  })
  .strict()
  .superRefine((source, context) => {
    if (["text", "drawing", "page"].includes(source.kind) && source.content === undefined) {
      context.addIssue({
        code: "custom",
        message: `${source.kind} context sources require content`
      });
    }
    if (source.previewDataUri !== undefined && source.kind !== "image") {
      context.addIssue({
        code: "custom",
        message: "Only image context sources can hold an inline preview"
      });
    }
    // A link source may be empty (no URL yet), just like an image or file source can be attached
    // later. Only validate the URL once one is actually present.
    if (source.kind !== "link" || source.url === undefined) return;
    const parsed = new URL(source.url);
    // Query strings and fragments are allowed so ordinary references (docs anchors, video ids)
    // work; only insecure schemes and embedded credentials are rejected.
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      context.addIssue({
        code: "custom",
        message: "Link context sources must use a credential-free HTTPS URL"
      });
    }
  });

export const canvasShapeSchema = z
  .object({
    kind: z.enum(["rectangle", "ellipse", "diamond"])
  })
  .strict();

export const canvasFrameSchema = z
  .object({
    memberNodeIds: z.array(z.string().min(1).max(160)).max(1_000).default([])
  })
  .strict();

/** The three facts a card shows about its agent, and nothing more. */
export const agentNodeBadgeSchema = z
  .object({
    assignedAdapter: agentAdapterIdSchema.nullable(),
    displayName: z.string().trim().max(160).default(""),
    available: z.boolean().default(false),
    /** True when the node cannot start until someone picks an agent. */
    needsSelection: z.boolean().default(false)
  })
  .strict();
export type AgentNodeBadge = z.infer<typeof agentNodeBadgeSchema>;

export const canvasNodeDataSchema = z
  .object({
    title: z.string().min(1).max(160),
    state: canvasNodeStateSchema,
    summary: z.string().max(2_000).default(""),
    content: z.string().max(100_000).optional(),
    artifact: canvasArtifactReferenceSchema.optional(),
    contextSource: canvasContextSourceSchema.optional(),
    contextInclusion: contextInclusionSchema.optional(),
    shape: canvasShapeSchema.optional(),
    frame: canvasFrameSchema.optional(),
    adapterId: z.string().max(160).optional(),
    role: canvasAgentRoleSchema.optional(),
    workflowNodeId: z.string().max(160).optional(),
    /**
     * Composer lifecycle for a node projected from a WorkflowDraft. `draft`/`configured` render as
     * ghost nodes with no active terminal session. Optional so ordinary canvas nodes are unaffected;
     * the draft store — not the canvas — is the source of truth for draft nodes.
     */
    lifecycle: canvasNodeLifecycleSchema.optional(),
    /** Set when a user locks fields on a projected draft node so the orchestrator cannot overwrite them. */
    lock: workflowNodeLockSchema.optional(),
    /**
     * Display-only badge for a projected draft node: which agent will run it and whether that agent is
     * usable right now. Optional, and never set for an ordinary canvas node. The draft owns the
     * choice and the live catalog owns availability — this only carries them to the card, so the card
     * stays clean and the full selector lives in the inspector.
     */
    agentBadge: agentNodeBadgeSchema.optional(),
    retryMaxAttempts: z.number().int().min(1).max(10).default(1),
    progressPercent: z.number().int().min(0).max(100).optional(),
    blocker: z.string().min(1).max(500).optional(),
    permissions: z.array(z.string().max(160)).max(32).default([])
  })
  .strict();

export const canvasNodeSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: canvasNodeTypeSchema,
    position: canvasPositionSchema,
    width: z.number().finite().min(120).max(1_200).optional(),
    height: z.number().finite().min(60).max(1_200).optional(),
    zIndex: z.number().int().min(-100).max(100).optional(),
    data: canvasNodeDataSchema
  })
  .strict();

export const edgeContractSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    kind: z.enum(["context", "dependency", "handoff", "artifact", "approval"]),
    label: z.string().max(160).default(""),
    requiredEvidenceTypes: z
      .array(z.enum(["exit_code", "artifact", "approval", "test", "output"]))
      .max(16)
      .default([]),
    handoffMode: z.enum(["manual", "after-success"]).optional(),
    sourceDeliverable: z.string().max(4_000).optional(),
    targetInstruction: z.string().max(4_000).optional()
  })
  .strict();

export const canvasEdgeSchema = z
  .object({
    id: z.string().min(1).max(160),
    source: z.string().min(1).max(160),
    target: z.string().min(1).max(160),
    contract: edgeContractSchema
  })
  .strict();

export const canvasViewportSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().min(0.05).max(4)
  })
  .strict();

export const canvasSnapshotSchema = z
  .object({
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    mission: canvasMissionSchema.optional(),
    revision: z.number().int().nonnegative(),
    viewport: canvasViewportSchema,
    /** Header controls, persisted per canvas. Independent and valid in any combination. */
    creationMode: creationModeSchema.default(DEFAULT_CREATION_MODE),
    executionProfile: executionProfileSchema.default(DEFAULT_EXECUTION_PROFILE),
    nodes: z.array(canvasNodeSchema).max(1_000),
    edges: z.array(canvasEdgeSchema).max(2_000)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    for (const edge of snapshot.edges) {
      if (edge.source === edge.target) {
        context.addIssue({ code: "custom", message: `Self edge is not allowed: ${edge.id}` });
      }
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({ code: "custom", message: `Edge ${edge.id} references a missing node` });
      }
    }
    for (const node of snapshot.nodes) {
      const isContextSource = canvasContextSourceKindSchema.options.includes(
        node.type as (typeof canvasContextSourceKindSchema.options)[number]
      );
      if (isContextSource && node.data.contextSource === undefined) {
        context.addIssue({
          code: "custom",
          message: `Context source node ${node.id} is missing source metadata`,
          path: ["nodes"]
        });
      }
      if (isContextSource && node.data.contextSource?.kind !== node.type) {
        context.addIssue({
          code: "custom",
          message: `Context source node ${node.id} has mismatched source metadata`,
          path: ["nodes"]
        });
      }
      if (node.type === "shape" && node.data.shape === undefined) {
        context.addIssue({
          code: "custom",
          message: `Shape node ${node.id} is missing shape metadata`,
          path: ["nodes"]
        });
      }
      if (node.type === "frame" && node.data.frame === undefined) {
        context.addIssue({
          code: "custom",
          message: `Frame node ${node.id} is missing frame metadata`,
          path: ["nodes"]
        });
      }
      if (node.type !== "frame" && node.data.frame !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Only frame nodes can define group membership: ${node.id}`,
          path: ["nodes"]
        });
      }
      if (node.type !== "shape" && node.data.shape !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Only shape nodes can define shape metadata: ${node.id}`,
          path: ["nodes"]
        });
      }
      if (node.type === "frame") {
        for (const memberNodeId of node.data.frame?.memberNodeIds ?? []) {
          if (!nodeIds.has(memberNodeId) || memberNodeId === node.id) {
            context.addIssue({
              code: "custom",
              message: `Frame ${node.id} references an invalid member`,
              path: ["nodes"]
            });
          }
        }
      }
    }
  });

export const canvasLoadRequestSchema = z.object({ canvasId: z.string().min(1).max(160) }).strict();
export const canvasLoadResponseSchema = z
  .object({ snapshot: canvasSnapshotSchema.nullable() })
  .strict();
export const canvasSaveRequestSchema = z.object({ snapshot: canvasSnapshotSchema }).strict();
export const canvasSaveResponseSchema = z
  .object({
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export type CanvasNodeType = z.infer<typeof canvasNodeTypeSchema>;
export type CanvasMission = z.infer<typeof canvasMissionSchema>;
export type CanvasNodeState = z.infer<typeof canvasNodeStateSchema>;
export type CanvasAgentRole = z.infer<typeof canvasAgentRoleSchema>;
export type CanvasArtifactReference = z.infer<typeof canvasArtifactReferenceSchema>;
export type CanvasContextSourceKind = z.infer<typeof canvasContextSourceKindSchema>;
export type CanvasContextSource = z.infer<typeof canvasContextSourceSchema>;
export type CanvasShape = z.infer<typeof canvasShapeSchema>;
export type CanvasFrame = z.infer<typeof canvasFrameSchema>;
export type CanvasNodeData = z.infer<typeof canvasNodeDataSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type EdgeContract = z.infer<typeof edgeContractSchema>;
export type CanvasViewport = z.infer<typeof canvasViewportSchema>;
export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>;
export type CanvasLoadRequest = z.infer<typeof canvasLoadRequestSchema>;
export type CanvasLoadResponse = z.infer<typeof canvasLoadResponseSchema>;
export type CanvasSaveRequest = z.infer<typeof canvasSaveRequestSchema>;
export type CanvasSaveResponse = z.infer<typeof canvasSaveResponseSchema>;
