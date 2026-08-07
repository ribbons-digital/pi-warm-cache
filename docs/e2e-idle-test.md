# E2E: idle-past-TTL cache warming test

This is the canonical real-provider verification procedure for pi-warm-cache.
Use the [diagnostics reference](upgrade-notes.md) for `/warm` status fields, lifecycle states, savings, and JSONL fields.
The [README manual validation section](../README.md#manual-validation) points here.

Manual end-to-end procedure to verify that `pi-warm-cache` actually keeps a prompt
cache alive across a long idle gap.

File logging is optional. All evidence comes from:

- `/warm` status text (`SessionWarmer.getStatusText`)
- `/warm now` notify output
- the widget above the editor
- provider-side usage (Anthropic console) for cost cross-checks
- `.pi/warm-cache.jsonl` when debug logging is enabled

## Setup

1. Load the extension against a real Anthropic key:

   ```bash
   pi -e ./src/index.ts --warm-cache=true
   ```

   Anthropic short (5m) is the easiest family to test: 4m wait, cheap, and
   `cacheRead` is unambiguous in usage.

2. Build a big prefix. Ask the agent to read a few large files so the prompt
   prefix is clearly above 50k tokens (well over `minCachedTokens: 512`).

   Do **two** real turns. Turn 1 writes the cache; turn 2 must show
   `cacheRead > 0`. If turn 2 shows no cache read, stop - the problem is Pi
   cache configuration, not this extension.

3. Confirm the anchor exists:

   ```
   /warm
   ```

   Expect:

   ```
   enabled family=anthropic-short
   lifecycle=anchored
   capability=verified
   capabilityReason=first-party Anthropic Messages route with cache markers
   provider=anthropic/claude-fable-5
   api=anthropic-messages
   strategy=anthropic-short
   cadence=5m prompt-cache TTL
   intervalMs=240000
   nextDue=<ISO timestamp>
   realTurn=hit (...)
   probe=none
   probeSource=extension-only
   probeHits=0
   probeMisses=0
   probeFailStreak=0/3
   savingsSummary=probeHits=0 probeMisses=0 totalEstimatedSaved=$0.0000 totalProbeCost=$0.0000 net=$0.0000 pricingSource=model
   cacheKey=none
   pfp=<8-char hash>
   autoWarm=on
   probes=<n>
   savings=est. $<amount> saved
   pricing=model
   realRead=<big> realWrite=0 probeRead=none prompt≈<big>
   last=none
   ```

   - `inactive capability=unsupported` -> this route is unsupported and the provider will not be called, abort.
   - `lifecycle=awaiting-reanchor` -> the old payload was dropped and no probe is allowed until a new real turn is captured.
   - `realTurn=unknown (read=0 write=0 input=0 prompt=0 ...)` after a completed turn -> `message_end` usage tracking is not landing.

4. Confirm the exact route before waiting.

   The status must show `capability=verified`, the expected provider/model route, and the expected API transport.

   Do not start a timer test for `capability=unverified` or `capability=unsupported`.

   Direct xAI Grok 4.5 on `https://api.x.ai/v1` with `openai-responses` is verified as a best-effort route.

   Its captured payload must include a stable `prompt_cache_key` before the automatic cadence can start.

   Do not treat the 4m cadence as a provider TTL guarantee.

## Step 1: smoke test (before any waiting)

```
/warm now
```

Expect `Extension probe hit (anthropic/claude-fable-5 api=anthropic-messages; capability=verified ...; extensionProbe read=<~prefix size> write=0 in=<input tokens> out=<output tokens> cost=$<cost>; source=extension-only; pfp=<hash>; retry=0/3; savingsSummary=...)`.

This is the highest-value check: it isolates payload replay from timing.
If it reports `Extension probe miss (anthropic/claude-fable-5 api=anthropic-messages; capability=verified ...; extensionProbe read=0 write=<N> in=<input tokens> out=<output tokens> cost=$<cost>; source=extension-only; pfp=<hash>; retry=<N>/3; savingsSummary=...)`, the replayed payload does not
byte-match the real one. That is the failure mode described in the README
("payload replay, not Context rebuild"), and the timer test will only reproduce
it more slowly.

Sanity check the magnitude: `cacheRead` should be within a few tokens of the
prompt size of the last real turn. A much smaller number means only part of the
prefix matched.

## Step 2: the idle run

1. Do one more real turn to re-anchor cleanly.
2. Do nothing. No typing, no model switch, no `/compact`, no tree navigation.
   Model changes, compaction, branch navigation, and a non-continuing payload
   boundary mark the next real-turn observation as `unknown` and require a new
   anchor.
3. Watch the widget. It refreshes every 15s and counts down to the ~4m mark.
4. At the tick the widget flips to a probe-hit render. Then run `/warm` and
   expect `probeHits=1 probeMisses=0` with `realTurn=hit (...)`, a positive `totalEstimatedSaved`, and `nextDue` pushed ~4m further out.
   Run `/warm savings` to print only the cumulative savings summary.
5. Let it run at least **3 ticks** (~12m). One tick proves replay works; three
   prove rescheduling does not drift, collapse into a retry loop, or accumulate
   probe misses.
6. Break the idle with a real turn. That turn should show `realTurn=hit` and `cacheRead > 0`.
   The real-turn observation must remain separate from the preceding probe hit.
   This is the end-to-end payoff: the cache survived 12+ minutes of idle.

## Step 3: control run

Repeat step 2 with warming off:

```bash
pi -e ./src/index.ts --warm-cache=off
```

Same prefix size, same idle duration. The resuming turn should show
`realTurn=unknown` or `realTurn=miss` with `cacheRead = 0` or a large `cacheWrite`.
The extension must not convert Pi's own cache notice into a second savings entry.

Without this control you have only proven the extension runs, not that it works.

## Pass criteria

| Check | Expected |
|-------|----------|
| `/warm now` | `probe=hit`, `cacheRead` ≈ full prefix, `cacheWrite` ≈ 0 |
| 3+ timer ticks | `probeHits` increments, `probeMisses=0` |
| Post-idle real turn, warming on | `realTurn=hit` and `cacheRead > 0` |
| Post-idle real turn, warming off | `cacheRead = 0` |
| `savingsSummary=...` | hits, misses, estimated savings, probe cost, net, and pricing source are shown |
| `savings=est. $... saved` | positive and growing for verified routes with model pricing |
| Unknown model pricing | monetary summary fields show `n/a` |

Caveat on the last row: the savings figure is an estimate computed from model
pricing in `savings.ts`, not billed data. It debits actual warm spend on every
tick, so a negative number means warming costs more than it saves. For a real
cost claim, cross-check the Anthropic console usage for the test window.

## Things that will make the test lie to you

- **Anthropic 5m TTL is sliding.** Any background activity refreshes it for
  free, so the control run can falsely "pass". Keep the terminal untouched.
- **Timers are `unref`'d** (`src/warmer.ts`, `unrefTimer`). In non-TUI or print
  modes, if nothing else holds the event loop open, ticks may never fire. Test
  in the interactive TUI.
- **`agent_start` clears timers.** Any turn during the wait restarts the
  countdown and you will misread the interval.
- **Miss-with-write is sticky.** On `cacheWrite > 0 && cacheRead === 0` the
  anchor is dropped and warming stops until the next real turn. If the widget
  goes quiet mid-test, check `/warm` - this is more likely than a timer bug.
- **`maxConsecutiveFailures: 3`** silently parks the warmer as
  `too many failures`. Check status before concluding "it just stopped".

## Shortening the loop while iterating

For debugging the mechanism (not for validating real TTL behavior):

```
/warm interval=45s
```

A tick every 45s sits well inside the 5m TTL, so every tick should hit. Once
that is stable for several ticks, return to the default interval for the real
4m validation. A 45s interval proves replay correctness but says nothing about
whether the 4m cadence actually beats the TTL.

## Other families

| Family | Interval | Idle wait to validate |
|--------|----------|-----------------------|
| `anthropic-short` | ~4m | ~12m (3 ticks) |
| `anthropic-long` | ~48m | requires Pi cache retention set to long |
| `openai-explicit` | ~24m | needs `supportsExplicitPromptCacheMode` |
| `openai-implicit` | ~6.4m | ~20m (3 ticks) |
| `xai-best-effort` | 4m heuristic | at least 12m, record observed hit rate |

`anthropic-short` is the recommended default for validation. The others follow
the same procedure with longer waits.

For `xai-best-effort`, record the route, payload fingerprint, cache-key identity,
read, write, output, cost, and retry values for every probe.

xAI may report cached reads without a separate cache-write token count through Pi.

Repeated no-read/no-write probes must stop and request a new real-turn anchor when
the configured failure budget is reached.
