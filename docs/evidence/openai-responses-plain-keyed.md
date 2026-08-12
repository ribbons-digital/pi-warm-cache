# Evidence record: (openai-responses, opencode-go-plain with key gate)

## Identity

- pi-ai version: 0.83.0
- Provider: opencode-go
- API transport: openai-responses
- Family: opencode-go-plain (keyed-but-unretained behaves like plain)
- Model: grok-4.5
- baseUrl: https://opencode.ai/zen/go/v1
- Campaign date: 2026-08-12
- Method: temporary verification-mode override (`/warm verify=opencode-go-plain`), live pi session via pty, extension timers.
- Campaign parameters (non-default): `verify=<family>`, `interval=3m`, `maxidle=0` (idle cutoff disabled so probes continue past the default 30m cutoff), `log`. Evidence demonstrates the warming mechanism under the campaign override, not default-config behavior.

## Part 1 - Replay hit (manual probe, 2 min idle, no intervening probes)

- Prefix tokens: ~38k, above minCachedTokens.
- Idle before probe: 2 min 0 s.
- Probe result: cacheRead = 34688, cacheWrite = 0, input = 29, out = 12.
- Pass: yes.

## Part 2 - Sustained keepalive

Final window 50 min (exceeds the measured responses TTL of 20-40 min).
Timer cadence 3 min with `maxidle=0`.

- Timer probes: 17
- Timer hits: 17 (cacheRead 34688 each; details in the session JSONL)
- Idle window: 50 min.
- Pass: yes.

## Part 3 - User value

- Real-turn usage: cacheRead = 34688, cacheWrite = 0, input = 44.
- Pass: yes.

## Part 4 - Causality control

Same 50 min window with warming disabled (control session, no `verify=`).

- Control usage: cacheRead = 128, cacheWrite = 0, input = 35428.
- Decay criterion (evidence-record.template.md): control cacheRead < 1% of the
  keepalive part-3 cacheRead counts as decayed; the shared-boilerplate
  artifact floor is 128 tokens on the responses transport. 128 / 34688 = 0.37%
  < 1%, so the ~35k prefix cache is absent and the control decayed.
- Pass: yes.

## Verdict

- All four parts pass: yes.
- Evidence pointer: this record; raw events in the campaign session JSONLs
  (/tmp/pi-warm-cache-campaign/p3f-k and p3f-c).

## Notes

- The measured responses TTL is 20-40 min (independent-trial finder: hot at
  20 min, cold at 40 min).
- grok-4.5 outputs 12 tokens per probe even at the Responses 16-token floor,
  so its probe cost is higher than the completions routes.
- The responses key gate holds under the override. In-session evidence: every
  p3f-k capture event carries `cacheKeyFingerprint: "72cbb3ea"` (a stable
  `prompt_cache_key` present; fingerprint never the raw key). The negative
  case is pinned by the unit test at src/provider.test.ts:4341-4352
  (block 22: "responses without a stable key must never arm under the
  override" / "responses with a stable key must arm under the override").
