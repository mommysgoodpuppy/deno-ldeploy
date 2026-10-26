/**
 * Copies every entry from one KV database into an app's local one, for moving
 * an app's state off Deno Deploy.
 *
 *   DENO_KV_ACCESS_TOKEN=... deno run -A --unstable-kv scripts/import-kv.ts \
 *     https://api.deno.com/databases/<id>/connect bsky-twit-bridge
 *
 * The source can be anything Deno.openKv() accepts: a KV Connect URL or a
 * sqlite file. Stop the app first (or run this before its first start), since
 * the copy isn't atomic against a running writer. Expiry times aren't
 * preserved, which only matters for short-lived entries such as locks.
 */

import { loadConfig } from "../src/config.ts";
import { appPaths } from "../src/state.ts";
import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";

const [source, app] = Deno.args;
if (!source || !app) {
  console.error("usage: import-kv.ts <source kv url or path> <app>");
  Deno.exit(2);
}

const config = await loadConfig();
if (!config.apps.has(app)) throw new Error(`no app named ${app} in ldeploy.jsonc`);
const dest = appPaths(config.dataDir, app).kv;
await ensureDir(dirname(dest));

const from = await Deno.openKv(source);
const to = await Deno.openKv(dest);
let count = 0;
for await (const entry of from.list({ prefix: [] })) {
  await to.set(entry.key, entry.value);
  count++;
}
console.log(`copied ${count} entries into ${dest}`);
from.close();
to.close();
