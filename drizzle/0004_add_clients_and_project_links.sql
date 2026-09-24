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
--> statement-breakpoint
ALTER TABLE `projects` ADD `client_id` integer REFERENCES clients(id) ON DELETE SET NULL;
--> statement-breakpoint
INSERT INTO `clients` (`name`, `relationship`, `billing_rule`, `notes`, `created_at`, `updated_at`)
VALUES
  ('DH/AP', 'current_or_potential', 'clocked_in_only', '', unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('VC/FR', 'current_or_potential', 'clocked_in_only', '', unixepoch('now') * 1000, unixepoch('now') * 1000);
--> statement-breakpoint
UPDATE `projects`
SET `client_id` = (SELECT `id` FROM `clients` WHERE `name` = 'DH/AP')
WHERE lower(`title`) = 'airpay work' AND `client_id` IS NULL;
