# pi-warm-cache

Pi extension that keeps supported provider prompt caches warm during long idle gaps in agent sessions.

## Why

Large-context agent loops often hold 100k-300k+ tokens in the prompt prefix.
Provider prompt caches expire after a short idle period.

When a cache expires, the next turn pays a cold read or a costly rewrite.
This extension runs a lightweight keepalive probe before the provider cache is likely to expire.

## Current provider support

The extension verifies the complete provider route before it enables automatic warming.
Provider identity, API transport, endpoint, compatibility metadata, model, and captured payload shape must agree.

### Verified automatic warming

| Provider route | API transport | Strategy | Notes |
|---|---|---|---|
| Anthropic first-party | `anthropic-messages` | `anthropic-short` or `anthropic-long` | Uses cache markers from the captured payload. |
| Registered Anthropic-compatible route | `anthropic-messages` | `anthropic-short` or `anthropic-long` | Requires `compat.cacheControlFormat = "anthropic"`. |
| OpenAI first-party | `openai-responses` or `openai-completions` | `openai-explicit` or `openai-implicit` | Requires the first-party OpenAI route. |
| Azure OpenAI | `azure-openai-responses` | OpenAI response strategy | Uses the registered Azure route. |
| OpenAI Codex | `openai-codex-responses` | Codex policy | Uses the Codex-specific output policy. |
| xAI Grok 4.5 | `openai-responses` | `xai-best-effort` | Requires `https://api.x.ai` and a captured `prompt_cache_key`. |

Direct xAI Grok 4.5 warming is best effort.
Its default probe cadence is 4 minutes, but this is an operational heuristic and not a provider TTL guarantee.

xAI may expose cached reads without exposing a separate cache-write token count through Pi.
Repeated no-read/no-write probes stop warming and request a new real-turn anchor after the configured failure budget.

### Manual probe only

Other direct xAI models on the first-party xAI endpoint can use one clearly labelled manual probe when their captured payload is safe to replay.
They do not receive an automatic timer or a verified savings claim.

### Unsupported routes

OpenRouter, OpenCode Go, and other API-compatible proxy routes do not inherit first-party support.
Routes without an explicit registered capability are rejected before the provider is called.

## Install

Install the published package from npm:

```bash
pi install npm:pi-warm-cache
```

For development or testing of an unreleased change, install the repository checkout:

```bash
pi install /absolute/path/to/pi-warm-cache
```

Run the source extension for one session without installing it:

```bash
pi -e /absolute/path/to/pi-warm-cache/src/index.ts
```

Restart or reload Pi after changing an installed package.

## Architecture

```text
session_start
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Real agent turn                                             │
│                                                             │
│ agent_start                                                 │
│   Pause the keepalive timer                                 │
│ before_provider_request                                     │
│   Capture the exact provider payload                        │
│ message_end(assistant)                                      │
│   Record real-turn cache usage                              │
│ agent_settled                                               │
│   Schedule the provider-specific keepalive timer            │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Idle keepalive timer                                        │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Replay the captured payload                                 │
│                                                             │
│ complete(model, dummyContext, {                             │
│   sessionId: same as session,                               │
│   cacheRetention: short | long,                             │
│   onPayload: () => mutate(clonedAnchorPayload)              │
│ })                                                          │
└─────────────────────────────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
              ▼                                 ▼
┌───────────────────────────┐     ┌───────────────────────────┐
│ Probe hit                 │     │ Probe miss                │
│ Update diagnostics        │     │ Retry, or wait for a new  │
│ and reschedule            │     │ real-turn anchor          │
└───────────────────────────┘     └───────────────────────────┘

session_shutdown
    └─ Clear timers and abort in-flight warm requests
```

### Design rule: payload replay, not context rebuild

Do not rebuild a warm request from `getSystemPrompt()` plus tools and `convertToLlm(branch)`.

That path can change the provider payload through tool ordering, schema serialization, system prompt blocks, cache markers, thinking fields, or session affinity.

A mismatch can turn every warm tick into a full cache write on a large prefix.
That is worse than the cold read the probe tried to avoid.

The extension therefore:

1. Captures `event.payload` from `before_provider_request` on real turns.
2. Replays a structured clone through `complete()` and `onPayload`.
3. Changes only the output field allowed by the selected route.
4. Preserves the same session identity, cache retention, tools, messages, system blocks, reasoning fields, and cache-routing fields.
5. Drops the anchor when the provider payload or cache identity changes.

Anthropic probes use `max_tokens` with the minimum required by the thinking budget.
OpenAI Responses and xAI Responses probes use a legal `max_output_tokens` floor of 16.
Codex Responses probes never add `max_output_tokens` and use the Codex-specific policy.

### Lifecycle hooks

| Hook | Role |
|---|---|
| `session_start` | Bind context and load configuration. |
| `before_provider_request` | Capture the exact real-turn payload. |
| `session_compact` / `session_tree` | Drop the anchor because the prefix changed. |
| `message_end` | Track real-turn cache usage, prompt size, and pricing. |
| `agent_start` | Pause the timer while the agent is working. |
| `agent_settled` | Schedule the next keepalive probe. |
| `model_select` / `thinking_level_select` | Drop the anchor because the cache identity changed. |
| `session_shutdown` | Dispose timers and abort in-flight requests. |

### Drift and re-anchor policy

The anchor is invalidated by compaction, tree navigation, model changes, and thinking-level changes.

The next real turn also performs a payload-continuity check.
A non-continuing prefix becomes an unknown real-turn observation and replaces the old anchor.

Idle custom messages and advisor injections do not drop the warm payload.
Those entries do not change the provider cache written by the last real turn.

## Diagnostics

File logging is off by default.
Enable it with an environment variable or the `/warm log` command:

```bash
PI_WARM_CACHE_DEBUG=1 pi
```

```text
/warm log
```

When enabled, diagnostics are written to `.pi/warm-cache.jsonl`.
The `/warm` status and `/warm now` result include the provider route, capability state, strategy, cadence, payload fingerprint, redacted cache-key identity, observed usage, and retry state.

`realTurn=unknown` is used for the first turn, invalidation boundaries, changed prefixes, and prompts below the configured minimum.

`probeHits` and `probeMisses` count extension probes only.

`/warm` includes a stable `savingsSummary` with probe hits, misses, total estimated savings, total probe cost, net, and the pricing source.

Use `/warm savings` to print only that cumulative summary.

When model pricing is unavailable or unusable, the summary reports monetary values as `n/a`.

A first implicit-cache `read=0 write=0` probe is labelled `transient-miss` and retries quietly.

A provider error is reported as an error and does not increment `probeMisses`.

## Keepalive strategies

| Strategy | Cache behavior | Default interval | Cache retention |
|---|---|---:|---|
| `anthropic-short` | 5-minute sliding cache window | about 4 minutes | `short` |
| `anthropic-long` | 1-hour cache markers already present on the wire | about 48 minutes | `long` |
| `openai-explicit` | 30-minute explicit prompt-cache mode | about 24 minutes | `short` |
| `openai-implicit` | older in-memory idle window | about 6.4 minutes | `short` |
| `xai-best-effort` | no fixed provider TTL claim | 4-minute heuristic | `short` plus captured key |

The existing `interval` configuration overrides the default interval for every strategy, including xAI best-effort probes.

The 1-hour Anthropic mode follows the cache retention already present in the Pi payload.
The extension does not stamp `cache_control.ttl = "1h"` onto real turns.

## Commands

```text
/warm                  # show status and cumulative savings
/warm savings          # show only the cumulative savings summary
/warm on               # enable and clear a sticky automatic-warm block
/warm off              # disable warming
/warm now              # force one probe when the captured route permits it
/warm resume           # clear a sticky large-output block
/warm codex-on         # enable Codex timer warming
/warm codex-off        # disable Codex timer warming
/warm 5m               # select Anthropic short cadence
/warm 1h               # select Anthropic long cadence when the payload supports it
/warm auto              # select the provider strategy automatically
/warm log              # enable JSONL diagnostics
/warm nolog            # disable JSONL diagnostics
/warm interval=3.5m max=2
```

The extension can also be configured when Pi starts:

```bash
pi --warm-cache
pi --warm-cache=off
pi --warm-cache="1h interval=45m"
```

## Configuration

```ts
interface WarmCacheConfig {
  enabled: boolean;                  // default true
  anthropicTtl: "5m" | "1h" | "auto";
  intervalMs: number | null;         // null = strategy default
  maxConcurrentWarmSessions: number; // default 3
  minCachedTokens: number;           // default 512
  maxConsecutiveFailures: number;    // default 3
  showWidget: boolean;               // default true
  warmSuffix: string;                // reserved for route-specific policies
  maxOutputTokens: number;           // preferred output floor
  logToFile: boolean;                // default false
}
```

## Edge cases

1. **Payload drift or a probe miss with a write** - stop warming until the next real turn re-anchors.
2. **Implicit-cache probe miss** - retry the first no-read/no-write result quietly, then expose repeated misses.
3. **Model or thinking-level change** - drop the anchor immediately.
4. **Compaction or branch navigation** - replace the old anchor on the next real turn.
5. **Agent busy at a tick** - skip the tick and reschedule without steering the live turn.
6. **Concurrency** - a process-wide gate limits simultaneous warm requests across sessions.
7. **Unsupported provider** - clear the active widget and status without calling the provider.
8. **Small prefix** - do not warm below the configured minimum cached-token threshold.
9. **Session resume** - wait for the first real turn instead of restoring an old payload.
10. **Print or RPC mode** - keep warming when enabled, but skip TUI widgets when no UI exists.
11. **Direct xAI Grok 4.5** - require the first-party Responses route and a captured `prompt_cache_key`.
12. **Shutdown or disable** - clear timers and abort in-flight `complete()` calls.

## Package layout

```text
src/
  index.ts      # extension entry and /warm command
  warmer.ts     # timer and payload replay loop
  capability.ts # explicit provider-route capability classification
  provider.ts   # strategy selection and payload mutation
  config.ts     # configuration parsing and formatters
  savings.ts    # estimated savings calculation
  ui.ts         # widget and status rendering
  types.ts      # shared interfaces
```

## Development

Clone the repository and install its development dependencies:

```bash
git clone https://github.com/ribbons-digital/pi-warm-cache.git
cd pi-warm-cache
pnpm install
```

Run the unit tests and type check:

```bash
pnpm test
pnpm exec tsc --noEmit
```

Build changes on a feature branch and open a pull request against `main`.

## Release

The repository includes a manual GitHub Actions release workflow that uses npm Trusted Publishing.
It does not require an npm token or an interactive OTP.

Before the first release, register the repository and `release.yml` as a trusted publisher for `pi-warm-cache` on npmjs.com.
Use the `npm-release` GitHub environment name when configuring the trusted publisher.
Under "Allowed actions", ensure npm publish is listed as a required configuration.

For each release:

1. Update `package.json` and commit the version on `main`.
2. Create and push the matching tag, such as `v0.2.0`.
3. Run **Publish npm package** from the GitHub Actions tab with that tag.
4. Confirm the package version on npmjs.com.

The workflow checks the tag, runs tests and type checks, validates the exact publish tarball, and publishes with provenance.

## Manual validation

Use the E2E procedure in [`docs/e2e-idle-test.md`](docs/e2e-idle-test.md) with a real provider account.

The most useful check is a large captured prefix, one manual `/warm now` probe, and at least three idle timer ticks.

A live xAI validation must record the route, prompt-cache key identity, cache reads, cache writes, output, cost, and retry values.

## License

MIT
