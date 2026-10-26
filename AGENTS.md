# AGENTS.md

A self-hosted stand-in for Deno Deploy: one Deno daemon that builds apps from git, routes to them by
hostname, and supervises them. Start with `README.md`.

- `ldeploy.jsonc`: the apps, their sources, hostnames and ports. Per-app build/runtime settings come
  from each app repo's `deno.json` `deploy` block, merged under the app's `deploy` entry here.
- `src/`: `app.ts` (lifecycle: deploy, switch, rollback, poll, prune), `build.ts`, `instance.ts`
  (static server / supervised process), `proxy.ts`, `server.ts` (router and control API).
- `data/` (gitignored): live builds, logs, `state.json` and each app's `kv.sqlite3`. The KV files are
  production state (the bridge's record of mirrored tweets); never delete or reset them.
- `secrets/` (gitignored): app env files holding real credentials. Don't print or commit them.
- Use `_scratch/` for agent scratch files, experiments and local test artifacts. It is ignored by
  Git. Global tmp may be used but is not persistent; project-local, don't use `project/tmp/` or
  others, only `_scratch/`.
- Check: `deno task check && deno lint && deno fmt --check`. Run: `deno task serve` (in production
  it runs as the `ldeploy` systemd user unit, `systemd/ldeploy.service`).
- Test against a separate config (`LDEPLOY_CONFIG=_scratch/test/ldeploy.jsonc`) with its own
  `dataDir` and ports, never against the live daemon on :8000/:8001.
- Never start bsky-twit-bridge with real secrets for testing: a second running copy posts to
  Bluesky. Use dummy env values and a cron schedule that never fires (`0 0 1 1 *`).
- Builds are slow and large: my-website clones submodules and runs four vite builds (~1.2GB before
  trimming); the bridge vendors ~100MB of python and ffmpeg.
- Deno's fetch and WebSocket clients drop custom `Host` headers; `proxy.ts` uses a proxy-form
  `HttpClient` to preserve it. Test hostname routing with curl or raw sockets, not Deno clients.
- Killing the daemon with `pkill -f 'main.ts serve'` also matches the calling shell; use
  `pgrep -f 'main[.]ts serve'`.

## Related projects

- `../my-website`: static site (petplay.fi). Its Deploy dashboard settings live in `ldeploy.jsonc`.
- `../bsky-twit-bridge`: dynamic app using KV and cron. Its settings come from its own `deno.json`.
- Both deploy from their GitHub `main`, not the local checkouts; ldeploy never edits them.

## Git

Manage git however you see fit. Primary is `main`.

- Commit as the configured git identity. No `Co-Authored-By` or other co-author trailers.
- Never push, open PRs or issues, or publish anything to external sites unless asked for that
  specific action.
- End every agent-made commit message with:

  ```
  Agent: <harness> <version>; model <exact model id>; thread <harness thread/session id>
  ```

  For example, `Agent: Claude Code 2.1.296; model claude-opus-5-5; thread 941be8c7-aca1-4664-b284-7cc0eed69e21`.
