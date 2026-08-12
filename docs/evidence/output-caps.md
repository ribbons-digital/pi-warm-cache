# Minimum legal output cap per upstream (Slice 7, measured)

Measured 2026-08-12 against the live gateway, pi-ai 0.83.0.
Method: direct `complete()` request with `max_tokens = 1, 2, 4, 8, 16` until accepted.
kimi-k3 is excluded (display name carries "(2x usage)" billing).
Every upstream accepts `max_tokens = 1`.

| Model | Thinking format | Minimum accepted max_tokens | Notes |
|---|---|---|---|
| deepseek-v4-flash | deepseek | 1 | out=1 |
| deepseek-v4-pro | deepseek | 1 | out=1 |
| glm-5.1 | - | 1 | out=1 |
| glm-5.2 | - | 1 | out=1 |
| hy3 | - | 1 | out=1 |
| kimi-k2.6 | deepseek | 1 | out=1 |
| kimi-k2.7-code | - | 1 | out=2 |
| mimo-v2.5 | - | 1 | out=1 |
| mimo-v2.5-pro | - | 1 | out=1 |
| minimax-m2.7 | - | 1 | out=3 |
| qwen3.6-plus | qwen | 1 | out=1 |

## Findings

- The checklist concern ("deepseek/qwen thinking formats with a max_tokens floor of 1 are untested") resolves: the floor is 1 everywhere; no upstream rejects `max_tokens = 1`.
- The extension's `applyWarmOutputLimit` floor of 1 (with `compat.maxTokensField: "max_tokens"`) is legal for every opencode-go completions upstream.
- `OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16` still governs the Responses transport (pi issue 6265); the Responses probes in the keepalive runs used the 16 floor.
