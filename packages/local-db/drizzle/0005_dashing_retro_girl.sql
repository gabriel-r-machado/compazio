CREATE TABLE `cloud_sync_outbox` (
	`event_key` text PRIMARY KEY NOT NULL,
	`event_json` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `cloud_sync_outbox_state_idx` ON `cloud_sync_outbox` (`state`,`created_at`);