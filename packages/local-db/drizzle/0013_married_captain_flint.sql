CREATE TABLE `workspace_artifact_events` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `workspace_artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_artifact_events_sequence_idx` ON `workspace_artifact_events` (`artifact_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `workspace_artifact_events_artifact_idx` ON `workspace_artifact_events` (`artifact_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_relative_path` text NOT NULL,
	`relative_path` text NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`media_type` text NOT NULL,
	`published_by_node_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_artifacts_idempotency_idx` ON `workspace_artifacts` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `workspace_artifacts_workspace_created_idx` ON `workspace_artifacts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workspace_artifacts_project_created_idx` ON `workspace_artifacts` (`project_id`,`created_at`);