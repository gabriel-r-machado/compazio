CREATE TABLE `delivery_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worktree_id` text NOT NULL,
	`title` text NOT NULL,
	`markdown` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `managed_worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delivery_reports_worktree_idx` ON `delivery_reports` (`worktree_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `managed_worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_key` text NOT NULL,
	`task_title` text NOT NULL,
	`branch_name` text NOT NULL,
	`path` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_commit` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_worktrees_project_branch_idx` ON `managed_worktrees` (`project_id`,`branch_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `managed_worktrees_path_idx` ON `managed_worktrees` (`path`);--> statement-breakpoint
CREATE INDEX `managed_worktrees_project_state_idx` ON `managed_worktrees` (`project_id`,`state`);--> statement-breakpoint
CREATE TABLE `merge_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worktree_id` text NOT NULL,
	`source_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`source_head` text NOT NULL,
	`target_head` text NOT NULL,
	`confirmation_token_hash` text,
	`conflicted_files_json` text NOT NULL,
	`required_gate_run_ids_json` text NOT NULL,
	`state` text NOT NULL,
	`eligible` integer NOT NULL,
	`issues_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer,
	`merge_commit` text,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `managed_worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `merge_plans_project_state_idx` ON `merge_plans` (`project_id`,`state`);--> statement-breakpoint
CREATE TABLE `project_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_leases_project_idx` ON `project_leases` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`canonical_root_path` text NOT NULL,
	`default_branch` text NOT NULL,
	`head_commit` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_canonical_root_idx` ON `projects` (`canonical_root_path`);--> statement-breakpoint
CREATE TABLE `quality_gate_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worktree_id` text NOT NULL,
	`preset_id` text NOT NULL,
	`state` text NOT NULL,
	`executable_name` text NOT NULL,
	`args_json` text NOT NULL,
	`head_commit` text NOT NULL,
	`exit_code` integer,
	`duration_ms` integer,
	`timed_out` integer NOT NULL,
	`output_summary` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `managed_worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quality_gate_runs_worktree_idx` ON `quality_gate_runs` (`worktree_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `quality_gate_runs_state_idx` ON `quality_gate_runs` (`state`);--> statement-breakpoint
CREATE TABLE `worktree_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `managed_worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_leases_worktree_idx` ON `worktree_leases` (`worktree_id`);