CREATE TABLE `runtime_project_leases` (
	`project_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runtime_project_leases_owner_idx` ON `runtime_project_leases` (`owner_id`);