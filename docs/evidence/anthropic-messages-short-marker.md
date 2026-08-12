# Evidence record: (anthropic-messages, opencode-go-short-marker)

## Identity

- pi-ai version: 0.83.0
- Provider: opencode-go
- API transport: anthropic-messages
- Family: opencode-go-short-marker
- Model: minimax-m3
- baseUrl: https://opencode.ai/zen/go
- Campaign date: 2026-08-12
- Method: temporary verification-mode override (`/warm verify=opencode-go-short-marker`), live pi session via pty, extension timers.
- Campaign parameters (non-default): `verify=<family>`, `interval=3m`, `maxidle=0` (idle cutoff disabled so probes continue past the default 30m cutoff), `log`. Evidence demonstrates the warming mechanism under the campaign override, not default-config behavior.

## Part 1 - Replay hit (manual probe, 2 min idle, no intervening probes)

- Prefix tokens: ~38k, above minCachedTokens.
- Idle before probe: 2 min 0 s.
- Probe result: cacheRead = 32512, cacheWrite = 0, input = 37, out = 1.
- Pass: yes.

## Part 2 - Sustained keepalive

Final window 60 min (exceeds the measured anthropic TTL of 14-50 min).
Timer cadence 3 min with `maxidle=0`.

- Timer probes: 20
- Timer hits: 20 (cacheRead 32512 each; details in the session JSONL)
- Idle window: 60 min.
- Pass: yes.

## Part 3 - User value

- Real-turn usage: cacheRead = 32512, cacheWrite = 0, input = 55.
- Pass: yes.

## Part 4 - Causality control

Same 60 min window with warming disabled (control session, no `verify=`).

- Control usage: cacheRead = 0, cacheWrite = 0, input = 31738.
- Pass: yes (literal cacheRead = 0; the prefix cache decayed without warming).

## Verdict

- All four parts pass: yes.
- Evidence pointer: this record; raw events in the campaign session JSONLs
  (/tmp/pi-warm-cache-campaign/p2f-k and p2f-c).

## Notes

- The measured anthropic TTL is 14-50 min (control at 14 min hot, control at
  50 min at the artifact floor; the 60 min final control decayed to 0).
- The anthropic transport reports input tokens alongside cacheRead: the cache
  covers the system plus the cacheable message blocks, and the uncached tail
  is input. The seed writes cache without reporting cacheWrite (the
  no-write-reporting behavior); the control reading confirms the write.
- Long-marker replay on this transport is separately recorded in
  retained-wire.md (cache_control ttl "1h" accepted).
