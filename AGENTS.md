# AGENTS.md

A local stand-in for Deno Deploy: one daemon that builds, routes and supervises apps. See `README.md`.

- `data/` holds production state, including each app's `kv.sqlite3`; never delete or reset it.
  `secrets/` holds real credentials; don't print or commit them.
- `markdown/`: plans, work in progress and notes that should outlast a session. Keep project
  memory here, not in a harness's own memory system (Claude Code memory, Codex memories and the
  like).
- Use `_scratch/` for agent scratch files, experiments and local test artifacts. It is ignored by
  Git. Global tmp may be used but is not persistent; project-local, don't use `project/tmp/` or
  others, only `_scratch/`.
- Check: `deno task check && deno lint && deno fmt --check`. Run: `deno task serve`.
- Test with a separate `LDEPLOY_CONFIG` (own `dataDir` and ports), never the live daemon.
- Never run bsky-twit-bridge with real secrets for testing: a second copy posts to Bluesky.

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
