const configPath = new URL("../server/src/local-config.ts", import.meta.url);
const examplePath = "server/src/local-config.example.ts";

if (!(await Bun.file(configPath).exists())) {
  console.error(`Missing server/src/local-config.ts. Copy ${examplePath}, then replace its placeholders with the three calendar IDs.`);
  process.exit(1);
}

const source = await Bun.file(configPath).text();
for (const key of ["primary", "intent", "tangentcode"]) {
  if (!new RegExp(`\\b${key}\\s*:`).test(source)) {
    console.error(`Invalid server/src/local-config.ts: missing ${key}. Copy ${examplePath} and fill every calendar ID.`);
    process.exit(1);
  }
}
