CREATE TABLE `workspace_note_events` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`projection_state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `workspace_notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_note_events_sequence_idx` ON `workspace_note_events` (`note_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_note_events_idempotency_idx` ON `workspace_note_events` (`note_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `workspace_note_events_projection_idx` ON `workspace_note_events` (`projection_state`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`canvas_id` text NOT NULL,
	`project_id` text NOT NULL,
	`node_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`revision` integer NOT NULL,
	`created_by_node_id` text,
	`create_idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_notes_workspace_create_idempotency_idx` ON `workspace_notes` (`workspace_id`,`create_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_notes_workspace_node_idx` ON `workspace_notes` (`workspace_id`,`node_id`);--> statement-breakpoint
CREATE INDEX `workspace_notes_workspace_updated_idx` ON `workspace_notes` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workspace_notes_canvas_idx` ON `workspace_notes` (`canvas_id`,`updated_at`);