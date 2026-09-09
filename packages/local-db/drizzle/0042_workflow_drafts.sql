CREATE TABLE workflow_drafts (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_terminal_id text NOT NULL,
  state text NOT NULL,
  creation_mode text NOT NULL,
  execution_profile text NOT NULL,
  version integer NOT NULL,
  draft_json text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX workflow_drafts_workspace_updated_idx
  ON workflow_drafts (workspace_id, updated_at);
--> statement-breakpoint
CREATE INDEX workflow_drafts_terminal_updated_idx
  ON workflow_drafts (source_terminal_id, updated_at);
--> statement-breakpoint
CREATE TABLE workflow_draft_events (
  id text PRIMARY KEY NOT NULL,
  draft_id text NOT NULL REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type text NOT NULL,
  actor text NOT NULL,
  summary text NOT NULL,
  rejection_reason text,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_draft_events_sequence_idx
  ON workflow_draft_events (draft_id, sequence);
--> statement-breakpoint
CREATE INDEX workflow_draft_events_draft_created_idx
  ON workflow_draft_events (draft_id, created_at);
--> statement-breakpoint
ALTER TABLE canvases ADD COLUMN creation_mode text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE canvases ADD COLUMN execution_profile text NOT NULL DEFAULT 'balanced';
