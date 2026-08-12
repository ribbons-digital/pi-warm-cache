# Evidence record template: (api, family)

One record per (api, family) pair.
The four parts are the gate; every record pins the pi-ai version and the tested model.

## Decay criterion for part 4

Part 4 passes when the control cacheRead is at the shared-boilerplate artifact
floor, not a prefix-size hit.
Criterion: control cacheRead < 1% of the keepalive part-3 cacheRead for the
same prefix counts as decayed (the artifact floor is 128 tokens on the
responses and anthropic transports; a literal 0 also passes).
A control cacheRead near the full prefix size means the native TTL exceeds the
window and part 4 is not satisfied.

## Identity

- pi-ai version: 0.83.0
- Provider: opencode-go
- API transport: (openai-completions | anthropic-messages | openai-responses)
- Family: (opencode-go-plain | opencode-go-short-marker | opencode-go-long-marker)
- Model: (model id)
- baseUrl: (https://opencode.ai/zen/go or https://opencode.ai/zen/go/v1)
- Evidence date: (ISO date)
- Campaign parameters: `verify=<family>`, `interval=3m`, `maxidle=0`, `log`
  (non-default; demonstrates the mechanism under the campaign override)

## Part 1 - Replay hit

Manual probe after at least 2 minutes idle on a real captured payload.

- Prefix tokens: (n, must be >= minCachedTokens)
- Idle before probe: (m:ss)
- Probe result: cacheRead = (n), cacheWrite = (n), input = (n)
- Pass/fail: (pass if cacheRead > 0)

## Part 2 - Sustained keepalive

At least 3 consecutive timer-cadence probe hits across an idle window that
exceeds the route's measured native cache TTL (window must be sized from the
TTL bracket, not a nominal reference).

| Probe # | t + offset | cacheRead | cacheWrite | outcome |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| ... | | | | |

- Idle window length: (m:ss, must exceed measured TTL)
- Pass/fail: (pass if >= 3 consecutive hits)

## Part 3 - User value

First real turn after the idle window.

- Real-turn usage: cacheRead = (n), cacheWrite = (n), input = (n)
- Pass/fail: (pass if cacheRead > 0)

## Part 4 - Causality control

Same idle window with warming disabled.

- Control usage: cacheRead = (n), cacheWrite = (n), input = (n)
- Pass/fail: (pass per the decay criterion above)

## Verdict

- All four parts pass: (yes/no)
- Evidence pointer: (path to this record)
