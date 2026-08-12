# OpenCode Go live registry snapshot (Slice 7 evidence)

Captured from the installed pi-ai registry on 2026-08-11.

- pi-ai version: 0.83.0
- Source: `node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json`
- Count: 16 models across three API transports

## Transports and base URLs

| API transport | baseUrl path |
|---|---|
| `anthropic-messages` | `https://opencode.ai/zen/go` |
| `openai-completions` | `https://opencode.ai/zen/go/v1` |
| `openai-responses` | `https://opencode.ai/zen/go/v1` |

The registry matches the registered proxy routes in `src/capability.ts` (PROXY_ROUTE_REGISTRY): `/zen/go` for anthropic-messages, `/zen/go/v1` for both OpenAI transports.
Exact-path equality applies after trailing-slash normalization; `/zen/go` never matches `/zen/go/v1`.

## Models

### anthropic-messages at https://opencode.ai/zen/go

| Model | Reasoning | Compat |
|---|---|---|
| minimax-m3 | true | - |
| qwen3.7-max | true | - |
| qwen3.7-plus | true | - |

### openai-completions at https://opencode.ai/zen/go/v1

All completions models declare `maxTokensField: "max_tokens"`, so the uncapped-completions warm probe writes `max_tokens`, never the default `max_completion_tokens`.

| Model | Reasoning | Thinking format | Notable compat |
|---|---|---|---|
| deepseek-v4-flash | true | deepseek | requiresReasoningContentOnAssistantMessages, no developer role, no store |
| deepseek-v4-pro | true | deepseek | same as flash |
| glm-5.1 | true | - | no developer role, no store |
| glm-5.2 | true | - | no developer role, no store |
| hy3 | true | - | no developer role, no store |
| kimi-k2.6 | true | deepseek | no developer role, no store, no long cache retention, no reasoning effort |
| kimi-k2.7-code | true | - | no developer role, no store |
| kimi-k3 | true | - | no developer role, no store (2x usage billing) |
| mimo-v2.5 | true | - | no developer role, no store |
| mimo-v2.5-pro | true | - | no developer role, no store |
| minimax-m2.7 | true | - | no developer role, no store |
| qwen3.6-plus | true | qwen | no developer role, no store |

### openai-responses at https://opencode.ai/zen/go/v1

| Model | Reasoning | Compat |
|---|---|---|
| grok-4.5 | true | sessionAffinityFormat: "openai-nosession" |

## Notes

- kimi-k3 lists "(2x usage)" in its display name, relevant to the budget-dollar savings framing: the marker keys on provider billing identity, never on model metadata.
- kimi-k2.6 declares `supportsLongCacheRetention: false`; the retained-wire observation must not use it for a 24h retention turn.
- The completions thinking-format field (deepseek / qwen) matters for the minimum-legal-output-cap checklist item: reasoning models with a `max_tokens` floor of 1 are untested until probed.
