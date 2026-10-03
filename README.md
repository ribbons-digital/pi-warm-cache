# pi-warm-cache

Keeps supported provider prompt caches warm during long idle gaps in Pi sessions.

Large prompts often sit in a provider cache.
That cache expires if you leave the session idle.
The next turn then pays a cold read or a costly rewrite.
This extension sends a small keepalive probe before that is likely to happen.

It requires [Pi](https://github.com/badlogic/pi-mono) 0.84 or newer.

## How it works

The extension copies the last real provider request and replays it with a tiny output limit.
It does not rebuild the conversation.
It does not change your real turns.
It does not run tools.

Automatic keepalive runs only on verified routes.
Requests that disable caching or use budget-based Anthropic thinking do not receive automatic probes.
A timer that wakes after the route's cache-refresh deadline drops the old payload and waits for a new real turn.
The deadline uses request capture or successful replay dispatch time, not response arrival time.
It is a safety limit, not proof of the provider's cache lifetime.
After compaction, a model change, a thinking-level change, or a branch change, it waits for the next real turn before probing again.
Starting a real turn cancels any in-flight extension probe so the new request can become the anchor.
A late reply from the cancelled probe cannot replace that anchor or count as a fresh probe hit.
Cancellation does not guarantee that the provider charges nothing for a request already sent.

Savings numbers use only the prices on the active model.
They compare cold-input and cached-read prices for probe hits, not proven savings on your next real turn.
If those prices are missing, the status shows `n/a`.

## Pi's native warmer

Pi 0.86 and newer also have a native warmer.
Pi v1 defaults to `cacheWarming: "streaming"`; `idle` and `off` are the other modes.
The extension stops native warming on routes that it owns, including OpenAI routes with subscription or unknown authentication and verified routes restricted by request safety.
Ownership does not fall back to native warming merely because an extension timer is paused, blocked, or idle.
Other routes retain Pi's native behavior.
`/warm` shows the route owner.

On owned routes, native streaming warming also stops.
This extension warms only while idle, not during long tool work.
`/warm off` disables only the extension and releases its native veto.
It does not turn off Pi's native warmer or provider caching.
After off/on, reload, or session replacement, send a new real turn before using `/warm now` or a timer.

A native request already sent cannot be cancelled by the veto.
A later extension decision can also override it.
If another extension conflicts, set Pi's global `cacheWarming` to `off` while using pi-warm-cache.
Native usage is not included in this extension's probe counters.

## Install

```bash
pi install npm:pi-warm-cache
```

Restart or reload Pi after install.

## Commands

```text
/warm                  # show status and savings
/warm savings          # show only the savings summary
/warm on               # enable the extension; off/on needs a new real turn
/warm off              # disable the extension only; Pi native warming is unchanged
/warm now              # send one probe when the current route allows it
/warm resume           # clear a sticky automatic-warm block
/warm codex-on         # enable Codex timer warming
/warm codex-off        # disable Codex timer warming
/warm 5m               # Anthropic short cadence
/warm 1h               # Anthropic long cadence when the request already uses it
/warm auto             # follow the provider strategy
/warm log              # write a local diagnostic log
/warm nolog            # stop the diagnostic log
/warm interval=3.5m max=2 maxidle=2h spend=2.5
```

You can also set this when Pi starts:

```bash
pi --warm-cache
pi --warm-cache=off
pi --warm-cache="1h interval=45m"
```

## What stays warm

Automatic keepalive is on for these registered routes:

| Route | What you get |
|---|---|
| Anthropic | Probe about every 4 minutes, or about every 48 minutes when the request already uses a 1-hour cache |
| OpenAI API key | Probe on the cache window selected from the captured request; explicit thirty-minute TTL must be present on the wire |
| Azure OpenAI | Same OpenAI response strategy |
| Legacy OpenAI Codex | Timer on by default with output-spike protection; `/warm codex-off` disables timers |
| xAI Grok 4.5 | Best-effort probe about every 4 minutes when the request has a stable cache key |
| OpenCode Go (default setup) | Keepalive on short Anthropic and keyed Responses routes; no timer on Completions because that cache already lasts a long time |

`/warm now` sends one probe.
On verified automatic routes, the existing timer policy can continue afterward.
On manual-only routes, no keepalive timer starts.

These routes allow `/warm now` only:

- OpenAI ChatGPT sign-in on the exact tested profiles described below
- Other first-party xAI models, when the captured request is safe to replay
- OpenRouter, on the registered OpenRouter endpoint
- Some non-default OpenCode Go retention settings

Unlisted proxies and other compatible APIs stay off.
The extension will not call the provider for those routes.

xAI Grok 4.5 keepalive is best effort.
The 4-minute cadence is not a provider TTL promise.
If probes keep returning no cache read, warming stops until the next real turn.

OpenCode Go must use the registered endpoints: Anthropic at `https://opencode.ai/zen/go`, and OpenAI-style APIs at `https://opencode.ai/zen/go/v1`.

### OpenAI ChatGPT sign-in

This is not the legacy `openai-codex` connection.
Automatic warming stays off because cache preservation is unverified.
`/warm on`, interval overrides, and `/warm codex-on` do not bypass that restriction.

One manual probe is allowed only for first-party `openai` / `openai-responses` at `https://api.openai.com/v1`:

- `gpt-5.6-luna` with thinking off
- `gpt-6.1-sol` with low thinking

It also needs a safe captured real request with a stable cache key and `store: false`.
Unknown authentication, other profiles, changed endpoints, or unsafe payloads are refused.
The probe changes only the output cap to sixteen tokens.
It has forty-five-second cancellation, zero automatic HTTP retries, and no queued follow-up after success, failure, timeout, or refusal.
A configured spend ceiling applies before dispatch.
The cap does not limit input tokens, total cost, or subscription allowance use.
The spend check can allow a request that takes spending above the ceiling; it is not a hard request-cost cap.
A probe hit does not prove longer cache retention or a hit on the next real turn.
See the [live evidence](docs/evidence/openai-chatgpt-v1-live-trial.md) and [follow-up investigation](docs/evidence/openai-chatgpt-v1-cache-investigation.md).

## When this helps

Use it when a supported route holds a large prompt and you often leave Pi idle long enough for the cache to expire.

It does not help when:

- The prompt is below the minimum cached-token threshold (default 512)
- The route is unsupported or manual-only (no timer)
- The model has no usable prices (savings show `n/a`)
- You just compacted, changed model, or changed thinking level (wait for the next real turn)

## Configuration

Useful tokens for `/warm` and `--warm-cache`:

| Token | Meaning | Default |
|---|---|---|
| `on` / `off` | Extension switch; does not change Pi's native warmer or provider caching | on |
| `5m` / `1h` / `auto` | Anthropic cadence | auto |
| `interval=` | Override probe delay | strategy default |
| `max=` | Max concurrent warm sessions | 3 |
| `maxidle=` | Stop after this idle time; `0` means no cutoff | about 30 minutes, or longer for 1-hour families |
| `spend=` | Probe-spend ceiling in USD; `0` means unlimited | $1.00 on OpenCode Go only |
| `log` / `nolog` | Local JSONL log | off |

The 1-hour Anthropic mode follows the cache retention already on the Pi request.
This extension does not add 1-hour markers to your real turns.

On existing verified-route anchors, `/warm now` keeps its idle-cutoff and spend-ceiling bypass.
The new ChatGPT subscription manual probe must obey a configured spend ceiling.
`spend=0` means unlimited; the default still applies only to OpenCode Go.
No manual action can reuse an anchor already dropped by invalidation or ownership changes.

## Status and savings

`/warm` shows whether warming is active, the current route, the next probe time, and a savings summary.

`probeHits` and `probeMisses` count extension probes only, not your real turns.

OpenCode Go savings are subscription budget-dollars, not a card invoice.

Enable a local log with `/warm log` or `PI_WARM_CACHE_DEBUG=1`.
The file is `.pi/warm-cache.jsonl` in the working directory.
It stores route names, counts, and redacted fingerprints.
It does not store prompts or API keys.

## Common cases

- After compaction or a model change, wait for the next real turn.
- If the agent is busy at a tick, that probe is deferred.
- Session resume waits for the first real turn.
- In print or RPC mode, warming can still run; the widget is hidden when there is no UI.
- Codex can pause automatic warming if probe output is repeatedly huge; use `/warm resume` or `/warm codex-off`.

## Manual validation

See the [idle-past-TTL test guide](docs/e2e-idle-test.md) and [diagnostics reference](docs/upgrade-notes.md).
Synthetic host and UI checks validate safety and display behavior, not live cache preservation.

## License

MIT
