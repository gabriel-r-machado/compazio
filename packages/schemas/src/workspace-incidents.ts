import { z } from "zod";

export const WORKSPACE_INCIDENTS_LIST_CHANNEL = "workspace:incidents:list" as const;

/**
 * What went wrong, drawn from rows the runtime already writes durably.
 *
 * Every kind here is a failure a person has to be able to see *after* it happened. The product used
 * to surface these as transient alerts that cleared themselves after a few seconds, which meant a
 * denial or a dead adapter was indistinguishable from nothing having happened at all.
 */
export const workspaceIncidentKindSchema = z.enum([
  /** The Policy Engine refused an action because the agent's node lacks the permission. */
  "policy_denied",
  /** A durable `remove`/`assign_role`/`restart` request did not complete. */
  "lifecycle_failed",
  /** A message to another agent could not be delivered. */
  "message_failed",
  /** Creating an agent from the CLI did not produce a running terminal. */
  "spawn_failed"
]);

export const workspaceIncidentSeveritySchema = z.enum(["error", "warning"]);

/**
 * A single line in the activity panel.
 *
 * Deliberately structural: an id, a kind, the node it concerns and a short machine-readable detail.
 * No message content, no terminal output, no path, no command and no executable ever reaches this
 * type — the panel explains *that* something failed and *which* permission or action was involved,
 * which is what a person needs to act, and nothing that would turn an audit trail into a data leak.
 */
export const workspaceIncidentSchema = z
  .object({
    id: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(160),
    kind: workspaceIncidentKindSchema,
    severity: workspaceIncidentSeveritySchema,
    /** The canvas node this concerns, when the runtime knows one. */
    nodeId: z.string().min(1).max(160).nullable(),
    /** The agent that asked, when the action was requested by one rather than by the person. */
    actorNodeId: z.string().min(1).max(160).nullable(),
    /**
     * The permission, action or error code involved — a bounded identifier from a closed set the
     * runtime produces, never free text a process could steer.
     */
    detail: z.string().min(1).max(80),
    /** Secondary structural identifier: the reason a decision was refused, the action attempted. */
    context: z.string().max(80).nullable(),
    occurredAt: z.string().datetime({ offset: true })
  })
  .strict();

export const workspaceIncidentListRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(160),
    limit: z.number().int().min(1).max(200).default(50)
  })
  .strict();

export const workspaceIncidentListResponseSchema = z
  .object({
    incidents: z.array(workspaceIncidentSchema).max(200)
  })
  .strict();

export type WorkspaceIncidentKind = z.infer<typeof workspaceIncidentKindSchema>;
export type WorkspaceIncidentSeverity = z.infer<typeof workspaceIncidentSeveritySchema>;
export type WorkspaceIncident = z.infer<typeof workspaceIncidentSchema>;
export type WorkspaceIncidentListRequest = z.infer<typeof workspaceIncidentListRequestSchema>;
export type WorkspaceIncidentListResponse = z.infer<typeof workspaceIncidentListResponseSchema>;
