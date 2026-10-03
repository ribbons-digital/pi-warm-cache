# OpenAI ChatGPT cache-miss investigation

## Result

The follow-up found no request-body drift, header drift, or cache-usage parsing error in its immediate replay checks.
It did not reproduce or identify the service-side cause of the earlier eight-minute miss.

It did establish a capability mismatch that matters for the compatibility plan.
Both tested subscription models rejected an explicit thirty-minute cache lifetime and the native prewarm option.
A diagnostics-only Luna request was accepted but returned `unavailable`, not an explanation of the miss.
Sol diagnostics were not tested.

Do not treat these authenticated routes as having a verified thirty-minute lifetime or verified automatic warming.
Do not shorten the timer or add repeated cold writes and claim that the original problem is fixed.
Production code and user settings were unchanged during this investigation.

## Scope and safeguards

- Date: 2026-10-03.
- Pi packages: 1.0.0 in Docker Sandbox `pi-warm-cache-v1-research`.
- Authentication: A scoped copy of the existing OpenAI OAuth access credential, with no refresh token.
- Endpoint: Confirmed at actual HTTP dispatch as `https://api.openai.com/v1/responses`.
- Models: `gpt-5.6-luna` with no thinking and `gpt-6.1-sol` with low thinking.
- Input: Synthetic text only.
- Output limit: Sixteen tokens on every follow-up request.
- Native warmer and production extension timers: Not loaded.
- Automatic HTTP retries: Disabled.
- Guards: Request counts, a forty-five-second timeout, streamed-output limits, token-validity checks, and catalog-price soft ceilings.

The scoped credential was removed after each run.
No login, refresh-token rotation, or host authentication change was performed.

## Checks and observations

### Actual request and response checks

The follow-up recorded hashes of the serialized HTTP body, input, non-secret headers, and session-routing headers.
It checked that the bearer credential matched the scoped access token without logging that token.

Three Luna requests used identical serialized bodies and headers.
The first was cold; the next two reused 6,912 cached tokens.
The returned model remained `gpt-5.6-luna`, and the returned service tier remained `default`.

The driver's raw completed-response usage agreed with Pi's parsed cached reads, cache writes, and output count on all four successful follow-up responses.
The provider itself reported zero cache-write tokens, including on the cold seed.
No usage-conversion defect was found.
These checks apply to the follow-up, not retroactively to unrecorded headers from the earlier timed campaign.

### Native cache fields

| Request | Model | Result |
|---|---|---|
| `comparison_response_id` only | Luna | HTTP 200; cached read; diagnostics `unavailable` |
| Diagnostic comparison plus `ttl: "30m"` | Luna | HTTP 400 |
| `prewarm: true` plus `ttl: "30m"` | Luna | HTTP 400 |
| `ttl: "30m"` only | Luna | HTTP 400 |
| `prewarm: true` only | Luna | HTTP 400 |
| `ttl: "30m"` only | Sol | HTTP 400 |
| `prewarm: true` only | Sol | HTTP 400 |

Each rejection reported `prompt_cache_options is not supported on this model`.
The separate field tests prevent a combined-field rejection from being mistaken for proof that both individual controls are unsupported.
The Sol field checks used a short prompt and tested acceptance, not useful cache reuse.

The successful diagnostics response echoed `mode: "implicit"` and `ttl: "30m"` even though the request did not ask for that lifetime.
That echo is not a measured retention guarantee.
The explicit lifetime request was rejected, and the earlier campaign had already shown a miss within eight minutes.
A miss also does not, by itself, prove that an entry expired: a request may fail to reach a machine that holds it.

## Official documentation versus observed behavior

The current [OpenAI prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) describes a thirty-minute default lifetime and `prewarm: true` for GPT-5.6 and later supported models.
It also says cached states live on individual machines and that retaining a matching prefix does not guarantee a cache hit.
For these newer models, cache keys are described primarily as a way to separate cache accounting, not a way to pin requests to a machine.

The [diagnostics guide](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics) describes `comparison_response_id` and explicitly calls diagnostic results best effort.
An `unavailable` result supplies no cause and is not evidence of either a hit or a miss.

The generic API documentation and model capability metadata are therefore not sufficient evidence for the tested ChatGPT-authenticated model profiles.
Do not infer that all OpenAI subscription models or API-key requests share these restrictions.
The rejection does not isolate whether the restriction depends on authentication, account, model variant, or deployment.

## Limits and next decision

The original eight-minute miss remains unexplained.
Backend routing, cache eviction, hidden rendered-context changes, and retention behavior remain possible causes, not established diagnoses.
No valid expiry-versus-warming control comparison has completed.

Keep this connection's automatic warming unverified in the compatibility proposal.
Bounded manual replay remains a candidate only for the tested output-cap profiles, with no cache-preservation promise.
Preserve existing verified routes and their controls.
At the time of this investigation, the extension did not enforce the proposed subscription restriction.
The later reviewed Slice 2 implements the [manual safety contract](../upgrade-notes.md#openai-chatgpt-subscription-manual-contract), with automatic subscription warming still disabled.
Its synthetic checks add no new live cache-preservation evidence.

A further timed comparison would need a fresh, sufficiently long-lived access token.
The copied token was nearing the driver's safety cutoff; it was not refreshed to extend the experiment.
Further live testing should collect the untouched control even if the treatment fails, mark the treatment as failed, and never use a cold rewrite as preservation evidence.

## Usage and artifacts

- Follow-up provider requests: Ten.
- Successful responses: Four.
- Validation rejections: Six.
- Largest reported output: Five tokens.
- Successful-response catalog-price equivalent: About $0.00210.
  Rejections supplied no billable-usage response; this is not a subscription allowance measurement.
- Driver syntax and lint: Passed.
- Immediate wire-identity and usage-conversion assertions: Passed.
- Exact service-side miss diagnosis and cache-preservation causality: Not established.

Redacted observations: `docs/evidence/openai-chatgpt-v1-cache-investigation.jsonl`.
The raw sandbox log retains the original observations; the project artifact omits unused per-message attribution identifiers.
The reusable research driver remains `/tmp/pi-warm-cache-v1-research.J82S7J/chatgpt-live-trial.mjs`.
Its follow-up phases are `WARM_TRIAL_PHASE=diagnose` and `fields`, with `WARM_TRIAL_REPORT` selecting a separate evidence file.
The driver must run inside the Docker Sandbox.

## Review gate

The required Fable 5 review was attempted but did not start.
Launch ID: `37177beb-8381-405f-9748-83ba7c6ad98c`.
A status lookup found no registered async run, consistent with the pre-start failure.

The runtime error was:

```text
Background children require the host npm package (@earendil-works/pi-coding-agent) with its dependencies;
/Users/shiang/.nvm/versions/node/v22.22.3/lib/node_modules/@earendil-works/pi-coding-agent
does not provide @earendil-works/pi-agent-core/node.
```

The review target remained the main checkout at `3153e19`, with only untracked research documents and evidence.
No reviewer session, worktree, implementation, or fallback model was launched.
No consensus recommendation or implementation approval is claimed.
Repairing the delegation setup is a separate task requiring owner approval.

### Astra retry after the extension update

The user updated pi-subagents and approved a same-protocol retry with Astra instead of Fable 5.
The user explicitly prohibited Anthropic calls for this task.
The selected reviewer model was `openai-codex/gpt-6-astra`, confirmed in the local model catalog.
The review target remained the existing Luna and Sol evidence, not new warming profiles.

The retry failed at startup with:

```text
(0 , _requiredChildExtensions.assertRequiredChildExtensionsAdmitted) is not a function
```

No reviewer result or consensus was produced.
The subsequent status check reported no active async runs.
No Anthropic calls or alternate execution-mode fallback were used.

At the time of the retry, the checkout remained on `main` at `3153e19`, with untracked research documents and unchanged production code.
The retry snapshot is `/tmp/pi-warm-cache-astra-retry-3153e19.tar`.
At that point, the startup failure prevented the automated review gate from completing.

### Direct Astra review supplied by the user

The user later supplied a review performed directly with Astra in a separate chat.
This was an evidence review, not a rerun of the tests or a repair of pi-subagents.
The reported verdict was “agree with corrections.”
The parent checked and accepted all three findings:

1. The research driver's `expiredTrial` and `causalityDemonstrated` conclusion path overstates what one miss and one comparison can prove.
   That path did not execute in the recorded campaign, so the existing negative finding remains valid.
   Do not reuse the timed branch before correcting its conclusion and stop paths.
   Future campaigns need repeated independent comparisons and an untouched control collected even after treatment failure, subject to safety guards.
2. The current production request path lacks the experiment's explicit timeout and zero-retry settings, and manual `/warm now` bypasses the spend ceiling.
   The future manual experiment needs explicit request, output, timeout, retry, authentication/profile, timer, budget, and accounting rules.
   Tested output bounds are not input-cost or subscription-allowance bounds.
3. Slice 1 retains a first-party OpenAI capability classification that does not distinguish subscription authentication.
   Slice 1 is therefore a non-release host-contract check.
   Ownership, subscription restrictions, their documentation, and regression checks must ship together before a compatibility release.

Source checks used `src/warmer.ts`, `src/capability.ts`, `README.md`, and the research driver.
The updated compatibility plan records these corrections.
The agreed next recommendation is Slice 1 only, with no further live ChatGPT campaign and no release claim.
Implementation, publishing, and the later safety slice still require separate user approval.
The pi-subagents startup issue remains unresolved by this manual review.
