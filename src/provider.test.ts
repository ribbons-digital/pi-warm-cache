/**
 * Lightweight assertions (no test runner required).
 * Prefer: node scripts/run-unit-tests.mjs
 * Direct: node --experimental-strip-types src/provider.test.ts
 *
 * Do not launch this in the same parallel batch as an edit of this file.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendWarmUserTurn,
  applyWarmOutputLimit,
  applyXaiWarmOutputLimit,
  canManualProbe,
  classifyOpencodeGoFamily,
  classifyProbeOutcome,
  classifyRealTurnObservation,
  CODEX_WARM_OUTPUT_ABORT_TOKENS,
  decideCodexOversizedAction,
  getPromptCacheKey,
  getPromptCacheKeyFingerprint,
  getModelCompat,
  hasStableResponsesCacheKey,
  hasXaiPromptCacheKey,
  isCodexPayload,
  isPayloadContinuation,
  minimumOutputTokensForPayload,
  modelSupportsLongCacheRetention,
  opencodeGoForeignInstrumentationReason,
  isSafeReplayPayload,
  isSafeXaiReplayPayload,
  isStablePromptCacheKey,
  OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
  payloadHasAnthropicLongTtl,
  payloadHasCacheControl,
  supportsManualProbe,
  XAI_BEST_EFFORT_INTERVAL_MS,
  resolveCacheFamily,
  resolveCacheRetention,
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
import piWarmCache from "./index.ts";
import { SessionWarmer } from "./warmer.ts";
import {
  renderCapabilityNotice,
  renderFailureUi,
  renderManualOnlyUi,
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

// 2d) Uncapped completions fallback honors compat.maxTokensField; the default
// field stays "max_completion_tokens" without compat; an already-capped body
// mutates only the declared field.
{
  const uncapped = {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
  };
  const declared = applyWarmOutputLimit(
    structuredClone(uncapped),
    8,
    "openai-completions",
    { maxTokensField: "max_tokens" },
  ) as Record<string, unknown>;
  assert(
    declared.max_tokens === 8,
    "uncapped completions must write the declared maxTokensField",
  );
  assert(
    !("max_completion_tokens" in declared),
    "must not write the default field when maxTokensField is declared",
  );

  const defaulted = applyWarmOutputLimit(
    structuredClone(uncapped),
    8,
    "openai-completions",
  ) as Record<string, unknown>;
  assert(
    defaulted.max_completion_tokens === 8,
    "uncapped completions without compat keeps the default field",
  );
  assert(!("max_tokens" in defaulted), "must not add max_tokens without compat");

  // Already-capped body: the existing declared field is capped in place and no
  // other field is added (exact-prefix replay preserved).
  const cappedOriginal = {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8192,
  };
  const cappedOut = applyWarmOutputLimit(
    structuredClone(cappedOriginal),
    8,
    "openai-completions",
    { maxTokensField: "max_tokens" },
  ) as Record<string, unknown>;
  assert(cappedOut.max_tokens === 8, "an existing declared cap field is capped in place");
  deepEqualExcept(cappedOriginal, cappedOut, WARM_MUTABLE_PAYLOAD_KEYS);

  // The Anthropic and Responses fallbacks stay unchanged when compat is passed.
  const anthropicUncapped = {
    model: "claude-fable-5",
    messages: [{ role: "user", content: "hi" }],
  };
  const anthropicOut = applyWarmOutputLimit(
    structuredClone(anthropicUncapped),
    8,
    "anthropic-messages",
    { maxTokensField: "max_tokens" },
  ) as Record<string, unknown>;
  assert(anthropicOut.max_tokens === 8, "the Anthropic fallback keeps writing max_tokens");

  const responsesUncapped = { model: "gpt-5.6", input: [{ role: "user", content: "hi" }] };
  const responsesOut = applyWarmOutputLimit(
    structuredClone(responsesUncapped),
    8,
    "openai-responses",
    { maxTokensField: "max_tokens" },
  ) as Record<string, unknown>;
  assert(
    responsesOut.max_output_tokens === OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
    "the Responses fallback keeps writing max_output_tokens at its legal floor",
  );
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
  assert(hasXaiPromptCacheKey(xaiPayload), "xAI key detector should accept the exact Responses shape");
  assert(getPromptCacheKey(xaiPayload, directXai.api) === "xai-session-1", "key detector should return the captured key");
  assert(getPromptCacheKeyFingerprint(xaiPayload, directXai.api) !== "none", "key fingerprint should be redacted but present");
  assert(isStablePromptCacheKey("session-id"), "normal session ids should be stable keys");
  assert(!isStablePromptCacheKey(" session-id"), "leading whitespace must not qualify as stable");
  assert(!isStablePromptCacheKey("session-id "), "trailing whitespace must not qualify as stable");
  assert(!isStablePromptCacheKey(""), "empty key must not qualify as stable");
  assert(!isStablePromptCacheKey(42), "non-string key must not qualify as stable");
  assert(!hasXaiPromptCacheKey({ ...xaiPayload, prompt_cache_key: "   " }), "blank xAI key must be rejected");
  assert(!hasXaiPromptCacheKey({ ...xaiPayload, prompt_cache_key: "xai\nkey" }), "control characters must be rejected");
  assert(!hasXaiPromptCacheKey({ ...xaiPayload, prompt_cache_key: "key\u009Bvalue" }), "C1 control characters (U+0080-U+009F) must be rejected");
  assert(getPromptCacheKey(xaiPayload, "openai-completions") === null, "wrong API must not expose a Responses key");
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
    compat: { sessionAffinityFormat: "openrouter" },
  } as any;
  const openRouterCapability = resolveProviderCapability(openRouterXai);
  assert(openRouterCapability.state === "unverified", "OpenRouter should use the manual-only tier");
  assert(!openRouterCapability.automaticWarm, "OpenRouter manual-only routes must never auto-warm");
  assert(openRouterCapability.manualProbe, "registered OpenRouter routes should permit manual probes");
  assert(
    openRouterCapability.reason.includes("manual-only") &&
      openRouterCapability.reason.includes("savings are n/a"),
    "OpenRouter manual-only reason must explain the safety and savings limits",
  );
  assert(canManualProbe(openRouterXai, xaiPayload), "safe OpenRouter payload should permit a manual probe");
  const openRouterStrategy = resolveStrategy(openRouterXai, DEFAULT_CONFIG, xaiPayload);
  assert(openRouterStrategy.family === "unverified", "OpenRouter must not inherit an xAI or OpenAI family");
  assert(!openRouterStrategy.automaticWarm, "manual-only OpenRouter route must not auto-warm");
  assert(openRouterStrategy.intervalMs === null, "manual-only OpenRouter route must not receive a timer");

  const openRouterWrongEndpoint = {
    ...openRouterXai,
    baseUrl: "https://openrouter-proxy.example/v1",
  } as any;
  assert(
    resolveProviderCapability(openRouterWrongEndpoint).state === "unsupported",
    "OpenRouter routes with a different endpoint must fail closed",
  );
  const openRouterWrongPath = {
    ...openRouterXai,
    baseUrl: "https://openrouter.ai/api/v2",
  } as any;
  assert(
    resolveProviderCapability(openRouterWrongPath).state === "unsupported",
    "OpenRouter routes on an unregistered path must fail closed (exact-path matching)",
  );
  const openRouterWrongRouting = {
    ...openRouterXai,
    compat: { sessionAffinityFormat: "openai" },
  } as any;
  assert(
    resolveProviderCapability(openRouterWrongRouting).state === "unsupported",
    "OpenRouter routes with non-OpenRouter routing metadata must fail closed",
  );

  const openRouterMissingMetadata = {
    id: "x-ai/grok-4.5",
    provider: "openrouter",
    api: "openai-responses",
    baseUrl: "https://openrouter.ai/api/v1",
  } as any;
  assert(
    resolveProviderCapability(openRouterMissingMetadata).state === "unsupported",
    "OpenRouter routes with missing session-affinity metadata must fail closed",
  );
  assert(
    !resolveProviderCapability(openRouterMissingMetadata).manualProbe,
    "OpenRouter routes with missing metadata must not enable manualProbe",
  );

  // OpenCode Go: per-api proxy route registry with exact baseUrl paths.
  {
    // Drive the gate from the live pi-ai registry so catalog churn stays
    // visible: 3 anthropic-messages, 12 openai-completions, 1 openai-responses.
    const registryPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "dist",
      "providers",
      "data",
      "opencode-go.json",
    );
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<
      string,
      Record<string, any>
    >;
    const goModels: any[] = [];
    for (const [api, modelsById] of Object.entries(registry)) {
      for (const model of Object.values(modelsById)) {
        goModels.push({ ...model, api });
      }
    }
    assert(
      goModels.length === 16,
      `expected 16 OpenCode Go registry models, got ${goModels.length}`,
    );
    const goApiCounts: Record<string, number> = {};
    for (const model of goModels) {
      goApiCounts[model.api] = (goApiCounts[model.api] ?? 0) + 1;
      const capability = resolveProviderCapability(model);
      assert(
        capability.state === "unverified",
        `opencode-go ${model.api}/${model.id} should use the manual-only tier, got ${capability.state}`,
      );
      assert(!capability.automaticWarm, `opencode-go ${model.id} must never auto-warm`);
      assert(capability.manualProbe, `opencode-go ${model.id} should permit manual probes`);
      assert(
        capability.reason.includes("manual-only") &&
          capability.reason.includes("savings are n/a"),
        `opencode-go ${model.id} reason must explain the safety and savings limits`,
      );
      const expectedPath = model.api === "anthropic-messages" ? "/zen/go" : "/zen/go/v1";
      assert(
        model.baseUrl === `https://opencode.ai${expectedPath}`,
        `opencode-go ${model.id} should register the exact ${expectedPath} baseUrl`,
      );
    }
    assert(goApiCounts["anthropic-messages"] === 3, "expected 3 anthropic-messages models");
    assert(goApiCounts["openai-completions"] === 12, "expected 12 openai-completions models");
    assert(goApiCounts["openai-responses"] === 1, "expected 1 openai-responses model");

    // The single responses model carries the registered routing metadata and
    // resolves through its exact path; the anthropic-messages models need no
    // compat at all.
    const goGrok = {
      id: "grok-4.5",
      provider: "opencode-go",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { sessionAffinityFormat: "openai-nosession" },
    } as any;
    assert(
      resolveProviderCapability(goGrok).state === "unverified",
      "the responses model must resolve through its registered path",
    );
    const goGrokTrailingSlash = { ...goGrok, baseUrl: "https://opencode.ai/zen/go/v1/" } as any;
    assert(
      resolveProviderCapability(goGrokTrailingSlash).state === "unverified",
      "a trailing slash must normalize to the registered path",
    );
    const goGrokExtraPath = { ...goGrok, baseUrl: "https://opencode.ai/zen/go/v1/extra" } as any;
    assert(
      resolveProviderCapability(goGrokExtraPath).state === "unsupported",
      "a longer path must not match via prefix semantics",
    );

    // Wrong-path fixtures: each (provider, api) pair has exactly one path.
    // /zen/go is a prefix of /zen/go/v1 and must not match the wrong transport.
    const goAnthropicOnCompletionsPath = {
      id: "minimax-m3",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go/v1",
    } as any;
    assert(
      resolveProviderCapability(goAnthropicOnCompletionsPath).state === "unsupported",
      "an anthropic model on the completions path must fail closed",
    );
    const goCompletionsOnAnthropicPath = {
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go",
    } as any;
    assert(
      resolveProviderCapability(goCompletionsOnAnthropicPath).state === "unsupported",
      "a completions model on the anthropic path must fail closed",
    );

    // Wrong-api fixture: an unregistered OpenCode Go transport fails closed.
    const goWrongApi = {
      id: "grok-4.5",
      provider: "opencode-go",
      api: "openai-codex-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
    } as any;
    assert(
      resolveProviderCapability(goWrongApi).state === "unsupported",
      "an unregistered OpenCode Go API must fail closed",
    );
    assert(
      resolveProviderCapability(goWrongApi).reason.includes("not registered"),
      "an unregistered OpenCode Go API must name the missing registration",
    );

    // Regression: a provider match always returns a decision. An OpenCode Go
    // anthropic model copying first-party metadata must never reach the
    // first-party verified branch.
    const goAnthropicCompat = {
      id: "qwen3.7-max",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      compat: { cacheControlFormat: "anthropic" },
    } as any;
    const goAnthropicCompatCapability = resolveProviderCapability(goAnthropicCompat);
    assert(
      goAnthropicCompatCapability.state === "unverified",
      "opencode-go anthropic models must not reach first-party verified via cacheControlFormat",
    );
    assert(
      !goAnthropicCompatCapability.automaticWarm,
      "the fall-through regression route must never auto-warm",
    );
    assert(
      resolveStrategy(goAnthropicCompat, DEFAULT_CONFIG).family === "opencode-go-plain",
      "the fall-through regression route must not receive a verified family; the payload-driven plain family applies",
    );

    // A registered OpenCode Go route without any compat still resolves; the
    // anthropic-messages transport does not require routing metadata.
    const goAnthropicNoCompat = {
      id: "qwen3.7-plus",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    } as any;
    assert(
      resolveProviderCapability(goAnthropicNoCompat).state === "unverified",
      "anthropic-messages models need no compat routing metadata to resolve",
    );
    const goAnthropicPayload = {
      model: "qwen3.7-plus",
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
    };
    assert(
      canManualProbe(goAnthropicNoCompat, goAnthropicPayload),
      "a safe anthropic payload should permit a manual probe on the Go anthropic route",
    );
    const goStrategy = resolveStrategy(goAnthropicNoCompat, DEFAULT_CONFIG);
    assert(
      goStrategy.family === "opencode-go-plain",
      "OpenCode Go must not inherit an Anthropic family; the payload-driven plain family applies",
    );
    assert(goStrategy.intervalMs === null, "manual-only OpenCode Go route must not receive a timer");

    // Foreign-instrumentation refusal: an opencode-go openai-completions
    // payload may carry cache_control only when the route compat declares
    // cacheControlFormat: "anthropic". No opencode-go completions model
    // declares it today, so any cache_control is evidence of third-party
    // mutation (for example the community pi-opencode-go-cache rewriter) and
    // is refused for replay.
    const goCompletions = {
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    } as any;
    const goCompletionsClean = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    };
    assert(
      canManualProbe(goCompletions, goCompletionsClean),
      "a clean completions payload still permits a manual probe",
    );
    assert(
      supportsManualProbe(goCompletions),
      "supportsManualProbe without a payload must stay permissive for a registered manual-only route",
    );

    // Nested markers deep in a completions payload are refused: the deep-walk
    // scans nested objects and arrays at any depth.
    const goCompletionsNestedMarker = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "bash",
                arguments: { metadata: { cache_control: { type: "ephemeral" } } },
              },
            },
          ],
        },
      ],
    };
    assert(
      payloadHasCacheControl(goCompletionsNestedMarker),
      "the deep-walk must find a cache_control key at any depth",
    );
    const refusedCapability = resolveProviderCapability(goCompletions, goCompletionsNestedMarker);
    assert(
      refusedCapability.state === "unverified",
      "a refused completions payload keeps the route unverified, not unsupported",
    );
    assert(
      !refusedCapability.manualProbe,
      "an illegal cache_control payload must disable the manual probe",
    );
    assert(
      refusedCapability.reason.includes("cache_control") &&
        refusedCapability.reason.includes("foreign instrumentation") &&
        refusedCapability.reason.includes("read-only"),
      "the refusal reason must name the foreign instrumentation and the capture ordering",
    );
    assert(
      opencodeGoForeignInstrumentationReason(goCompletions, goCompletionsNestedMarker) !== null,
      "the detector must fire on a nested marker",
    );
    assert(
      !canManualProbe(goCompletions, goCompletionsNestedMarker),
      "a completions payload carrying illegal cache_control must be refused for replay",
    );
    assert(
      !supportsManualProbe(goCompletions, goCompletionsNestedMarker),
      "supportsManualProbe must refuse the illegal payload too",
    );

    // Compat-conditional allow: a completions model that declares
    // cacheControlFormat: "anthropic" may carry cache_control with no refusal.
    const goCompletionsAnthropicCompat = {
      id: "future-completions-model",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { cacheControlFormat: "anthropic" },
    } as any;
    const goCompletionsMarkerPayload = {
      model: "future-completions-model",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    assert(
      opencodeGoForeignInstrumentationReason(goCompletionsAnthropicCompat, goCompletionsMarkerPayload) ===
        null,
      "no refusal when the route compat declares cacheControlFormat: anthropic",
    );
    assert(
      canManualProbe(goCompletionsAnthropicCompat, goCompletionsMarkerPayload),
      "compat-conditional allow: a cache_control payload is legal when the route declares the format",
    );

    // A GLM fixture is refused like any other completions model: there is no
    // model-id denylist, the rule derives purely from the compat declaration.
    const goGlm = {
      id: "glm-5.1",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { maxTokensField: "max_tokens" },
    } as any;
    assert(
      opencodeGoForeignInstrumentationReason(goGlm, goCompletionsNestedMarker) !== null,
      "glm-5.1 has no denylist; the refusal is pure compat shape",
    );
    assert(
      !canManualProbe(goGlm, goCompletionsNestedMarker),
      "glm-5.1 refuses an illegal cache_control payload like any other completions model",
    );

    // Anthropic-messages markers are legal: that transport carries
    // cache_control by design, so the refusal never fires for it.
    const goAnthropicMarkers = {
      id: "qwen3.7-max",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    } as any;
    const goAnthropicMarkerPayload = {
      model: "qwen3.7-max",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
      ],
    };
    assert(
      opencodeGoForeignInstrumentationReason(goAnthropicMarkers, goAnthropicMarkerPayload) === null,
      "anthropic-messages markers are legal; the refusal never fires for that transport",
    );
    assert(
      canManualProbe(goAnthropicMarkers, goAnthropicMarkerPayload),
      "anthropic-messages markers must not disable the manual probe",
    );

    // Payload-driven family classification for every instrumentation state.
    // The family is independent of capability state and comes from the
    // instrumentation actually observed on the captured payload.
    const goAnthropicFamilyModel = {
      id: "qwen3.7-max",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    } as any;
    assert(
      classifyOpencodeGoFamily({ model: "qwen3.7-max", messages: [], system: [] }) ===
        "opencode-go-plain",
      "anthropic-messages without markers must classify plain",
    );
    assert(
      classifyOpencodeGoFamily(undefined) === "opencode-go-plain",
      "no payload must classify plain",
    );
    assert(
      classifyOpencodeGoFamily({
        model: "qwen3.7-max",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
          },
        ],
        system: [],
      }) === "opencode-go-short-marker",
      "any cache_control without ttl must classify short-marker",
    );
    assert(
      classifyOpencodeGoFamily({
        model: "qwen3.7-max",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } },
            ],
          },
        ],
        system: [],
      }) === "opencode-go-long-marker",
      "cache_control with ttl 1h must classify long-marker",
    );
    assert(
      classifyOpencodeGoFamily({
        model: "qwen3.7-max",
        prompt_cache_retention: "24h",
        messages: [{ role: "user", content: "hi" }],
        system: [],
      }) === "opencode-go-retained",
      "prompt_cache_retention 24h must classify retained",
    );
    // Retention wins over markers: it is the stronger lifetime signal.
    assert(
      classifyOpencodeGoFamily({
        model: "qwen3.7-max",
        prompt_cache_retention: "24h",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
          },
        ],
        system: [],
      }) === "opencode-go-retained",
      "retention must win over a co-occurring marker",
    );
    // Keyed-but-unretained is not a separate family: it behaves like plain.
    assert(
      classifyOpencodeGoFamily({
        model: "grok-4.5",
        input: [{ role: "user", content: "hi" }],
        prompt_cache_key: "go-session-1",
      }) === "opencode-go-plain",
      "prompt_cache_key without prompt_cache_retention must behave like plain",
    );

    // The retained family never schedules a probe: intervalMs null and no
    // automatic warming from day one, independent of capability state.
    const retainedStrategy = resolveStrategy(
      goAnthropicFamilyModel,
      DEFAULT_CONFIG,
      { model: "qwen3.7-max", prompt_cache_retention: "24h", messages: [], system: [] },
    );
    assert(
      retainedStrategy.family === "opencode-go-retained",
      "a retained payload must resolve the retained family even while unverified",
    );
    assert(retainedStrategy.intervalMs === null, "retained must never schedule a probe");
    assert(!retainedStrategy.automaticWarm, "retained must never auto-warm");
    assert(
      retainedStrategy.ttlLabel.includes("no keepalive scheduled"),
      "retained label must explain that no keepalive is scheduled",
    );
    const retainedCapability = resolveProviderCapability(goAnthropicFamilyModel, {
      model: "qwen3.7-max",
      prompt_cache_retention: "24h",
      messages: [],
      system: [],
    });
    assert(
      !retainedCapability.manualProbe,
      "the retained family must disable the manual probe while unverified",
    );
    assert(
      !supportsManualProbe(goAnthropicFamilyModel, {
        model: "qwen3.7-max",
        prompt_cache_retention: "24h",
        messages: [],
        system: [],
      }),
      "supportsManualProbe must refuse a retained payload",
    );
    assert(
      retainedStrategy.manualProbe === false,
      "the retained strategy must not permit a manual probe",
    );
    assert(
      resolveProviderCapability(goAnthropicFamilyModel, {
        model: "qwen3.7-max",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } },
            ],
          },
        ],
        system: [],
      }).manualProbe,
      "marker families must keep the manual probe escape hatch",
    );

    // Marker and plain families surface their cadence label even while
    // unverified. No Go family renders a numeric lifetime, and no timer is
    // armed: every unverified Go family resolves intervalMs null.
    const longMarkerStrategy = resolveStrategy(
      goAnthropicFamilyModel,
      DEFAULT_CONFIG,
      {
        model: "qwen3.7-max",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } },
            ],
          },
        ],
        system: [],
      },
    );
    assert(
      longMarkerStrategy.family === "opencode-go-long-marker",
      "long-marker family must resolve",
    );
    assert(longMarkerStrategy.intervalMs === null, "unverified long-marker must not arm a timer");
    assert(
      longMarkerStrategy.ttlLabel.includes("best-effort probe cadence (~48m)"),
      "long-marker must show the best-effort cadence label, not a numeric lifetime",
    );
    const shortMarkerStrategy = resolveStrategy(
      goAnthropicFamilyModel,
      DEFAULT_CONFIG,
      {
        model: "qwen3.7-max",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
          },
        ],
        system: [],
      },
    );
    assert(
      shortMarkerStrategy.family === "opencode-go-short-marker",
      "short-marker family must resolve",
    );
    assert(shortMarkerStrategy.intervalMs === null, "unverified short-marker must not arm a timer");
    assert(
      shortMarkerStrategy.ttlLabel.includes("best-effort probe cadence (~4m)"),
      "short-marker must show the best-effort cadence label",
    );
    const plainStrategy = resolveStrategy(
      goAnthropicFamilyModel,
      DEFAULT_CONFIG,
      { model: "qwen3.7-max", messages: [{ role: "user", content: "hi" }], system: [] },
    );
    assert(plainStrategy.family === "opencode-go-plain", "plain family must resolve");
    assert(plainStrategy.intervalMs === null, "unverified plain must not arm a timer");
    assert(
      plainStrategy.ttlLabel.includes("best-effort probe cadence (~4m)"),
      "plain must show the best-effort cadence label",
    );
    assert(
      resolveProviderCapability(goAnthropicFamilyModel, {
        model: "qwen3.7-max",
        messages: [{ role: "user", content: "hi" }],
        system: [],
      }).reason.includes("set Pi cache retention to long for keyed 24h Go caching"),
      "the plain family must fold the degraded retention hint into capability.reason",
    );
    assert(
      !resolveProviderCapability(goAnthropicFamilyModel, {
        model: "qwen3.7-max",
        prompt_cache_retention: "24h",
        messages: [],
        system: [],
      }).reason.includes("set Pi cache retention to long"),
      "the retained family must not carry the plain degraded hint",
    );

    // resolveCacheRetention mapping for the four Go families.
    assert(
      resolveCacheRetention("opencode-go-long-marker") === "long",
      "long-marker maps to long retention",
    );
    assert(
      resolveCacheRetention("opencode-go-short-marker") === "short",
      "short-marker maps to short retention",
    );
    assert(resolveCacheRetention("opencode-go-plain") === "short", "plain maps to short retention");
    assert(
      resolveCacheRetention("opencode-go-retained") === "none",
      "retained never probes so retention is none",
    );

    // resolveCacheFamily is payload-driven for Go routes even while unverified
    // and resolves before the capability-state collapse.
    assert(
      resolveCacheFamily(goAnthropicFamilyModel, "auto", {
        model: "qwen3.7-max",
        prompt_cache_retention: "24h",
        messages: [],
        system: [],
      }) === "opencode-go-retained",
      "resolveCacheFamily must surface the retained family before the capability-state collapse",
    );
    assert(
      resolveCacheFamily(goAnthropicFamilyModel, "auto", undefined) === "opencode-go-plain",
      "resolveCacheFamily with no payload must default to plain for Go routes",
    );

    // The generalized responses key predicate mirrors the direct xAI gate.
    assert(
      hasStableResponsesCacheKey({
        model: "grok-4.5",
        input: [{ role: "user", content: "hi" }],
        prompt_cache_key: "go-session-1",
      }),
      "a responses payload with a stable key must pass the generalized key predicate",
    );
    assert(
      !hasStableResponsesCacheKey({ model: "grok-4.5", input: [{ role: "user", content: "hi" }] }),
      "a responses payload without a key must fail the generalized key predicate",
    );
  }

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
  const reanchorCapturedAt = Date.now();
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
  assert(reanchoredStatus.includes("nextDue=none"), "re-anchor must not retain the dropped timer");

  // The fresh anchor uses the real-turn capture time, not an extra full interval
  // counted from agent_settled after a long turn has finished.
  await new Promise((resolve) => setTimeout(resolve, 20));
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  warmer.onAgentSettled(ctx);
  const reanchoredDueAt = (warmer as any).nextDueAt as number;
  assert(reanchoredDueAt > Date.now(), "re-anchor should arm the normal strategy timer");
  assert(
    reanchoredDueAt <= reanchorCapturedAt + 60_010,
    "re-anchor timer should not add settlement time to the normal interval",
  );
  warmer.setConfig({ ...warmer.getConfig(), enabled: false });
  assert(warmer.getLifecycleState() === "disabled", "disabled config should enter disabled state");
  warmer.dispose();
}

// 11) Hard re-anchor logs the invalidation reason and both payload/cache identities.
{
  const cwd = mkdtempSync(join(tmpdir(), "pi-warm-cache-reanchor-"));
  const model = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as any;
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = {
    cwd,
    model,
    hasUI: false,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "reanchor-log-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  } as any;
  const warmer = new SessionWarmer({ getThinkingLevel: () => "off" } as any);
  const config = {
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    logToFile: true,
  };
  const oldPayload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "old prefix" }] }],
    prompt_cache_key: "reanchor-old-key",
  };
  const newPayload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "new prefix" }] }],
    prompt_cache_key: "reanchor-new-key",
  };

  warmer.bindContext(ctx);
  warmer.setConfig(config);
  warmer.capturePayload(oldPayload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  warmer.onAgentSettled(ctx);
  const oldPayloadFingerprint = stableFingerprint(oldPayload);
  warmer.invalidateAnchor(ctx, "compacted · waiting for next turn");
  warmer.capturePayload(newPayload, ctx);

  const events = readFileSync(join(cwd, ".pi", "warm-cache.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const transition = events.find((event) => event.event === "anchor_reanchored");
  assert(transition !== undefined, "fresh capture should log an anchor_reanchored transition");
  assert(transition?.reason === "compacted · waiting for next turn", "transition should preserve the reason");
  assert(
    transition?.oldPayloadFingerprint === oldPayloadFingerprint,
    "transition should log the dropped payload fingerprint",
  );
  assert(
    transition?.newPayloadFingerprint === stableFingerprint(newPayload),
    "transition should log the fresh payload fingerprint",
  );
  assert(
    typeof transition?.oldCacheKeyFingerprint === "string" &&
      transition.oldCacheKeyFingerprint !== "reanchor-old-key" &&
      typeof transition?.newCacheKeyFingerprint === "string" &&
      transition.newCacheKeyFingerprint !== "reanchor-new-key",
    "transition should log only redacted old and new cache-key fingerprints",
  );
  assert(warmer.getStatusText().includes("nextDue=none"), "re-anchor log capture must not retain the old timer");
  warmer.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

// 12) Disable/re-enable preserves "awaiting-reanchor" and "blocked" states
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
  warmer.capturePayload({ ...capturedPayload, prompt_cache_key: "rotated-xai-session" }, ctx);
  assert(
    warmer.getLatestRealTurnObservation()?.reason.includes("prompt_cache_key changed"),
    "xAI key changes should explain the hard re-anchor boundary",
  );
  assert(
    !warmer.getStatusText().includes("rotated-xai-session"),
    "xAI status must never expose the raw cache key",
  );
  warmer.capturePayload(capturedPayload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });

  const first = await warmer.warmNow(ctx);
  assert(first.family === "xai-best-effort", "xAI result should identify its strategy");
  assert(first.probeOutcome === "transient-miss", "first xAI miss should retry quietly");
  assert(first.cacheKeyFingerprint !== "none", "xAI result should expose cache-key identity");
  assert(first.cacheKeyFingerprint !== "xai-session", "xAI result must expose only a redacted key fingerprint");
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
  assert(
    notifications.some(
      (entry) =>
        entry.message.includes("xAI best-effort") &&
        entry.message.includes("failure budget") &&
        entry.message.includes("cache-write"),
    ),
    "repeated xAI no-read/no-write misses should explain the failure budget and missing write usage",
  );
  assert(warmer.getStatusText().includes("idle (no anchor)"), "xAI repeated misses should clear the replay payload");
  assert(warmer.getStatusText().includes("payload=none"), "xAI drift status should request a re-anchor");
  const xaiCallsBeforeWaitingProbe = calls.length;
  const xaiWaiting = await warmer.warmNow(ctx);
  assert(xaiWaiting.unavailable === true, "xAI drift must not probe before re-anchor");
  assert(calls.length === xaiCallsBeforeWaitingProbe, "xAI awaiting re-anchor must not call the provider");
  assert(notifications.some((entry) => entry.level === "warning"), "xAI re-anchor should be visible");
  warmer.dispose();
}

// 11a) Foreign-instrumentation refusal survives the prefix-change re-anchor
// path: a clean opencode-go completions turn followed by a turn carrying
// injected cache_control must keep the refusal on the new anchor, so /warm now
// refuses to replay the tampered body and never calls the provider.
{
  const notifications: Array<{ message: string; level: string }> = [];
  const calls: unknown[] = [];
  const completeStub = async (args: unknown): Promise<any> => {
    calls.push(args);
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    };
  };
  const goModel = {
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
  } as any;
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = {
    cwd: process.cwd(),
    model: goModel,
    hasUI: true,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "go-session" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "go-key", headers: {}, env: {} }),
    },
  } as any;
  const warmer = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  warmer.bindContext(ctx);
  warmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConsecutiveFailures: 3,
  });

  warmer.capturePayload(
    { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hello" }] },
    ctx,
  );
  assert(warmer.getLifecycleState() === "anchored", "a clean Go completions turn should anchor");

  // The rewriter injects cache_control into the next turn. The refusal must
  // survive the prefix-change re-anchor and disable the manual probe.
  warmer.capturePayload(
    {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "user",
          content: [{ type: "text", text: "injected", cache_control: { type: "ephemeral" } }],
        },
      ],
    },
    ctx,
  );
  const refusedCapability = warmer.getCapability();
  assert(
    refusedCapability.reason.includes("foreign instrumentation"),
    "the re-anchored capability must keep the refusal reason",
  );
  assert(
    !refusedCapability.manualProbe,
    "a cache_control-carrying completions turn must keep manualProbe disabled",
  );
  const refused = await warmer.warmNow(ctx);
  assert(refused.unavailable === true, "a refused Go completions payload must not probe");
  assert(
    refused.capabilityReason?.includes("cache_control"),
    "the refusal reason must be exposed on the /warm now result",
  );
  assert(calls.length === 0, "a refused Go completions payload must never reach the provider");
  warmer.dispose();
}

// 11b) The warmer call site passes getModelCompat through: an OpenCode Go
// completions probe on an uncapped captured body writes the declared
// maxTokensField (max_tokens), never the default max_completion_tokens.
{
  const notifications: Array<{ message: string; level: string }> = [];
  const responses = [
    {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
  ];
  const goModel = {
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    compat: { maxTokensField: "max_tokens" },
    cost: { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  } as any;
  assert(
    getModelCompat(goModel)?.maxTokensField === "max_tokens",
    "getModelCompat must expose the declared maxTokensField",
  );
  const calls: Array<{ options: any; payload: any }> = [];
  const completeStub = async (_model: any, _context: any, options: any): Promise<any> => {
    const payload = options.onPayload?.(
      structuredClone({ model: "deepseek-v4-flash", messages: [] }),
      goModel,
    );
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
    model: goModel,
    hasUI: true,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "go-session" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "go-key", headers: {}, env: {} }),
    },
  } as any;
  const warmer = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  warmer.bindContext(ctx);
  warmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConsecutiveFailures: 3,
  });

  const captured = {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hello" }],
  };
  warmer.capturePayload(captured, ctx);
  const result = await warmer.warmNow(ctx);
  assert(result.ok === true, "a manual probe on a clean Go completions payload should run");
  assert(calls.length === 1, "a manual probe must reach the provider");
  const shaped = calls[0]?.payload as Record<string, unknown>;
  assert(
    shaped.max_tokens === 1,
    "the probe must cap the declared maxTokensField (max_tokens)",
  );
  assert(
    !("max_completion_tokens" in shaped),
    "the probe must not write the default max_completion_tokens field",
  );
  assert(
    JSON.stringify(shaped.messages) === JSON.stringify(captured.messages),
    "the probe must preserve the exact captured prefix",
  );
  warmer.dispose();
}

// 11c) The retained family never probes end to end: /warm now on a payload
// carrying prompt_cache_retention "24h" is refused before any provider request,
// and the plan and the warmer agree because both derive manual gating from
// capability.manualProbe.
{
  let calls = 0;
  const goModel = {
    id: "qwen3.7-max",
    provider: "opencode-go",
    api: "anthropic-messages",
    baseUrl: "https://opencode.ai/zen/go",
  } as any;
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = {
    cwd: process.cwd(),
    model: goModel,
    hasUI: false,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "go-retained-session" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "go-key", headers: {}, env: {} }),
    },
  } as any;
  const completeStub = async (): Promise<any> => {
    calls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    };
  };
  const warmer = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  warmer.bindContext(ctx);
  warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, intervalMs: 60_000 });
  warmer.capturePayload(
    {
      model: "qwen3.7-max",
      prompt_cache_retention: "24h",
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
    },
    ctx,
  );
  const retainedCapability = warmer.getCapability();
  assert(
    retainedCapability.state === "unverified" && !retainedCapability.manualProbe,
    "the retained family must disable the manual probe while unverified",
  );
  const retainedPlan = (warmer as any).plan as { family: string; manualProbe: boolean };
  assert(
    retainedPlan.family === "opencode-go-retained" && retainedPlan.manualProbe === false,
    "the retained plan must agree that no manual probe is available",
  );
  const retainedResult = await warmer.warmNow(ctx);
  assert(retainedResult.unavailable === true, "retained must refuse /warm now");
  assert(
    String(retainedResult.error).includes("never probes"),
    "the retained refusal must explain that the family never probes",
  );
  assert(calls === 0, "retained must never reach the provider");
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
  const manualUiCalls: Array<{ kind: "status" | "widget"; value: unknown }> = [];
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: string) => notifications.push({ message, level }),
    setStatus: (_id: string, value: unknown) => manualUiCalls.push({ kind: "status", value }),
    setWidget: (_id: string, value: unknown) => manualUiCalls.push({ kind: "widget", value }),
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
    notifications.length === 0,
    "SessionWarmer must leave the manual-only warning to the /warm now command",
  );

  warmer.setConfig({ ...warmer.getConfig(), enabled: false });
  assert(
    manualUiCalls.at(-1)?.kind === "status" && manualUiCalls.at(-1)?.value === undefined &&
      manualUiCalls.at(-2)?.kind === "widget" && manualUiCalls.at(-2)?.value === undefined,
    "disabling a manual-only route must clear its widget and status",
  );
  warmer.dispose();
}

// 13) /warm now owns one manual-only warning and does not duplicate it.
{
  const notifications: Array<{ message: string; level: string }> = [];
  let warmHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    registerFlag: () => undefined,
    getFlag: () => "true",
    on: () => undefined,
    registerCommand: (_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      warmHandler = command.handler;
    },
  } as any;
  piWarmCache(pi);
  assert(warmHandler !== undefined, "warm command should be registered");
  const ctx = {
    model: {
      id: "grok-4.3",
      provider: "xai",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    },
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  } as any;
  await warmHandler!("now", ctx);
  assert(notifications.length === 1, "manual-only /warm now should emit exactly one warning");
  assert(notifications[0]!.level === "warning", "manual-only /warm now notice should be warning-level");
  assert(
    notifications[0]!.message.includes("automatic warming is disabled") &&
      notifications[0]!.message.includes("manual-only") &&
      notifications[0]!.message.includes("n/a (unverified route)"),
    "manual-only /warm now warning should include the complete UX guidance",
  );
}

// 14) Process-wide concurrency observability defers without sending an extra probe.
{
  const cwd = mkdtempSync(join(tmpdir(), "pi-warm-cache-concurrency-"));
  const model = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  } as any;
  let calls = 0;
  let releaseFirst: ((value: any) => void) | null = null;
  let signalFirstStarted: (() => void) | null = null;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const completeStub = async (): Promise<any> => {
    calls += 1;
    if (calls === 1) {
      signalFirstStarted?.();
      return new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
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
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const makeContext = (sessionId: string) =>
    ({
      cwd,
      model,
      hasUI: false,
      ui,
      thinkingLevel: "off",
      isIdle: () => true,
      sessionManager: { getSessionId: () => sessionId },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
      },
    }) as any;
  const payload = (sessionId: string) => ({
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "concurrency" }] }],
    prompt_cache_key: sessionId,
  });
  const warmerA = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  const warmerB = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  const ctxA = makeContext("concurrency-a");
  const ctxB = makeContext("concurrency-b");

  warmerA.bindContext(ctxA);
  warmerB.bindContext(ctxB);
  const config = {
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    maxConcurrentWarmSessions: 1,
    logToFile: true,
  };
  warmerA.setConfig(config);
  warmerB.setConfig(config);
  warmerA.capturePayload(payload("concurrency-a"), ctxA);
  warmerB.capturePayload(payload("concurrency-b"), ctxB);
  warmerA.noteAssistantUsage(ctxA, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  warmerB.noteAssistantUsage(ctxB, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });

  const firstPromise = warmerA.warmNow(ctxA);
  await firstStarted;
  assert(warmerA.getActiveWarmSessions() === 1, "first warmer should occupy the process-wide slot");
  assert(
    warmerA.getStatusText().includes("activeWarmSessions=1/1"),
    "status should expose the active process-wide warm session count",
  );

  const deferred = await warmerB.warmNow(ctxB);
  assert(deferred.deferred?.reason === "concurrency limit", "full gate should mark the probe deferred");
  assert(deferred.deferred?.activeWarmSessions === 1, "deferral should record the occupied slot count");
  assert(calls === 1, "a full concurrency gate must not call the provider");
  assert(warmerB.getDeferredProbe()?.reason === "concurrency limit", "status state should retain the deferral");
  const deferredStatus = warmerB.getStatusText();
  assert(
    deferredStatus.includes("activeWarmSessions=1/1") &&
      deferredStatus.includes("deferred=concurrency limit (1/1 slots used)"),
    "status should explain the full concurrency gate",
  );

  const events = readFileSync(join(cwd, ".pi", "warm-cache.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const gateEvent = events.find((event) => event.event === "warm_deferred" && event.reason === "concurrency limit");
  assert(gateEvent !== undefined, "concurrency deferral should emit a JSONL event");
  assert(gateEvent?.activeWarmSessions === 1, "JSONL deferral should record active warm sessions");
  assert(gateEvent?.maxConcurrentWarmSessions === 1, "JSONL deferral should record the configured limit");
  assert(gateEvent?.providerRequest === false, "deferred JSONL event must state that no provider request was sent");

  const release = releaseFirst as unknown as (value: any) => void;
  release({
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 100,
      cacheWrite: 0,
      cost: { total: 0.01 },
    },
  });
  const firstResult = await firstPromise;
  assert(firstResult.ok, "the first warmer should complete after its slot is released");
  assert(warmerA.getActiveWarmSessions() === 0, "the gate should release the slot after completion");

  const retry = await warmerB.warmNow(ctxB);
  assert(retry.ok && retry.deferred === undefined, "a deferred warmer should retry once a slot is free");
  assert(warmerB.getDeferredProbe() === null, "a probe that gets a slot should clear its deferral state");
  assert(Number(calls) === 2, "the retry should be the only provider call after the deferred tick");

  warmerA.dispose();
  warmerB.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

// 15) Agent-busy timer ticks retain an explicit deferral reason.
{
  const cwd = mkdtempSync(join(tmpdir(), "pi-warm-cache-busy-"));
  const model = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as any;
  let calls = 0;
  const completeStub = async (): Promise<any> => {
    calls += 1;
    return { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0 } };
  };
  const ctx = {
    cwd,
    model,
    hasUI: false,
    ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: () => undefined, setWidget: () => undefined },
    thinkingLevel: "off",
    isIdle: () => false,
    sessionManager: { getSessionId: () => "busy-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  } as any;
  const warmer = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  warmer.bindContext(ctx);
  warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, intervalMs: 60_000, logToFile: true });
  warmer.capturePayload(
    {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "busy" }] }],
      prompt_cache_key: "busy-test",
    },
    ctx,
  );
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });

  const result = await (warmer as any).runWarm("timer");
  assert(result.deferred?.reason === "agent busy", "a busy timer tick should be marked deferred");
  assert(calls === 0, "a busy timer tick must not call the provider");
  assert(warmer.getStatusText().includes("deferred=agent busy"), "status should expose the busy deferral reason");
  warmer.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

// 16) UI surfaces stay concise, distinguish re-anchoring, and hide the widget cleanly.
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

  renderWaitingUi(
    ctx,
    { ...DEFAULT_CONFIG, showWidget: true },
    anchor,
    plan,
    Date.now() + 180_000,
    {
      reason: "concurrency limit",
      activeWarmSessions: 2,
      maxConcurrentWarmSessions: 3,
      deferredAt: Date.now(),
    },
  );
  const deferredWidget = calls.filter((call) => call.kind === "widget").at(-1)?.value;
  const deferredStatus = String(calls.filter((call) => call.kind === "status").at(-1)?.value);
  assert(
    Array.isArray(deferredWidget) &&
      deferredWidget.some((line) => String(line).includes("deferred - 2/3 slots used")),
    "waiting widget should show the gate deferral and occupied slots",
  );
  assert(
    deferredStatus.includes("deferred · concurrency limit (2/3 slots used)"),
    "waiting status should show the gate deferral and occupied slots",
  );

  const xaiCalls: Array<{ kind: "widget" | "status"; value: unknown }> = [];
  const xaiCtx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value: unknown) => xaiCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value: unknown) => xaiCalls.push({ kind: "status", value }),
    },
  } as any;
  const xaiAnchor = { ...anchor, capability: { state: "verified" } } as any;
  const xaiPlan = {
    ...plan,
    family: "xai-best-effort",
    ttlLabel: "xAI best-effort probe cadence",
  } as any;
  renderWaitingUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, xaiAnchor, xaiPlan, Date.now() + 180_000);
  renderWarmHitUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, xaiAnchor, xaiPlan, 128_000);
  renderReanchorUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "prompt_cache_key changed", true);
  renderProbeRetryUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "read=0 write=0", undefined, true);
  renderFailureUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "probe miss", "read=0 write=0", undefined, true);
  renderIdleUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "prefix too small", undefined, true);
  const xaiUiText = xaiCalls
    .flatMap((call) => (Array.isArray(call.value) ? call.value : [String(call.value)]))
    .map(String)
    .join(" ");
  assert(xaiUiText.includes("xAI best-effort"), "xAI UI should label the best-effort policy");
  assert(!xaiUiText.includes("xAI best-effort cache warm · xAI best-effort extension probe hit"), "xAI hit UI should avoid redundant policy labels");

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
  const manualWidget = capabilityCalls.filter((call) => call.kind === "widget").at(-1)?.value;
  const manualStatus = capabilityCalls.filter((call) => call.kind === "status").at(-1)?.value;
  assert(
    Array.isArray(manualWidget) &&
      manualWidget.some((line) => String(line).includes("MANUAL ONLY")),
    "manual-only capability should show a warning widget badge",
  );
  assert(
    String(manualStatus).includes("manual only"),
    "manual-only capability should show a warning status badge",
  );
  renderManualOnlyUi(
    capabilityCtx,
    { ...DEFAULT_CONFIG, showWidget: true },
    {
      state: "unverified",
      reason: "OpenRouter route is explicitly registered for manual-only probing",
      automaticWarm: false,
      manualProbe: true,
    },
    true,
  );
  assert(
    String(capabilityCalls.filter((call) => call.kind === "status").at(-1)?.value).includes(
      "/warm now ready",
    ),
    "manual-only status should identify a ready one-shot probe",
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
