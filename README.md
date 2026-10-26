# ldeploy

A local stand-in for Deno Deploy: one Deno daemon that builds apps from git, serves them by hostname, and
keeps them running. It reads the same `deploy` block in `deno.json` that Deploy does, so apps move over
without code changes.

Hosted here: `my-website` (static) and `bsky-twit-bridge` (dynamic, KV + cron).

## how it works

```
cloudflared ──> :8000 router ──Host──> static build   (served in-process)
                                  └──> dynamic build  (deno run child on a private port)
CLI ─────────> :8001 control API (localhost only)
```

- **Deploy**: clone the branch head (with submodules) into a fresh `data/apps/<app>/builds/<id>/`, run
  `install` then `build`, then start it. Traffic moves to the new build only once it's up; the old one gets 5s
  to drain. A failed build never replaces a working one.
- **Settings**: the repo's `deno.json` `deploy` block, with the app's `deploy` entry in `ldeploy.jsonc` merged
  over it. my-website's settings only ever lived in the Deploy dashboard, so they're in `ldeploy.jsonc`.
- **Dynamic apps** run as `deno run -A --unstable-kv --unstable-cron <entrypoint>` (override with
  `denoFlags`). `Deno.serve()` with no options binds to the assigned port via `DENO_SERVE_ADDRESS`, so apps
  need no changes. A crashed process is restarted with backoff. `Deno.cron` works because the process is
  long-lived.
- **KV**: `Deno.openKv()` with no path opens `data/apps/<app>/kv.sqlite3` (via `DENO_KV_DEFAULT_PATH`). It's
  shared by every build of the app, so state survives deploys and rollbacks, and it lives outside the Deno
  cache, so `deno clean` can't wipe it.
- **Env**: `envFile` (dotenv) plus `env` from `ldeploy.jsonc` reach both the build and the app. Apps also get
  `DENO_DEPLOYMENT_ID` (the build id) and `PORT`.
- **Proxying**: the app sees the public `Host` and `req.url`, plus `X-Forwarded-For/Proto/Host`. WebSockets
  are proxied.
- **Auto-deploy**: with `poll` set, the daemon checks the branch with `git ls-remote` every `poll` seconds and
  deploys new commits. A commit that fails to build isn't retried until the branch moves again.
- **Rollback**: the last `keepBuilds` working builds stay on disk.

## usage

```sh
deno task serve                          # run the daemon (or use the systemd unit)
deno task ldeploy status                 # what's live, build history
deno task ldeploy deploy my-website      # build the branch head and switch to it
deno task ldeploy rollback my-website    # back to the previous build (or pass a build id)
deno task ldeploy restart bsky-twit-bridge   # restart the live build, e.g. after editing its env file
deno task ldeploy logs bsky-twit-bridge -f   # app output
deno task ldeploy build-log my-website   # latest build's output (or pass a build id)
```

Every app is reachable at `http://<app>.localhost:8000` for testing, whatever its hostnames are. Config
changes (`ldeploy.jsonc`) need a daemon restart.

## running it permanently

```sh
ln -s ~/git/deno-ldeploy/systemd/ldeploy.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ldeploy
journalctl --user -u ldeploy -f
```

Restarting the daemon brings each app's live build back up without rebuilding.

## going public

Public traffic arrives through a dedicated cloudflared tunnel named `ldeploy`, running next to the daemon as
`systemd/cloudflared-ldeploy.service`. The tunnel was created on a machine holding the account's
`~/.cloudflared/cert.pem`; the server only has that tunnel's credentials file, which can run this tunnel and
nothing else.

`~/.cloudflared/ldeploy.yml` on the server sends each public hostname to the router:

```yaml
tunnel: <tunnel id>
credentials-file: /home/ellie/.cloudflared/<tunnel id>.json
ingress:
  - hostname: petplay.fi
    service: http://127.0.0.1:8000
  - service: http_status:404
```

To publish another hostname: add it to that ingress list and to the app's `hostnames`, restart both units,
then point DNS at the tunnel from the machine with `cert.pem`:

```sh
cloudflared tunnel route dns ldeploy <hostname>     # --overwrite-dns to replace an existing record
```

Cloudflare terminates TLS, and requests arrive with `X-Forwarded-Proto: https`.

## host stats

An app with `"hostStats": "/api/server"` gets live load figures as JSON at that path on its hostnames: CPU use
and temperature, memory and swap use (as percentages), load average, network throughput and Wi-Fi signal, with
10 minutes of 5-second history, plus the hosted apps and their request counts. It's read from `/proc` and
`/sys`, so it's Linux only.

The endpoint is public, so it says how busy the machine is, never what it is: no hardware model, CPU, OS,
kernel version, uptime (which dates the running kernel), capacities or disk use, IPs, hostname, users or
processes. Keep it that way; those are what match a machine to a vulnerability announcement. my-website's
homepage shows it.

## dynamic IP

Tunnel-served hostnames don't care about the home IP: cloudflared connects outward. Plain A records that point
at the connection itself (e.g. for SSH or game streaming) do. A `ddns` block keeps those up to date:

```jsonc
"ddns": {
  "zone": "petplay.fi",
  "records": ["vrpc.petplay.fi"],
  // A Cloudflare API token with Zone > DNS > Edit on the zone, and nothing else.
  "tokenFile": "secrets/cloudflare-dns.token",
  "interval": 300
}
```

Every `interval` seconds the daemon looks up its public IPv4 (Cloudflare's trace endpoint, then ipify) and
patches any listed record that differs, leaving its proxied setting and TTL alone. The records must already
exist. `ldeploy status` shows the last check. A failing check is logged and retried; it never affects the
apps.

## moving bsky-twit-bridge off Deploy

Do these **in order**. The bot's KV records which tweets it already mirrored. Started against an empty KV with
`BACKFILL_DAYS` set, it re-posts that many days of tweets.

1. Copy its secrets from the Deploy dashboard into `secrets/bsky-twit-bridge.env` (format: `.env.example` in
   the repo).
2. Either import its KV from Deploy (stop the daemon or don't deploy the app yet):

   ```sh
   DENO_KV_ACCESS_TOKEN=<token> deno run -A --unstable-kv scripts/import-kv.ts \
     https://api.deno.com/databases/<database-id>/connect bsky-twit-bridge
   ```

   or set `BACKFILL_DAYS=0` in the env file, so the first run records the current timeline as already seen and
   only mirrors new tweets.
3. **Stop the Deploy instance first.** Two copies running against separate state would both post every new
   tweet.
4. `deno task ldeploy deploy bsky-twit-bridge`.

The build vendors python and ffmpeg into the build directory (~100MB per build, times `keepBuilds`).

## layout

```
main.ts            CLI and `serve` entry
ldeploy.jsonc      apps, hostnames, ports
src/config.ts      config loading, deploy-settings merge
src/app.ts         per-app lifecycle: deploy, switch, rollback, poll, prune
src/build.ts       clone + install + build
src/instance.ts    static server / supervised deno process
src/proxy.ts       HTTP + WebSocket forwarding
src/hoststats.ts   live load stats (hostStats)
src/ddns.ts        Cloudflare A records kept on the public IP
src/server.ts      router and control API
src/state.ts       on-disk layout and state.json
scripts/import-kv.ts   copy a KV database into an app's local one
data/              builds, logs, state, KV (gitignored)
secrets/           env files (gitignored)
```
