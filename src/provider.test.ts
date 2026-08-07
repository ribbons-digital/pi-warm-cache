/**
 * Lightweight assertions (no test runner required).
 * Prefer: node scripts/run-unit-tests.mjs
 * Direct: node --experimental-strip-types src/provider.test.ts
 *
 * Do not launch this in the same parallel batch as an edit of this file.
 */

import {
  appendWarmUserTurn,
  applyWarmOutputLimit,
  applyXaiWarmOutputLimit,
  canManualProbe,
  classifyProbeOutcome,
  classifyRealTurnObservation,
  CODEX_WARM_OUTPUT_ABORT_TOKENS,
  decideCodexOversizedAction,
  isCodexPayload,
  isPayloadContinuation,
  minimumOutputTokensForPayload,
  modelSupportsLongCacheRetention,
  isSafeReplayPayload,
  isSafeXaiReplayPayload,
  OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
  payloadHasAnthropicLongTtl,
  XAI_BEST_EFFORT_INTERVAL_MS,
  resolveProviderCapability,
  resolveStrategy,
  stableFingerprint,
  WARM_MUTABLE_PAYLOAD_KEYS,
} from "./provider.ts";
import {
  buildWarmResult,
  estimateSavedUsd,
  formatSavingsLabel,
  formatSavingsSummary,
  resolveModelPricing,
} from "./savings.ts";
import { SessionWarmer } from "./warmer.ts";
import {
  renderCapabilityNotice,
  renderFailureUi,
  renderIdleUi,
  renderProbeRetryUi,
  renderReanchorUi,
  renderWaitingUi,
  renderWarmHitUi,
} from "./ui.ts";
import { DEFAULT_CONFIG } from "./types.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function deepEqualExcept(a: unknown, b: unknown, allowed: Set<string>, path = ""): void {
  if (a === b) return;
  if (typeof a !== typeof b) throw new Error(`type mismatch at ${path}`);
  if (!a || !b || typeof a !== "object") {
    if (a !== b) throw new Error(`value mismatch at ${path}: ${String(a)} !== ${String(b)}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      throw new Error(`array mismatch at ${path}`);
    }
    for (let i = 0; i < a.length; i++) deepEqualExcept(a[i], b[i], allowed, `${path}[${i}]`);
    return;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const key of keys) {
    if (path === "" && allowed.has(key)) continue;
    deepEqualExcept(ao[key], bo[key], allowed, path ? `${path}.${key}` : key);
  }
}

// 1) Thinking-enabled Anthropic payload must not mutate thinking, and max_tokens > budget.
{
  const original = {
    model: "claude-fable-5",
    max_tokens: 16000,
    thinking: { type: "enabled", budget_tokens: 8000 },
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "bash", input_schema: { type: "object" } }],
  };
  const cloned = structuredClone(original);
  const out = applyWarmOutputLimit(cloned, 1) as typeof original;

  assert(out.max_tokens === 8001, `expected max_tokens=8001, got ${out.max_tokens}`);
  deepEqualExcept(original, out, WARM_MUTABLE_PAYLOAD_KEYS);
  assert(out.thinking.budget_tokens === 8000, "thinking budget must stay identical");
}

// 2) OpenAI Responses payload: floor is 16, not 1.
{
  const original = {
    model: "gpt-5.6",
    max_output_tokens: 8192,
    prompt_cache_key: "sess-1",
    input: [{ role: "user", content: "hi" }],
  };
  const out = applyWarmOutputLimit(structuredClone(original), 1, "openai-responses") as typeof original;
  assert(
    out.max_output_tokens === OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
    `openai-responses floor ${OPENAI_RESPONSES_MIN_OUTPUT_TOKENS}, got ${out.max_output_tokens}`,
  );
  deepEqualExcept(original, out, WARM_MUTABLE_PAYLOAD_KEYS);
}

// 2a) xAI Responses: cap only the legal output field and preserve cache identity.
{
  const original = {
    model: "grok-4.5",
    max_output_tokens: 4096,
    prompt_cache_key: "xai-session-1",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    instructions: "Keep this exact.",
    reasoning: { effort: "high", summary: "auto" },
    tools: [{ type: "function", name: "bash" }],
  };
  const out = applyXaiWarmOutputLimit(structuredClone(original), 1) as typeof original;
  assert(out.max_output_tokens === OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, "xAI output cap should use the legal floor");
  assert(out.prompt_cache_key === original.prompt_cache_key, "xAI cache key must stay unchanged");
  assert(out.instructions === original.instructions, "xAI instructions must stay unchanged");
  assert(JSON.stringify(out.reasoning) === JSON.stringify(original.reasoning), "xAI reasoning must stay unchanged");
  assert(JSON.stringify(out.tools) === JSON.stringify(original.tools), "xAI tools must stay unchanged");
  assert(!("max_tokens" in out), "xAI must not receive max_tokens");
  assert(!("max_completion_tokens" in out), "xAI must not receive max_completion_tokens");
}

// 2b) Codex: strip illegal caps; keep effort/tool_choice; suffix append is separate.
{
  const original = {
    model: "gpt-5.6",
    store: false,
    stream: true,
    instructions: "You are a helpful assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    text: { verbosity: "medium" },
    reasoning: { effort: "xhigh", summary: "auto" },
    prompt_cache_key: "sess-1",
    tool_choice: "auto",
    tools: [{ type: "function", name: "bash" }],
  };
  const out = applyWarmOutputLimit(structuredClone(original), 1, "openai-codex-responses") as Record<
    string,
    unknown
  >;
  assert(!("max_output_tokens" in out), "codex must not receive max_output_tokens");
  assert(!("max_tokens" in out), "codex must not receive max_tokens");
  assert((out.reasoning as { effort: string }).effort === "xhigh", "codex effort must stay identical");
  assert(out.tool_choice === "auto", "codex tool_choice must stay identical");
  assert(out.instructions === original.instructions, "instructions must stay identical");
  assert(JSON.stringify(out.tools) === JSON.stringify(original.tools), "tools must stay identical");
  assert(isCodexPayload(original as any), "fixture should look like codex");

  const withTurn = appendWarmUserTurn(structuredClone(original), "Reply OK only", "openai-codex-responses") as {
    input: unknown[];
    instructions: string;
    tools: unknown;
  };
  assert(withTurn.input.length === original.input.length + 1, "suffix adds one input item");
  assert(withTurn.instructions === original.instructions, "suffix must not edit instructions");
  assert(JSON.stringify(withTurn.tools) === JSON.stringify(original.tools), "suffix must not edit tools");
  assert(
    JSON.stringify(withTurn.input.slice(0, -1)) === JSON.stringify(original.input),
    "prefix input must stay identical",
  );
  assert(CODEX_WARM_OUTPUT_ABORT_TOKENS >= 128, "abort threshold should sit above normal OK-suffix outs");
  assert(CODEX_WARM_OUTPUT_ABORT_TOKENS === 256, "current shipped threshold is 256");
}

// 2c) Codex oversized policy: ok -> soft-skip -> sticky-block
{
  const under = decideCodexOversizedAction(32, 0);
  assert(under.decision === "ok" && under.consecutiveAfter === 0, "normal out resets streak");

  const first = decideCodexOversizedAction(300, 0);
  assert(first.decision === "soft-skip" && first.consecutiveAfter === 1, "first spike soft-skips");

  const second = decideCodexOversizedAction(300, 1);
  assert(second.decision === "sticky-block" && second.consecutiveAfter === 2, "second spike blocks");

  const recover = decideCodexOversizedAction(20, 1);
  assert(recover.decision === "ok" && recover.consecutiveAfter === 0, "small out clears streak");
}

// 3) Strategy intervals stay inside TTL.
{
  const anthropic = {
    id: "claude-fable-5",
    provider: "anthropic",
    api: "anthropic-messages",
  } as any;
  const assertReasoned = (capability: any, label: string): void => {
    assert(typeof capability.reason === "string" && capability.reason.length > 0, `${label} needs a reason`);
  };
  const noModelCapability = resolveProviderCapability(undefined);
  assert(noModelCapability.state === "unsupported", "no model should be unsupported");
  assertReasoned(noModelCapability, "no model capability");
  assert(!noModelCapability.automaticWarm && !noModelCapability.manualProbe, "no model must not probe");
  assertReasoned(resolveProviderCapability(anthropic), "first-party Anthropic capability");

  const short = resolveStrategy(anthropic, { ...DEFAULT_CONFIG, anthropicTtl: "5m" });
  const shortInterval = short.intervalMs;
  assert(shortInterval !== null, "short strategy must have an interval");
  assert(shortInterval < 5 * 60_000, "short interval must be inside 5m");
  assert(shortInterval >= 3 * 60_000, "short interval should be roughly 4m");

  const degraded = resolveStrategy(anthropic, { ...DEFAULT_CONFIG, anthropicTtl: "1h" }, {
    system: [{ cache_control: { type: "ephemeral" } }],
  });
  assert(degraded.family === "anthropic-short", "1h request without payload 1h stays short");
  assert(degraded.longTtlDegradedReason !== null, "must report degraded reason");

  const longPayload = {
    system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
  };
  const long = resolveStrategy(anthropic, { ...DEFAULT_CONFIG, anthropicTtl: "1h" }, longPayload);
  assert(long.family === "anthropic-long", "payload 1h markers select long family");
  const longInterval = long.intervalMs;
  assert(longInterval !== null, "long strategy must have an interval");
  assert(longInterval < 60 * 60_000, "long interval must be inside 1h");
  assert(long.cacheRetention === "long", "1h mode uses long retention");
  assert(payloadHasAnthropicLongTtl(longPayload), "detector finds 1h markers");

  const noLong = {
    id: "proxy-model",
    provider: "anthropic",
    api: "anthropic-messages",
    compat: { supportsLongCacheRetention: false },
  } as any;
  assert(modelSupportsLongCacheRetention(noLong) === false, "explicit false disables long");

  const wrongAnthropicEndpoint = {
    ...anthropic,
    baseUrl: "https://anthropic-proxy.example/v1",
  } as any;
  const wrongAnthropicCapability = resolveProviderCapability(wrongAnthropicEndpoint);
  assert(wrongAnthropicCapability.state === "unsupported", "wrong Anthropic endpoint must fail closed");
  assert(
    wrongAnthropicCapability.reason.includes("baseUrl is not api.anthropic.com"),
    "Anthropic endpoint rejection must identify the incorrect baseUrl",
  );

  const openaiExplicit = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    compat: { supportsExplicitPromptCacheMode: true },
  } as any;
  const oaiCapability = resolveProviderCapability(openaiExplicit);
  assert(oaiCapability.state === "verified", "first-party OpenAI should be verified");
  assertReasoned(oaiCapability, "first-party OpenAI capability");
  const anthropicCompat = {
    id: "claude-compatible",
    provider: "proxy-anthropic",
    api: "anthropic-messages",
    compat: { cacheControlFormat: "anthropic" },
  } as any;
  const anthropicCompatCapability = resolveProviderCapability(anthropicCompat);
  assert(anthropicCompatCapability.state === "verified", "registered Anthropic-compatible route should be verified");
  assertReasoned(anthropicCompatCapability, "Anthropic-compatible capability");
  const azure = {
    id: "azure-gpt",
    provider: "azure-openai-responses",
    api: "azure-openai-responses",
  } as any;
  assert(resolveProviderCapability(azure).state === "verified", "registered Azure route should be verified");
  const codex = {
    id: "gpt-5.6",
    provider: "openai-codex",
    api: "openai-codex-responses",
  } as any;
  assert(resolveProviderCapability(codex).state === "verified", "registered Codex route should be verified");
  const oai = resolveStrategy(openaiExplicit, DEFAULT_CONFIG);
  assert(oai.family === "openai-explicit", "compat flag selects explicit 30m family");
  const openAiInterval = oai.intervalMs;
  assert(openAiInterval !== null, "OpenAI strategy must have an interval");
  assert(openAiInterval < 30 * 60_000, "openai interval inside 30m");

  const openaiOld = {
    id: "o3",
    provider: "openai",
    api: "openai-responses",
  } as any;
  const old = resolveStrategy(openaiOld, DEFAULT_CONFIG);
  assert(old.family === "openai-implicit", "without compat flag, OpenAI stays implicit");
  const wrongOpenAi = {
    ...openaiOld,
    baseUrl: "https://openai-proxy.example/v1",
  } as any;
  const wrongOpenAiCapability = resolveProviderCapability(wrongOpenAi);
  assert(wrongOpenAiCapability.state === "unsupported", "wrong OpenAI endpoint must fail closed");
  assert(
    wrongOpenAiCapability.reason.includes("baseUrl is not api.openai.com"),
    "OpenAI endpoint rejection must identify the incorrect baseUrl",
  );

  const directXai = {
    id: "grok-4.5",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    compat: { sessionAffinityFormat: "openai", supportsLongCacheRetention: false },
  } as any;
  const xaiCapability = resolveProviderCapability(directXai);
  assert(xaiCapability.state === "verified", "direct xAI Grok 4.5 should be verified");
  assert(xaiCapability.automaticWarm, "verified xAI should allow automatic warming");
  assert(!xaiCapability.manualProbe, "verified xAI does not need an unverified probe escape hatch");
  const insecureXai = { ...directXai, baseUrl: "http://api.x.ai/v1" } as any;
  const insecureCapability = resolveProviderCapability(insecureXai);
  assert(insecureCapability.state === "unsupported", "HTTP xAI routes must not receive first-party capability");
  assert(
    insecureCapability.reason.includes("baseUrl is not api.x.ai"),
    "xAI endpoint rejection must identify the incorrect baseUrl",
  );
  const missingBaseUrl = { ...directXai, baseUrl: undefined } as any;
  assert(
    resolveProviderCapability(missingBaseUrl).state === "unsupported",
    "xAI routes without endpoint metadata must fail closed",
  );
  const wrongRouting = {
    ...directXai,
    compat: { sessionAffinityFormat: "openrouter" },
  } as any;
  assert(
    resolveProviderCapability(wrongRouting).state === "unsupported",
    "proxy cache-routing metadata must fail closed for direct xAI",
  );
  const xai = resolveStrategy(directXai, DEFAULT_CONFIG);
  assert(xai.family === "xai-best-effort", "xAI should use its named best-effort family");
  assert(xai.intervalMs === XAI_BEST_EFFORT_INTERVAL_MS, "xAI should use its provider cadence by default");
  assert(xai.ttlLabel.includes("best-effort"), "xAI should not expose a fixed TTL label");
  assert(xai.automaticWarm, "xAI strategy should allow automatic warming after payload validation");

  const xaiPayload = {
    model: "grok-4.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    prompt_cache_key: "xai-session-1",
  };
  assert(isSafeReplayPayload(xaiPayload, directXai.api), "Responses payload should be probe-safe");
  assert(isSafeXaiReplayPayload(xaiPayload), "xAI payload should include a stable prompt-cache key");
  assert(!canManualProbe(directXai, xaiPayload), "verified xAI should not use the unverified probe path");
  const xaiWithoutKey = { ...xaiPayload, prompt_cache_key: undefined };
  const xaiWithoutKeyStrategy = resolveStrategy(directXai, DEFAULT_CONFIG, xaiWithoutKey);
  assert(!xaiWithoutKeyStrategy.automaticWarm, "xAI must fail closed without a cache key");
  assert(
    xaiWithoutKeyStrategy.ttlLabel.includes("stable prompt-cache key"),
    "missing xAI cache key should explain why warming is inactive",
  );
  const missingKeyCapability = resolveProviderCapability(directXai, xaiWithoutKey);
  assert(missingKeyCapability.state === "unverified", "missing xAI cache key should be unverified");
  assert(!missingKeyCapability.automaticWarm, "missing xAI cache key must disable automatic warming");
  assert(!missingKeyCapability.manualProbe, "missing xAI cache key must not permit an unsafe manual probe");
  assert(
    missingKeyCapability.reason.includes("prompt_cache_key") &&
      missingKeyCapability.reason.includes("automatic warming is disabled"),
    "missing xAI cache key reason must be actionable",
  );
  assert(
    resolveStrategy(directXai, DEFAULT_CONFIG, xaiWithoutKey).family === "unverified",
    "missing xAI cache key must not receive a verified cache family",
  );
  const xaiOverride = resolveStrategy(
    directXai,
    { ...DEFAULT_CONFIG, intervalMs: 75_000 },
    xaiPayload,
  );
  assert(xaiOverride.intervalMs === 75_000, "xAI should honor the existing interval override");
  const otherXai = { ...directXai, id: "grok-4.3" } as any;
  const otherXaiCapability = resolveProviderCapability(otherXai);
  assert(otherXaiCapability.state === "unverified", "other xAI models remain unverified");
  assert(!otherXaiCapability.automaticWarm, "unverified xAI routes must not auto-warm");
  assert(otherXaiCapability.manualProbe, "other xAI models retain manual probe access");
  assert(
    otherXaiCapability.reason.includes("automatic warming is disabled") &&
      otherXaiCapability.reason.includes("/warm now"),
    "manual-only xAI reason must explain the explicit probe path",
  );
  assert(
    canManualProbe(otherXai, xaiPayload),
    "safe payload should allow a manual probe for an unverified xAI model",
  );
  assert(
    !canManualProbe(directXai, { model: "grok-4.5", messages: [] }),
    "unsafe xAI payload should not allow a manual probe",
  );

  const openRouterXai = {
    id: "x-ai/grok-4.5",
    provider: "openrouter",
    api: "openai-responses",
    baseUrl: "https://openrouter.ai/api/v1",
  } as any;
  const openRouterCapability = resolveProviderCapability(openRouterXai);
  assert(openRouterCapability.state === "unsupported", "OpenRouter must not inherit xAI support");
  assert(
    openRouterCapability.reason.includes("OpenRouter routes do not inherit first-party cache strategies"),
    "OpenRouter rejection must explain that first-party support is not inherited",
  );
  assert(!openRouterCapability.manualProbe, "unsupported OpenRouter route must not probe");
  assert(!canManualProbe(openRouterXai, xaiPayload), "OpenRouter must reject manual probes");
  const openRouterStrategy = resolveStrategy(openRouterXai, DEFAULT_CONFIG);
  assert(!openRouterStrategy.automaticWarm, "unsupported OpenRouter route must not auto-warm");
  assert(openRouterStrategy.intervalMs === null, "unsupported route must not receive a timer");

  const openCodeGrok = {
    id: "grok-4.5",
    provider: "opencode-go",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
  } as any;
  assert(
    resolveProviderCapability(openCodeGrok).state === "unsupported",
    "OpenCode Go must not inherit OpenAI support",
  );
  assert(!canManualProbe(openCodeGrok, xaiPayload), "OpenCode Go must reject manual probes");

  const unknownResponses = {
    id: "gpt-compatible",
    provider: "my-proxy",
    api: "openai-responses",
  } as any;
  const unknownCapability = resolveProviderCapability(unknownResponses);
  assert(unknownCapability.state === "unsupported", "unknown OpenAI-compatible routes must be unsupported");
  assert(
    unknownCapability.reason.includes("automatic and manual warming are disabled"),
    "unknown route rejection must explain both disabled paths",
  );
  assert(!canManualProbe(unknownResponses, xaiPayload), "unknown routes must reject manual probes");

  const xaiProbe = buildWarmResult({
    fingerprint: "xai-payload",
    usage: {
      input: 4,
      output: 2,
      cacheRead: 1200,
      cacheWrite: 0,
      cost: { total: 0.01 },
    },
    anchor: {
      inputPricePerMTok: 2,
      cacheReadPricePerMTok: 0.3,
      savingsKnown: true,
      capability: xaiCapability,
    },
  });
  assert(xaiProbe.cacheHit, "xAI probe should retain observed cache-read result");
  assert(xaiProbe.probeOutcome === "hit", "xAI probe result should identify a hit");
  assert(xaiProbe.estimatedSavedUsd > 0, "verified xAI savings should use observed cache reads");
  const rejectedProbe = buildWarmResult({
    fingerprint: "unsafe-xai-payload",
    error: "captured payload shape is not safe",
    unavailable: true,
    anchor: {
      inputPricePerMTok: 2,
      cacheReadPricePerMTok: 0.3,
      savingsKnown: false,
      capability: otherXaiCapability,
    },
  });
  assert(rejectedProbe.unavailable === true, "policy rejection must be marked unavailable");
  assert(rejectedProbe.probeOutcome === "unavailable", "rejected probe should be unavailable, not a miss");
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0,
      savingsKnown: false,
      pricingSource: "model",
      capability: otherXaiCapability,
    }) === "n/a (unverified route)",
    "unverified route must not use the no-pricing message for savings",
  );
  assert(
    formatSavingsSummary({
      probeHitCount: 1,
      probeMissCount: 0,
      totalEstimatedSavedUsd: 10,
      totalProbeCostUsd: 1,
      savingsKnown: true,
      pricingSource: "model",
      capability: otherXaiCapability,
    }) === "n/a (unverified route)",
    "unverified route savings summary must stay n/a even with model pricing",
  );
}

// 4) Implicit probe misses retry quietly before becoming persistent misses.
{
  assert(
    classifyProbeOutcome({
      cacheFamily: "openai-implicit",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 0,
    }) === "transient-miss",
    "first implicit no-read/no-write response should be transient",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "openai-implicit",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 1,
    }) === "miss",
    "repeated implicit no-read/no-write response should be persistent miss",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "anthropic-short",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 0,
    }) === "miss",
    "non-implicit no-read/no-write response should remain a miss",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "anthropic-short",
      cacheRead: 0,
      cacheWrite: 300,
      consecutiveFailuresBefore: 0,
    }) === "payload-drift",
    "write without read should be a payload-drift candidate",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "xai-best-effort",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 0,
      maxConsecutiveFailures: 3,
    }) === "transient-miss",
    "first xAI no-read/no-write response should retry quietly",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "xai-best-effort",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 1,
      maxConsecutiveFailures: 3,
    }) === "miss",
    "second xAI no-read/no-write response should remain retryable",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "xai-best-effort",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    }) === "payload-drift",
    "repeated xAI misses should request a re-anchor when cache writes are unavailable",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "xai-best-effort",
      cacheRead: 0,
      cacheWrite: 100,
      consecutiveFailuresBefore: 0,
    }) === "payload-drift",
    "reported xAI cache writes should request an immediate re-anchor",
  );
}

// 5) minimumOutputTokensForPayload helper
{
  const n = minimumOutputTokensForPayload({ thinking: { type: "enabled", budget_tokens: 100 } }, 1);
  assert(n === 101, `expected 101, got ${n}`);
}

// 6) Payload fingerprint changes when payload changes
{
  const a = stableFingerprint({ messages: [{ role: "user", content: "a" }] });
  const b = stableFingerprint({ messages: [{ role: "user", content: "b" }] });
  assert(a !== b, "different payloads must fingerprint differently");
  assert(a === stableFingerprint({ messages: [{ role: "user", content: "a" }] }), "stable");
}

// 7) Real-turn continuity and classification stay separate from probe results.
{
  const firstPayload = {
    model: "gpt-5.6",
    input: [{ role: "user", content: [{ type: "input_text", text: "first" }] }],
    prompt_cache_key: "session-1",
  };
  const continuedPayload = {
    ...firstPayload,
    input: [
      ...firstPayload.input,
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { role: "user", content: [{ type: "input_text", text: "second" }] },
    ],
  };
  const changedPrefix = {
    ...continuedPayload,
    input: [
      { role: "user", content: [{ type: "input_text", text: "rewritten" }] },
      ...continuedPayload.input.slice(1),
    ],
  };
  assert(
    isPayloadContinuation(firstPayload, continuedPayload, "openai-responses"),
    "appended conversation items should preserve continuity",
  );
  assert(
    !isPayloadContinuation(firstPayload, changedPrefix, "openai-responses"),
    "rewritten prefix must not be treated as continuity",
  );
  const markerPrevious = {
    model: "claude-fable-5",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }],
      },
    ],
    system: [],
  };
  const markerCurrent = {
    ...markerPrevious,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  assert(
    isPayloadContinuation(markerPrevious, markerCurrent, "anthropic-messages"),
    "moving Anthropic cache markers must not break normal-turn continuity",
  );

  const first = classifyRealTurnObservation({
    input: 10,
    cacheRead: 1000,
    cacheWrite: 0,
    minCachedTokens: 512,
    continuity: false,
    continuityReason: "first real turn",
    provider: "openai",
    modelId: "gpt-5.6",
    api: "openai-responses",
  });
  assert(first.state === "unknown", "first real turn must remain unknown");
  assert(first.cacheRead === 1000, "unknown state must retain raw cache-read usage");

  const hit = classifyRealTurnObservation({
    input: 10,
    cacheRead: 1000,
    cacheWrite: 0,
    minCachedTokens: 512,
    continuity: true,
    continuityReason: "comparable continuation",
  });
  assert(hit.state === "hit", "comparable real turn with a read is a hit");

  const miss = classifyRealTurnObservation({
    input: 10,
    cacheRead: 0,
    cacheWrite: 1000,
    minCachedTokens: 512,
    continuity: true,
    continuityReason: "comparable continuation",
  });
  assert(miss.state === "miss", "comparable real turn with no read is a miss");

  const small = classifyRealTurnObservation({
    input: 10,
    cacheRead: 0,
    cacheWrite: 20,
    minCachedTokens: 512,
    continuity: true,
    continuityReason: "comparable continuation",
  });
  assert(small.state === "unknown", "small prompts must not claim a real-turn miss");
  assert(small.reason.includes("below minimum"), "small prompt should explain unknown state");
}

// 8) Savings pricing: zero-cost proxy => n/a (do not invent catalog rates)
{
  const vibe = {
    id: "claude-opus-5",
    provider: "vibeproxy",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as any;
  const p = resolveModelPricing(vibe);
  assert(p.source === "unknown", `expected unknown, got ${p.source}`);
  assert(!p.savingsKnown, "zero-cost proxy must not claim known savings");
  assert(estimateSavedUsd(26778, p.inputPricePerMTok, p.cacheReadPricePerMTok) === 0, "no invented savings");
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0,
      savingsKnown: false,
      pricingSource: "unknown",
    }) === "n/a (no model pricing)",
    "unknown must not render as $0.00",
  );

  const priced = {
    id: "x",
    cost: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  } as any;
  const m = resolveModelPricing(priced);
  assert(m.source === "model", "non-zero model cost wins");
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0.23,
      savingsKnown: true,
      pricingSource: "model",
    }) === "est. $0.23 saved",
    "known savings phrase must include 'saved'",
  );
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: -0.0023,
      savingsKnown: true,
      pricingSource: "model",
    }).includes("net cost"),
    "negative net must not look like savings",
  );
}

// 9) Cumulative savings summaries preserve hits, costs, pricing state, and net losses.
{
  const known = formatSavingsSummary({
    probeHitCount: 2,
    probeMissCount: 1,
    totalEstimatedSavedUsd: 0.0045,
    totalProbeCostUsd: 0.01,
    savingsKnown: true,
    pricingSource: "model",
  });
  assert(
    known ===
      "probeHits=2 probeMisses=1 totalEstimatedSaved=$0.0045 totalProbeCost=$0.01 net=-$0.0055 pricingSource=model",
    `known savings summary is not stable: ${known}`,
  );

  const unknown = formatSavingsSummary({
    probeHitCount: 1,
    probeMissCount: 3,
    totalEstimatedSavedUsd: 0,
    totalProbeCostUsd: 0.04,
    savingsKnown: false,
    pricingSource: "unknown",
  });
  assert(
    unknown ===
      "probeHits=1 probeMisses=3 totalEstimatedSaved=n/a totalProbeCost=n/a net=n/a pricingSource=unknown",
    `unknown savings must be n/a: ${unknown}`,
  );
}

// 10) Session warmer keeps real-turn observations, probe outcomes, and retries separate.
{
  const notifications: Array<{ message: string; level: string }> = [];
  const responses: Array<unknown> = [
    {
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.01 },
      },
    },
    {
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 100,
        cacheWrite: 0,
        cost: { total: 0.01 },
      },
    },
    new Error("provider down"),
    {
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 100,
        cost: { total: 0.2 },
      },
    },
  ];
  const completeStub = async (): Promise<any> => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const model = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  } as any;
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = {
    cwd: process.cwd(),
    model,
    hasUI: true,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "warmer-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  } as any;
  const warmer = new SessionWarmer(
    { getThinkingLevel: () => "off" } as any,
    completeStub as any,
  );
  warmer.bindContext(ctx);
  warmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConsecutiveFailures: 3,
  });
  assert(warmer.getLifecycleState() === "idle", "new warmer should start idle");
  const initialStats = warmer.getSessionWarmStats();
  assert(initialStats.totalEstimatedSavedUsd === 0, "savings stats should start at zero");
  assert(initialStats.totalProbeCostUsd === 0, "probe cost stats should start at zero");
  assert(initialStats.probeHitCount === 0, "probe hit stats should start at zero");
  assert(initialStats.probeMissCount === 0, "probe miss stats should start at zero");
  assert(initialStats.lastProbeAt === null, "last probe time should start empty");
  warmer.invalidateAnchor(ctx, "compacted · waiting for next turn");
  assert(warmer.getLifecycleState() === "awaiting-reanchor", "invalidation should await re-anchor");
  const waiting = await warmer.warmNow(ctx);
  assert(waiting.unavailable === true, "awaiting re-anchor must not probe");
  warmer.capturePayload(
    {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      prompt_cache_key: "warmer-test",
    },
    ctx,
  );
  assert(warmer.getLifecycleState() === "anchored", "real-turn capture should create an anchor");
  const anchorStats = warmer.getSessionWarmStats();
  assert(anchorStats.totalEstimatedSavedUsd === 0, "new anchor savings should start at zero");
  assert(anchorStats.totalProbeCostUsd === 0, "new anchor probe cost should start at zero");
  assert(anchorStats.probeHitCount === 0, "new anchor probe hits should start at zero");
  assert(anchorStats.probeMissCount === 0, "new anchor probe misses should start at zero");
  assert(anchorStats.lastProbeAt === null, "new anchor last probe time should be empty");
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });

  const transient = await warmer.warmNow(ctx);
  assert(transient.probeOutcome === "transient-miss", "first implicit miss should be transient");
  assert(transient.retryState === "1/3", "transient miss should expose retry state");
  assert(warmer.getLatestRealTurnObservation()?.state === "unknown", "probe must not classify the real turn");
  assert(warmer.getLatestProbeObservation()?.outcome === "transient-miss", "latest probe should show transient miss");
  assert(notifications.every((entry) => entry.level !== "warning"), "first transient miss must not warn immediately");

  const hit = await warmer.warmNow(ctx);
  assert(hit.probeOutcome === "hit", "retry hit should be labelled as a probe hit");
  assert(warmer.getLatestProbeObservation()?.outcome === "hit", "latest probe should be a hit");
  assert(warmer.getLatestRealTurnObservation()?.state === "unknown", "probe hit must not change real-turn state");
  assert(warmer.getStatusText().includes("probeHits=1"), "status should expose probe hits");
  assert(warmer.getStatusText().includes("probeMisses=1"), "status should expose probe misses");
  assert(warmer.getStatusText().includes("probeFailStreak=0/3"), "successful probe should reset retry state");
  const cumulativeStats = warmer.getSessionWarmStats();
  assert(
    Math.abs(cumulativeStats.totalEstimatedSavedUsd - 0.00018) < 1e-12,
    `hit savings should accumulate, got ${cumulativeStats.totalEstimatedSavedUsd}`,
  );
  assert(
    Math.abs(cumulativeStats.totalProbeCostUsd - 0.02) < 1e-12,
    `probe costs should accumulate, got ${cumulativeStats.totalProbeCostUsd}`,
  );
  assert(
    warmer.getSavingsSummaryText() ===
      "probeHits=1 probeMisses=1 totalEstimatedSaved=$0.0002 totalProbeCost=$0.02 net=-$0.02 pricingSource=model",
    `warmer savings summary is not cumulative: ${warmer.getSavingsSummaryText()}`,
  );
  const stableStatus = warmer.getStatusText();
  assert(
    stableStatus.includes("lifecycle=anchored"),
    "status should expose the lifecycle state",
  );
  assert(
    stableStatus.includes("capability=verified") && stableStatus.includes("capabilityReason="),
    "status should expose capability state and reason",
  );
  assert(
    stableStatus.includes("strategy=openai-implicit") &&
      stableStatus.includes("cadence=~8m idle cache window") &&
      stableStatus.includes("nextDue="),
    "status should expose strategy, cadence, and next due time",
  );
  assert(
    stableStatus.includes("realTurn=unknown") &&
      stableStatus.includes("probe=hit") &&
      stableStatus.includes("probeSource=extension-only"),
    "status should separate real-turn and extension-probe observations",
  );
  assert(stableStatus.includes("cacheKey=") && stableStatus.includes("pfp="), "status should expose cache identity");
  assert(
    stableStatus.includes("savingsSummary=probeHits=1 probeMisses=1"),
    "status should expose the stable savings summary",
  );

  // A continuing real turn gets a fresh observation, but the preceding probe
  // remains visible so users can compare the two cache signals.
  const continuedPayload = {
    model: model.id,
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ],
    prompt_cache_key: "warmer-test",
  };
  warmer.capturePayload(continuedPayload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 0, cacheWrite: 100, output: 2 });
  assert(warmer.getLatestRealTurnObservation()?.state === "miss", "real turn should classify independently");
  assert(warmer.getLatestProbeObservation()?.outcome === "hit", "real turn should retain the preceding probe");
  assert(warmer.getStatusText().includes("realTurn=miss"), "status should expose the real-turn miss");
  assert(warmer.getStatusText().includes("probe=hit"), "status should retain the probe outcome");

  const providerError = await warmer.warmNow(ctx);
  assert(!providerError.ok && providerError.probeOutcome === "error", "provider error should be an error outcome");
  assert(warmer.getLatestProbeObservation()?.outcome === "error", "provider error should remain a probe error");
  assert(warmer.getStatusText().includes("probeMisses=1"), "provider errors must not increment probe misses");

  const drift = await warmer.warmNow(ctx);
  assert(drift.probeOutcome === "payload-drift", "write without read should require re-anchor");
  assert(
    warmer.getLatestProbeObservation()?.outcome === "payload-drift",
    "payload drift should retain the invalidated probe diagnostic",
  );
  assert(warmer.getLifecycleState() === "awaiting-reanchor", "payload drift should await re-anchor");
  assert(warmer.getStatusText().includes("idle (no anchor)"), "payload drift should clear the replay payload");
  assert(warmer.getStatusText().includes("payload=none"), "payload drift status should request a re-anchor");
  const callsBeforeWaitingProbe = responses.length;
  const waitingAfterDrift = await warmer.warmNow(ctx);
  assert(waitingAfterDrift.unavailable === true, "payload drift must keep probes disabled");
  assert(responses.length === callsBeforeWaitingProbe, "awaiting re-anchor must not call the provider");
  assert(notifications.some((entry) => entry.level === "warning"), "payload drift should warn immediately");

  // Recapturing the same payload after drift must create a fresh anchor. The
  // old fingerprint alone is not enough to prove continuity because the old
  // replay payload was deliberately discarded.
  warmer.capturePayload(
    {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      prompt_cache_key: "warmer-test",
    },
    ctx,
  );
  const reanchoredStatus = warmer.getStatusText();
  assert(warmer.getLifecycleState() === "anchored", "new real-turn capture should finish re-anchor");
  assert(warmer.getLatestProbeObservation() === null, "re-anchor should clear the prior probe observation");
  assert(
    warmer.getLatestRealTurnObservation()?.reason.includes("payload drift"),
    "re-anchor should mark the continuity boundary",
  );
  assert(reanchoredStatus.includes("probeHits=0"), "re-anchor should reset probe hits");
  assert(reanchoredStatus.includes("probeMisses=0"), "re-anchor should reset probe misses");
  assert(
    reanchoredStatus.includes("savings=est. $0.0000 saved"),
    "re-anchor should reset probe savings",
  );
  warmer.setConfig({ ...warmer.getConfig(), enabled: false });
  assert(warmer.getLifecycleState() === "disabled", "disabled config should enter disabled state");
  warmer.dispose();
}

// 11) Disable/re-enable preserves "awaiting-reanchor" and "blocked" states
{
  const notifications: Array<{ message: string; level: string }> = [];
  const responses: Array<unknown> = [
    {
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 100,
        cost: { total: 0.2 },
      },
    },
  ];
  const completeStub = async (): Promise<any> => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const model = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  } as any;
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = {
    cwd: process.cwd(),
    model,
    hasUI: true,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "disable-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  } as any;

  // Test 1: Disable while in "awaiting-reanchor" state, then re-enable restores "awaiting-reanchor"
  const warmer1 = new SessionWarmer(
    { getThinkingLevel: () => "off" } as any,
    completeStub as any,
  );
  warmer1.bindContext(ctx);
  warmer1.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConsecutiveFailures: 3,
  });
  warmer1.capturePayload(
    {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      prompt_cache_key: "disable-test",
    },
    ctx,
  );
  assert(warmer1.getLifecycleState() === "anchored", "should start as anchored after capture");
  warmer1.invalidateAnchor(ctx, "test hard invalidation");
  assert(warmer1.getLifecycleState() === "awaiting-reanchor", "should be awaiting-reanchor after invalidation");

  // Disable while in awaiting-reanchor state
  warmer1.setConfig({ ...warmer1.getConfig(), enabled: false });
  assert(warmer1.getLifecycleState() === "disabled", "should be disabled after setConfig(enabled: false)");

  // Re-enable should restore awaiting-reanchor
  warmer1.setConfig({ ...warmer1.getConfig(), enabled: true });
  assert(warmer1.getLifecycleState() === "awaiting-reanchor", "should restore awaiting-reanchor after re-enable");
  warmer1.dispose();

  // Test 2: Disable while "blocked" (autoWarmBlockReason set), then re-enable restores "blocked"
  const warmer2 = new SessionWarmer(
    { getThinkingLevel: () => "off" } as any,
    completeStub as any,
  );
  warmer2.bindContext(ctx);
  warmer2.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConsecutiveFailures: 3,
  });
  warmer2.capturePayload(
    {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      prompt_cache_key: "disable-test",
    },
    ctx,
  );
  assert(warmer2.getLifecycleState() === "anchored", "should start as anchored");

  // Trigger a block by calling the private method indirectly through warmNow with oversized Codex output
  // Since we can't easily trigger the block through normal flow, we'll use the public getAutoWarmBlockReason API
  // to verify the block state. First, let's manually invoke the internal path via payload drift
  const drift = await warmer2.warmNow(ctx);
  assert(drift.probeOutcome === "payload-drift", "should get payload drift for write without read");

  // Re-capture to get back to anchored, then we'll need to create a different test scenario
  warmer2.capturePayload(
    {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello2" }] }],
      prompt_cache_key: "disable-test",
    },
    ctx,
  );

  // Since we can't easily trigger autoWarmBlockReason through the test fixture without Codex,
  // let's test the scenario differently by using the clearAutoWarmBlock API.
  // We'll create a new warmer and use a Codex model instead.
  const codexModel = {
    id: "gpt-5.6",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  } as any;
  const codexResponses = [
    // First oversized response (soft-skip)
    {
      stopReason: "stop",
      usage: { input: 1, output: 300, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
    },
    // Second oversized response (sticky-block)
    {
      stopReason: "stop",
      usage: { input: 1, output: 300, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
    },
  ];
  const codexCompleteStub = async (): Promise<any> => {
    return codexResponses.shift();
  };
  const codexCtx = { ...ctx, model: codexModel };
  const warmer3 = new SessionWarmer(
    { getThinkingLevel: () => "off" } as any,
    codexCompleteStub as any,
  );
  warmer3.bindContext(codexCtx);
  warmer3.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConsecutiveFailures: 3,
    allowCodexAutoWarm: true,
  });
  warmer3.capturePayload(
    {
      model: codexModel.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      prompt_cache_key: "codex-test",
      store: false,
      stream: true,
    },
    codexCtx,
  );
  warmer3.noteAssistantUsage(codexCtx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });

  // First oversized probe (soft-skip)
  const firstCodex = await warmer3.warmNow(codexCtx);
  assert(warmer3.getLifecycleState() === "anchored", "first oversized should soft-skip and stay anchored");

  // Second oversized probe (sticky-block)
  const secondCodex = await warmer3.warmNow(codexCtx);
  assert(warmer3.getLifecycleState() === "blocked", "second oversized should trigger sticky-block");
  assert(warmer3.getAutoWarmBlockReason() !== null, "autoWarmBlockReason should be set");

  // Disable while blocked
  warmer3.setConfig({ ...warmer3.getConfig(), enabled: false });
  assert(warmer3.getLifecycleState() === "disabled", "should be disabled after setConfig(enabled: false)");

  // Re-enable should restore blocked state
  warmer3.setConfig({ ...warmer3.getConfig(), enabled: true });
  assert(warmer3.getLifecycleState() === "blocked", "should restore blocked state after re-enable");
  assert(warmer3.getAutoWarmBlockReason() !== null, "autoWarmBlockReason should still be set after re-enable");

  // Clear the block and re-disable/re-enable to verify it doesn't restore blocked
  warmer3.clearAutoWarmBlock("test clear");
  assert(warmer3.getLifecycleState() === "anchored", "should be anchored after clearing block");

  warmer3.setConfig({ ...warmer3.getConfig(), enabled: false });
  assert(warmer3.getLifecycleState() === "disabled", "should be disabled again");

  warmer3.setConfig({ ...warmer3.getConfig(), enabled: true });
  assert(warmer3.getLifecycleState() === "anchored", "should restore anchored (not blocked) after block was cleared");

  warmer3.dispose();
  warmer2.dispose();
}

// 10) Direct xAI uses the exact anchor, stable cache routing, legal output
// shaping, quiet first miss, and a bounded re-anchor after repeated misses.
{
  const notifications: Array<{ message: string; level: string }> = [];
  const responses = [
    { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
    { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
    { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
  ];
  const xaiModel = {
    id: "grok-4.5",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    compat: { sessionAffinityFormat: "openai", supportsLongCacheRetention: false },
    cost: { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  } as any;
  const capturedPayload = {
    model: "grok-4.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "keep this exact" }] }],
    prompt_cache_key: "xai-session",
    max_output_tokens: 4096,
    instructions: "Do not change this.",
    reasoning: { effort: "high", summary: "auto" },
    tools: [{ type: "function", name: "bash" }],
  };
  const calls: Array<{ options: any; payload: any }> = [];
  const completeStub = async (_model: any, _context: any, options: any): Promise<any> => {
    const payload = options.onPayload?.(structuredClone({
      model: "grok-4.5",
      input: [],
      prompt_cache_key: "generated-by-adapter",
    }), xaiModel);
    calls.push({ options, payload });
    return responses.shift();
  };
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = {
    cwd: process.cwd(),
    model: xaiModel,
    hasUI: true,
    ui,
    thinkingLevel: "high",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "xai-session" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-key", headers: {}, env: {} }),
    },
  } as any;
  const warmer = new SessionWarmer({ getThinkingLevel: () => "high" } as any, completeStub as any);
  warmer.bindContext(ctx);
  warmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConsecutiveFailures: 3,
  });
  warmer.capturePayload(capturedPayload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });

  const first = await warmer.warmNow(ctx);
  assert(first.family === "xai-best-effort", "xAI result should identify its strategy");
  assert(first.probeOutcome === "transient-miss", "first xAI miss should retry quietly");
  assert(first.cacheKeyFingerprint !== "none", "xAI result should expose cache-key identity");
  assert(warmer.getStatusText().includes("strategy=xai-best-effort"), "status should expose the xAI strategy");
  assert(warmer.getStatusText().includes("cadence=xAI best-effort probe cadence"), "status should expose the xAI cadence");
  assert(warmer.getStatusText().includes("cacheKey="), "status should expose cache-key identity");
  assert(calls[0]?.options.sessionId === "xai-session", "xAI probe should reuse the stable session identity");
  assert(calls[0]?.options.cacheRetention === "short", "xAI probe should use short cache retention");
  const shaped = calls[0]?.payload as Record<string, unknown>;
  assert(shaped.max_output_tokens === OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, "xAI probe should cap output legally");
  assert(shaped.prompt_cache_key === capturedPayload.prompt_cache_key, "xAI probe should preserve the cache key");
  assert(shaped.instructions === capturedPayload.instructions, "xAI probe should preserve instructions");
  assert(JSON.stringify(shaped.reasoning) === JSON.stringify(capturedPayload.reasoning), "xAI probe should preserve reasoning");
  assert(JSON.stringify(shaped.tools) === JSON.stringify(capturedPayload.tools), "xAI probe should preserve tools");
  assert(JSON.stringify(shaped.input) === JSON.stringify(capturedPayload.input), "xAI probe should preserve the exact prefix");
  assert(notifications.every((entry) => entry.level !== "warning"), "first xAI miss should not warn immediately");

  const second = await warmer.warmNow(ctx);
  assert(second.probeOutcome === "miss", "second xAI miss should remain retryable");
  const third = await warmer.warmNow(ctx);
  assert(third.probeOutcome === "payload-drift", "repeated xAI misses should request re-anchor");
  assert(warmer.getLifecycleState() === "awaiting-reanchor", "xAI drift should await re-anchor");
  assert(warmer.getStatusText().includes("idle (no anchor)"), "xAI repeated misses should clear the replay payload");
  assert(warmer.getStatusText().includes("payload=none"), "xAI drift status should request a re-anchor");
  const xaiCallsBeforeWaitingProbe = calls.length;
  const xaiWaiting = await warmer.warmNow(ctx);
  assert(xaiWaiting.unavailable === true, "xAI drift must not probe before re-anchor");
  assert(calls.length === xaiCallsBeforeWaitingProbe, "xAI awaiting re-anchor must not call the provider");
  assert(notifications.some((entry) => entry.level === "warning"), "xAI re-anchor should be visible");
  warmer.dispose();
}

// 12) Unverified routes remain manual-only: no timer, no verified savings, one safe probe.
{
  let calls = 0;
  const notifications: Array<{ message: string; level: string }> = [];
  const model = {
    id: "grok-4.3",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    cost: { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  } as any;
  const payload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "manual only" }] }],
  };
  const completeStub = async (_model: any, _context: any, options: any): Promise<any> => {
    calls += 1;
    options.onPayload?.(structuredClone(payload), model);
    return {
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 100,
        cacheWrite: 0,
        cost: { total: 0.01 },
      },
    };
  };
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = {
    cwd: process.cwd(),
    model,
    hasUI: true,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "manual-only-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "xai-key", headers: {}, env: {} }),
    },
  } as any;
  const warmer = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  warmer.bindContext(ctx);
  warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, intervalMs: 60_000 });
  warmer.capturePayload(payload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  warmer.onAgentSettled(ctx);

  const status = warmer.getStatusText();
  assert(status.includes("capability=unverified"), "manual-only status should expose unverified capability");
  assert(status.includes("autoWarm=off"), "manual-only status should show automatic warming off");
  assert(status.includes("manualProbe=ready"), "safe manual-only payload should be ready");
  assert(status.includes("nextDue=none"), "manual-only route must not arm a timer");

  const result = await warmer.warmNow(ctx);
  assert(result.ok && result.cacheHit, "manual-only route should allow an explicit safe probe");
  assert(result.capabilityState === "unverified", "manual probe result should remain unverified");
  assert(result.estimatedSavedUsd === 0, "manual-only probe must not claim savings");
  assert(warmer.getSavingsSummaryText() === "n/a (unverified route)", "manual-only savings must stay n/a");
  assert(calls === 1, "manual-only route should call the provider only for /warm now");
  assert(
    notifications.some(
      (entry) => entry.level === "warning" && entry.message.includes("automatic warming is disabled"),
    ),
    "manual probe should warn that automatic warming remains disabled",
  );
  warmer.dispose();
}

// 13) UI surfaces stay concise, distinguish re-anchoring, and hide the widget cleanly.
{
  const calls: Array<{ kind: "widget" | "status"; value: unknown }> = [];
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    setWidget: (_id: string, value: unknown) => calls.push({ kind: "widget", value }),
    setStatus: (_id: string, value: unknown) => calls.push({ kind: "status", value }),
  };
  const ctx = { hasUI: true, ui } as any;
  const anchor = {
    cachedTokens: 128_000,
    promptTokens: 128_000,
    probeHitCount: 2,
    probeMissCount: 0,
    savingsKnown: true,
    estimatedSavingsUsd: 0.12,
    capability: { state: "verified" },
  } as any;
  const plan = {
    family: "openai-implicit",
    intervalMs: 240_000,
    ttlLabel: "~8m idle cache window",
    waitLabel: "4m",
    automaticWarm: true,
    manualProbe: false,
    cacheRetention: "short",
  } as any;

  renderWaitingUi(ctx, { ...DEFAULT_CONFIG, showWidget: true }, anchor, plan, Date.now() + 180_000);
  renderWarmHitUi(ctx, { ...DEFAULT_CONFIG, showWidget: true }, anchor, plan, 128_000);
  renderReanchorUi(ctx, { ...DEFAULT_CONFIG, showWidget: true }, "compacted · waiting for next turn");
  renderProbeRetryUi(ctx, { ...DEFAULT_CONFIG, showWidget: true }, "read=0 write=0");
  renderFailureUi(ctx, { ...DEFAULT_CONFIG, showWidget: true }, "probe miss · retry 1/3", "read=0 write=0");
  renderIdleUi(ctx, { ...DEFAULT_CONFIG, showWidget: true }, "waiting for first turn");

  const widgets = calls.filter((call) => call.kind === "widget");
  assert(widgets.length === 6, `visible UI should render six widget states, got ${widgets.length}`);
  assert(
    widgets.every((call) => Array.isArray(call.value) && call.value.length <= 3),
    "every widget state must stay within three lines",
  );
  assert(
    widgets.some((call) =>
      (call.value as string[]).some((line) => line.includes("re-anchoring after compaction")),
    ),
    "re-anchoring needs a distinct non-alarming widget message",
  );
  const statuses = calls
    .filter((call) => call.kind === "status")
    .map((call) => String(call.value));
  assert(
    statuses.some((status) => status === "warm · re-anchoring"),
    "re-anchoring status should be concise",
  );
  assert(
    statuses.some((status) => /warm [0-9.]+m · 2\/2 · ~128k/.test(status)),
    "healthy status should show cadence, probe ratio, and prompt size",
  );

  const capabilityCalls: Array<{ kind: "widget" | "status" | "notify"; value: unknown; level?: string }> = [];
  const capabilityCtx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value: unknown) => capabilityCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value: unknown) => capabilityCalls.push({ kind: "status", value }),
      notify: (value: string, level: string) => capabilityCalls.push({ kind: "notify", value, level }),
    },
  } as any;
  renderCapabilityNotice(capabilityCtx, {
    state: "unverified",
    reason: "direct xAI route has no verified automatic keepalive strategy",
    automaticWarm: false,
    manualProbe: true,
  });
  const manualNotice = capabilityCalls.find((call) => call.kind === "notify");
  assert(String(manualNotice?.value).includes("manual-only route"), "manual-only notice should name its mode");
  assert(String(manualNotice?.value).includes("Automatic warming is disabled"), "manual-only notice should disable timers");
  assert(String(manualNotice?.value).includes("n/a (unverified route)"), "manual-only notice should disable savings claims");
  assert(manualNotice?.level === "warning", "manual-only notice should be warning-level");
  assert(
    capabilityCalls.filter((call) => call.kind === "widget").at(-1)?.value === undefined &&
      capabilityCalls.filter((call) => call.kind === "status").at(-1)?.value === undefined,
    "capability rejection should clear active UI",
  );
  renderCapabilityNotice(capabilityCtx, {
    state: "unsupported",
    reason: "OpenRouter routes do not inherit first-party cache strategies",
    automaticWarm: false,
    manualProbe: false,
  });
  const unsupportedNotice = capabilityCalls.filter((call) => call.kind === "notify").at(-1);
  assert(unsupportedNotice?.level === "info", "unsupported route notice should not be warning-level noise");

  const hiddenCalls: Array<{ kind: "widget" | "status"; value: unknown }> = [];
  const hiddenCtx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value: unknown) => hiddenCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value: unknown) => hiddenCalls.push({ kind: "status", value }),
    },
  } as any;
  const hiddenConfig = { ...DEFAULT_CONFIG, showWidget: false };
  renderWaitingUi(hiddenCtx, hiddenConfig, anchor, plan, Date.now() + 180_000);
  renderWarmHitUi(hiddenCtx, hiddenConfig, anchor, plan, 128_000);
  renderReanchorUi(hiddenCtx, hiddenConfig, "compacted");
  renderProbeRetryUi(hiddenCtx, hiddenConfig, "read=0 write=0");
  renderFailureUi(hiddenCtx, hiddenConfig, "probe miss");
  renderIdleUi(hiddenCtx, hiddenConfig, "disabled");
  const hiddenWidgets = hiddenCalls.filter((call) => call.kind === "widget");
  assert(
    hiddenWidgets.length === 6 && hiddenWidgets.every((call) => call.value === undefined),
    "showWidget=false must clear widget output for every UI state",
  );
  assert(
    hiddenCalls.filter((call) => call.kind === "status").length === 6,
    "the compact status line should remain available when only the widget is hidden",
  );
}

console.log("provider.test.ts: all assertions passed");
