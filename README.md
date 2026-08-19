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
After compaction, a model change, a thinking-level change, or a branch change, it waits for the next real turn before probing again.

Savings numbers use only the prices on the active model.
If those prices are missing, the status shows `n/a`.

## Install

```bash
pi install npm:pi-warm-cache
```

Restart or reload Pi after install.

## Commands

```text
/warm                  # show status and savings
/warm savings          # show only the savings summary
/warm on               # enable warming
/warm off              # disable warming
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

Automatic keepalive is on for these routes when Pi is talking to the first-party endpoint:

| Route | What you get |
|---|---|
| Anthropic | Probe about every 4 minutes, or about every 48 minutes when the request already uses a 1-hour cache |
| OpenAI | Probe on the explicit or implicit cache window for that model |
| Azure OpenAI | Same OpenAI response strategy |
| OpenAI Codex | Codex timer policy; turn it off with `/warm codex-off` if output spikes |
| xAI Grok 4.5 | Best-effort probe about every 4 minutes when the request has a stable cache key |
| OpenCode Go (default setup) | Keepalive on short Anthropic and keyed Responses routes; no timer on Completions because that cache already lasts a long time |

`/warm now` is a one-shot probe.
It does not start a timer.

These routes allow `/warm now` only:

- Other first-party xAI models, when the captured request is safe to replay
- OpenRouter, on the registered OpenRouter endpoint
- Some non-default OpenCode Go retention settings

Unlisted proxies and other compatible APIs stay off.
The extension will not call the provider for those routes.

xAI Grok 4.5 keepalive is best effort.
The 4-minute cadence is not a provider TTL promise.
If probes keep returning no cache read, warming stops until the next real turn.

OpenCode Go must use the registered endpoints: Anthropic at `https://opencode.ai/zen/go`, and OpenAI-style APIs at `https://opencode.ai/zen/go/v1`.

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
| `on` / `off` | Master switch | on |
| `5m` / `1h` / `auto` | Anthropic cadence | auto |
| `interval=` | Override probe delay | strategy default |
| `max=` | Max concurrent warm sessions | 3 |
| `maxidle=` | Stop after this idle time; `0` means no cutoff | about 30 minutes, or longer for 1-hour families |
| `spend=` | Probe-spend ceiling in USD; `0` means unlimited | $1.00 on OpenCode Go only |
| `log` / `nolog` | Local JSONL log | off |

The 1-hour Anthropic mode follows the cache retention already on the Pi request.
This extension does not add 1-hour markers to your real turns.

`/warm now` ignores the idle cutoff and the spend ceiling.

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

## License

MIT
