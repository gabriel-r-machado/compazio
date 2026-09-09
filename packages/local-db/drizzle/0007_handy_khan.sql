CREATE TABLE `canvas_handoff_events` (
	`id` text PRIMARY KEY NOT NULL,
	`handoff_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`handoff_id`) REFERENCES `canvas_handoffs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_handoff_events_sequence_idx` ON `canvas_handoff_events` (`handoff_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `canvas_handoff_events_handoff_idx` ON `canvas_handoff_events` (`handoff_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `canvas_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`mission` text NOT NULL,
	`source_json` text NOT NULL,
	`target_json` text NOT NULL,
	`edge_json` text NOT NULL,
	`content_json` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ready_at` integer,
	`delivered_at` integer,
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `canvas_handoffs_canvas_updated_idx` ON `canvas_handoffs` (`canvas_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `canvas_handoffs_status_idx` ON `canvas_handoffs` (`status`);--> statement-breakpoint
ALTER TABLE `canvases` ADD `mission` text DEFAULT '' NOT NULL;