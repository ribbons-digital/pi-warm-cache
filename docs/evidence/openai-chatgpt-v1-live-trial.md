# OpenAI ChatGPT sign-in: Pi v1.0 live trial

## Result

Bounded exact-payload replay worked through the new OpenAI ChatGPT sign-in connection.
A 16-token output limit was accepted and enforced on both tested models.
This corrects the earlier assumption that this connection necessarily rejects that field.

Reliable cache preservation during idle time was not demonstrated.
The timed campaign stopped when its second warming probe returned no cached reads.
Do not promote this result to verified automatic warming or claim savings from cache preservation.

## Scope

- Date: 2026-10-03, with timestamps in UTC in the raw evidence.
- Pi packages: 1.0.0.
- Provider/API: `openai` / `openai-responses` at the first-party OpenAI endpoint.
- Authentication: The user's stored OpenAI OAuth login, not an API key and not legacy Codex.
- Models: `gpt-5.6-luna` and `gpt-6.1-sol`.
- Thinking settings: `none` for Luna and `low` for Sol.
- Prompt: Synthetic reference text, approximately 7,260 tokens, with a different random identifier at the start of each independent prefix.
- Environment: Docker Sandbox `pi-warm-cache-v1-research`.
- Native warming and extension timers: Not loaded.
  The test driver scheduled the candidate requests itself.
- Production extension code: Unchanged.

Only the OpenAI access credential was copied into the sandbox.
No refresh token or unrelated credentials were copied.
The credential copy was deleted after the trial.

## Request acceptance and output limit

Pi's v1 adapter omits `max_output_tokens` on ChatGPT-authenticated requests.
The trial first used that unmodified request, then injected `max_output_tokens: 16` through the supported payload hook.

| Check | Result |
|---|---|
| Small ordinary request through ChatGPT login | Accepted; five output tokens |
| Small uncapped OK-only suffix replay | Accepted; five output tokens |
| Small capped suffix replay | Accepted; five output tokens |
| Luna request asking for a longer answer, capped at sixteen tokens | Exactly sixteen output tokens; `stopReason: length` |
| Sol request asking for a longer answer, capped at sixteen tokens | Exactly sixteen output tokens; `stopReason: length` |

The adapter's conservative behavior is not proof that the current service rejects the cap.
The live result is specific to these models, settings, endpoint, account, and test date.
High thinking levels and other models were not tested.

## Immediate cache reuse

| Model/path | Probe cached reads | Following real turn cached reads |
|---|---:|---:|
| Luna, bare capped replay | 6,912 | 6,912 |
| Sol, bare capped replay | 7,040 | 7,040 |
| Luna, a separate suffix trial | 6,912 | 0 |

The bare replay copied the captured request body and changed only its output limit.
It did not need an appended warm instruction.
The successful following real turns retained the original request as an exact serialized prefix.

The suffix trial's following real turn missed.
That does not establish that the suffix caused the miss.
Other identical requests also sometimes missed before their first confirmed cached read.
There is no evidence here that the suffix is better than the existing bare replay.

## Timed campaign

The planned campaign used four independent groups:

1. A six-minute expiry check.
2. A twelve-minute expiry check.
3. A twenty-minute control with no warming after its baseline.
4. A twenty-minute treatment with bare capped probes every four minutes.

Every group had to confirm reuse of at least 80% of its seeded prompt before its idle clock began.
A later cache miss was never treated as expiry unless that group's initial reuse was confirmed.
Each expiry group would receive only one replay after its confirmed baseline.
Its requests could not refresh the other groups' prefixes.

The first attempt stopped immediately because the first group's initial cached read was not confirmed.
The revised attempt allowed at most three baseline checks per group, with short waits between them.
All four groups then confirmed 6,912 cached tokens.
The clocks started after each successful confirmation, not after an earlier failed attempt.

| Completed observation | Cached reads | Outcome |
|---|---:|---|
| Treatment at four minutes | 6,912 | Hit |
| Independent group after six idle minutes | 6,912 | Hit |
| Treatment at eight minutes, about four minutes after its previous hit | 0 | Miss; campaign stopped |

The four-minute and eight-minute treatment requests had identical captured-body fingerprints and cache-key fingerprints.
No prompt, model, thinking setting, or key change explains the observed miss within the test driver.
This does not identify the service-side cause.
Possible explanations include eviction, routing differences, or reads not extending the cache lifetime as assumed.
The trial did not distinguish them.

The driver stopped rather than retrying a cold write and calling that successful preservation.
The twelve-minute expiry request and both twenty-minute final turns did not run.
Consequently, the normal cache lifetime was not established, and a warming-versus-control benefit was not proven.

## Usage and checks

- Live requests: 31 across acceptance, output-cap, immediate-reuse, aborted-baseline, and timed checks.
- Luna requests: 27.
- Sol requests: 4.
- Largest reported output: Sixteen tokens.
- Model-catalog price equivalent: About $0.03848 in total.
  This is not a card charge or a measured reduction in subscription allowance.
- Guards: Request-count limits, a $0.05 catalog-price soft ceiling, no automatic HTTP retries, a forty-five-second request timeout, and streamed-output cancellation guards.
- Script syntax and lint: Passed.
- Cache-preservation test: Failed at the second treatment tick.
- Full extension install, command handling, UI, native-warmer coexistence, and automatic rescheduling: Not tested in this live trial.

## Effect on the compatibility plan

Keep bare exact-payload replay as the preferred candidate for these subscription models.
Do not add a Codex-style suffix solely because Pi omits output limits by default.
Do not block a bounded manual probe solely on the earlier output-field assumption.

Automatic warming still needs independent verification.
The short-retention subscription request carried a cache key but no explicit cache TTL or retention field.
A model's explicit-cache capability flag therefore must not select a thirty-minute lifetime for this request.

Before enabling timers by default for this connection, investigate the identical-request miss and complete a valid expiry/control comparison.
Retain strict limits and honest miss reporting in the meantime.

## Artifacts

- Redacted raw observations: `docs/evidence/openai-chatgpt-v1-live-trial.jsonl`.
- Research driver: `/tmp/pi-warm-cache-v1-research.J82S7J/chatgpt-live-trial.mjs`.
- Sandbox Node executable: `/tmp/warm-node-runtime/node_modules/node-linux-arm64/bin/node`.
- Driver phases: `WARM_TRIAL_PHASE=cap`, `cache`, or `timed`.
- Model selection: `WARM_TRIAL_MODEL=gpt-5.6-luna` or `gpt-6.1-sol`.
- Bare immediate replay: `WARM_TRIAL_BARE_ONLY=1`.

Run the driver only inside the Docker Sandbox and supply a newly scoped, valid access credential.
The old credential copy no longer exists.
Raw observations contain usage, status, model names, timestamps, and redacted fingerprints, not prompts, API keys, or raw cache keys.
