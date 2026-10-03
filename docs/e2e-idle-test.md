# E2E: idle-past-TTL cache warming test

This is the real-provider verification procedure for pi-warm-cache.
Use the [diagnostics reference](upgrade-notes.md) for status, lifecycle, savings, and JSONL fields.
Run live tests only with explicit approval for the provider, request count, output bounds, time limit, and spend limit.
Synthetic checks validate the mechanism, not live preservation.

## Setup and controls

1. Use a verified automatic route.
   Anthropic short retention is the simplest starting point.
   Cache markers must already be present on the real request.
   Budget-based Anthropic thinking cannot receive automatic probes.
2. Set Pi's global `cacheWarming` to `off` for both treatment and control groups.
   `/warm off` disables only this extension, not the native warmer or provider caching.
   Native streaming is otherwise the Pi v1 default and can affect a control.
   Check for other extensions or clients that could refresh the same cache.
3. Prepare independent treatment and control prefixes with distinct nonce values near the start of the large prefix.
   Use distinct cache-routing keys where the route supports them.
   Do not let treatment requests refresh the control's cache.
   Record only redacted key and payload fingerprints in shared evidence.
4. Keep model, endpoint, auth method, thinking, retention, output limits, and prompt size comparable.
   Record the Pi/pi-ai versions and all non-default settings.
   The family deadline is a safety policy, not a measured provider TTL.
5. Load the extension in an interactive Pi session:

   ```bash
   pi -e ./src/index.ts --warm-cache=true
   ```

   Run dependency code in the project's Docker Sandbox.
   A live campaign needs its own approved network and credential access; do not remove the offline-check deny rule just to run this guide.
6. Build a large prefix above `minCachedTokens` (default 512), ideally large enough to make cached usage clear.
   In each group, make two real turns before starting the wait.
   The second turn must report cached reads for that group's prefix.
   If either baseline is cold, stop and fix the baseline before comparing groups.
7. Check `/warm` on the treatment route.
   Expect `capability=verified`, `lifecycle=anchored`, the exact route and API, an automatic strategy, a future `nextDue`, and a confirmed real-turn hit.
   On v1, `owner=extension` describes the native veto, not native usage accounting.
   Unsupported or unverified capability cannot start this timer test.

Evidence can come from `/warm`, `/warm now`, the widget, provider-reported usage, provider billing records, and optional `.pi/warm-cache.jsonl` logging.
Inspect logs before sharing because provider error text may contain private data.

## Step 1: replay smoke check

```text
/warm now
```

Expect `Extension probe hit`, cached reads near the intended prefix size, the permitted output cap, and `source=extension-only`.
Check that the replay uses the same captured prefix and cache-key fingerprint.
A miss alone does not prove body drift, expiry, or a backend cause.
Record the actual request identity and raw usage before diagnosing it.
If this check fails, stop the timing test.

Make a fresh real turn before the treatment wait.
Do not smoke-probe the control during its idle wait.

## Step 2: treatment wait

1. Leave the treatment session idle without typing, model changes, compaction, or tree navigation.
2. With Anthropic short retention, expect a probe around four minutes.
   The widget updates every fifteen seconds.
3. After each tick, record dispatch time, route, payload/key fingerprints, cache read/write, input/output, cost, and outcome.
   `/warm` must keep real-turn and extension-probe observations separate.
4. Observe at least three ticks for a rescheduling check when approved limits allow it.
   Three ticks test the loop; they do not prove causality.
5. Resume with a real turn after the planned idle period.
   Record its raw cached reads and its relation to the confirmed baseline.

A delayed timer that crosses the family deadline must send no automatic request.
It drops the anchor and waits for a new real turn.
The deadline starts at real capture or successful replay dispatch, not settlement or delayed response arrival.
A manual probe cannot reuse an anchor already dropped by invalidation.

## Step 3: untouched control

Disable the extension for the control before establishing its real-turn baseline:

```bash
pi -e ./src/index.ts --warm-cache=off
```

Keep Pi's native `cacheWarming` off too.
Use the same idle duration and comparable settings, but an independent prefix and cache identity.
Do not send probes or other cache-refreshing requests during the wait.
Then resume with one real turn and record provider usage.
The disabled extension may have no anchor and show an unknown real-turn state; use raw provider usage for the comparison.

If treatment misses, mark it failed and stop further warming.
Still collect the untouched control when approved safety limits permit it.
If quota, timeout, credential validity, or another guard prevents that observation, report an incomplete comparison.
Do not call a single idle miss measured expiry.

Repeat independent treatment/control comparisons before claiming a preservation benefit.
If both groups remain cached, the comparison is inconclusive for benefit.
If both miss, preservation was not demonstrated.
A warmed real-turn hit is useful mechanism evidence, but it is not causal proof without comparable control decay.

## Pass criteria and limits

| Check | Expected |
|---|---|
| Confirmed baselines | Each independent group reports cached reads before its wait |
| Replay smoke check | Exact permitted replay, legal output cap, intended cached prefix |
| Timer mechanism | Expected cadence, separate probe counters, no duplicate owner, no expired dispatch |
| Treatment real turn | Cached reads after the approved idle wait |
| Control comparison | Untouched independent control observed at the comparable idle duration |
| Preservation claim | Repeated comparable treatment benefit with control decay, not selected favorable trials |
| Savings display | Probe-price comparison, probe costs, and model pricing; `n/a` where unknown |

Savings compare cold-input and cached-read prices on probe hits.
They do not measure avoided real-turn spending and are not a billing statement.
Cross-check billed usage before making a cost claim.

## Lifecycle and concurrency checks

- After compaction, tree navigation, model or thinking selection, reload, session replacement, or off/on, the old payload must be unavailable.
  A new real turn must capture a fresh anchor.
- A real turn cancels an in-flight extension probe and can capture immediately.
  Late probe replies cannot replace its observations or failure status.
  The old call retains its concurrency slot until the provider call ends.
- For two sessions sharing one extension process, set `max=1` and overlap synthetic slow probes.
  The waiting timer must report `activeWarmSessions=1/1` and a concurrency deferral without calling the provider.
  A subscription manual refusal must not queue a follow-up.
  Separate Pi processes do not share this gate.
- Native off, streaming, and idle ownership, off/on handoff, the last-handler limitation, failures, and cancellation are covered by `pnpm test` with synthetic transport.
  These do not need a paid concurrency experiment.

## Things that can invalidate the result

- Background activity can refresh a sliding cache, including activity from Pi's native warmer.
- Shared treatment/control identity can let treatment refresh the control.
- Non-TUI timers are unreferenced and may never fire if nothing else keeps the process alive.
- `agent_start` clears the warm timer and retires an active extension probe.
- Cache misses, writes, or exhausted failure budgets can drop or park an anchor.
  Check status instead of inferring expiry.
- A CLI preload fetch stub can be replaced by Pi's transport setup.
  Offline CLI checks must load that module first, record intercepted provider calls, and enforce sandbox network denial.
- `maxidle=0` removes the idle cutoff, not the expiry guard.
  Disclose it for campaigns longer than the default idle horizon.

## Shortening the mechanism loop

```text
/warm interval=45s
```

Use this only for replay and scheduling checks, not measured retention.
Return to the strategy cadence for an approved timing comparison.
An interval beyond the family deadline does not authorize an expired automatic request.

## Other families

| Family | Default cadence | Verification limit |
|---|---|---|
| `anthropic-short` | About 4 minutes | Real request already has short cache markers |
| `anthropic-long` | About 48 minutes | Real request already uses one-hour retention |
| `openai-explicit` | About 24 minutes | Captured request contains explicit `ttl: "30m"` |
| `openai-implicit` | About 6.4 minutes | Operational window, not measured expiry for every route |
| `xai-best-effort` | Four-minute heuristic | Stable captured key; no fixed TTL promise |

For xAI, record cached reads even when cache-write usage is absent.
Repeated no-read/no-write results exhaust the configured failure budget and require a fresh anchor.
Never copy the raw cache key into shared evidence.

### ChatGPT subscription exception

Do not use this timer procedure for new OpenAI ChatGPT sign-in.
Automatic cache preservation remains unverified.
Only the exact tested Luna/off and Sol/low profiles on the first-party Responses endpoint permit a safe keyed manual replay.
Each accepted manual action has sixteen output tokens, forty-five-second cancellation, zero automatic HTTP retries, and no scheduled follow-up.
Configured spend ceilings apply, but neither input cost nor subscription allowance use is capped.
See the [manual contract](upgrade-notes.md#openai-chatgpt-subscription-manual-contract) and existing [live evidence](evidence/openai-chatgpt-v1-live-trial.md).
This safety slice authorizes no new live campaign.
