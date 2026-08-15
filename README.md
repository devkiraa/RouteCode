# OpenRouter Claude Gateway (`openrouter-claude-router`)

Zero-latency intelligent OpenRouter failover gateway for **Claude Code** and LLM developer tools, built with [Bun](https://bun.sh).

## Quick Start (Single Command)

Run instantly without cloning or manual setup:

```bash
npx openrouter-claude-router
# or using bun
bunx openrouter-claude-router
```

Claude Code talks to one stable local endpoint (`http://127.0.0.1:8080`). The gateway:

- **Exposes every free OpenRouter model** — no selection needed. The free-model catalog
  shows up in Claude Code's own `/model` picker; pick any of them and the router uses it.
  Claude Code's built-in model names (`claude-sonnet-*`, `claude-haiku-*`, …) are
  automatically mapped to the best matching free model. (Claude Code's `/model` only keeps
  gateway models whose id contains `claude`/`anthropic` — it's hardcoded in its bundled
  source — so the router advertises the other free models under reversible gateway aliases
  and maps them back to the real OpenRouter id when you pick one.)
- **Proactive Rate-Limit Probing & Predictive Scoring** — queries OpenRouter `GET /api/v1/key`
  and OpenRouter rate-limit response headers (`x-ratelimit-*`) to score key health (0-100%)
  and proactively rotate keys *before* hitting HTTP 429 rate limit or 402 payment required errors.
- **Routes across multiple OpenRouter accounts** (one key per account in `settings.json`),
  rotating through healthy keys dynamically by predictive score.
- **Fails over automatically** — if a key returns `429`, `402`, `5xx`, or a network error, the
  router retries the same request with the next key. Failed keys enter an exponential
  cooldown so they aren't hammered while they're down.
- **Falls back when a free model is unusable** — free models get rate-limited (`429`) or
  disappear from the provider (`404`) all the time. When the model you picked fails like
  that on every key, the router retries the same request with another free model (default
  override → first free model) so your session keeps working instead of dying on a
  throttled or dead model. Key-level errors (`5xx`, network) are never masked.
- **Speaks plain tools to non-Anthropic models** — Claude Code's "deferred custom tools"
  (`defer_to_client`) are Anthropic-only; the router strips those flags for non-Anthropic
  models so Cohere, DeepSeek, etc. work instead of failing with a `400` (and it forces
  `ENABLE_TOOL_SEARCH=false` in Claude Code's settings so the requests are never generated).
- **Includes a local Web Dashboard** — view live request logs, key rate limit meters, credit balances, key cooldown countdown timers, model success rates, and request latency history at `http://localhost:8080/dashboard`.

```
Claude Code ──(Anthropic Messages API)──▶ gateway :8080 ──▶ OpenRouter /api/v1/messages
                                                │  ▲
                            pool of N keys ──────┘  └─ 429/5xx/network error → next key
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 or Node.js
- At least one OpenRouter account API key (`sk-or-v1-…`)

## Setup

```bash
# 1. Add your OpenRouter API keys — one per account
#    (edit the file that was created for you in settings.json)
```

`settings.json`:

```json
{
  "openrouterKeys": [
    "sk-or-v1-REPLACE_WITH_YOUR_FIRST_KEY",
    "sk-or-v1-REPLACE_WITH_YOUR_SECOND_KEY"
  ]
}
```

```bash
# 2. Start the gateway
npx openrouter-claude-router
```

That's it — no model selection. The router fetches the OpenRouter catalog, keeps the
**free models** (ids ending in `:free` or priced at $0), and advertises all of them to
Claude Code. Inside Claude Code, run `/model` and pick any free model you like.

## Web Dashboard

While the router is running, open the local telemetry dashboard in your browser:

```
http://localhost:8080/dashboard
```

The dashboard provides real-time updates (auto-refreshed every second) for:
- **Key Pool Status**: Healthy vs cooling-down OpenRouter API keys with live countdown timers.
- **Latency Sparkline**: Graph showing request response times for the last 30 requests.
- **Live Request Logs**: Searchable request table displaying request IDs, status codes, latency, models used, and key pool labels.
- **Model Statistics**: Aggregated success rates and average response times per free model.

API JSON statistics are also available at `http://localhost:8080/api/stats`.

## Point Claude Code at the router

### Automatic setup (default)

The router configures Claude Code for you. After the first run (and on every
startup) it merges its connection variables into **`~/.claude/settings.json`** —
the user-level file that applies to *every* project where you run `claude` —
creating the file if needed and leaving anything already in it untouched.

```
✓ Claude Code settings updated: C:\Users\you\.claude\settings.json
    ANTHROPIC_BASE_URL=http://127.0.0.1:8080
    ANTHROPIC_API_BASE_URL=http://127.0.0.1:8080
    CLAUDE_AGENT_API_BASE_URL=http://127.0.0.1:8080
    ANTHROPIC_AUTH_TOKEN=router
    ANTHROPIC_API_KEY=
    CLAUDE_CODE_USE_GATEWAY=1
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
    ENABLE_TOOL_SEARCH=false
```

The merge updates **all three base-URL variants** (the CLI, the Agent SDK and the
Codex bridge each read a different one) and **removes stale gateway leftovers** —
`apiKeyHelper`, top-level `model`, `ANTHROPIC_MODEL`, `CCR_CLAUDE_CODE_MODEL` and
`CODEXL_CLAUDE_CODE_MODEL` — so migrating from claude-code-router is a one-time
start of the router. Everything else in the file (theme, status line, spinner,
permissions, hooks, other env vars) is preserved.

Tune it in `system.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `autoConfigureClaude` | `true` | Set `false` to stop updating Claude Code's settings |
| `claudeSettingsPath` | `null` | Target file (`null` = `~/.claude/settings.json`; supports `~/…` and relative paths) |

### Manual setup

Claude Code settings files support an `env` block. Add it to one of these files
(more specific files win over less specific ones):

| File | Scope |
| --- | --- |
| `~/.claude/settings.json` | User-wide — applies to every project |
| `.claude/settings.json` | This project only — shared with the team |
| `.claude/settings.local.json` | This project only — machine-specific, git-ignored |

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_AUTH_TOKEN": "router",
    "ANTHROPIC_API_KEY": "",
    "CLAUDE_CODE_USE_GATEWAY": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ENABLE_TOOL_SEARCH": "false"
  }
}
```

- `ANTHROPIC_AUTH_TOKEN` can be any value — the router manages the real OpenRouter keys.
- `ANTHROPIC_API_KEY` must stay empty so it doesn't conflict with the bearer token.
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is optional — it lets Claude Code's
  `/model` command list the catalog from the router. **All free models appear** — Claude
  Code's picker filters gateway models to ids matching `/(claude|anthropic)/i` (hardcoded
  in its bundled source), and almost no free OpenRouter model matches that today, so the
  router advertises each non-Claude free model under a gateway alias like
  `anthropic/claude-route-<base64url-of-the-real-id>` (which passes the filter and shows
  the real model name as its label) and decodes it back to the real OpenRouter id when the
  request arrives. You'll see the actual model id as the option's description.
- `CLAUDE_CODE_USE_GATEWAY` is **required for `/model` to show the free models**: Claude
  Code only runs gateway model discovery when its provider mode is `"gateway"`, and the
  only way to reach that mode is `CLAUDE_CODE_USE_GATEWAY` + `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` set together (verified against Claude Code's source, issue
  anthropics/claude-code#84583). Without it, `/model` shows only the built-in models.
- `ENABLE_TOOL_SEARCH` must be `false`. With it on, Claude Code sends *deferred custom
  tools* (`defer_to_client`) that only Anthropic models accept — a non-Anthropic model
  (Cohere, DeepSeek, …) dies with `400 Deferred custom tools are only supported on
  Anthropic models`. The router also strips those flags on the way through, so requests
  still work even if tool search gets re-enabled.
- There's **no need to set `ANTHROPIC_MODEL`** — the router decides which free model a
  request uses (pass-through for free ids, class fallbacks for Claude Code's names).

> ⚠ Don't confuse this with this project's own root `settings.json`, which holds the
> router's **OpenRouter API keys**. Claude Code's settings live in `.claude/settings.json`
> (or `~/.claude/settings.json`).

### Alternative: environment variables

Same values as the settings-file `env` block, exported in your shell (Git Bash / Linux):

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_AUTH_TOKEN="router"          # any value — the router manages the real keys
export ANTHROPIC_API_KEY=""                   # keep empty to avoid auth conflicts
export CLAUDE_CODE_USE_GATEWAY="1"                       # required: puts Claude Code in gateway mode so /model discovery fires
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"   # makes /model list the router's free models
export ENABLE_TOOL_SEARCH="false"                        # required for non-Anthropic models (deferred tools are Anthropic-only)

claude
```

On Windows PowerShell: `$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8080"` (repeat for
each variable). Add the lines to your shell profile so every new terminal picks them up.

> If Claude Code was previously logged in to Anthropic, run `/logout` inside Claude Code
> once so cached OAuth tokens don't override these variables.

## While the server is running

Type any of these in the router's terminal:

| Command  | What it does                                                    |
| -------- | --------------------------------------------------------------- |
| `models` | List all available free models                                  |
| `model`  | Set/clear the default override (pick from the free list)        |
| `status` | Free-model count, override, port, and per-key health/cooldown   |
| `keys`   | List configured keys (masked)                                   |
| `quit`   | Stop the router                                                 |

## CLI flags

```
bun run index.ts                 start the router (all free models available, no selection)
bun run index.ts --model <id>    force one free model as the default override
bun run index.ts --select-model  open the picker to set that override
bun run index.ts --port 9000     change the port
```

## Configuration

### `system.json`

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8080` | Local port Claude Code connects to |
| `defaultModel` | `null` | Optional override — non-free requests fall back to it (null = auto) |
| `roundRobin` | `true` | `true`: spread load across healthy keys · `false`: always prefer the first keys |
| `openrouterBaseUrl` | `https://openrouter.ai/api` | Upstream API base (overridable) |
| `autoConfigureClaude` | `true` | Automatically merge the router env block into Claude Code's settings on startup |
| `claudeSettingsPath` | `null` | Claude Code settings file to update (`null` = `~/.claude/settings.json`) |
| `failover.maxRetries` | `0` | Keys tried per request (`0` = try every key) |
| `failover.cooldownBaseSeconds` | `10` | Cooldown after the first failure (doubles per consecutive failure) |
| `failover.cooldownMaxSeconds` | `300` | Cooldown cap |

### HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages API — proxied to OpenRouter with model rewrite + failover |
| `POST /v1/messages/count_tokens` | Token counting (model rewrite + failover) |
| `GET /v1/models` | Free-model catalog shown in Claude Code's `/model` picker (needs `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`) |
| `GET /health` | Model, key pool, cooldowns, request stats |

## Testing

```bash
bun test
```

The integration tests spin up a mock OpenRouter in-process and verify: model
rewriting, failover from a 429 key to a healthy key, all-keys-failed error
propagation, `count_tokens`, `/health` and `/v1/models`.

## How failover works

1. Each request asks the key pool for an ordered list of candidates — healthy keys
   first, then cooled-down keys (soonest expiry first).
2. The request is sent with the first candidate. Success moves the round-robin cursor
   and resets that key's failure streak.
3. On `429` / `5xx` / network error / timeout the key is marked failed with an
   exponential cooldown (`base × 2^n`, capped) and the request is retried with the
   next key. Upstream requests have a 5-minute timeout (`/v1/messages`) or 30-second
   timeout (`/v1/messages/count_tokens`) so a hung connection rotates instead of
   hanging your session.
4. If every key fails with a **model-level error** (`404` — the free model is dead or
   unsupported — or `429` — free tier rate limit), the router retries the whole
   request with the next model candidate (the default override, then the first free
   model) and logs `~ model "…" failed (429) → falling back to "…"`. This is what
   makes any pick in `/model` work even when that specific free model is throttled or
   broken.
5. If every key fails with a key-level error (`5xx`, network, auth) — or every model
   candidate fails — the last upstream error is returned to Claude Code.

> **Caveat:** failover happens *before* a response starts streaming. Once OpenRouter
> returns `200` and the SSE stream is flowing to Claude Code, a mid-stream failure
> cannot switch keys — Claude Code detects the truncated stream and retries on its side.

> 💡 Free tiers rate-limit per account. With one OpenRouter key, a rate-limited model
> falls back to another free model; with **multiple keys** in `settings.json` the router
> can also rotate accounts, which stretches your free quota much further.
