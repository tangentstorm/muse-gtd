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
