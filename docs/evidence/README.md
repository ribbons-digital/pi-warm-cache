# Slice 7 E2E verification campaign

Run the four-part evidence gate per (api, family) against a real OpenCode Go account, through the temporary verification-mode override.
The override never ships as a verified path and is removed after the campaign.

Status: executed 2026-08-12 with the live Go account and pi-ai 0.83.0.
Verdicts: (anthropic-messages, short-marker) and (openai-responses, plain with key gate) pass all four parts; (openai-completions, plain) passes parts 1-3 and part 4 is not satisfied because the native completions cache TTL exceeds 130 min, so keepalive causality is not demonstrated on that route.

The temporary verification-mode override was removed from the code after the campaign per the spec and never ships as a verified path (the code contains no verification-mode override today).
Slice 8 promotes the recorded pairs to verified as data changes citing these records.

## Evidence gate (four parts, per pair)

The pi-ai version and the tested model are pinned in every evidence record.

1. **Replay hit**: a manual probe on a real captured payload after at least 2 minutes idle returns `cacheRead > 0` on a prefix at or above `minCachedTokens`.
2. **Sustained keepalive**: at least 3 consecutive timer-cadence probes hit across an idle window that exceeds the presumed base TTL.
3. **User value**: the first real turn after the idle window shows `cacheRead > 0`.
4. **Causality control**: the same idle window with warming disabled shows `cacheRead = 0` on the post-idle real turn.

Sequencing: (openai-completions, plain) first, then (anthropic-messages, short-marker), then (openai-responses, plain with key gate), plus retained-wire observations.
(anthropic-messages, long-marker) stays unverified.

## Routes under test

| Pair | Model | API | baseUrl |
|---|---|---|---|
| (openai-completions, plain) | deepseek-v4-flash | openai-completions | https://opencode.ai/zen/go/v1 |
| (anthropic-messages, short-marker) | minimax-m3 or qwen3.7-max/plus | anthropic-messages | https://opencode.ai/zen/go |
| (openai-responses, plain with key gate) | grok-4.5 | openai-responses | https://opencode.ai/zen/go/v1 |

## Setup per pair

1. Run pi with the extension against the Go route:

   ```bash
   pi -e ./src/index.ts --warm-cache=true
   ```

2. Enable file diagnostics and the verification mode for the campaign family:

   ```
   /warm log
   /warm verify=opencode-go-plain
   ```

   `verify=` takes comma-separated family names; only opencode-go routes whose payload-derived family is listed arm timers.
   The route stays `capability=unverified`; status shows `verificationMode=on` and `verification mode family=<family>`.

3. Build a big prefix.
   Read a few large files so the prompt prefix is well above 50k tokens.
   Do two real turns; the second must show `cacheRead > 0`.
   If it does not, the problem is Pi cache configuration, not the extension.

4. Confirm the anchor and the mode:

   ```
   /warm
   ```

   Expect `verification mode family=<family>`, `lifecycle=anchored`, `capability=unverified (temporary verification override)`, `verificationMode=on`, `probeFailStreak=0/3`.

## Run the gate

- **Part 1**: wait 2+ minutes idle, then `/warm now`.
  Record the probe `read=`/`write=` values from the result or the JSONL `attempt` event.
- **Part 2**: keep the session idle past the presumed base TTL (plain ~4m cadence: 12+ minutes).
  The timer probes fire automatically.
  Record at least 3 consecutive `attempt` events with `ok: true` and `probeOutcome: "hit"`.
- **Part 3**: send a normal real turn with the same prefix.
  Record `cacheRead > 0` on the `usage` event (real_turn).
- **Part 4**: repeat the idle window with `/warm off` (or no `verify=`), then send a real turn.
  Record `cacheRead = 0` on the `usage` event.

Everything is in `.pi/warm-cache.jsonl` when `/warm log` is on.

## Evidence records

- `registry-snapshot.md`: live registry, baseUrls, pi-ai version (0.83.0).
- `openai-completions-plain.md`: deepseek-v4-flash; parts 1-3 pass; part 4 not satisfied (TTL > 130 min).
- `anthropic-messages-short-marker.md`: minimax-m3; four-part pass (control cacheRead=0).
- `openai-responses-plain-keyed.md`: grok-4.5; four-part pass (control decayed to artifact floor).
- `retained-wire.md`: retained-wire + anthropic long-marker + beta-header behavior.
- `output-caps.md`: minimum legal output cap per upstream (all accept max_tokens=1).

## Completion

Check off the Slice 7 todo list in `docs/specs/04-opencode-go-warming.md` and remove the verification-mode override from the code after the campaign.
