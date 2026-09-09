CREATE TABLE `quality_gate_processes` (
	`gate_run_id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`process_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`gate_run_id`) REFERENCES `quality_gate_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `managed_worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
