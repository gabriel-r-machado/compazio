ALTER TABLE workflow_run_commands ADD COLUMN alternative_label text;
--> statement-breakpoint

ALTER TABLE workflow_runs ADD COLUMN retry_of_run_id text;
--> statement-breakpoint
ALTER TABLE workflow_runs ADD COLUMN retry_node_id text;
--> statement-breakpoint
ALTER TABLE workflow_runs ADD COLUMN retry_scope text;
--> statement-breakpoint
ALTER TABLE workflow_runs ADD COLUMN alternative_group_id text;
--> statement-breakpoint
ALTER TABLE workflow_runs ADD COLUMN alternative_label text;
--> statement-breakpoint

CREATE INDEX workflow_runs_alternative_group_idx
  ON workflow_runs (alternative_group_id, created_at);
