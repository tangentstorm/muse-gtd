// Applies the drizzle/*.sql migrations to a sqlite database.
// Idempotent: already-applied files are tracked in _standalone_migrations.
//
// Usage:
//   GTD_DB=./app.db bun scripts/migrate.ts     (defaults to ./app.db)
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dbPath = process.env.GTD_DB ?? join(root, "app.db");

const db = new Database(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS _standalone_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
const applied = new Set(
  (db.query("SELECT name FROM _standalone_migrations").all() as Array<{ name: string }>).map((r) => r.name),
);

const dir = join(root, "drizzle");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let ran = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  db.exec(readFileSync(join(dir, file), "utf8"));
  db.query("INSERT INTO _standalone_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  console.log("applied", file);
  ran += 1;
}
console.log(ran === 0 ? "database already up to date:" : "database ready:", dbPath);
