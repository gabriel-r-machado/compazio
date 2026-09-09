ALTER TABLE `workflow_run_commands` ADD COLUMN `agent_node_id` text;
--> statement-breakpoint
ALTER TABLE `workflow_run_targets` ADD COLUMN `agent_node_id` text;
--> statement-breakpoint
CREATE INDEX `workflow_run_targets_workspace_agent_idx`
  ON `workflow_run_targets` (`workspace_id`, `agent_node_id`);
