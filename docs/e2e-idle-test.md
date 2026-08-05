# E2E: idle-past-TTL cache warming test

Manual end-to-end procedure to verify that `pi-warm-cache` actually keeps a prompt
cache alive across a long idle gap.

There is no log file. All evidence comes from:

- `/warm` status text (`SessionWarmer.getStatusText`)
- `/warm now` notify output
- the widget above the editor
- provider-side usage (Anthropic console) for cost cross-checks

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
   enabled family=anthropic-short cached≈<big> hits=0 misses=0 saved≈$0.0000 nextDue=<~4m out> ctx=<hash> pfp=<hash>
   ```

   - `family=unsupported` or `idle (no anchor)` -> capture failed, abort.
   - `cached≈0` -> `message_end` usage tracking is not landing.

4. Confirm the exact route before waiting.

   The status must show `capability=verified`, the expected provider/model route, and the expected API transport.

   Do not start a timer test for `capability=unverified` or `capability=unsupported`.

   Direct xAI is currently unverified and supports only a clearly labelled manual probe when its captured payload is safe.

## Step 1: smoke test (before any waiting)

```
/warm now
```

Expect `Warm hit cacheRead=<~prefix size> saved≈$...`.

This is the highest-value check: it isolates payload replay from timing.
If it reports `no cache hit (read=0 write=N)`, the replayed payload does not
byte-match the real one. That is the failure mode described in the README
("payload replay, not Context rebuild"), and the timer test will only reproduce
it more slowly.

Sanity check the magnitude: `cacheRead` should be within a few tokens of the
prompt size of the last real turn. A much smaller number means only part of the
prefix matched.

## Step 2: the idle run

1. Do one more real turn to re-anchor cleanly.
2. Do nothing. No typing, no model switch, no `/compact`, no tree navigation.
   `liveContextKey` covers provider, model id, thinking level, leaf id, and the
   prompt entry signature; changing any of them trips the drift check and you
   will see `prefix changed · re-anchor needed`.
3. Watch the widget. It refreshes every 15s and counts down to the ~4m mark.
4. At the tick the widget flips to a warm-hit render. Then run `/warm` and
   expect `hits=1 misses=0` with `nextDue` pushed ~4m further out.
5. Let it run at least **3 ticks** (~12m). One tick proves replay works; three
   prove rescheduling does not drift, collapse into a retry loop, or accumulate
   misses.
6. Break the idle with a real turn. That turn should show `cacheRead > 0`.
   This is the end-to-end payoff: the cache survived 12+ minutes of idle.

## Step 3: control run

Repeat step 2 with warming off:

```bash
pi -e ./src/index.ts --warm-cache=off
```

Same prefix size, same idle duration. The resuming turn should show
`cacheRead = 0` or a large `cacheWrite`.

Without this control you have only proven the extension runs, not that it works.

## Pass criteria

| Check | Expected |
|-------|----------|
| `/warm now` | `cacheRead` ≈ full prefix, `cacheWrite` ≈ 0 |
| 3+ timer ticks | `hits` increments, `misses=0` |
| Post-idle real turn, warming on | `cacheRead > 0` |
| Post-idle real turn, warming off | `cacheRead = 0` |
| `saved≈$` | positive and growing |

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

`anthropic-short` is the recommended default for validation. The others follow
the same procedure with longer waits.
