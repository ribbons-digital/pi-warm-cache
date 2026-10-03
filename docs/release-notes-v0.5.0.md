# pi-warm-cache v0.5.0

## Pi v1 compatibility and safer keepalive

Version 0.5.0 adds Pi 1.0 compatibility while keeping the earlier Pi 0.84 host path.
Automated checks cover Pi 0.84.2 with pi-tui 0.84.4 and all three Pi packages at 1.0.0.
The extension still uses Pi's host-provided packages rather than bundling another copy.

### What changes for users

- **One automatic warmer per owned route.**
  The extension stops Pi's native warmer on routes it owns, including native streaming warming during tool work.
  The extension remains idle-only; unowned routes keep Pi's native behavior.
  `/warm` shows ownership.
- **Real turns take priority.**
  Starting a real turn cancels an extension probe.
  Late replies and timeouts cannot replace the new request's observations or failure status.
  Cancellation does not guarantee zero provider usage for a request already sent.
- **Safer scheduling.**
  Cache opt-out and budget-based Anthropic thinking prohibit automatic replay.
  Delayed probes cannot send an expired payload.
  OpenAI's explicit thirty-minute policy requires that TTL on the captured request, not just model metadata.
- **Fresh requests after resets.**
  Off/on, reload, session replacement, compaction, and route or thinking changes require a new real turn before probing resumes.
  `/warm off` disables only this extension, not native warming or provider caching.
- **Bounded ChatGPT manual probes.**
  New `openai` ChatGPT sign-in is separate from legacy Codex.
  Only Luna (`gpt-5.6-luna`) with thinking off and Sol (`gpt-6.1-sol`) with low thinking on the first-party Responses endpoint are eligible.
  A safe keyed real request is required.
  One `/warm now` action sets sixteen output tokens, forty-five-second cancellation, zero automatic HTTP retries, and no scheduled follow-up.
  A configured spend ceiling applies; input usage, total request cost, and subscription allowance use are not capped.
  Captured `instructions` remain unchanged and cannot remove the final output cap.

### What stays the same

Existing verified-route commands, cadence controls, concurrency limits, and defaults remain, except for the safety restrictions above.
Legacy Codex timers remain enabled by default with output-spike protection; `/warm codex-off` disables them.
Existing verified-route manual idle/spend bypass remains available while the anchor is usable.
Unlisted proxies and unsafe or unknown subscription routes fail closed.
xAI best-effort behavior does not become a provider TTL guarantee.

### Limits

Automatic ChatGPT subscription warming remains disabled because cache preservation is unverified.
No new cost-aware warming policy or live cache-preservation claim is included.
Savings compare probe prices, not measured avoided spending on your next real turn.
Expiry deadlines are conservative safety limits, not measured provider retention.
Native requests already sent cannot be cancelled by the veto, and a later extension handler can override it.
Native usage remains outside the extension's counters.

## Upgrade

On Pi v1, update an unpinned installation with `pi update npm:pi-warm-cache`.
For a pinned installation, use `pi install npm:pi-warm-cache@0.5.0`.
Restart or reload Pi, send a real turn, then check `/warm` for ownership and probe eligibility.
See the [upgrade guide](upgrade-notes.md#upgrading-from-040-to-050) for the behavior changes and [README](../README.md) for commands and supported routes.
