// Standalone server for running muse-gtd outside the Muse web-artifact
// pipeline. Serves the built client (client/dist) and dispatches the client's
// POST ./actions calls to the real server action handlers in
// server/src/actions.ts, backed by a local sqlite database.
//
// Google Calendar calls go through the real privileged handlers in
// server/src/privileged.ts (they shell out to `hatch_gws_cli` when present).
// Without calendar credentials the Week view degrades to its quiet
// "calendar unavailable" state; everything else works.
//
// Usage:
//   GTD_DB=./app.db PORT=8479 bun scripts/serve-standalone.ts
//   (defaults: ./app.db, port 8479)
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import { Actions } from "../server/src/actions.ts";
import { privilegedHandlers } from "../server/src/privileged.ts";
import * as schema from "../server/src/schema.ts";

const root = new URL("..", import.meta.url).pathname;
const dbPath = process.env.GTD_DB ?? join(root, "app.db");
const port = Number(process.env.PORT ?? 8479);
const host = process.env.HOST ?? "127.0.0.1";
const DIST = join(root, "client", "dist");

const sqlite = new Database(dbPath);
const db = drizzle(sqlite, { schema });

const privilegedEntries = (privilegedHandlers as unknown as {
  entries: Array<{ contract: unknown; handler: (args: any) => Promise<any> }>;
}).entries;

async function executePrivileged(contract: unknown, args: unknown) {
  const entry = privilegedEntries.find((e) => e.contract === contract);
  if (!entry) throw new Error("no privileged handler registered for this contract");
  return entry.handler(args);
}

// Minimal space Ctx: the GTD actions only use db, executePrivileged,
// emit, and invalidateQueries.
const ctx: any = {
  slug: "gtd",
  invocationId: "standalone",
  spaceDir: root,
  db: () => db,
  executePrivileged,
  blobs: {},
  emit: () => {},
  invalidateQueries: () => {},
};

const contentTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

Bun.serve({
  port,
  hostname: host,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/actions" && req.method === "POST") {
      try {
        const body = (await req.json()) as { action: string; args: any };
        const def = (Actions as any)[body.action];
        if (!def) return Response.json({ error: `unknown action ${body.action}` }, { status: 404 });
        const args = def.request.parse(body.args ?? {});
        const data = await def.handler(ctx, args);
        return Response.json({ data: def.response.parse(data) });
      } catch (err: any) {
        console.error("action error:", err?.message ?? err);
        return Response.json({ error: String(err?.message ?? err) }, { status: 500 });
      }
    }
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (pathname.includes("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(join(DIST, pathname));
    if (await file.exists()) {
      const ext = pathname.slice(pathname.lastIndexOf("."));
      return new Response(file, { headers: { "content-type": contentTypes[ext] ?? "application/octet-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`muse-gtd serving on http://${host}:${port}/  (db: ${dbPath})`);
