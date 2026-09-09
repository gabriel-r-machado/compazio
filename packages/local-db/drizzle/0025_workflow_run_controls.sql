CREATE TABLE `workflow_run_commands` (
  `id` text PRIMARY KEY NOT NULL,
  `action` text NOT NULL,
  `status` text NOT NULL,
  `run_id` text,
  `node_id` text,
  `template_id` text,
  `dry_run` integer,
  `decision_note` text,
  `requested_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `applied_at` integer,
  `result_run_id` text,
  `error_code` text
);
--> statement-breakpoint
CREATE INDEX `workflow_run_commands_status_created_idx`
  ON `workflow_run_commands` (`status`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `workflow_run_commands_run_created_idx`
  ON `workflow_run_commands` (`run_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `workflow_run_command_events` (
  `id` text PRIMARY KEY NOT NULL,
  `command_id` text NOT NULL,
  `action` text NOT NULL,
  `outcome` text NOT NULL,
  `actor` text NOT NULL,
  `error_code` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`command_id`) REFERENCES `workflow_run_commands`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_run_command_events_command_created_idx`
  ON `workflow_run_command_events` (`command_id`, `created_at`);
