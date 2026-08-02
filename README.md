# pi-warm-cache

Pi extension that keeps Anthropic and OpenAI prompt caches warm during long idle gaps in agent sessions.

## Why

Large-context agent loops often hold 100k-300k+ tokens in the prompt prefix.
Provider prompt caches expire after a short idle TTL.

- Anthropic default: 5 minutes (sliding). Optional 1h TTL at higher write cost.
- OpenAI GPT-5.6+: explicit `prompt_cache_options.ttl = "30m"` (minimum lifetime).
- Older OpenAI routes: shorter in-memory idle windows.

When the cache expires, the next turn pays a cold re-read (or a costly rewrite).
This extension runs a lightweight "monitor on duty" that refreshes the cache before TTL expiry.

## Architecture

```
session_start
    │
    ▼
real agent turn
    │
    ├─ before_provider_request ──► snapshot EXACT provider payload (anchor)
    ├─ message_end(assistant)  ──► record cacheRead / prompt tokens / prices
    └─ agent_settled           ──► start provider-specific keepalive timer
                                      │
                                      ▼
                                 timer fires while idle
                                      │
                                      ▼
                         complete(model, dummyContext, {
                           sessionId: same as session,
                           cacheRetention: short|long,
                           maxTokens: 1,
                           onPayload: () => mutate(clonedAnchorPayload)
                         })
                                      │
                                      ├─ cache hit  ► update savings UI, reschedule
                                      └─ cache miss ► stop and wait for re-anchor
session_shutdown ──► clear timers / abort in-flight warm
```

### Design rule: payload replay, not Context rebuild

Do **not** rebuild a warm request from `getSystemPrompt()` + tools + `convertToLlm(branch)`.

That path will not byte-match Pi's real provider payload:

- tool order and schema serialization
- system prompt block splitting
- Anthropic `cache_control` breakpoints on last tool + last text block
- thinking / effort fields
- OpenAI `prompt_cache_key` / session affinity

A mismatch can turn every warm tick into a full cache **write** on a huge prefix.
That is worse than the cold read you tried to avoid.

Instead:

1. Capture `event.payload` from `before_provider_request` on real turns.
2. Replay a structured clone through `complete()` `onPayload`.
3. Change only output limits.
   Prefer `max_tokens = 1`.
   If Anthropic thinking is enabled, set `max_tokens = thinking.budget_tokens + 1`.
   Never mutate `thinking`, `reasoning.effort`, tools, messages, system blocks, or `cache_control`.
4. Keep the same `sessionId` and `cacheRetention`.
5. Never copy the summarize/handoff pattern of `cacheRetention: "none"` + fresh `uuidv7()` session ids.

Note: on high-thinking models a warm tick may still spend thinking tokens.
That cost is usually far below a cold re-read of a 100k-300k prefix.

### Lifecycle hooks

| Hook | Role |
|------|------|
| `session_start` | Bind context, load config/flags |
| `before_provider_request` | Read-only anchor of exact payload (never rewrite real turns) |
| `session_compact` / `session_tree` | Drop anchor (prefix changed) |
| `message_end` | Track cacheRead / prompt size / pricing |
| `agent_start` | Pause timer (real work already refreshes cache) |
| `agent_settled` | Schedule next warm tick |
| `model_select` / `thinking_level_select` | Drop anchor (cache key changed) |
| `session_shutdown` | Dispose timers and abort controllers |

### Drift / re-anchor policy

Prefix invalidation is **event-only**:

- `session_compact`
- `session_tree`
- `model_select`
- `thinking_level_select`
- next real `before_provider_request` capture

Idle `custom_message` / advisor injections do **not** drop the warm payload.
Those entries do not invalidate the provider cache written by the last real turn.

### Diagnostics

File logging is **off by default** (no project dotfile unless you opt in).

Enable with either:

```bash
PI_WARM_CACHE_DEBUG=1 pi
```

or:

```
/warm log
```

Then inspect:

```
.pi/warm-cache.jsonl
/warm          # includes last=... and log= path when enabled
```

Failures keep the widget visible with a reason. They do not silently clear to a blank editor.

### 1h Anthropic mode

This extension does **not** stamp `cache_control.ttl: "1h"` onto real turns.
That bypasses Pi's `supportsLongCacheRetention` gate and can 400 some routes.

Long TTL is detected from the on-wire payload Pi already sent.
To use 1h caches, set Pi cache retention to long.
`/warm 1h` only selects the long cadence when the captured payload already has 1h markers.
Otherwise it stays on the 5m strategy and warns.

OpenAI explicit vs implicit mode uses `model.compat.supportsExplicitPromptCacheMode` (default false).
Do not guess from model id strings.

### Keepalive strategy

| Family | TTL | Default interval | cacheRetention |
|--------|-----|------------------|----------------|
| `anthropic-short` | 5m | ~4m (0.8 × TTL) | `short` |
| `anthropic-long` | 1h | ~48m | `long` |
| `openai-explicit` | 30m min | ~24m | `short` (+ keep key) |
| `openai-implicit` | ~8m idle | ~6.4m | `short` |

### UI (reference style)

Widget above the editor while waiting:

```
⚡ Cache-warm wait · 1 monitor on duty
Continuation deferred 4m - the timed wake stays inside the 5m prompt-cache TTL.
~281.6K tokens kept warm · est. $2.53 saved vs a cold re-read
```

## Commands

```
/warm              # status
/warm on           # enable (also clears sticky auto-warm block)
/warm off          # disable
/warm now          # force one warm tick (allowed even when auto-warm is blocked)
/warm resume       # clear sticky large-output block
/warm codex-on     # enable Codex timer auto-warm (on by default)
/warm codex-off    # disable Codex timer auto-warm
/warm 5m           # Anthropic short TTL mode
/warm 1h           # Anthropic long cadence only when Pi on-wire payload already uses 1h
/warm auto         # detect
/warm log|nolog    # JSONL diagnostics on/off (.pi/warm-cache.jsonl)
/warm interval=3.5m max=2
```

Codex (`openai-codex-responses`) has no API output-token cap, so bare payload replay
can continue the agent trajectory and bill large `out` (measured `out=1127` on a hit).

**Working path (measured):** replay exact prefix + append constrained OK user suffix.

| Probe | read | write | out |
|---|---:|---:|---:|
| Bare replay hit | 38400 | 0 | 1127 |
| Manual `/warm now` + OK suffix | 41472 | 0 | 5 |
| Fresh session `/warm now` + OK suffix | 39424 | 0 | 17 |
| Timer tick after `/warm codex-on` | 39424 | 0 | 32 |

Policy:

- Codex timer auto-warm **on by default** (`allowCodexAutoWarm: true`) using OK-suffix.
- Sticky-block if a tick still emits huge output (`out >= 64`); `/warm resume` clears it.
- `/warm codex-off` disables Codex timers; `/warm now` still works.
- Anthropic / OpenAI Responses: exact replay + legal output caps (no suffix).
- Never send `max_output_tokens` on Codex (API rejects it).
- Do not mutate Codex `reasoning.effort` without a same-session proof.

### OpenAI workaround evaluation (adopted parts)

Sound ideas we adopted:

- Stable `prompt_cache_key` / session id.
- Lowest practical output cap where the API allows it.
- Extremely constrained warm user text as a **Codex suffix** after the real prefix.
- Accept small non-zero output cost; aim for manageable, not free.

Ideas we did **not** copy as-is:

- Rebuilding from a chat `messages` array instead of Pi's exact provider payload.
- Sending `max_output_tokens` on **Codex** ChatGPT routes.
- Treating this as equivalent to Anthropic `max_tokens: 0`.


Flag:

```
pi --warm-cache
pi --warm-cache=off
pi --warm-cache="1h interval=45m"
```

## Install

```bash
pi install /absolute/path/to/pi-warm-cache
# or for a one-off test:
pi -e ./src/index.ts
```

## Config schema

```ts
interface WarmCacheConfig {
  enabled: boolean;                  // default true
  anthropicTtl: "5m" | "1h" | "auto";
  intervalMs: number | null;         // null = strategy default
  maxConcurrentWarmSessions: number; // default 3
  minCachedTokens: number;           // default 512
  maxConsecutiveFailures: number;    // default 3
  showWidget: boolean;               // default true
  warmSuffix: string;                // unused on payload-replay path
  maxOutputTokens: number;           // preferred floor; API may raise (e.g. OpenAI >= 16)
  logToFile: boolean;                // default false; PI_WARM_CACHE_DEBUG=1 or /warm log
}
```

## Edge cases (handle early)

1. **Payload drift / miss with write** - stop warming until the next real turn re-anchors. Do not keep paying write premium.
2. **Model or thinking-level change** - drop anchor immediately. Caches are per model and often per effort.
3. **Compaction / branch navigation** - next real turn produces a new payload; old anchor is replaced on capture.
4. **Agent busy at tick** - skip and reschedule. Never steer or follow-up a live turn for warming.
5. **Concurrency** - process-wide gate limits simultaneous warm HTTP calls across sessions.
6. **Unsupported provider** - show disabled status; no timers.
7. **Small prefix** - below `minCachedTokens`, warming is not worth the request overhead.
8. **Session resume** - do not restore old payloads. Wait for the first real turn.
9. **Print/RPC modes** - still warm if enabled, but skip TUI widgets when `!ctx.hasUI`.
10. **1h Anthropic mode** - follow on-wire Pi long TTL only. This extension does not rewrite real turns.
11. **Codex / openai-codex-responses** - never send `max_output_tokens` (API rejects it).
12. **OpenAI Responses** - `max_output_tokens` floor is 16, not 1.
11. **Do not use `sendUserMessage`** - it pollutes history and can trigger tool loops.
12. **Abort on shutdown / disable** - clear `setTimeout` / `setInterval` and abort in-flight `complete()`.

## Package layout

```
src/
  index.ts      # extension entry, hooks, /warm command
  warmer.ts     # timer + payload replay loop
  provider.ts   # family detection + payload mutation
  config.ts     # config parsing + formatters
  savings.ts    # estimated USD saved
  ui.ts         # widget / status line
  types.ts      # interfaces
```

## Next implementation steps

1. Verify `onPayload` full replacement is honored for Anthropic and OpenAI routes in your Pi version.
2. Add unit tests for `applyWarmOutputLimit`, strategy intervals, and savings math.
3. Log warm hits via `pi.appendEntry("pi-warm-cache-stats", ...)` for session-level totals.
4. Optionally hide warm HTTP from user-visible TPS footer (it already stays out of the transcript).
5. E2E: idle past 4 minutes with a large cached prefix and confirm `cacheRead > 0` on the warm response.
