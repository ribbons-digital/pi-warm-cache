# Diagnostics and upgrade notes

This page documents the lifecycle, `/warm` status, savings summary, and JSONL diagnostics used by pi-warm-cache.
It describes the behavior delivered by the first four upgrade PRs.

## Safety rules and scope

The extension follows four non-negotiable rules:

1. **Exact payload replay only** - warm probes replay the exact provider payload captured from a real turn.
   The extension does not rebuild context from the live session.
2. **Strict capability verification** - automatic warming is allowed only when the exact provider route resolves to `state: "verified"`.
3. **Hard invalidation on real prefix drift** - compaction, model switch, thinking-level change, and a non-continuing payload drop the anchor immediately.
   No probe is allowed until a new real payload is captured.
4. **No invented pricing** - savings estimates use only the active model's supplied `cost` fields.
   Missing or unusable pricing is reported as `n/a`.

This extension supports Pi only.
Tau is out of scope.

## When this helps

Cache warming is useful when all of the following are true:

- The route is verified and has an automatic keepalive strategy.
- The real provider payload contains a large prefix that is worth retaining.
- The session will be idle long enough for the provider cache to expire without a probe.
- The provider route can be tested with the [canonical real-provider procedure](e2e-idle-test.md).

A real turn must capture the anchor before the timer can start.
The first real-turn observation can remain `unknown` until Pi reports assistant usage.

## When this does not help

- A prefix below `minCachedTokens` is not scheduled for warming.
- Unsupported, proxy, and unverified routes do not receive automatic warming.
- A manual-only route can issue one safe `/warm now` probe, but it does not receive a timer or a verified savings claim.
- xAI best-effort warming uses an operational cadence, not a provider TTL guarantee.
- Warming cannot guarantee a cache hit or a fixed dollar saving.
- An invalidated anchor is never reused after compaction, model or thinking-level changes, branch changes, or prefix drift.
- The extension reports `n/a` instead of estimating savings when the active model has no usable pricing.
- The extension does not support Tau.

## Lifecycle states

`/warm` reports the current lifecycle in `lifecycle=<state>`.
The capability state is separate and must also be checked.

| State | Meaning | Probe behavior |
|---|---|---|
| `idle` | No usable anchor is active, or the prefix is waiting for the first real turn or is too small. | No automatic probe. |
| `anchored` | A real provider payload is captured for the current route. | A verified strategy may arm its timer after the agent settles. |
| `awaiting-reanchor` | A hard invalidation dropped the old anchor and payload. | Zero probes until another real payload is captured. |
| `disabled` | Warming is disabled by configuration or the session is shutting down. | Timers are cleared and in-flight warm requests are aborted. |
| `blocked` | Automatic warming is stopped by a sticky session block, such as repeated oversized Codex output. | Automatic probes stay off until `/warm resume` or an equivalent explicit re-enable command. |

A route with `capability=unverified` or `capability=unsupported` is inactive even if another lifecycle field is present.
Only `capability=verified` permits automatic warming.

After a hard invalidation, the next captured real payload creates a new anchor.
The new anchor does not inherit probe counters or evidence from a changed prefix.
A continuing real turn can retain session probe statistics when the prefix remains valid.

## `/warm` status reference

The status command is human-readable and multiline.
Run `/warm` or `/warm status` while the extension is loaded.

The first line describes the broad state and may be one of the following forms:

- `enabled family=<family>` means a verified anchor and automatic strategy are active.
- `inactive capability=<state>` means the route is unsupported or unverified.
- `idle (no anchor)` means the extension is waiting for a real payload or a new anchor.
- `disabled` means the master switch is off.

When a hard invalidation is waiting for a new payload, the second line is `payload=none (needs re-anchor)`.
The old payload cannot be reused in that state.

The following fields form the stable diagnostic block.
Inactive-capability output also includes the `manualProbe` field.

| Field | Meaning |
|---|---|
| `lifecycle` | The lifecycle state from the table above. |
| `capability` | The exact route policy: `verified`, `unverified`, or `unsupported`. |
| `capabilityReason` | The actionable reason for the capability decision. This is route and payload policy, not a provider promise. |
| `manualProbe` | In inactive-capability output, `ready` means the captured payload is safe for a manual probe, `unsafe-payload` means the route is manual-capable but the captured shape is unsafe, `waiting-for-safe-payload` means no payload is captured yet, and `off` means manual probing is not permitted. This field is omitted from the verified-route status form. |
| `provider` | The provider and model route, such as `anthropic/claude-fable-5`. |
| `api` | The exact Pi API transport, such as `anthropic-messages` or `openai-responses`. |
| `strategy` | The selected cache family, such as `anthropic-short`, `openai-explicit`, `openai-implicit`, or `xai-best-effort`. |
| `cadence` | The human label for the selected cache window or probe cadence. xAI is labelled best effort and has no fixed TTL claim. |
| `intervalMs` | The configured delay before the next automatic probe in milliseconds, or `none` when no timer is available. |
| `nextDue` | The next scheduled probe time as an ISO timestamp, or `none`. |
| `realTurn` | The latest cache observation from a real assistant turn. It includes `hit`, `miss`, or `unknown` plus raw read, write, input, prompt, and reason values. |
| `probe` | The latest response from an extension probe. It includes the outcome, raw read, write, input, output, cost, and short payload fingerprint. |
| `probeSource` | Always `extension-only` for these counters. It prevents extension probes from being confused with Pi's native cache notices. |
| `probeHits` | The number of extension probe responses classified as cache hits for the current anchor. |
| `probeMisses` | The number of extension probe responses that were not hits for the current anchor. Provider errors are recorded as errors and are not counted as probe misses. |
| `probeFailStreak` | The current consecutive automatic probe failure count and the configured maximum, such as `1/3`. A successful probe or real turn resets the failure streak. |
| `savingsSummary` | The cumulative hit, miss, estimated-saved, probe-cost, net, and pricing-source fields described below. |
| `cacheKey` | A short redacted fingerprint of the provider cache-routing key, or `none`. The raw key is not logged in status output. |
| `pfp` | The first eight characters of the payload fingerprint. It identifies the captured payload without printing its contents. |
| `autoWarm` | `on` when a verified automatic timer is allowed, `off` when it is not, or `blocked` after a sticky automatic-warm block. |
| `codexAuto` | An optional Codex control field. `codexAuto=on` means the Codex timer switch is enabled, but the output-size safety block still applies. |
| `blockReason` | The reason for a sticky automatic-warm block, when one exists. |
| `probes` | The number of provider responses returned by the warm-probe path for the current anchor. |
| `savings` | A compact current session savings label, such as `est. $0.02 saved`, `est. net cost $0.01`, or `n/a (no model pricing)`. |
| `pricing` | The pricing source for the active anchor, currently `model` or `unknown`. |
| `realRead` | The raw cache-read token count from the latest real-turn observation. |
| `realWrite` | The raw cache-write token count from the latest real-turn observation. |
| `probeRead` | The raw cache-read token count from the latest probe, or `none`. |
| `prompt≈` | The largest known prompt-size hint from real-turn or probe usage. It is a scheduling hint, not a replacement for the raw observations. |
| `last` | The latest warm attempt detail and its timestamp, or `none`. The detail identifies timer, manual, system, error, retry, or drift outcomes. |
| `log` | The JSONL path when file logging is enabled. It is omitted when logging is disabled. |

`realTurn` and `probe` are intentionally separate observations.
A real-turn cache hit does not increment `probeHits`.
A probe hit does not change the real-turn classification.

The `reason`, `capabilityReason`, `last`, and provider error text are descriptive strings and can change between releases.
The numeric usage fields are raw values reported by Pi or the provider adapter.

## Savings summary

The status block and `/warm savings` command use this format:

```text
probeHits=<n> probeMisses=<n> totalEstimatedSaved=<amount> totalProbeCost=<amount> net=<amount> pricingSource=<source>
```

| Field | Meaning |
|---|---|
| `probeHits` | Count of extension probes with an observed cache read. |
| `probeMisses` | Count of returned extension probe responses without a cache hit. |
| `totalEstimatedSaved` | Sum of the observed cold-input versus cache-read price delta for probe hits. |
| `totalProbeCost` | Sum of the model-supplied `cost.total` values for warm probes. |
| `net` | `totalEstimatedSaved - totalProbeCost`. A negative value means the observed probe cost exceeded the estimated read savings. |
| `pricingSource` | `model` when usable prices came from the active model entry, or `unknown` otherwise. |

The savings formula is:

```text
(input price - cache-read price) * (cache-read tokens / 1,000,000)
```

The extension does not use a catalog lookup or a hard-coded provider price.
When pricing is missing or unusable, monetary fields show `n/a`.
Unverified and unsupported routes show `n/a (unverified route)` or `n/a (unsupported route)` even when a model entry contains prices.
The result is an estimate from observed usage, not a billing statement.

## JSONL schema

Enable file logging with `PI_WARM_CACHE_DEBUG=1` or `/warm log`.
The file is `.pi/warm-cache.jsonl` below the Pi working directory.
Each line is one JSON object.

The log stores diagnostic metadata, usage counts, route identifiers, and redacted fingerprints.
It does not intentionally store provider payloads, prompt text, API keys, or personal data.
Provider error text can be copied into an error or detail field by the provider adapter, so inspect a log before sharing it.

Every event has these common fields when the value is available:

| Field | Meaning |
|---|---|
| `ts` | ISO timestamp for the event. |
| `event` | Event name listed in the event table below. |
| `source` | `real_turn`, `warm_probe`, or `system`. |
| `sessionId` | Pi session identifier used to correlate events from one session. |
| `provider` | Provider identifier for the active route. |
| `modelId` | Model identifier for the active route. |
| `api` | Pi API transport for the active route. |
| `capabilityState` | Capability result at the time of the event. |
| `capabilityReason` | Human-readable capability decision reason. |
| `automaticWarm` | Whether the route policy permits a timer. |
| `manualProbe` | Whether the route policy permits an explicit one-shot probe. |
| `family` | Selected cache family when a strategy or anchor exists. |
| `cacheKeyFingerprint` | Redacted fingerprint of a provider cache-routing key. |
| `payloadFingerprint` | Stable fingerprint of the captured or replayed payload. |
| `reason` | Event-specific cause, such as `timer`, `manual`, `ttl`, `agent busy`, or invalidation text. |

The following event names are emitted by the current implementation.
Fields in the event-specific column are present only when that event has the corresponding data.

| Event | Event-specific fields and meaning |
|---|---|
| `capture` | `manualProbeAvailable` records whether the captured shape is safe for a manual probe. `prefixChanged` records whether the old anchor was replaced. `realTurnContinuity` is `comparable` or `unknown`. `realTurnContinuityReason` explains the continuity decision. `modelCost` is the active model cost object or `null`. `pricingSource` is `model` or `unknown`. `savingsKnown` records whether a usable savings delta exists. `inputPricePerMTok` and `cacheReadPricePerMTok` are the resolved prices, or zero when unknown. An unsupported capture can also contain `ignored=true`. |
| `usage` | `cacheRead`, `cacheWrite`, `input`, `output`, and `promptTokens` are raw real-turn usage values. `realTurnState` is `hit`, `miss`, or `unknown`. `realTurnReason` explains the classification. A usage event without an anchor omits `sessionId` and records `realTurnReason=no anchor`. |
| `agent_start` | Records that the real agent turn started and the warm timer was paused. |
| `agent_settled` | `hasPayload` records whether an exact payload is available. `cachedTokens` is the scheduler's prompt-size hint. `realTurnState` and `realTurnReason` identify the latest real-turn observation. `probeOutcome`, `probeHits`, and `probeMisses` identify the latest probe state and counters. `retryState` records the failure streak and configured limit. |
| `schedule` | `delayMs` is the scheduled delay. `nextDueAt` is the next due time as an ISO timestamp. `reason` identifies the schedule cause, such as `ttl`, `agent busy`, or `concurrency limit`. |
| `schedule_skipped` | `automaticWarm` and `reason` explain why no timer was armed, such as an unverified capability, unsupported route, or unavailable automatic strategy. |
| `warm_start` | `reason` is `timer` or `manual`. This event marks the start of an extension provider request. |
| `attempt` | `reason` is `timer`, `manual`, or `system`. `ok` records whether the attempt completed successfully. `detail` contains the short result or error description. `probeOutcome` can be `hit`, `transient-miss`, `miss`, `payload-drift`, `error`, or `unavailable`. `retryState` records the failure streak. `usage` contains the raw `input`, `output`, `cacheRead`, `cacheWrite`, and model-supplied `costTotal` values when a provider response exists. |
| `anchor_invalidated` | `reason` explains the hard invalidation. The event is `source=system` and can include the route that was invalidated. No old payload is retained for a later probe. |
| `auto_warm_blocked` | `reason` explains the sticky automatic-warm block. Timers are cleared. |
| `auto_warm_block_cleared` | `previous` records the old block reason. `reason` records the explicit user action or other cause that cleared it. |

The event type is intentionally additive.
Future versions may add fields without changing the meaning of the fields above.
Consumers should ignore fields they do not understand.

To compare a real turn with its following probe, correlate `sessionId`, `payloadFingerprint`, `provider`, `modelId`, and `api`.
Use `source=real_turn` for Pi assistant usage and `source=warm_probe` for extension requests.
Do not treat an `attempt` event as evidence of a cache hit without checking its `probeOutcome` and usage fields.

## Canonical verification

The [idle-past-TTL procedure](e2e-idle-test.md) is the canonical real-provider verification method.
It checks the exact route, a manual probe, multiple timer ticks, the post-idle real turn, and a warming-off control.

A unit test or a `/warm` status snapshot can verify diagnostics.
Only the real-provider procedure can verify that a provider route preserves the intended cache across an idle gap.
