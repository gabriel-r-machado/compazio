CREATE TABLE autonomy_decisions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id text,
  proposal_id text,
  actor text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  rule text NOT NULL,
  context_json text NOT NULL,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX autonomy_decisions_workspace_created_idx
  ON autonomy_decisions (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX autonomy_decisions_run_created_idx
  ON autonomy_decisions (run_id, created_at);
--> statement-breakpoint
CREATE TABLE autonomy_controls (
  workspace_id text PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kill_switch integer NOT NULL DEFAULT 0,
  engaged_by text,
  updated_at integer NOT NULL
);
