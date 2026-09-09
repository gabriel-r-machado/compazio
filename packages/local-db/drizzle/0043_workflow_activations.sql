CREATE TABLE workflow_activations (
  id text PRIMARY KEY NOT NULL,
  draft_id text NOT NULL,
  draft_version integer NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  workflow_id text NOT NULL,
  definition_sha256 text NOT NULL,
  run_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_activations_draft_revision_idx
  ON workflow_activations (draft_id, draft_version);
--> statement-breakpoint
CREATE INDEX workflow_activations_workspace_updated_idx
  ON workflow_activations (workspace_id, updated_at);
--> statement-breakpoint
CREATE INDEX workflow_activations_run_idx
  ON workflow_activations (run_id);
