# Pi v1.0 compatibility findings and action plan

Status: Compatibility implementation is complete.
Slice 1 merged as [PR #71](https://github.com/ribbons-digital/pi-warm-cache/pull/71), commit `4b17f916c21697c348b145cdf30485ad7ef7481c`.
Slice 2 merged as [PR #72](https://github.com/ribbons-digital/pi-warm-cache/pull/72), commit `56abbced4679849f44aaf7cdc3121b90996e243c`.
Both CI targets passed before the Slice 2 merge, including the instructions-cap correction and isolated OAuth fixture.
Local `main` was synced and the retired local feature branches were removed; GitHub had already removed the Slice 2 remote branch.
The user approved v0.5.0 release preparation and publication, with matching user-facing documentation.
Preparation is on `release/v0.5.0`; the release PR must merge before tagging or dispatching publication from `main`.
No Slice 3, new economics policy, automatic subscription promotion, or new live campaign is included.
The maintenance updates from PRs #65-67 passed both CI targets before the Slice 1 merge; Astra's recorded pass applies to the slice before those additions.
A subsequent user-approved live trial is recorded in [OpenAI ChatGPT sign-in evidence](evidence/openai-chatgpt-v1-live-trial.md).
Its results update the subscription-route recommendation below.
A [follow-up cache investigation](evidence/openai-chatgpt-v1-cache-investigation.md) checked actual HTTP identity, raw usage, and native cache fields.
The initial Fable 5 review could not start because the subagent runtime could not resolve `@earendil-works/pi-agent-core/node` from the installed Pi package.
After updating pi-subagents, the user selected Astra instead and prohibited Anthropic calls for this review.
The Astra retry also failed at startup: `assertRequiredChildExtensionsAdmitted` was not a function.
The user subsequently supplied a direct Astra review with the verdict “agree with corrections.”
The parent checked and accepted its three findings: evidence-driver claims, explicit manual bounds, and release/documentation gates.
The original implementation approval covered non-release Slice 1.
After its merge, the user approved starting Slice 2.
The Slice 1 checks and limits are recorded under [Slice 1 verification](#slice-1-verification).
Slice 2 review passed as reported by the user, and its merge is complete.
The approved v0.5.0 release is separate from the optional Slice 3 enhancements.

## Summary

The original pi-warm-cache 0.4.0 audit passed type checking against Pi 1.0.0 but did not support an unconditional compatibility claim.
Its main problems were request safety, coordination with native warming, and a test that assumed an old model catalog.
The merged Slice 1 corrected the contract checks; the merged Slice 2 corrected the safety policy and matching documentation.
These satisfy the compatibility implementation scope for v0.5.0.
A rewrite is not needed.

Keep our exact provider-payload replay and route verification.
Adopt Pi's expired-cache guard and cost-aware decision method.
Use one automatic warmer per route rather than letting both send requests independently.

The main tradeoff is that the safest first integration cannot retain native streaming warming on routes owned by the extension.
A reliable streaming-to-idle handoff needs better request-origin and completion information from Pi.

## Research scope and evidence

- Extension baseline: `pi-warm-cache` 0.4.0, commit `3153e19`.
- Previous development dependencies: `pi-ai` and `pi-coding-agent` 0.84.2, with `pi-tui` 0.84.4.
- Target: all three Pi packages at 1.0.0.
- The npm `latest` tag for `pi-coding-agent` was confirmed as 1.0.0.
- Checked the installed v1.0 documentation and implementation, the tagged upstream warmer and tests, and our capture-to-probe path.
- Ran checks in an isolated Docker Sandbox copy, not in the project workspace.
- The initial compatibility audit used no real provider requests, paid probes, credentials, or terminal interaction tests.
- A later controlled live trial used a narrowly scoped OpenAI access credential.
  Its output-cap checks passed, but timed cache preservation was not demonstrated.
  See the linked evidence for limits and usage.

| Check | Result |
|---|---|
| Existing unit suite with previous Pi dependencies | Passed |
| Type check with Pi 1.0.0 | Passed |
| Lint with Pi 1.0.0 | Passed |
| Existing unit suite with Pi 1.0.0 | Failed at the old OpenCode Go catalog-count assertion |
| Synthetic native/extension interaction | Reproduced anchor replacement and two independent probe requests |
| Synthetic delayed timer | Reproduced a probe after the five-minute cache lifetime |
| Actual v1 Responses request generation, stopped before network dispatch | Confirmed that ChatGPT omits an output cap which our output shaper adds back |
| Actual v1 cache-disabled request generation, stopped before network dispatch | Confirmed that our strategy still permits automatic warming |
| Subsequent live subscription output-cap checks | Sixteen-token caps accepted and enforced on Luna and Sol |
| Subsequent live bare replay and following real turn | Cached reads observed on both tested models |
| Subsequent timed subscription campaign | Stopped at eight minutes when the second treatment tick missed; expiry/control comparison incomplete |
| Follow-up immediate subscription wire and usage checks | Identical HTTP bodies/headers on three Luna requests; raw cached-token usage agrees with Pi parsing |
| Follow-up native cache fields | Explicit thirty-minute TTL and prewarm individually rejected on Luna and Sol; Luna diagnostics-only request accepted but unavailable; Sol diagnostics untested |

The default sandbox Node 22.22.1 build lacked TypeScript stripping support.
The successful runtime checks used Node 24.21.0 inside the same sandbox.
The initial runtime and lint failures caused by that sandbox build were environmental, not evidence of a Pi API break.
The original tests were not changed or bypassed during research.
That original v1 run stopped at its first failure, so it did not verify later assertions.
The approved Slice 1 now runs the updated full suite against both dependency targets, as recorded below.

## What Pi's native warmer does

Native warming arrived in Pi 0.86.0, before the 1.0 release.
Pi 0.87.0 added protection against delayed refreshes rebuilding expired caches.

Its design is provider-neutral, but the bundled v1.0 catalog supplies `promptCache` lifetimes only for Anthropic models.
That makes the default coverage Claude-focused.
Other providers or validated proxies can become eligible through model metadata or overrides.
Those declarations are not live proof that a route preserves its cache.

Pi has three global modes:

- `off`: No native warming.
- `streaming`, the default: Warm during an active agent run, including long tool work, and stop when the run settles.
- `idle`: Also allow warming between runs.

For eligible requests, Pi:

1. Reads the lifetime from `model.promptCache.short` or `.long` for the request's retention tier.
2. Refreshes at 90% of that lifetime, with at least ten seconds of margin.
3. Stops if dispatch is late, including after awaiting extension decisions.
4. Replays the saved model context and request options through `streamSimple()`, with `maxTokens: 1` and `maxRetries: 0`.
5. Rejects budget-based Anthropic thinking requests that cannot be replayed cheaply and safely.
6. Estimates whether the refresh is worthwhile.
7. Records refresh usage in session totals without adding messages to model context.

Its decision is:

```text
expected benefit = continuation probability × extra cost of a cold next request
                   - estimated refresh cost
warm only when expected benefit >= $0.05
```

Pi uses a continuation probability of 1 during active runs and 0.15 while idle.
The 0.15 value is an upstream usage assumption, not a provider guarantee or a measurement of this extension's users.

Warming stops after one hour from the real request during active runs, or thirty minutes from that request while idle.
Probe requests do not extend those limits.
Consequently, a one-hour Anthropic cache normally receives no idle refresh: its first refresh would be at about 54 minutes, beyond the idle horizon.

## Comparison and adoption decision

| Area | Pi native | pi-warm-cache | Recommendation |
|---|---|---|---|
| Replay identity | Saved context is serialized again; request hooks run again | Clones captured provider body, changing only allowed output fields or the Codex suffix | Keep ours; it preserves the observed body more directly |
| Activity covered | Active runs and optional idle gaps | Idle gaps only | Preserve our scope for this upgrade |
| Route coverage | Lifetime metadata required; bundled coverage is Anthropic | Anthropic, OpenAI, Azure, legacy Codex, selected xAI and OpenCode Go families | Keep verified extension coverage |
| Timing | Metadata-based, 90% of lifetime, late-dispatch guard | Usually 80%, with provider constants and overrides; no expiry guard | Adopt the guard; do not change cadence merely to match Pi |
| Economics | Expected next-turn benefit, including refresh cost | Token threshold, optional spend ceiling, and a retrospective probe-price comparison | Add an opt-in economic policy; keep existing controls |
| Thinking/output safety | Refuses unsafe budget-thinking replay | Preserves budget but may raise output cap to budget plus one | Refuse expensive automatic replay by default |
| Failures | Best effort within a fixed horizon | Bounded miss retries, re-anchoring, and Codex output-spike blocks | Keep ours; do not copy blind retries |
| Usage accounting | Persisted session usage, included in `/session` | Extension-only counters and optional log | Keep attribution separate; native accounting has no equivalent public extension write API |
| Idle limit | Thirty minutes, including long-retention requests | Usually thirty minutes; longer for long-retention families; configurable | Preserve ours; it serves a use case native idle warming does not |

Our reported savings sum the cold-versus-cached price difference for each probe hit.
They do not prove that each probe prevented a cold real turn.
Repeated refreshes can therefore produce an optimistic cumulative savings figure even if the user never resumes.
Keep existing diagnostic fields compatible, but label that figure as a probe-price comparison rather than realized avoided spending.
Show economic-policy estimates separately if the new policy is enabled.

## Compatibility findings at the original baseline

### 1. Public APIs used by the extension still exist

`modelRegistry.complete()`, request-payload replacement, the lifecycle events, command and flag registration, and the current widget/status APIs remain available.
The registry still accepts our legacy context input and normalizes it.
Pi's move to normalized transcript context does not require us to rebuild the conversation.

Keep the current host-provided peer dependency layout.
Pi's package guidance still requires `"*"` peer ranges and no bundled copies of its host packages.

### 2. Native probes look like real requests to our capture hook

Native warming preserves the agent's `onPayload` callback.
It therefore runs `before_provider_request` again.
Our `isWarming()` guard recognizes only our own probe, not Pi's probe.

A native refresh can replace the real-turn anchor with a capped warm payload, reset observed token information and the spend campaign, and change re-anchor state.
The synthetic check reproduced this.

Native idle mode also permits both timers to probe the same route.
Even default streaming mode can disturb our anchor during a long active run.
This is not just a duplicate-timer problem.

### 3. New OpenAI ChatGPT authentication is not legacy Codex

Pi 0.99 introduced “Sign in with ChatGPT” on the `openai` provider and describes `openai-codex` as legacy.
The new route still uses `openai-responses` and the normal OpenAI endpoint.
The adapter omits output caps and certain cache fields for subscription authentication and comments that they are rejected.
The later live trial showed that `max_output_tokens: 16` was accepted and enforced on `gpt-5.6-luna` with no thinking and `gpt-6.1-sol` with low thinking.
The service behavior is therefore less restrictive than the adapter assumes for those tested profiles.

Our existing bare capped replay produced cached reads, followed by cached reads on the next real turn, on both tested models.
There is no need to add a legacy Codex suffix solely to overcome the output-field concern.
One suffix trial's following real turn missed, but the trial did not establish that the suffix caused it.

Treat the subscription route separately from API-key OpenAI and legacy Codex for retention and verification.
Do not generalize the tested cap behavior to every model or thinking level.
Automatic warming remains unverified: the timed Luna campaign lost cached reads on its second tick despite an unchanged body and cache key.
The follow-up found no body/header drift or usage-parsing defect in its immediate replay checks, but did not reproduce the original timed miss.
Both tested authenticated models rejected `prompt_cache_options.ttl: "30m"` and `prompt_cache_options.prewarm: true` when tested separately.
A comparison-only Luna request returned diagnostics `unavailable`, which supplies no cause.
Sol diagnostics were not tested.
Its echoed default TTL is not evidence of measured retention.
Generic API defaults and capability flags cannot establish this subscription route's cache-preservation behavior; the restriction's model, account, authentication, or deployment dependency remains unresolved.

### 4. Cache lifetime and cache opt-out are not fully reflected in our policy

A late timer can send after the cache has expired but before our idle cutoff.
That can pay for a new cache write rather than preserve the old entry.
Settlement time is also not proof that the provider cache was refreshed.

Our OpenAI explicit-cache family is selected from capability metadata, even when the actual request has no explicit TTL.
In v1, `cacheRetention: "none"` produces an explicit-mode payload without a cache key or TTL, but our strategy still allows a timer.
Audit the real request fields and retention tier before choosing a lifetime or scheduling a probe.
Metadata may inform timing, but must not override an observed cache opt-out or our route checks.

### 5. The tests assume a stale model catalog

The suite expects nineteen OpenCode Go models.
Pi 1.0.0 contains twenty-nine: two Anthropic Messages, twenty-one Completions, and six Responses entries.

Replace fixed catalog totals with required route and capability assertions.
Keep iteration over all current entries and explicit checks for unexpected transports.
Refresh evidence records where adapter behavior changed; do not claim fresh live verification from catalog compatibility alone.

## Coexistence design

### Recommended first release: one owner per route

On routes where pi-warm-cache is enabled and manages automatic warming, use the public `cache_warming_decision` event to return `{ action: "stop" }` for native refreshes.
Leave Pi's native policy unchanged on other routes.
Register this integration only on Pi versions that support it, while preserving the older standalone path.

Ownership must follow configuration and route changes.
Invalidate the anchor when ownership changes and wait for a fresh real turn.
Do not retain probes captured while the extension was disabled as real-turn anchors.
The status must say which warmer owns the route.

This preserves our idle controls and exact-payload strategy without changing the user's global Pi setting.
It also prevents native probes from entering our capture path on extension-owned routes.

The deliberate limitation is that native streaming warming is stopped on those same routes.
Our extension still does not warm during long tool work.
Native warming remains available elsewhere, or when the extension is disabled and Pi's native mode permits it.
`/warm off` must clearly mean “extension off,” not “all Pi warming off.”

### Limits that cannot be removed with the current public contract

- The decision event allows warm/stop overrides, but does not identify the exact saved request or provide a native refresh-completion callback.
- `before_provider_request` has no real-turn versus native-warm origin label.
  A “skip the next payload” flag is not safe when real and warm requests overlap.
- The last decision handler returning an action wins.
  Another extension can override our stop decision.
  Exclusive ownership cannot be guaranteed against a later conflicting handler.
- A decision veto does not cancel a native request already in flight.
  Enable ownership from session startup; treat reload or mid-request handoff as a re-anchor boundary.
- The extension context has a read-only session manager.
  It cannot safely append native usage entries or directly inspect/cancel the SDK's warmer through the documented extension API.
- Our concurrency gate does not cover native warming or separate Pi processes.
- Exact body replay does not preserve every request-time header rewrite.
  Authentication and configured headers still come from the registry, but custom header instrumentation needs separate validation.
- Virtual models can select a different physical route for each request.
  Keep them unsupported rather than replay against the selected virtual model.

If another extension overrides the ownership decision, the supported fallback is to set Pi's global `cacheWarming` mode to `off` while using pi-warm-cache.
That fallback disables native warming everywhere and requires an explicit user choice.

A seamless native-streaming/extension-idle split is deferred.
First request a public request-origin label, request identity, refresh completion/usage notification, and a safe cancellation or ownership operation from Pi.
Do not depend on its private warmer fields or private runner APIs.

## Action plan

### Release gate and review corrections

Slice 1 is a non-release compatibility check.
Passing it does not make the current automatic subscription classification or native-warmer interaction safe to ship.
Do not publish, tag a release, or claim unconditional Pi v1 compatibility from Slice 1 alone.

A compatibility release requires ownership, subscription safety, matching user documentation, and regression checks from Slice 2.
The new economic policy can remain a separate, later change.
Safety exceptions to existing behavior must be explicit; do not silently change existing verified routes or manual controls.

Do not reuse the research driver's timed branch before correcting its conclusion and stop paths.
Its current `expiredTrial`/`causalityDemonstrated` logic can overstate a single idle miss as expiry and a single comparison as benefit.
That path did not execute in the recorded campaign, so the existing negative result remains valid.
Future evidence must report idle hit/miss observations, not infer a fixed lifetime from a miss.
Require repeated independent comparisons before claiming a warming benefit, without selecting only favorable trials.
Retain initial cache confirmation and actual HTTP instrumentation for every group.
After a treatment miss, mark treatment as failed and stop its warming, but still collect the untouched control if safety limits permit.
If token validity, quota, timeout, or another safety guard prevents completion, record an incomplete comparison rather than success.
No driver changes or additional live campaign are included in Slice 1.

### Slice 1: Update and verify the v1 contract, without releasing

**Outcome:** The unchanged extension behavior is checked against both the previous supported baseline and Pi 1.0.0.
This establishes the host API contract, not verified new-route warming or release readiness.

- Update development Pi packages and the lockfile to 1.0.0.
- Keep host-provided peer dependencies as peers.
- Replace brittle catalog-count assertions with route/capability invariants.
- Add a CI compatibility matrix for the previous supported baseline and 1.0.0.
- Smoke-test loading, command/flag registration, `complete()` payload replacement, lifecycle cleanup, and legacy-context normalization through actual Pi APIs with a fake provider.
- Keep new event registration version-gated and narrowly typed so old-version checks remain meaningful.

**Likely files:** `package.json`, `pnpm-lock.yaml`, `src/provider.test.ts`, `.github/workflows/ci.yml`, and a focused integration check if the existing suite cannot cover the host boundary.

**Completion:** Both version targets pass full applicable tests, type checks, and lint inside Docker Sandboxes.
Actual Pi load/reload and fake-provider host-contract checks pass without provider credentials or live inference.
Record existing safety defects as release blockers, not as acceptable behavior merely because the baseline tests pass.
No ownership, subscription-policy, economic-policy, or production-behavior changes, publishing, tags, or release claims are included.
Pause for review before starting Slice 2.

### Slice 1 verification

Implementation passed Astra review for non-release Slice 1, not for a compatibility release.
The feature branch is `compat/pi-v1-contract`, based on `3153e19`.
No production warming source or user setting changed.

Changed files:

- `package.json` and the generated `pnpm-lock.yaml`: Pin development Pi packages to 1.0.0; retain the host-provided peer ranges and package version.
- `src/provider.test.ts`: Check all bundled OpenCode Go routes, known transports, non-empty unique route IDs, provider identity, and existing route/capability invariants instead of catalog totals.
- `scripts/check-pi-host.ts`: Exercise the actual Pi loader and Responses adapter with synthetic HTTP responses and a dummy API key.
- `tsconfig.json`: Include the host check in type checking.
- `.github/workflows/ci.yml`: Run both Pi dependency targets with Node 24.
- `CONTRIBUTING.md`: Document the Docker Sandbox checks, Node runtime, and offline host-test limits.

| Dependency target | Full unit suite | Offline host check | Type check | Lint |
|---|---|---|---|---|
| pi-ai / pi-coding-agent 0.84.2, pi-tui 0.84.4 | Passed | Passed | Passed | Passed |
| All three Pi packages 1.0.0 | Passed | Passed | Passed | Passed |

The original v1 catalog failure was reproduced before the test change.
The updated unit suite reaches all assertions on both targets.
The host check verifies command/flag registration, startup and reload/shutdown events, read-only real-payload capture, settlement, parsed cache usage, and `ModelRegistry.complete()` with legacy context normalization.
It verifies exact body replay except the output cap, a serialized sixteen-token cap, no conversation changes from successful or failed probes, a handled HTTP 400, and anchor invalidation after reload, model selection, and thinking selection.
The headless command notifications report the synthetic hit and failure correctly.
The corrected cleanup check uses Node's built-in controlled clock with native warming disabled and a synthetic one-second extension interval.
A positive control first proves that an armed timer dispatches an offline probe.
A fresh real turn then arms another timer, and reload occurs without disabling warming.
The check requires shutdown to clear that exact timer and advances fifteen seconds beyond its deadline with no further HTTP request.
A synthetic cap field and cached usage are host-contract checks, not evidence that a provider enforces that cap or preserves a live cache.
All HTTP requests are handled locally; unexpected requests fail locally with no outbound fallback.
No provider credential, login, live inference, or Anthropic call was used.
Native warming is explicitly disabled for this check.
Existing native capture collisions, delayed-expiry dispatch, cache-opt-out handling, and unsafe subscription classification remain release blockers for Slice 2.

The final checks ran inside `pi-warm-cache-v1-research` using Node 24.21.0 and pnpm 10.
The two isolated dependency workspaces are `/tmp/pi-warm-cache-v1-research.J82S7J/slice1-baseline` and `/tmp/pi-warm-cache-v1-research.J82S7J/slice1-v1`.
The baseline copy substitutes the previous three Pi versions; the v1 copy uses the updated frozen lockfile.
The matrix's baseline dependency-selection command was also exercised locally.
Both GitHub Actions matrix targets later passed on the initial PR commit `34f4438`.
No interactive TUI or live provider flow was checked in this slice.
The new CI matrix uses Node 24 to match the checked TypeScript-capable runtime; the package's production Node engine range is unchanged.

Run the final commands from the host, replacing `TARGET` with `slice1-baseline` or `slice1-v1`:

```bash
sbx exec --workdir /tmp/pi-warm-cache-v1-research.J82S7J/TARGET pi-warm-cache-v1-research bash -lc '
  set -e
  export PATH=/tmp/warm-node-runtime/node_modules/node-linux-arm64/bin:$PATH
  corepack pnpm test
  corepack pnpm exec tsc --noEmit
  corepack pnpm lint
'
sbx stop pi-warm-cache-v1-research
```

Plan comparison: The approved dependencies, catalog invariants, CI matrix, and offline host-contract checks are implemented.
The only supporting additions are the host check's type-check inclusion and development instructions.
No new lifecycle event handler was added to production, so no version gate was needed in this slice.
No ownership, subscription-policy, economic-policy, live-evidence driver, or release work was started.
Recommend checking the pull request's CI results next because local host checks do not replace remote verification or resolve production safety blockers.
Wait for owner approval before merging or starting Slice 2.

#### Astra cleanup review correction

Astra accepted the slice scope but found that the original check disabled warming before reload.
That checked shutdown notification and anchor invalidation, not cancellation of an active timer.
The finding is corrected in `scripts/check-pi-host.ts`; this document records the new verification.
No production behavior, configuration, or dependency change was needed for the correction.

A sandbox-only fault test confirmed the gap: the original host check still passed on v1 with `warmer.dispose()` omitted from the shutdown handler.
With the corrected check, omitting that call fails on both dependency targets with `shutdown must clear the armed extension timer`.
The temporary fault was applied only to isolated sandbox copies of `src/index.ts`.
Both copies were restored and matched the unchanged project source before final verification.
The full tests, type check, and lint then passed again on both targets.
The controlled clock and timer observers are restored in the check's cleanup path.

Verification logs are preserved under `/tmp/pi-warm-cache-v1-research.J82S7J/`:

- `slice1-cleanup-old-check.log`: Original v1 check passes with shutdown cleanup omitted.
- `slice1-cleanup-mutation-slice1-baseline.log` and `slice1-cleanup-mutation-slice1-v1.log`: Corrected check rejects the same fault on both targets.
- `slice1-cleanup-verified-baseline.log` and `slice1-cleanup-verified-v1.log`: Final full checks pass with normal shutdown cleanup restored.

This closes the host-level active-timer cleanup gap without changing the release limits.
No GitHub Actions run, interactive TUI check, credential access, or live provider request was added.
The user supplied Astra's re-review with the verdict “Pass for non-release Slice 1.”
Astra confirmed the active-timer correction, the saved fault-test failures, restored sandbox copies, and unchanged production source.
No new blocking issue was reported.
The user then approved opening a pull request for Slice 1.
Merge and Slice 2 still require separate approval.

#### Approved maintenance additions from PRs #65-67

The user approved adding these maintenance updates to PR #71:

- PR #65: `pnpm/action-setup` 6.0.10 to 6.1.0 in CI and the release workflow.
  The release workflow keeps its full commit pin, updated to `ea17c68df8912ef543352723c149a84f56e3d413`.
  The upstream annotated tag was resolved and confirmed to point to that commit.
- PR #66: Development `npm` 12.0.2 to 12.1.0.
- PR #67: Development `oxlint` 1.80.0 to 1.85.0.

The lockfile was regenerated through pnpm inside the existing Docker Sandbox.
It changes only npm, Oxlint, and Oxlint's platform packages relative to the reviewed slice.
No lint rule, production source, peer range, package version, or Pi dependency target changed.
The release-workflow change only updates the setup action; it does not dispatch a release or grant publishing approval.

Both Pi dependency targets passed the full unit suite, corrected offline host check, type checking, and lint again with the updated tools.
The baseline verification first installed the new frozen v1 lockfile, then applied the same previous-Pi selection command used by CI.
The v1 frozen installation also passed, and the installed tools reported npm 12.1.0 and Oxlint 1.85.0.
Logs are preserved as `slice1-maintenance-verified-baseline.log` and `slice1-maintenance-verified-v1.log` under the research sandbox workspace.
The release workflow was not executed; no provider credential or live inference was used.
Both CI targets passed again after the maintenance additions, before PR #71 merged.

PRs #68-70 target Pi 0.87.1 and are superseded by PR #71's 1.0.0 target.
They remain unmerged; no Dependabot ignore policy was added.
The maintenance changes shipped in the merged non-release Slice 1.
The later approval to start Slice 2 does not approve a release.

### Slice 2: Ship safety, route ownership, and matching documentation together

**Outcome:** Pi v1 can run with the extension without duplicate automatic probes on managed routes or unsafe new-route requests.
Users receive the changed behavior and its configuration documentation in the same slice.

- Add the native-decision veto and ownership status described above.
- Cover configuration toggles, startup, reload, model changes, compaction, branch changes, and shutdown.
- Cancel or retire an extension probe when a real turn starts, and ensure an in-flight probe cannot suppress the fresh real-turn capture.
- Recognize new OpenAI subscription authentication through public registry information.
  Allow bounded manual probes for the output-cap profiles verified by the live trial, but keep automatic warming unverified until a valid expiry/control comparison succeeds.
  Put the manual-probe decision in the capability resolver; changing the strategy plan alone does not control manual eligibility.
- Give the new subscription manual experiment an explicit request contract:
  - Eligibility is the actual first-party `openai` / `openai-responses` OAuth route and the exact tested model/thinking profile: `gpt-5.6-luna` with no thinking or `gpt-6.1-sol` with low thinking.
    Unknown authentication, changed profiles, or unsafe captured payloads fail closed.
    Synthetic evidence is not a blanket production-conversation guarantee.
  - One HTTP attempt at most per accepted manual action; no queued follow-up probe after deferral or error.
  - Enforce `max_output_tokens: 16`, a forty-five-second timeout with cancellation, and zero automatic HTTP retries.
    Verify these at dispatch, not merely through configuration values.
  - No timer and no promise that the cache lifetime is extended.
    `/warm on` cannot bypass the subscription restriction.
  - State budget behavior explicitly before shipping.
    The new subscription manual action must honor a configured spend ceiling before dispatch; retain the existing verified-route manual bypass unless separately approved.
    This narrow safety exception must appear in the command documentation and tests.
  - Explain that the output cap does not cap input tokens, total request cost, or subscription allowance use.
    A pre-dispatch spend check is not a hard per-request cost guarantee.
- Respect observed cache-disabled requests and actual explicit retention fields.
- Add an expiry deadline anchored to real request/cache activity, not arbitrary settlement time.
  Recheck it immediately before dispatch after deferrals or awaited work.
- Do not issue automatic budget-thinking probes when a cheap output limit cannot be enforced.
- Preserve existing route gates, Codex spike protection, retry limits, defaults, cadence overrides, idle controls, and spend ceilings outside the explicitly approved safety exceptions.
- Update `README.md`, `docs/upgrade-notes.md`, and affected evidence records with the safety and ownership changes, not in a later slice.
  Explain `/warm off` as extension-only, route ownership, restricted manual eligibility and bounds, spend behavior, accounting limits, and native-warmer limitations.
  Distinguish a probe hit from proven preservation on the next real turn.

**Likely files:** `src/index.ts`, `src/warmer.ts`, `src/provider.ts`, `src/capability.ts`, `src/types.ts`, `src/ui.ts`, tests, `README.md`, `docs/upgrade-notes.md`, and affected evidence records.

**Completion:** A fake-provider integration verifies one owner with native modes `off`, `streaming`, and `idle`.
Native probes do not replace real-turn anchors on managed routes.
Expired, cache-disabled, unverified subscription, and unsafe thinking requests produce zero automatic provider calls.
Bounded manual subscription probes remain explicitly labelled as unverified cache preservation.
A late conflicting decision handler is tested and documented as a limitation.
Regression checks cover existing verified routes, defaults, cadence overrides, idle/spend controls, retry behavior, and Codex protection.
New subscription manual checks verify profile restrictions, the sixteen-token cap, timeout/cancellation, zero automatic retries, spend behavior, and zero scheduled follow-up calls.
Inspect command/status output, ownership transitions, failed-provider behavior, and relevant fullscreen/regular TUI views.
Matching user documentation is complete before these safety and ownership changes can ship.

### Slice 2 verification

The implementation is complete locally on `compat/pi-v1-safety`, based on merged Slice 1.
The user reported an independent review pass after the cap correction and approved opening the pull request.
See [safety verification evidence](evidence/pi-v1-safety-checks.md) for commands, artifacts, the failed CLI harness incident, and limits.

Implemented scope:

- Version-gated public native-decision veto with ownership status and no private production API dependency.
  Ownership covers managed automatic routes, verified safety-restricted requests, and registered OpenAI transports with subscription or unknown auth.
  Paused or blocked extension timers do not silently release the veto.
- Capture only during real agent turns; off/on and lifecycle boundaries discard old payloads.
  Real turns abort and retire probes, while late callbacks/results cannot change fresh anchors, failure status, scheduling, or a newer probe's state.
- Public registry authentication classification with exact subscription profile and payload gates in the capability resolver.
- One subscription manual request per accepted action, sixteen output tokens, forty-five-second cancellation, zero automatic HTTP retries, configured spend prechecks, and no queued follow-up.
  Existing verified-route manual idle/spend bypass remains.
- Actual cache opt-out and budget-thinking automatic guards, including registered proxy routes.
- Wire-driven explicit OpenAI retention and capture/dispatch-clock expiry checks after deferrals and awaited preparation.
  Idle cutoff and Codex-off policy are rechecked immediately before dispatch too.
  Existing verified-route defaults, cadence, idle/spend controls, failure budgets, and Codex protection remain outside the stated safety exceptions.
- Matching README, diagnostics/upgrade notes, contribution instructions, E2E procedure, and evidence addenda.
  The E2E guide now requires independent confirmed baselines and native-off untouched controls without promoting an idle miss to measured expiry.

The initial real-turn regression failed before its fix with `real turn must abort the in-flight warm request`.
A final additional regression reproduced a retired timeout writing failure status onto a new anchor; its request-ownership guard is now checked before timeout recording.
Both pass in the final suite.

| Dependency target | Full tests and host check | Type check | Lint |
|---|---|---|---|
| pi-ai/coding-agent 0.84.2, pi-tui 0.84.4 | Passed | Passed | Zero warnings/errors |
| All three Pi packages 1.0.0 | Passed | Passed | Zero warnings/errors |

Checks ran sequentially inside `pi-warm-cache-v1-research`, with Node 24.21.0 and pnpm 10.0.0.
Final logs are `slice2-final-slice1-baseline.log` and `slice2-final-slice1-v1.log` under `/tmp/pi-warm-cache-v1-research.J82S7J/`.
The v1 host check exercises the installed native warmer and actual decision chain in off, streaming, and idle modes, plus off/on handoff and the last-handler-wins limitation.
The real Responses adapter verifies synthetic OAuth cap-only replay, HTTP 500 without retry, and forty-five-second cancellation.
The review correction also checks eligible Luna/off and Sol/low instructions bodies through the real installed HTTP path on both targets, with synthetic public-registry OAuth classification.
Both targets failed with an absent final cap before the shared shaper made explicit API routing authoritative.
After correction, each body contains exactly sixteen output tokens as its cap and preserves every other captured field.
Explicit and inferred legacy Codex cap stripping and suffix/output-spike checks remain intact.
See the [review correction evidence](evidence/pi-v1-safety-checks.md#review-correction-instructions-must-not-remove-the-subscription-cap).
PR #72's initial CI passed Pi 0.84.2 but failed Pi 1.0.0 at the stored-OAuth fixture's public auth assertion.
The fixture now uses a fresh runtime/session seeded with dummy OAuth credentials before creation, avoiding stale API-key snapshots from background refreshes.
Both local target suites and ten repeated v1 host checks passed.
The [replacement GitHub CI run](https://github.com/ribbons-digital/pi-warm-cache/actions/runs/37157289029) passed both matrix targets before PR #72 merged.
Production source and existing safety assertions are unchanged.
See the [CI correction evidence](evidence/pi-v1-safety-checks.md#pr-72-ci-correction-isolate-the-oauth-runtime).
Compaction/tree/replacement checks emit lifecycle boundaries through the host runner; they do not perform live compaction or the complete `/new` journey.

The real v1 CLI was checked in regular 80-column and fullscreen 120-column modes using isolated dummy OAuth and synthetic transport.
Final transport records show one real-turn response, one capped manual hit, and one capped manual HTTP 500 in each mode, with no failure retry or off/on stale-payload dispatch.
Terminal-grid renders were inspected for manual-only labels, bounds, warnings/errors, cleared off state, and re-anchor refusal.
These checks do not demonstrate live cache preservation.

The first CLI harness failed to intercept transport and reached OpenAI with dummy credentials, returning HTTP 401 in both modes.
Those captures are explicitly excluded from offline success evidence.
Pi's CLI dispatcher had replaced a preload installed before its module loaded.
The repaired preload loads that module first, then installs the fetch stub.
All outbound sandbox traffic was denied before retrying, and recorded synthetic provider calls are required for acceptance.
The denial stays enabled; no real provider credential or new live campaign was used for Slice 2.

Plan comparison: The approved safety, ownership, manual subscription contract, lifecycle, checks, and matching documentation are implemented.
The existing public-hook limitations remain explicit: no cancellation of native in-flight requests, no guarantee against a later overriding handler, and no seamless streaming-to-idle handoff.
There is no new economics policy, evidence-driver reuse, automatic subscription promotion, package version change, or release.
No delegated review was launched.
The user reported that re-review passed on 2026-10-03 and approved committing, pushing this feature branch, and opening the Slice 2 pull request.
The parent did not launch another review or infer the reviewer's identity.
PR #72 subsequently merged after both CI targets passed.
The user has separately approved the v0.5.0 release; it requires a merged release-preparation PR before tagging and publication.
Slice 3 remains optional and unapproved.

### v0.5.0 release preparation

The user approved v0.5.0 after the two compatibility slices merged.
The release branch changes package version, upgrade/release documentation, status records, and the publication workflow's Node version and lint check.
It does not change production source, route policy, default economics, or live evidence.

Release-candidate checks use Docker Sandbox `pi-warm-cache-release-050`, Node 24.21.0, and pnpm 10.0.0.
The host workspace is the repository path; isolated verification copies are `/tmp/pi-warm-cache-release-050/previous` and `/tmp/pi-warm-cache-release-050/v1` inside the sandbox.
Both targets passed tests, type checking, and lint with sandbox-scoped deny-all active.
The v0.5.0 tarball contains only the manifest, README, license, and nine production source files.
The extracted package passed the real-loader host check against both dependency targets using a test harness added only outside the tarball.
No provider credentials or new live campaign were used.

Access uses `sbx exec --workdir /tmp/pi-warm-cache-release-050/v1 pi-warm-cache-release-050 bash`.
Project commands need `/tmp/pi-warm-node/node_modules/node/bin` first on `PATH`.
Stop with `sbx stop pi-warm-cache-release-050`.
No server or port publication is needed.
Candidate logs and tarball are preserved under `~/.local/share/pi-warm-cache/releases/v0.5.0/`.

The npm registry currently has v0.4.0 with provenance, and the existing trusted-publishing workflow has successful prior runs.
The release-preparation PR must merge before creating `v0.5.0` at the merged commit and dispatching `release.yml` from `main`.
A successful publish, registry/provenance verification, and GitHub release remain pending.

### Slice 3: Borrow economics and extend live verification separately

**Outcome:** Users can choose cost-aware warming without silently losing existing policy controls.

- Add one opt-in economic policy using expected next-turn benefit minus estimated probe cost.
- Account for cache-write versus input prices and legal output costs.
  Do not assume every route can produce one token.
- Treat Pi's 0.15 idle probability and $0.05 threshold as disclosed initial policy assumptions, not established facts for our users.
- Preserve the current policy by default for the compatibility release.
  Evaluate default changes separately after evidence exists.
- Keep unknown prices as `n/a`; an economic policy must not invent them.
- Prefer declared lifetime metadata where the exact verified route and actual retention agree.
  Retain existing measured fallback cadences and best-effort labels where metadata is absent.
- Clarify probe-price comparison versus predicted or measured avoided real-turn cost.
- Run approved live keepalive/control campaigns for affected Anthropic, OpenAI API-key, legacy Codex, xAI, and OpenCode Go routes.
  Legal capped replay and bounded output have now been shown for two ChatGPT profiles.
  Before enabling automatic warming for that connection, investigate the identical-request miss and complete the interrupted expiry/control comparison.
- Complete any separately approved live verification using the corrected evidence method above.
  Defer another ChatGPT campaign; it is not needed for Slice 1's host-contract verification.
- Inspect economic-policy status/accounting in `/warm`, widgets, and `/session`, including fullscreen, regular TUI, non-UI, and failed-provider paths.
- Document new economic settings, assumptions, and any newly verified coverage when those changes ship.
  Ownership and subscription-safety documentation is already required in Slice 2.

**Completion:** All project checks pass.
Live evidence distinguishes probe hits from successful cache reuse on the following real turn.
Documentation does not imply that native warming costs are included in extension counters or that both warmers preserve the same route simultaneously.

## Research sandbox archive

The original `pi-warm-cache-v1-research` sandbox was removed during the user-approved cleanup after PR #72 merged.
Its research workspace and guest files were preserved in `~/.local/share/docker-sandbox-archives/cleanup-2026-10-03/`.
The host research workspace remains at `/tmp/pi-warm-cache-v1-research.J82S7J`.
The old sandbox's start command and scoped network rule are no longer active.

The earlier checks used Node 24.21.0 and sandbox-scoped deny-all during synthetic verification.
No server or port mapping was needed.
The two `slice1-*` copies, logs, and scratch research drivers are historical evidence, not a current development environment.
Use [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup) for fresh sandbox setup.
Research drivers remain outside the package and require new approval and corrected controls before any live reuse.

## Primary sources

1. [Pi v1.0 settings and warming modes](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/settings.md#model-and-thinking).
2. [Native warmer implementation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/cache-warmer.ts).
3. [Native warmer tests](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/test/cache-warmer.test.ts).
4. [SDK request wiring](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/sdk.ts).
5. [Extension decision contract](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md#cache_warming_decision).
6. [OpenAI Responses request generation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/src/api/openai-responses.ts).
7. [Model cache-lifetime metadata](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md#prompt-cache-lifetimes).
8. [Pi release history](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md).
9. Local implementation: `src/index.ts`, `src/warmer.ts`, `src/provider.ts`, `src/capability.ts`, `src/savings.ts`, and `src/provider.test.ts`.
10. [Controlled OpenAI ChatGPT live trial](evidence/openai-chatgpt-v1-live-trial.md).
11. [Follow-up OpenAI ChatGPT cache investigation](evidence/openai-chatgpt-v1-cache-investigation.md).
12. [Current OpenAI prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) and [diagnostics guide](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).
