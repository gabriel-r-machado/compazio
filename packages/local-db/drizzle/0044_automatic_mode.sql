CREATE TABLE automatic_runs (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  objective text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  draft_id text NOT NULL,
  current_run_id text,
  remediation_cycle integer NOT NULL,
  stop_reason text,
  result text,
  state_json text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX automatic_runs_workspace_updated_idx
  ON automatic_runs (workspace_id, updated_at);
--> statement-breakpoint
CREATE INDEX automatic_runs_current_run_idx
  ON automatic_runs (current_run_id);
--> statement-breakpoint
CREATE TABLE automatic_node_prompts (
  run_id text NOT NULL,
  node_id text NOT NULL,
  automatic_run_id text NOT NULL REFERENCES automatic_runs(id) ON DELETE CASCADE,
  cycle integer NOT NULL,
  prompt text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (run_id, node_id)
);
--> statement-breakpoint
CREATE INDEX automatic_node_prompts_automatic_run_idx
  ON automatic_node_prompts (automatic_run_id);
--> statement-breakpoint
CREATE TABLE automatic_approvals (
  id text PRIMARY KEY NOT NULL,
  automatic_run_id text NOT NULL REFERENCES automatic_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  action_fingerprint text NOT NULL,
  decision text NOT NULL,
  created_at integer NOT NULL,
  decided_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX automatic_approvals_action_idx
  ON automatic_approvals (automatic_run_id, node_id, action_fingerprint);
