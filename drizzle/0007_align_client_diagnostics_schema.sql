ALTER TABLE `client_diagnostics` RENAME TO `client_diagnostics_legacy`;
--> statement-breakpoint
CREATE TABLE `client_diagnostics` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `kind` text NOT NULL,
  `detail` text NOT NULL DEFAULT '',
  `client_release` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `client_diagnostics` (`id`, `kind`, `detail`, `client_release`, `created_at`)
SELECT `id`, `event`, `detail`, `client_release`, `recorded_at`
FROM `client_diagnostics_legacy`;
--> statement-breakpoint
DROP TABLE `client_diagnostics_legacy`;
