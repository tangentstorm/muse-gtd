CREATE TABLE `client_diagnostics` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event` text NOT NULL,
  `occurred_at` text NOT NULL,
  `detail` text NOT NULL,
  `client_release` text NOT NULL,
  `recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `client_diagnostics_occurred_at_idx` ON `client_diagnostics` (`occurred_at`);
