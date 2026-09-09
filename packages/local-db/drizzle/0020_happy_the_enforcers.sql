CREATE TABLE `runtime_lifecycle_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `runtime_lifecycle_commands_pending_idx` ON `runtime_lifecycle_commands` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `runtime_lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`command_id` text,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`outcome` text NOT NULL,
	`actor` text NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `runtime_lifecycle_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runtime_lifecycle_events_created_idx` ON `runtime_lifecycle_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `runtime_lifecycle_state` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
