CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
);
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE `clients` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `relationship` text DEFAULT 'current_or_potential' NOT NULL,
  `billing_rule` text DEFAULT 'clocked_in_only' NOT NULL,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `clients_name_unique` UNIQUE(`name`)
);
CREATE TABLE `projects` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `client_id` integer,
  `outcome` text NOT NULL DEFAULT '',
  `notes` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE SET NULL
);
CREATE TABLE `next_actions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `context` text NOT NULL DEFAULT '@anywhere',
  `project_id` integer,
  `notes` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'active',
  `created_at` integer NOT NULL,
  `completed_at` integer,
  `is_next` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE SET NULL
);
CREATE TABLE `ticklers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `remind_on` text NOT NULL,
  `notes` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'pending',
  `created_at` integer NOT NULL
);
CREATE TABLE `inbox_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
CREATE TABLE `reference_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE TABLE `someday_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE TABLE `scheduled_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `title` text NOT NULL,
  `scheduled_date` text NOT NULL,
  `start_time` text,
  `end_time` text,
  `source_label` text DEFAULT '' NOT NULL,
  `is_blocking` integer DEFAULT 1 NOT NULL,
  `notes` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE TABLE `render_health_measurements` (
  `id` integer PRIMARY KEY NOT NULL,
  `render_generation` text NOT NULL,
  `request_id` text,
  `client_release` text NOT NULL,
  `server_release` text NOT NULL,
  `tab` text NOT NULL,
  `rendered_row_count` integer NOT NULL,
  `has_data` integer NOT NULL,
  `rendered_at` text NOT NULL,
  `recorded_at` text NOT NULL
);
