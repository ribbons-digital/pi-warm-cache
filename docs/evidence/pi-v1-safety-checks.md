# Pi v1 Slice 2 safety verification

Date: 2026-10-03.
Branch: `compat/pi-v1-safety`, based on merged Slice 1 commit `4b17f916c21697c348b145cdf30485ad7ef7481c`.
The user reported that independent re-review passed after the blocking cap finding was corrected.
The user approved committing, pushing the feature branch, and opening the Slice 2 pull request on 2026-10-03.
Merge, release, and a new live campaign remain unapproved.

## Technical checks

Final checks ran sequentially inside Docker Sandbox `pi-warm-cache-v1-research`.
Runtime: Node 24.21.0 and pnpm 10.0.0.
Workspace: `/tmp/pi-warm-cache-v1-research.J82S7J`.

| Target | `pnpm test` | `pnpm typecheck` | `pnpm lint` |
|---|---|---|---|
| pi-ai/coding-agent 0.84.2, pi-tui 0.84.4 | Passed | Passed | Zero warnings/errors |
| All three Pi packages 1.0.0 | Passed | Passed | Zero warnings/errors |

The full test command runs the existing unit suite, `src/safety.test.ts`, and `scripts/check-pi-host.ts`.
Checks use synthetic providers and dummy auth only.
They verify exact replay, route/auth/profile/payload refusal, cache opt-out, budget thinking on direct and registered proxy routes, expiry after deferral/preparation, and dispatch-time refresh clocks.
Idle cutoff and Codex-off policy are also rechecked after awaited payload preparation; both missing guards were reproduced before their correction.
Subscription checks cover sixteen tokens, forty-five-second cancellation, zero automatic HTTP retries, spend prechecks, and no scheduled follow-up.
The real v1 Responses adapter serializes cap-only Luna/off and Sol/low replays, handles synthetic HTTP 500 without retry, and cancels a hung synthetic fetch at the deadline.
Existing verified-route defaults, manual controls, cadence, idle/spend controls, retry behavior, and Codex protection remain in the full unit suite.

The v1 host check uses the installed native warmer with the actual extension decision chain.
It verifies off, streaming, and idle modes, a single dispatch owner, preserved real-turn anchors, off/on handoff, and a later handler overriding the stop decision.
That private native import is test-only; production uses the public version-gated decision hook.
The old host has no native warmer, so native integration is not applicable there.

Reload clears an active timer on both hosts.
Compaction, tree, and replacement checks emit lifecycle events through the installed runner and require fresh anchors afterward.
They do not perform a live compaction or the complete `/new` host journey.
Fresh replacement-session events create a usable warmer instead of leaving a disposed instance.

The original real-turn race failed before its fix with `real turn must abort the in-flight warm request`.
A final regression also reproduced a retired timeout writing failure status onto a new anchor.
The fix checks request ownership before recording timeout status.
Both regressions pass in the final suite.

Logs under the research workspace:

- `slice2-real-turn-baseline.log` and `slice2-real-turn-v1.log`: Initial cancellation checks.
- `slice2-retired-timeout-before.log`: Failing late-timeout status regression before the correction.
- `slice2-delayed-policy-before.log`: Failing delayed idle-cutoff check before correction.
- `slice2-delayed-codex-before.log`: Sandbox-only removal of the Codex dispatch guard fails the explicit Codex-off regression; the normal source was restored afterward.
- `slice2-final-slice1-baseline.log` and `slice2-final-slice1-v1.log`: Final full checks and installed version reports.

## Review correction: instructions must not remove the subscription cap

The user's review found that an eligible subscription body containing string `instructions` matched the legacy Codex shape heuristic.
The shared output shaper then removed `max_output_tokens` despite an explicit `openai-responses` API.
Request-level `maxTokens: 16` did not restore the cap after payload replacement.
This was a blocking output-safety defect, not live retention evidence.

The regression in `scripts/check-pi-host.ts` failed before the fix on both dependency targets with `undefined !== 16` at the final intercepted HTTP body.
It uses otherwise eligible Luna/off and Sol/low captured instructions bodies, synthetic public-registry OAuth classification, and the real installed `complete()`/Responses adapter with dummy credentials.
It requires one request, exactly `max_output_tokens: 16`, and deep equality of every remaining captured field.
This synthetic auth classification does not claim the older host supports the new ChatGPT sign-in flow.
The separate v1 stored-dummy-OAuth checks remain intact.

The shared shaper now treats an explicit API as authoritative.
Known Responses routes always set their legal output field and preserve the rest of the body.
Legacy Codex still strips injected caps when its API is explicit or inferred without an API argument.
Unit checks retain suffix, reasoning, tool, and output-spike regressions and now test that explicit OpenAI/Azure Responses routes do not inherit Codex shaping.
No capability restriction, live claim, timeout, retry, spend policy, or default changed.

Full checks exposed a separate test-fixture issue: re-registering the provider without `apiKey` retained the previous dummy API key under Pi's merge contract.
That let the stored-OAuth test report a verified API-key route instead of its expected unverified subscription route.
That correction removed the previous registration and asserted that the public runtime reported OAuth before testing it.
CI later exposed a remaining background-refresh race, addressed below.
The new synthetic-classification fixture runs afterward and restores its method mock.
No production auth logic or existing assertion was relaxed.

Review-correction logs under the research workspace:

- `slice2-review-cap-before-slice1-baseline.log` and `slice2-review-cap-before-slice1-v1.log`: Final HTTP cap regression fails before the fix.
- `slice2-review-cap-after-slice1-baseline.log` and `slice2-review-cap-after-slice1-v1.log`: Initial instructions HTTP regression and existing unit suite pass after the fix.
- `slice2-review-cap-mutation-slice1-baseline.log` and `slice2-review-cap-mutation-slice1-v1.log`: Final regression still fails when the buggy Codex heuristic is restored only in sandbox copies; both copies were restored afterward.
- `slice2-review-stored-oauth-fixture-before.log` and `slice2-review-stored-oauth-fixture-after.log`: Failed original OAuth notice expectation, followed by passing stored-OAuth checks, type checking, and lint after removing the retained dummy key.
- `slice2-review-cap-final-slice1-baseline.log` and `slice2-review-cap-final-slice1-v1.log`: Full tests, type checking, and lint after correction.

The saved UI renders below predate this correction.
No UI or command text changed; the correction is in shared request shaping and is checked at the intercepted HTTP boundary.
No additional live campaign or review launch was performed.

## PR #72 CI correction: isolate the OAuth runtime

The [initial CI run](https://github.com/ribbons-digital/pi-warm-cache/actions/runs/37156266219) passed Pi 0.84.2 but failed Pi 1.0.0 at `stored-OAuth fixture must not retain API-key auth` with `false !== true`.
Five unchanged host-check runs passed locally on the ARM sandbox, so the CI failure was not reproduced there.
The failing CI log is preserved as `slice2-pr72-ci-github-before.log` in the research workspace.

Pi's provider registration starts unawaited refreshes.
A full auth refresh whose sequence has been superseded returns without publishing its snapshot.
An awaited refresh of the reused API-key runtime therefore did not guarantee that the new OAuth snapshot was ready.
Removing the previous provider registration was not a complete fix for this race.

The OAuth scenario now uses a fresh runtime and SDK session with dummy OAuth credentials seeded before runtime creation.
All refreshes in that runtime see the same credential type, rather than switching from API-key setup mid-test.
The original session emits shutdown and is disposed before replacement.
The public OAuth assertion, real adapter cap/retry/timeout assertions, and instructions-body HTTP regressions remain intact.
The existing handler-error assertion moved to the end so it covers both SDK sessions without narrowing the error array before the second callback is registered.
Production code, dependency versions, capability policy, and CI requirements did not change.

Both targets passed full tests, type checking, and lint in the Docker Sandbox after this correction.
Ten additional Pi 1.0.0 host-check runs passed.
The deny-all rule remained active, and no live provider campaign ran.
These local results do not substitute for the new GitHub CI run.

Logs under the research workspace:

- `slice2-pr72-ci-before.log`: Five local passes with the original setup, despite the recorded CI failure.
- `slice2-pr72-ci-focused-after.log`: First focused test pass followed by the error-array type-check failure; preserved as failed intermediate evidence.
- `slice2-pr72-ci-final-slice1-baseline.log` and `slice2-pr72-ci-final-slice1-v1.log`: Full passing checks after correction.
- `slice2-pr72-ci-repeat-after.log`: Ten passing Pi 1.0.0 host checks with isolated OAuth setup.

## CLI UI checks

The actual Pi 1.0.0 CLI ran in a pseudo-terminal, meaning a terminal input/output device controlled by the test driver.
Regular mode used 80 columns; fullscreen used 120 columns; both used 40 rows.
The config, home directory, and dummy OAuth data were isolated.
Native warming was off for this display check; the host integration above checks native ownership separately.

Each mode recorded exactly three intercepted provider calls: one synthetic real turn, one successful manual replay, and one manual synthetic HTTP 500.
Both manual calls serialized `max_output_tokens: 16`.
The failure did not retry.
Off cleared the extension widget/status and explained that native warming was unchanged.
On followed by `/warm now` refused the old payload with `awaiting a new real-turn payload` and sent no further provider request.
Both CLI processes exited zero.

Saved ANSI output and terminal-grid text/SVG renders cover hit, failure, off, and re-anchor refusal.
PNG previews of those renders were inspected for status text, warning/error distinction, manual-only labels, limits, and transitions.
These are controlled terminal-grid renders, not screenshots of a user's terminal app.
The command's existing detailed diagnostics remain verbose; no general UI redesign is included.
The UI observation lasts about twenty seconds; longer no-follow-up behavior is checked with the controlled clock in the technical suite.

Artifacts under the research workspace:

- `check-ui.py`: Scratch real-CLI terminal driver.
- `ui-bootstrap.mjs`: Synthetic transport loaded before the CLI.
- `slice2-ui-offline-final.log`: Assertions and isolated run directories.
- `slice2-ui-offline-{regular,fullscreen}.ansi`.
- `slice2-ui-offline-{regular,fullscreen}-{hit,failure,off,refused}.{txt,svg}`.
- Each final isolated run's `transport.jsonl`: Synthetic URL/model/output-cap records without auth or prompt text.
- Preview PNGs: `/tmp/pi-warm-cache-ui-previews/`.

## Failed offline harness and correction

The first CLI harness was not offline.
Both original `slice2-ui-{regular,fullscreen}-hit.txt` captures contained actual OpenAI HTTP 401 responses for a dummy OAuth credential.
The requests used synthetic prompts and isolated dummy auth, not a real provider credential.
They reached the service and are excluded from successful offline or cache-hit evidence.
The initial CLI also downloaded its fd tool through GitHub.
Those original captures are preserved separately; they are not the `slice2-ui-offline-*` results above.

Cause: the preload installed `globalThis.fetch` before Pi's HTTP dispatcher module loaded.
CLI setup then installed undici's transport and replaced that stub.
The repaired preload imports the exact installed `core/http-dispatcher.js` first, then installs the synthetic fetch.
Pi's existing deliberate-override guard preserves that ordering.
The stub rejects unexpected HTTP locally and records every intercepted provider call.
The missing streamed text events in the initial synthetic response were also corrected before accepting the UI result.

Before rerunning, sandbox-scoped network denial was applied:

```bash
sbx policy deny network --sandbox pi-warm-cache-v1-research '**'
sbx policy check network --sandbox pi-warm-cache-v1-research https://api.openai.com/v1/responses
```

Policy checks returned explicit denial for OpenAI, ChatGPT, Anthropic, GitHub, and an IP target.
Rule ID: `cd6f3bc3-4161-497d-8287-9ce60fa68414`.
The rule remains enabled and does not change other sandboxes.
`slice2-network-audit-final.json` records policy enforcement and earlier traffic separately.
Its latest allowed provider connection predates the deny rule; later sandbox background package checks are blocked.
The repaired CLI's attempted fd lookup fails locally through the stub instead of reaching GitHub.
No external provider request is accepted as part of the repaired verification.

## Limits and next gate

Synthetic usage is not proof of live retention, output enforcement by every service profile, billing, or subscription allowance use.
Existing [live trial](openai-chatgpt-v1-live-trial.md) and [follow-up investigation](openai-chatgpt-v1-cache-investigation.md) remain the only approved subscription evidence.
Automatic subscription preservation remains unverified.
Native in-flight requests cannot be cancelled through the veto, and a later decision handler can override it.
No safe native-streaming/extension-idle handoff or native usage attribution is claimed.
No new economic policy, economic default change, evidence-driver reuse, or release was added.
The user reported that the external re-review passed and approved opening the pull request.
No additional review was launched by the parent, and no reviewer identity is inferred.
Pull-request CI and merge approval are the next gates.
