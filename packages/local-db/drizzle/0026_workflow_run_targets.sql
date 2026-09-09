ALTER TABLE `workflow_run_commands` ADD COLUMN `workspace_id` text;
--> statement-breakpoint
CREATE INDEX `workflow_run_commands_workspace_created_idx`
  ON `workflow_run_commands` (`workspace_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `workflow_run_targets` (
  `run_id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `project_id` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `workflow_run_targets_project_created_idx`
  ON `workflow_run_targets` (`project_id`, `created_at`);
