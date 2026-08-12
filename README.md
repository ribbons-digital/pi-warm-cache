# pi-warm-cache

Pi extension that keeps supported provider prompt caches warm during long idle gaps in agent sessions.

## Why

Large-context agent loops often hold 100k-300k+ tokens in the prompt prefix.
Provider prompt caches expire after a short idle period.

When a cache expires, the next turn pays a cold read or a costly rewrite.
This extension runs a lightweight keepalive probe before the provider cache is likely to expire.

## Safety rules

pi-warm-cache is conservative by design.
These four rules are non-negotiable:

1. **Exact payload replay only** - never rebuild context from the live session.
2. **Strict capability verification** - automatic warming is allowed only on routes that resolve to `state: "verified"`.
3. **Hard invalidation on real prefix drift** - drop the anchor immediately on compaction, model switch, thinking-level change, or a non-continuing payload.
   Issue no probe until a new real payload is captured.
4. **No invented pricing** - savings estimates use only the model-supplied `cost` fields.
   If pricing is missing or unusable, report `n/a`.

Capture is read-only: pi-warm-cache never rewrites real turns.
Provider guidance lists extension payload mutation as a top cause of cache instability, so read-only capture is both a safety rule and cache hygiene.

Capture happens on the read-only `before_provider_request` hook.
If a co-installed rewriter edits the body before our hook, we capture and replay its body, and the foreign-instrumentation rule refuses it when it is illegal for the route.
If a rewriter edits after our capture, our replay differs from the real wire body and the failure mode is a cache miss, never an error.

The extension supports Pi only.
Tau is out of scope.

## Provider support

The extension verifies the complete provider route before it enables automatic warming.
Provider identity, API transport, endpoint, compatibility metadata, model, and captured payload shape must agree.

### Automatic keepalive

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

### OpenCode Go coverage

All 16 OpenCode Go models are registered across three API transports: 12 `openai-completions`, 3 `anthropic-messages`, and 1 `openai-responses`.
The extension classifies each captured payload by the cache instrumentation actually observed on the wire, so the coverage depends on the retention setting Pi emits.

| OpenCode Go route | What the extension does | Coverage |
|---|---|---|
| `anthropic-messages`, default short retention | keepalive probe about every 4 minutes | Automatic keepalive |
| `anthropic-messages`, long retention (`ttl: "1h"` on the wire) | no timer; one safe manual probe | Manual only |
| `anthropic-messages`, no cache markers | no timer; one safe manual probe | Manual only |
| `openai-completions`, default retention | native cache outlives idle gaps, so no keepalive is scheduled; `/warm now` stays available | Keepalive not needed |
| `openai-completions`, 24h retention on the wire | keepalive is not needed; never probes | Keepalive not needed |
| `openai-responses`, stable prompt-cache key | keepalive probe about every 4 minutes | Automatic keepalive |
| `openai-responses`, 24h retention on the wire | keepalive is not needed; never probes | Keepalive not needed |

The default configuration of every OpenCode Go model is covered.
The manual-only paths are the non-default retention settings and a marker-less Anthropic payload; they may gain automatic keepalive in a future release.

Retention wins over markers on the wire, because it is the stronger lifetime signal.
A keyed-but-unretained payload behaves like plain: the gateway in-memory TTL is still the default.
The plain family carries a hint in its status line to set Pi cache retention to long while its pair is manual-only.
No OpenCode Go family renders a numeric lifetime; the cadences are best-effort probe cadences, not provider TTL claims.

OpenCode Go routes must match their registered API transport and exact endpoint: `anthropic-messages` at `https://opencode.ai/zen/go`, and `openai-completions` and `openai-responses` at `https://opencode.ai/zen/go/v1`.
A longer path never matches a shorter registered path.
They never inherit a first-party OpenAI or Anthropic strategy.

OpenCode Go `openai-completions` payloads may carry `cache_control` only when the route compat declares `cacheControlFormat: "anthropic"`.
No OpenCode Go completions model declares it today, so a captured completions payload containing `cache_control` is evidence of third-party mutation (for example the community `pi-opencode-go-cache` rewriter) and is refused for replay with a reason naming the foreign instrumentation.
The `anthropic-messages` transport carries `cache_control` by design and is never refused.

### Manual probe only

Other direct xAI models on the first-party xAI endpoint can use one clearly labelled manual probe when their captured payload is safe to replay.
They do not receive an automatic timer or a verified savings claim.

OpenRouter routes are manual-only.
Each route must match its registered API transport, exact endpoint, and routing metadata.

### Unsupported routes

Unregistered proxy routes, proxy routes with a different endpoint or routing format, and other API-compatible routes do not receive support.
Routes without an explicit registered capability are rejected before the provider is called.

## When this helps / When it does not

### When this helps

- It helps when a verified provider route holds a large prompt prefix across a long idle gap.
- It helps when you want the extension to replay the exact captured provider payload instead of rebuilding context.
- It helps when you need separate diagnostics for real-turn cache usage and extension warm probes.

### When this does not help

- It does not warm a prefix below `minCachedTokens` or make a small prompt more valuable to cache.
- It does not enable automatic warming for unsupported or manual-only routes.
- Manual-only routes can use one safe `/warm now` probe, but they do not receive a timer or a verified savings claim.
- The OpenCode Go no-keepalive families never arm a timer: the retained family refuses `/warm now` entirely, while completions plain keeps it for cold-cache protection and TTL uncertainty.
- xAI best-effort warming does not promise a provider TTL, a cache hit, or a fixed saving amount.
- It does not preserve an old anchor after compaction, model or thinking-level changes, branch changes, or other prefix drift.
- It does not invent a savings amount when the active model has no usable pricing data.
- It does not support Tau.

## Install

Install the published package from npm:

```bash
pi install npm:pi-warm-cache
```

For an unreleased checkout or local testing, install the repository directory:

```bash
pi install /absolute/path/to/pi-warm-cache
```

Run the source extension for one session without installing it:

```bash
pi -e /absolute/path/to/pi-warm-cache/src/index.ts
```

Restart or reload Pi after changing an installed package.

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
/warm auto             # select the provider strategy automatically
/warm log              # enable JSONL diagnostics
/warm nolog            # disable JSONL diagnostics
/warm interval=3.5m max=2 maxidle=2h spend=2.5
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
  maxIdleWarmMs: number | null;      // null = max(30m, 2 x referenceMs); 0 = no cutoff
  warmSpendCeilingUsd: number | null;// null = $1.00 for opencode-go; 0 = unlimited
  showWidget: boolean;               // default true
  warmSuffix: string;                // reserved for route-specific policies
  maxOutputTokens: number;           // preferred output floor
  logToFile: boolean;                // default false
}
```

## Keepalive strategies

| Strategy | Cache behavior | Default interval | Cache retention | State |
|---|---|---:|---|---|
| `anthropic-short` | 5-minute sliding cache window | about 4 minutes | `short` | verified |
| `anthropic-long` | 1-hour cache markers already present on the wire | about 48 minutes | `long` | verified |
| `openai-explicit` | 30-minute explicit prompt-cache mode | about 24 minutes | `short` | verified |
| `openai-implicit` | older in-memory idle window | about 6.4 minutes | `short` | verified |
| `xai-best-effort` | no fixed provider TTL claim | 4-minute heuristic | `short` plus captured key | verified |
| `opencode-go-retained` | 24h retention requested on the wire | no keepalive scheduled | `none` | verified on completions; never probes on any transport |
| `opencode-go-long-marker` | anthropic-style `cache_control` with `ttl: "1h"` | about 48 minutes (best-effort) | `long` | manual only |
| `opencode-go-short-marker` | `cache_control` ephemeral without ttl | about 4 minutes (best-effort) | `short` | verified on anthropic-messages |
| `opencode-go-plain` | no cache instrumentation | about 4 minutes (best-effort) | `short` | verified on completions and responses; manual on anthropic plain-fallback |

### Spend guardrails

The idle warm cutoff applies to every family: the timer stops when the session has been idle since the last real turn for `max(30m, 2 x referenceMs)`, where `referenceMs` is the family TTL when one exists and the interval otherwise.
`anthropic-long` and `opencode-go-long-marker` probe at 48m and 96m under a 120m cutoff; short families stop after 30m idle.
`maxidle=0` restores warm-until-failure.

The probe-spend ceiling is active by default only for `opencode-go` at $1.00 per provider per campaign, with a 250-probe fallback when model cost fields are zero or unusable.
The `spend=` token extends the ceiling to any provider; `spend=0` disables it for every provider (an extension mirroring `maxidle=0`).
Raising or disabling the ceiling resumes a soft-blocked session immediately; lowering it keeps the block until the next real turn.
A real turn resets the campaign ledger; both guards are scoped to timer fires only, so `/warm now` always bypasses them.

The existing `interval` configuration overrides the default interval for every strategy, including xAI best-effort probes.

The xAI `prompt_cache_key` must be a stable non-empty string without surrounding whitespace or control characters.

A missing, invalid, or changed xAI key disables best-effort probing until a new exact real-turn payload is captured.

The four-minute xAI interval is an operational heuristic and is not a provider TTL guarantee.

The 1-hour Anthropic mode follows the cache retention already present in the Pi payload.
The extension does not stamp `cache_control.ttl = "1h"` onto real turns.

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
The [diagnostics reference](docs/upgrade-notes.md) defines the `/warm` status fields, lifecycle states, savings summary, and JSONL schema.
The `/warm` status and `/warm now` result include the provider route, capability state, strategy, cadence, payload fingerprint, redacted cache-key identity, observed usage, retry state, and active warm-session count.

The redacted cache-key fingerprint covers `openai-responses`, `openai-completions`, and `azure-openai-responses` payloads: any captured top-level `prompt_cache_key` is reduced to an 8-hex identity and never written to status or logs.

When a timer probe is deferred, `/warm` reports the deferral reason and the occupied concurrency slots.
The `/warm now` output reports the same information when its request is deferred.

`realTurn=unknown` is used for the first turn, invalidation boundaries, changed prefixes, and prompts below the configured minimum.

`probeHits` and `probeMisses` count extension probes only.

`/warm` includes a stable `savingsSummary` with probe hits, misses, total estimated savings, total probe cost, net, and the pricing source.

Use `/warm savings` to print only that cumulative summary.

When model pricing is unavailable or unusable, the summary reports monetary values as `n/a`.

OpenCode Go savings are framed honestly as subscription budget-dollars: the label appends `(subscription budget-dollars)` and the summary appends `savingsUnit=budget-dollars`, because Go spend draws on a subscription budget rather than per-token invoicing.

A first implicit-cache `read=0 write=0` probe is labelled `transient-miss` and retries quietly.

A provider error is reported as an error and does not increment `probeMisses`.

## Edge cases

1. **Payload drift or a probe miss with a write** - stop warming until the next real turn re-anchors.
2. **Implicit-cache probe miss** - retry the first no-read/no-write result quietly, then expose repeated misses.
3. **Model or thinking-level change** - drop the anchor immediately.
4. **Compaction or branch navigation** - replace the old anchor on the next real turn.
5. **Agent busy at a tick** - skip the tick, report `deferred=agent busy`, and reschedule without steering the live turn.
6. **Concurrency** - a process-wide gate limits simultaneous warm requests across sessions.
   A full gate reports `activeWarmSessions=<active>/<max>` and `deferred=concurrency limit (<active>/<max> slots used)`.
   When file logging is enabled, the deferred tick emits a `warm_deferred` JSONL event without sending a provider request.
7. **Unsupported provider** - clear the active widget and status without calling the provider.
8. **Small prefix** - do not warm below the configured minimum cached-token threshold.
9. **Session resume** - wait for the first real turn instead of restoring an old payload.
10. **Print or RPC mode** - keep warming when enabled, but skip TUI widgets when no UI exists.
11. **Direct xAI Grok 4.5** - require the first-party Responses route and a stable captured `prompt_cache_key`.
12. **Manual-only proxy routes** - require the explicitly registered provider, API transport, proxy endpoint, and routing metadata; never arm a timer.
13. **xAI no-read/no-write probes** - retry within the configured failure budget, then stop and request a new real-turn anchor with a best-effort explanation.
14. **Shutdown or disable** - clear timers and abort in-flight `complete()` calls.
15. **Foreign instrumentation on an OpenCode Go completions payload** - refuse replay when `cache_control` appears without `cacheControlFormat: "anthropic"` compat, because the route cannot legally carry it.
16. **OpenCode Go family classification** - the family is payload-driven and independent of capability state; the retained family never probes on any transport (including `/warm now`); the verified completions-plain family is no-keepalive but keeps `/warm now`; the plain family carries the degraded retention hint in its reason only while its pair is manual-only.
17. **Interleaved sessions and the shared spend ledger** - the probe-spend ledger is shared per provider, so when one session on the same provider takes real turns while another session idles, the shared campaign counter never accumulates for the idle session. The idle cutoff still bounds the idle session's probes, and the per-instance soft block stops it once its own probes trip the ceiling.

## License

MIT
