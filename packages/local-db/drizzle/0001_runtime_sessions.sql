CREATE TABLE `runtime_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`state` text NOT NULL,
	`cwd` text NOT NULL,
	`process_id` integer,
	`started_at` integer,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	`exit_code` integer,
	`exit_signal` integer,
	`interruption_reason` text
);
