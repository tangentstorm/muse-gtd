CREATE TABLE `projects` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `outcome` text NOT NULL DEFAULT '',
  `notes` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `next_actions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `context` text NOT NULL DEFAULT '@anywhere',
  `project_id` integer,
  `notes` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `ticklers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `remind_on` text NOT NULL,
  `notes` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'pending',
  `created_at` integer NOT NULL
);