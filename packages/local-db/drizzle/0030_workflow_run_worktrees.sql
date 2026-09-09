ALTER TABLE `workflow_run_targets` ADD COLUMN `worktree_id` text;
--> statement-breakpoint
CREATE INDEX `workflow_run_targets_worktree_idx` ON `workflow_run_targets` (`worktree_id`);
