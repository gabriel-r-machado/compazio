CREATE TABLE `canvas_handoff_delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`handoff_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`target_session_id` text,
	`adapter_id` text,
	`status` text NOT NULL,
	`confirmation` text,
	`error` text,
	`responsible` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`handoff_id`) REFERENCES `canvas_handoffs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_handoff_delivery_attempts_sequence_idx` ON `canvas_handoff_delivery_attempts` (`handoff_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `canvas_handoff_delivery_attempts_handoff_idx` ON `canvas_handoff_delivery_attempts` (`handoff_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `canvas_handoff_events` ADD `delivery_attempt_id` text;--> statement-breakpoint
ALTER TABLE `canvas_handoff_events` ADD `responsible` text DEFAULT 'system' NOT NULL;