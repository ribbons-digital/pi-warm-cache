# Evidence record: (openai-completions, opencode-go-plain)

## Identity

- pi-ai version: 0.83.0
- Provider: opencode-go
- API transport: openai-completions
- Family: opencode-go-plain
- Model: deepseek-v4-flash
- baseUrl: https://opencode.ai/zen/go/v1
- Campaign date: 2026-08-12
- Method: temporary verification-mode override (`/warm verify=opencode-go-plain`), live pi session via pty, extension timers.
- Campaign parameters (non-default): `verify=<family>`, `interval=3m`, `maxidle=0` (idle cutoff disabled so probes continue past the default 30m cutoff), `log`. Evidence demonstrates the warming mechanism under the campaign override, not default-config behavior.

## Part 1 - Replay hit (manual probe, 2 min idle, no intervening probes)

- Prefix tokens: ~38k, above minCachedTokens.
- Idle before probe: 2 min 0 s.
- Probe result: cacheRead = 34560, cacheWrite = 0, input = 99, out = 1.
- Pass: yes.

## Part 2 - Sustained keepalive

Final window 130 min. Timer cadence 3 min with `maxidle=0`.

- Timer probes: 43
- Timer hits: 43 (cacheRead 34560 each; details in the session JSONL)
- Idle window: 130 min.
- Pass: yes.

## Part 3 - User value

- Real-turn usage: cacheRead = 34560, cacheWrite = 0, input = 110.
- Pass: yes.

## Part 4 - Causality control

Same 130 min window with warming disabled (control session, no `verify=`).

- Control usage: cacheRead = 35456, cacheWrite = 0, input = 38.
- Result: NOT satisfied. The control cache did not decay - a full-prefix hit
  essentially equal to the keepalive part-3 value (34560). The native
  completions cache TTL exceeds 130 min (independent-trial finder: hot at
  120 min; the 130 min control confirms). The keepalive probes are therefore
  not isolated as the cause of the part-3 hit: the cache survives the window
  without warming.

## Slice 8-relevant finding

- The native completions cache TTL exceeds 130 min, and the default product's
  30 min idle cutoff stops probes well inside that envelope. Within the
  measured cache lifetime, the extension adds no measurable benefit on
  deepseek-v4-flash completions: the gateway cache outlives realistic idle
  gaps on its own, so warming is redundant on this route.
- Precision: the TTL upper bound is unknown (measured >= 130 min, not the
  expiry point), and the in-memory cache is evictable under memory pressure,
  so "not needed within the measured envelope" is the honest claim, not
  "never needed".
- Promotion note for Slice 8: consider a no-keepalive label for this route
  mirroring the retained-family treatment, while keeping the probe path for
  cold-cache protection and TTL uncertainty.

## Verdict

- Parts 1-3: pass (replay hit, 43/43 sustained probe hits, part-3 user value
  34560).
- Part 4: NOT satisfied. Causality is not demonstrated on this route: the
  gateway completions cache outlives realistic idle gaps, so warming adds no
  provable incremental benefit within a practical window.
- Evidence pointer: this record; raw events in the campaign session JSONLs
  (/tmp/pi-warm-cache-campaign/p1f-k and p1f-c).
