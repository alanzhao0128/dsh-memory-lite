# dsh-memory-lite

English | [简体中文](README.md)

**Cross-session long-term memory for your dsh agent.** Plain Markdown files, zero dependencies: preferences, decisions and constraints from a session survive restarts, upgrades and profile switches.

> Every dsh session starts from a blank page — transcripts are persisted for audit, but the model never sees them again. This plugin adds that layer back: one resident memory catalog + 5 memory tools + background extraction.

<p align="center">
  <img src="docs/preview/header-indicator.png" alt="The memory-lite indicator in the session header" height="44">
</p>

## Quick start (3 steps)

```sh
# 1. Install (= pnpm add inside the profile; the package is added to
#    dsh.profile.bundles automatically)
dsh plugin --profile web add @alanzhao/dsh-memory-lite

# 2. Restart dsh (the host half and the browser half load at boot)

# 3. Verify — the three checks below
```

After installing you should see:

- a `memory-lite` capsule in the session header: **green** = last extraction ok, gray = extraction off, red = last extraction failed
- a full settings page under **Settings → memory-lite** (screenshot below)
- ask the model to remember something ("remember that I use pnpm") — it calls `remember` and a file lands under `~/.agent-memory/peers/<peer>/memories/preferences/` (directories are created on first use)

Requirements: **dsh ≥ 0.1.5** (since 0.2.0 the plugin RPC uses the `/api` shared Fetch-route registry; `connection.rpc.handle` is unusable for third-party plugins after 0.1.3-alpha.2), Node ≥ 22.

<p align="center">
  <img src="docs/preview/settings-extraction.png" alt="Settings → memory-lite: extraction mode and triggers" width="560">
</p>

## Features

| What | Notes |
|---|---|
| Explicit memory (5 tools) | `read_memory` / `search_memory` / `remember` / `update_memory` / `forget_memory`; `update` archives the previous content into `## History`, `forget` is a soft delete into `.trash/` |
| L0 catalog injection | one resident catalog message per session (rendered from `_index.md`); re-published when the index changes or compaction moves it off the visible surface |
| Implicit extraction | a background run feeds the new conversation window to the model and applies a create / merge / update / skip decision, with dedup search and parse-failure repair |
| Cross-peer sharing | mount another peer's memories read-only under `shared/<name>/` |
| Header indicator | capsule + three-state dot in the session header, polling the run status every 10 s |
| Peer isolation | the peer name derives from the session cwd (basename + short hash); cwd-less sessions fall back to `defaultPeer` |

<p align="center">
  <img src="docs/preview/settings-model.png" alt="Settings → memory-lite: message scope, extraction model, reasoning effort" width="560">
</p>

## What it costs

| When | Cost |
|---|---|
| Every step | the 5 tool schemas are injected (~300–800 tokens) |
| Every session | one resident catalog message, capped at 1200 tokens by default; near-zero incremental cost once the KV cache hits |
| Every explicit remember | one tool call; the index rebuild costs no LLM |
| Every implicit extraction | **one LLM call** (two when the answer needs a repair), using your default model or a pinned one |

Default triggers: 50 new conversation messages (`windowTurns`) or 30 minutes idle (`idleTimeoutMin`); turn-boundary and flush triggers are off by default.

> **Tip**: extraction is a structured JSON task and needs no reasoning. Set **reasoning effort = off** — otherwise the model can spend the whole output budget thinking (two calls and 20–80 s per run).

## Configuration

Everything is edited in **Settings → memory-lite** and stored under the `dsh-memory-lite:` section of `~/.dsh/settings.yaml`. Most fields apply on save; `root` and `sharing.*` need a restart.

| Group | Field | Notes |
|---|---|---|
| Extraction | Mode | `incremental` (default, implicit extraction on) / `explicit_only` / `off` |
| Triggers | Window turns | one run once this many new messages accumulate; default 50; 0 = trigger on every message (not a disable) |
| | Idle timeout (min) | extract the remaining window after N idle minutes; default 30 |
| | Turn-boundary / flush triggers | off by default (more expensive) |
| | Min messages / debounce | thresholds for the two triggers above |
| Content | Max messages | most messages fed to the model per run; default 20 |
| | Message scope | default user + assistant; raw tool results excluded (cost and noise only); all three unchecked = the default |
| | Tool-result truncation (bytes) | only used when "tool results" is checked |
| | Include digest / dedup search | both on by default |
| Model | Extraction model | follows the live global default model unless pinned to a provider/model |
| | Reasoning effort | read from the selected model's declaration; **off is recommended** |
| Reliability | Parse retry | one cheap repair call when the answer is not valid JSON (on by default) |
| | Audit log | writes `peers/{peer}/sessions/{session-id}.json` and `extraction.log` |
| Catalog | Token cap | truncation cap for the L0 catalog, default 1200 |
| UI | Indicator order | header utilities slot order; refresh the page after saving |
| Storage | Memory root | `~/.agent-memory` by default, **restart to apply** |
| | Default peer | owner of cwd-less sessions |
| | Cross-peer sharing | master switch, **restart to apply**; individual mounts are picked below |

Full schema and defaults: [`src/config.ts`](https://github.com/alanzhao0128/dsh-memory-lite/blob/main/src/config.ts).

## What the memory looks like

```
~/.agent-memory/
├── peers/{peer}/
│   ├── memories/
│   │   ├── _index.md              # L0 catalog (generated; hand-editable)
│   │   ├── preferences/  entities/  events/  experiences/
│   │   │   └── {slug}.md          # L1 full text
│   └── sessions/                  # extraction bookmark + audit + extraction.log
└── .trash/                        # soft-deleted memories (dated folders)
```

Each memory file uses `## Current` / `## History` / `## Related`; updates archive instead of overwriting. The four categories are retrieval paths for the model: preferences (always relevant), entities (mentioned knowledge), events (time-related), experiences (task lessons).

## How it works (short version)

- **Catalog injection**: in the `agent/pre-step` waterfall the peer's `_index.md` is rendered into one `user/message` carrying the official `plugin` source kind with the `catalog` form; subagent sessions get none.
- **Extraction**: triggered by `windowTurns` or idle → select the window → grep existing memories for dedup → one LLM decision → write files → advance the per-session bookmark. **A failed run keeps the bookmark**, so the same window is retried on the next trigger.
- **Safety**: every file access goes through a containment boundary (relative paths only; `..`, absolute paths and symlink escapes are rejected at the executor).
- **Concurrency**: all writes go through a serial queue with atomic tmp+rename replacement.

Details (design tradeoffs, incident notes, known deviations) live in [`IMPLEMENTATION.md`](https://github.com/alanzhao0128/dsh-memory-lite/blob/main/IMPLEMENTATION.md).

## Troubleshooting

| Symptom | What to do |
|---|---|
| Nothing happens after installing; the model has no memory tools | **Restart dsh**; check that `dsh plugin --profile web ls` lists the package and that it is in `dsh.profile.bundles` |
| No memory-lite capsule in the header | Refresh the page; the slot lives in the header utilities row (order is configurable) |
| The capsule is red | The last extraction failed: read the `note` of the last line in `~/.agent-memory/peers/<peer>/sessions/extraction.log` |
| Extraction never fires | Check, in order: extraction mode, window turns, message scope, max messages (0 = nothing is extracted) |
| The log says `no configured model`, or the panel shows 已失效 (stale) | The extraction model was renamed or removed — pick another one |
| Extraction is slow / always `parse-error-recovered` | Reasoning effort is eating the output budget: set it to off |
| Memories land under the wrong peer | The peer derives from the session cwd; cwd-less sessions use `defaultPeer` (configurable) |

## Uninstall

```sh
dsh plugin --profile web remove @alanzhao/dsh-memory-lite
# restart dsh
```

Your memories are not deleted: `~/.agent-memory` is left for you to keep or remove.

## Known limits

- `forget_memory` has no approval gate (the model can soft-delete directly).
- `## Related` auto-maintenance is not implemented.
- No CLI / MCP entry point.
- The browser half (indicator + settings page) is verified on the dsh web profile only.
- Extraction quality depends on the model you pick; small models produce JSON that needs repair more often.

## Development

```sh
npm install
npm run build     # tsc -> lib/
npm test          # node:test + tsx, including a real Loader boot smoke test
```

## License

MIT
