// Standalone client build for running muse-gtd outside the Muse web-artifact
// pipeline. Replicates the canonical bundle configuration owned by
// @hatch/space-sdk/build (production React bundle, tailwind, hashed assets).
// The artifact's own `bun run build:client` only runs inside the artifact
// builder; use this script (or `bun run build:standalone`) for local runs.
//
// Usage: bun scripts/build-client-standalone.mjs   (from the repo root)
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";

await rm(OUTDIR, { force: true, recursive: true });
const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("client build failed; see logged diagnostics");
}
// Bun emits imported-asset URLs as bare `./<file>`; re-prefix them to
// `./assets/<file>` so they resolve against the served dist directory.
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}
console.log(`client bundle written to ${OUTDIR} (${result.outputs.length} outputs)`);
