CREATE TABLE `local_auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`identity_id`) REFERENCES `local_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `local_auth_sessions_identity_active_idx` ON `local_auth_sessions` (`identity_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `local_auth_sessions_expiry_idx` ON `local_auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `local_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_identities_kind_subject_idx` ON `local_identities` (`kind`,`subject_id`);--> statement-breakpoint
CREATE TABLE `local_identity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text,
	`actor_identity_id` text,
	`type` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `local_identities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_identity_id`) REFERENCES `local_identities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `local_identity_events_identity_created_idx` ON `local_identity_events` (`identity_id`,`created_at`);