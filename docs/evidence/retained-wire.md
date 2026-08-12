# Retained-wire observations (Slice 7, measured)

Measured 2026-08-12, pi-ai 0.83.0, via the adapter `onPayload` wire capture.

## Completions transport (deepseek-v4-flash, cacheRetention "long")

The adapter emits on the wire:

- `prompt_cache_retention: "24h"`
- `prompt_cache_key`: absent
- `cache_control`: absent

A real turn with Pi long retention therefore classifies as `opencode-go-retained`
(`classifyOpencodeGoFamily` precedence 1). The retained family never probes:
`intervalMs: null`, `/warm now` refused, reason names the 24h retention.

## Anthropic long-marker replay (minimax-m3, cacheRetention "long")

The adapter emits `cache_control: {"type": "ephemeral", "ttl": "1h"}` on the wire.
The gateway ACCEPTS the payload (no 400/422). This is the long-marker replay shape
(`opencode-go-long-marker`, precedence 2). The first request is a cold write
(cache_read=0); a follow-up with the same prefix is the keepalive measurement.

## Beta-header behavior (anthropic-messages transport)

pi-ai 0.83.0 `anthropic-messages` adapter sends `anthropic-beta` when the feature
set is non-empty:

- `fine-grained-tool-streaming-2025-05-14`
- `interleaved-thinking-2025-05-14` (skipped for adaptive-thinking models:
  `compat.forceAdaptiveThinking === true`)

The opencode-go route authenticates by API key (not OAuth), so the API-key
branch applies and beta headers match between capture and replay. Replayed
long-marker payloads therefore carry identical headers to the captured real
turn, preserving the byte-exact replay contract.

## Notes

- kimi-k2.6 declares `supportsLongCacheRetention: false`; a long-retention turn
  on it is not expected to emit the 24h retention field. The retained-wire
  observation used deepseek-v4-flash.
