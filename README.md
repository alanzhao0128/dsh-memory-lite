# dsh-memory-lite

Lightweight, zero-dependency long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Memories are plain Markdown files under a configurable root; the plugin injects an L0 memory catalog into each session and exposes five model-facing tools.

Design: [《Light Memory for DSH 设计方案》](https://github.com/deepseek-ai/deepseek-harness) v7 (2026-08-25). Implementation spec: [IMPLEMENTATION.md](IMPLEMENTATION.md).

> **Status: Phase 1-3 implemented.** Explicit capture (remember / update / forget), L0 catalog injection, search and read (Phase 1); implicit background extraction (Phase 2, window + idle triggers active, turn/flush triggers shipped but off by config); and read-only cross-peer sharing (Phase 3) are built and live-tested. Not yet built: `forget_memory` approval, `## Related` auto-maintenance, CLI/MCP (Phase 4).

## Install

Install into a profile and add it to that profile's bundle list:

```sh
dsh plugin --profile web add @alanzhao/dsh-memory-lite
```

or, for a local checkout, add a linked dependency and bundle:

```jsonc
// $DSH_HOME/profiles/web/package.json
{
  "dependencies": { "@alanzhao/dsh-memory-lite": "^0.1.1" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@alanzhao/dsh-memory-lite"] } }
}
```

The bundle inserts the plugin row without configuration; defaults apply immediately.

## Configuration

All settings are edited in the **settings panel** (Settings → memory-lite). They persist to the harness settings document (`~/.dsh/settings.yaml`, section `dsh-memory-lite:`) and most take effect **immediately** — no restart, no YAML editing. The header indicator and extraction behavior react live.

The plugin row in `cordis.patch.yml` carries **no configuration** (mount only); a row config, if present, acts as the deployment base layer under the settings document (settings values win). The full schema, with defaults, lives in [src/config.ts](src/config.ts):

```yaml
- id: memory-lite
  name: @alanzhao/dsh-memory-lite
  # config:            # optional deployment defaults; settings override
  #   root: '~/.agent-memory'
  #   defaultPeer: dsh-web
  #   extraction:
  #     mode: incremental
  #     turnStoppingTrigger: false
  #     flushTrigger: false
  #   sharing:
  #     enabled: true
  #     mounts:
  #       - name: dsh-test
  #         peer: dsh-test-72572e8b
  #         subpath: ''
  #         readonly: true
```

Effect timing:

- **Live** (apply on save): `extraction.*`, `index.maxTokens`, `defaultPeer`, `workspacePeers.*`, `ui.headerOrder` (after a refresh for the slot order).
- **Restart** (persisted, apply on next boot): `root`, `sharing.*` — `MemoryStore` pins them at construction; the panel labels them accordingly.

## Tools

| Tool | Purpose |
|---|---|
| `read_memory` | Read the full text of one memory file (exact path from the catalog). |
| `search_memory` | Line search across the session peer's memory files. |
| `remember` | Create or append a memory — call ONLY when the user explicitly asks to remember. |
| `update_memory` | Replace a memory's current content; the previous content moves to `## History` (ADD-only). |
| `forget_memory` | Soft-delete a memory into `<root>/.trash/`. |

### Memory file layout

```
~/.agent-memory/
├── peers/{peer}/
│   ├── memories/
│   │   ├── _index.md             # L0 index (generated; human-editable)
│   │   ├── preferences/  entities/  events/  experiences/
│   │   │   └── {slug}.md         # L1 full text
│   └── sessions/                 # extraction checkpoint + audit ({session-id}.json) and extraction.log
└── .trash/                       # soft-deleted memories (root/.trash/<date>/)
```

Each memory file uses `## Current` / `## History` / `## Related` sections; updates archive, never destroy. The four categories are retrieval paths for the model: preferences (always relevant), entities (mentioned knowledge), events (time-related), experiences (task lessons).

## How it works

- **L0 catalog injection** (`agent/pre-step` waterfall, copied from `@deepseek-ai/dsh-tool-skill`): the peer's `_index.md` is rendered into one durable `user/message` with a typed `memory-catalog` source and re-published when the index changes or compaction moves it off the visible surface. A fresh empty index publishes nothing (unless sharing mounts are enabled — then only the `## shared` hint is published). Subagent sessions get no catalog.
- **Peer isolation**: each session's cwd derives its peer name (sanitized basename + short hash); cwd-less sessions fall back to `defaultPeer`.
- **Path safety**: every file access goes through a containment boundary — relative paths only, `..` / absolute / symlink escapes rejected at the executor.
- **Implicit extraction** (Phase 2): once `windowTurns` (default 20) new surface messages accumulate — or after `idleTimeoutMin` (default 30 min) of idle — a background run feeds the new window to the LLM and applies a create/merge/update/skip decision (dedup against existing memories), then advances a per-session checkpoint and rolling digest. Turn-boundary and flush triggers are shipped but disabled by config (cost); subagent sessions are never extracted. Audit trails live in `peers/{peer}/sessions/`.
- **Cross-peer sharing** (Phase 3): `sharing.mounts` expose another peer's memories read-only at `shared/<name>/...`; `search_memory` covers shared mounts and results keep the `shared/<name>` prefix. Shared entries stay out of the local catalog.
- **Concurrent writes**: all mutations run through a serial queue with atomic tmp+rename replacement.
- **Header status indicator** (browser half, `lib/client.js`): a compact "memory-lite" capsule in the session-header utilities row, left of the built-in "Session log" download button (position via `ui.headerOrder`, editable in the settings panel). The dot polls the `/memory-status` RPC channel every 10s — green (last extraction run ok), red (last run failed or the plugin is unreachable), gray (extraction mode off / explicit_only). No data yet is green.

## Model Experience

- **Per step**: the 5 tool schemas are injected into every model request (~300–800 tokens).
- **Per session**: the L0 catalog is one durable surface message (resident; re-sent only after compaction or an index change, capped at `index.maxTokens`, default 1200 — ~1000 tokens with the current memory count, near-zero incremental cost with KV cache).
- **Per explicit remember**: one tool call; the index rebuild is free (no LLM).

## Development

```sh
npm install            # project-local .npm-cache avoids a root-owned npm cache
npm run build          # tsc -> lib/
npm test               # node:test + tsx; includes a real Loader boot smoke
```

The Loader boot test (`tests/boot.test.ts`) boots a real `cordis.yml` through the Cordis Loader with the services the plugin needs and asserts all five tools register; it requires `npm run build` first (it loads the built `lib/`).

## License

MIT
