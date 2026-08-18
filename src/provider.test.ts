/**
 * Lightweight assertions (no test runner required).
 * Prefer: node scripts/run-unit-tests.mjs
 * Direct: node --experimental-strip-types src/provider.test.ts
 *
 * Do not launch this in the same parallel batch as an edit of this file.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendWarmUserTurn,
  applyWarmOutputLimit,
  applyXaiWarmOutputLimit,
  bestEffortFamilyLabel,
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
  isBestEffortNoWriteFamily,
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
  payloadObject,
  PROXY_ROUTE_REGISTRY,
  supportsManualProbe,
  XAI_BEST_EFFORT_INTERVAL_MS,
  resolveCacheFamily,
  resolveCacheRetention,
  resolveMaxIdleWarmMs,
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
import { parseConfigArgs } from "./config.ts";
import piWarmCache from "./index.ts";
import { resetProbeSpendLedgerForTest, SessionWarmer } from "./warmer.ts";
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
import { resolveWarmNowFailure } from "./index.ts";
import {
  DEFAULT_CONFIG,
  type CacheAnchor,
  type ProviderCapability,
  type StrategyPlan,
  type WarmResult,
} from "./types.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WarmComplete = NonNullable<ConstructorParameters<typeof SessionWarmer>[1]>;
type NotifyLevel = "info" | "warning" | "error";
type WarmCompleteContext = {
  systemPrompt?: string;
};
type ProbeRequestOptions = {
  sessionId?: string;
  cacheRetention?: string;
  onPayload?: <Payload>(payload: Payload, model: Model<any>) => Payload;
};

function assert<Condition>(cond: Condition, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function modelFixture<Fixture>(model: Fixture): Model<any> {
  // SAFETY: Route tests intentionally provide only fields read by the capability under test.
  return model as Model<any>;
}

function extensionApiFixture<Fixture>(api: Fixture): ExtensionAPI {
  // SAFETY: Warmer tests provide only getThinkingLevel, which SessionWarmer reads.
  return api as ExtensionAPI;
}

function contextFixture<Fixture>(ctx: Fixture): ExtensionContext {
  // SAFETY: Warmer tests provide only the context fields SessionWarmer reads.
  return ctx as ExtensionContext;
}

function completeFixture<Fn>(fn: Fn): WarmComplete {
  // SAFETY: Warmer tests return only the complete() fields SessionWarmer reads.
  return fn as WarmComplete;
}

function cacheAnchorFixture<Fixture>(anchor: Fixture): CacheAnchor {
  // SAFETY: UI tests provide only the anchor fields the renderer reads.
  return anchor as CacheAnchor;
}

function strategyPlanFixture<Fixture>(plan: Fixture): StrategyPlan {
  // SAFETY: UI tests provide only the plan fields the renderer reads.
  return plan as StrategyPlan;
}

function timerWarmerFixture<Warmer>(warmer: Warmer): {
  runWarm: (reason: "timer") => Promise<WarmResult>;
  clearTimers: () => void;
  anchor: { lastRealTurnAt: number } | null;
} {
  // SAFETY: Idle-cutoff and spend tests drive the private timer clock and fire path.
  return warmer as {
    runWarm: (reason: "timer") => Promise<WarmResult>;
    clearTimers: () => void;
    anchor: { lastRealTurnAt: number } | null;
  };
}

function runTimerWarm(warmer: SessionWarmer): Promise<WarmResult> {
  return timerWarmerFixture(warmer).runWarm("timer");
}

function clearWarmerTimers(warmer: SessionWarmer): void {
  timerWarmerFixture(warmer).clearTimers();
}

function setLastRealTurnAt(warmer: SessionWarmer, at: number): void {
  const anchor = timerWarmerFixture(warmer).anchor;
  assert(anchor !== null, "expected an anchor before shifting idle time");
  anchor.lastRealTurnAt = at;
}

type ProbeReply = {
  stopReason: "stop";
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total: number };
  };
};

type FirstProbeHooks = {
  release?: (value: ProbeReply) => void;
  started?: () => void;
};

function logNumber<Value>(value: Value): number | null {
  if (value !== Object(value) && Object.prototype.toString.call(value) === "[object Number]" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function deferredLog(line: string): {
  reason: string | null;
  activeWarmSessions: number | null;
  maxConcurrentWarmSessions: number | null;
  providerRequest: boolean | null;
} | null {
  const body = payloadObject(JSON.parse(line));
  if (!body || body.event !== "warm_deferred") return null;
  return {
    reason: logString(body.reason),
    activeWarmSessions: logNumber(body.activeWarmSessions),
    maxConcurrentWarmSessions: logNumber(body.maxConcurrentWarmSessions),
    providerRequest: body.providerRequest === true ? true : body.providerRequest === false ? false : null,
  };
}

function nextDueAtMs(status: string): number | null {
  const match = /(?:^|\s)nextDue=(\S+)/.exec(status);
  if (!match || match[1] === "none") return null;
  const due = Date.parse(match[1]);
  return Number.isFinite(due) ? due : null;
}

function logString<Value>(value: Value): string | null {
  if (value !== Object(value) && Object.prototype.toString.call(value) === "[object String]") {
    return String(value);
  }
  return null;
}

function reanchorLog(line: string): {
  reason: string | null;
  oldPayloadFingerprint: string | null;
  newPayloadFingerprint: string | null;
  oldCacheKeyFingerprint: string | null;
  newCacheKeyFingerprint: string | null;
} | null {
  const body = payloadObject(JSON.parse(line));
  if (!body || body.event !== "anchor_reanchored") return null;
  return {
    reason: logString(body.reason),
    oldPayloadFingerprint: logString(body.oldPayloadFingerprint),
    newPayloadFingerprint: logString(body.newPayloadFingerprint),
    oldCacheKeyFingerprint: logString(body.oldCacheKeyFingerprint),
    newCacheKeyFingerprint: logString(body.newCacheKeyFingerprint),
  };
}

function deepEqualExcept<Actual, Expected>(
  actual: Actual,
  expected: Expected,
  allowed: Set<string>,
  path = "",
): void {
  if (Object.is(actual, expected)) return;
  if (Object.prototype.toString.call(actual) !== Object.prototype.toString.call(expected)) {
    throw new Error(`type mismatch at ${path}`);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      throw new Error(`array mismatch at ${path}`);
    }
    for (let i = 0; i < actual.length; i++) {
      deepEqualExcept(actual[i], expected[i], allowed, `${path}[${i}]`);
    }
    return;
  }
  const actualObject = payloadObject(actual);
  const expectedObject = payloadObject(expected);
  if (!actualObject || !expectedObject) {
    throw new Error(`value mismatch at ${path}: ${String(actual)} !== ${String(expected)}`);
  }
  const keys = new Set([...Object.keys(actualObject), ...Object.keys(expectedObject)]);
  for (const key of keys) {
    if (path === "" && allowed.has(key)) continue;
    deepEqualExcept(
      actualObject[key],
      expectedObject[key],
      allowed,
      path ? `${path}.${key}` : key,
    );
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
  const out = applyWarmOutputLimit(cloned, 1);

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
  const out = applyWarmOutputLimit(structuredClone(original), 1, "openai-responses");
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
  const out = applyXaiWarmOutputLimit(structuredClone(original), 1);
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
  const out = applyWarmOutputLimit(structuredClone(original), 1, "openai-codex-responses");
  assert(!("max_output_tokens" in out), "codex must not receive max_output_tokens");
  assert(!("max_tokens" in out), "codex must not receive max_tokens");
  assert(out.reasoning.effort === "xhigh", "codex effort must stay identical");
  assert(out.tool_choice === "auto", "codex tool_choice must stay identical");
  assert(out.instructions === original.instructions, "instructions must stay identical");
  assert(JSON.stringify(out.tools) === JSON.stringify(original.tools), "tools must stay identical");
  assert(isCodexPayload(original), "fixture should look like codex");

  const withTurn = appendWarmUserTurn(
    structuredClone(original),
    "Reply OK only",
    "openai-codex-responses",
  );
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
  const declared = payloadObject(applyWarmOutputLimit(
    structuredClone(uncapped),
    8,
    "openai-completions",
    { maxTokensField: "max_tokens" },
  ));
  assert(declared, "declared completions result must remain an object");
  assert(
    declared.max_tokens === 8,
    "uncapped completions must write the declared maxTokensField",
  );
  assert(
    !("max_completion_tokens" in declared),
    "must not write the default field when maxTokensField is declared",
  );

  const defaulted = payloadObject(applyWarmOutputLimit(
    structuredClone(uncapped),
    8,
    "openai-completions",
  ));
  assert(defaulted, "default completions result must remain an object");
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
  );
  assert(cappedOut.max_tokens === 8, "an existing declared cap field is capped in place");
  deepEqualExcept(cappedOriginal, cappedOut, WARM_MUTABLE_PAYLOAD_KEYS);

  // The Anthropic and Responses fallbacks stay unchanged when compat is passed.
  const anthropicUncapped = {
    model: "claude-fable-5",
    messages: [{ role: "user", content: "hi" }],
  };
  const anthropicOut = payloadObject(applyWarmOutputLimit(
    structuredClone(anthropicUncapped),
    8,
    "anthropic-messages",
    { maxTokensField: "max_tokens" },
  ));
  assert(anthropicOut, "Anthropic result must remain an object");
  assert(anthropicOut.max_tokens === 8, "the Anthropic fallback keeps writing max_tokens");

  const responsesUncapped = { model: "gpt-5.6", input: [{ role: "user", content: "hi" }] };
  const responsesOut = payloadObject(applyWarmOutputLimit(
    structuredClone(responsesUncapped),
    8,
    "openai-responses",
    { maxTokensField: "max_tokens" },
  ));
  assert(responsesOut, "Responses result must remain an object");
  assert(
    responsesOut.max_output_tokens === OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
    "the Responses fallback keeps writing max_output_tokens at its legal floor",
  );
}

// 3) Strategy intervals stay inside TTL.
{
  const anthropic = modelFixture({
    id: "claude-fable-5",
    provider: "anthropic",
    api: "anthropic-messages",
  });
  const assertReasoned = (capability: ProviderCapability, label: string): void => {
    assert(capability.reason.length > 0, `${label} needs a reason`);
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

  const noLong = modelFixture({
    id: "proxy-model",
    provider: "anthropic",
    api: "anthropic-messages",
    compat: { supportsLongCacheRetention: false },
  });
  assert(modelSupportsLongCacheRetention(noLong) === false, "explicit false disables long");

  const wrongAnthropicEndpoint = modelFixture({
    ...anthropic,
    baseUrl: "https://anthropic-proxy.example/v1",
  });
  const wrongAnthropicCapability = resolveProviderCapability(wrongAnthropicEndpoint);
  assert(wrongAnthropicCapability.state === "unsupported", "wrong Anthropic endpoint must fail closed");
  assert(
    wrongAnthropicCapability.reason.includes("baseUrl is not api.anthropic.com"),
    "Anthropic endpoint rejection must identify the incorrect baseUrl",
  );

  const openaiExplicit = modelFixture({
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    compat: { supportsExplicitPromptCacheMode: true },
  });
  const oaiCapability = resolveProviderCapability(openaiExplicit);
  assert(oaiCapability.state === "verified", "first-party OpenAI should be verified");
  assertReasoned(oaiCapability, "first-party OpenAI capability");
  const anthropicCompat = modelFixture({
    id: "claude-compatible",
    provider: "proxy-anthropic",
    api: "anthropic-messages",
    compat: { cacheControlFormat: "anthropic" },
  });
  const anthropicCompatCapability = resolveProviderCapability(anthropicCompat);
  assert(anthropicCompatCapability.state === "verified", "registered Anthropic-compatible route should be verified");
  assertReasoned(anthropicCompatCapability, "Anthropic-compatible capability");
  const azure = modelFixture({
    id: "azure-gpt",
    provider: "azure-openai-responses",
    api: "azure-openai-responses",
  });
  assert(resolveProviderCapability(azure).state === "verified", "registered Azure route should be verified");
  const codex = modelFixture({
    id: "gpt-5.6",
    provider: "openai-codex",
    api: "openai-codex-responses",
  });
  assert(resolveProviderCapability(codex).state === "verified", "registered Codex route should be verified");
  const oai = resolveStrategy(openaiExplicit, DEFAULT_CONFIG);
  assert(oai.family === "openai-explicit", "compat flag selects explicit 30m family");
  const openAiInterval = oai.intervalMs;
  assert(openAiInterval !== null, "OpenAI strategy must have an interval");
  assert(openAiInterval < 30 * 60_000, "openai interval inside 30m");

  const openaiOld = modelFixture({
    id: "o3",
    provider: "openai",
    api: "openai-responses",
  });
  const old = resolveStrategy(openaiOld, DEFAULT_CONFIG);
  assert(old.family === "openai-implicit", "without compat flag, OpenAI stays implicit");
  const wrongOpenAi = modelFixture({
    ...openaiOld,
    baseUrl: "https://openai-proxy.example/v1",
  });
  const wrongOpenAiCapability = resolveProviderCapability(wrongOpenAi);
  assert(wrongOpenAiCapability.state === "unsupported", "wrong OpenAI endpoint must fail closed");
  assert(
    wrongOpenAiCapability.reason.includes("baseUrl is not api.openai.com"),
    "OpenAI endpoint rejection must identify the incorrect baseUrl",
  );

  const directXai = modelFixture({
    id: "grok-4.5",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    compat: { sessionAffinityFormat: "openai", supportsLongCacheRetention: false },
  });
  const xaiCapability = resolveProviderCapability(directXai);
  assert(xaiCapability.state === "verified", "direct xAI Grok 4.5 should be verified");
  assert(xaiCapability.automaticWarm, "verified xAI should allow automatic warming");
  assert(!xaiCapability.manualProbe, "verified xAI does not need an unverified probe escape hatch");
  const insecureXai = modelFixture({ ...directXai, baseUrl: "http://api.x.ai/v1" });
  const insecureCapability = resolveProviderCapability(insecureXai);
  assert(insecureCapability.state === "unsupported", "HTTP xAI routes must not receive first-party capability");
  assert(
    insecureCapability.reason.includes("baseUrl is not api.x.ai"),
    "xAI endpoint rejection must identify the incorrect baseUrl",
  );
  const missingBaseUrl = modelFixture({ ...directXai, baseUrl: undefined });
  assert(
    resolveProviderCapability(missingBaseUrl).state === "unsupported",
    "xAI routes without endpoint metadata must fail closed",
  );
  const wrongRouting = modelFixture({
    ...directXai,
    compat: { sessionAffinityFormat: "openrouter" },
  });
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
  assert(!isStablePromptCacheKey(Object("session-id")), "boxed strings must not qualify as stable");
  assert(!hasXaiPromptCacheKey({ ...xaiPayload, prompt_cache_key: "   " }), "blank xAI key must be rejected");
  assert(!hasXaiPromptCacheKey({ ...xaiPayload, prompt_cache_key: "xai\nkey" }), "control characters must be rejected");
  assert(!hasXaiPromptCacheKey({ ...xaiPayload, prompt_cache_key: "key\u009Bvalue" }), "C1 control characters (U+0080-U+009F) must be rejected");
  assert(getPromptCacheKey(xaiPayload, "anthropic-messages") === null, "wrong API must not expose a cache key");
  const callablePayload = Object.assign(() => undefined, { prompt_cache_key: "callable" });
  assert(
    getPromptCacheKey(callablePayload, directXai.api) === null,
    "callable values must not qualify as payload objects",
  );
  assert(!canManualProbe(directXai, xaiPayload), "verified xAI should not use the unverified probe path");
  assert(
    isSafeReplayPayload(
      {
        instructions: "Keep this multi-line system prompt.\nPreserve its whitespace.",
        input: [],
        store: false,
        prompt_cache_key: "codex-session-1",
      },
      "openai-codex-responses",
    ),
    "multi-line Codex instructions must remain safe to replay",
  );
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
  const otherXai = modelFixture({ ...directXai, id: "grok-4.3" });
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

  const openRouterXai = modelFixture({
    id: "x-ai/grok-4.5",
    provider: "openrouter",
    api: "openai-responses",
    baseUrl: "https://openrouter.ai/api/v1",
    compat: { sessionAffinityFormat: "openrouter" },
  });
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

  const openRouterWrongEndpoint = modelFixture({
    ...openRouterXai,
    baseUrl: "https://openrouter-proxy.example/v1",
  });
  assert(
    resolveProviderCapability(openRouterWrongEndpoint).state === "unsupported",
    "OpenRouter routes with a different endpoint must fail closed",
  );
  const openRouterWrongPath = modelFixture({
    ...openRouterXai,
    baseUrl: "https://openrouter.ai/api/v2",
  });
  assert(
    resolveProviderCapability(openRouterWrongPath).state === "unsupported",
    "OpenRouter routes on an unregistered path must fail closed (exact-path matching)",
  );
  const openRouterWrongRouting = modelFixture({
    ...openRouterXai,
    compat: { sessionAffinityFormat: "openai" },
  });
  assert(
    resolveProviderCapability(openRouterWrongRouting).state === "unsupported",
    "OpenRouter routes with non-OpenRouter routing metadata must fail closed",
  );

  const openRouterMissingMetadata = modelFixture({
    id: "x-ai/grok-4.5",
    provider: "openrouter",
    api: "openai-responses",
    baseUrl: "https://openrouter.ai/api/v1",
  });
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
    type GoModelRegistry = Record<string, Record<string, Model<any>>>;
    const registry: GoModelRegistry = JSON.parse(readFileSync(registryPath, "utf8"));
    const goModels: Model<any>[] = [];
    for (const [api, modelsById] of Object.entries(registry)) {
      for (const model of Object.values(modelsById)) {
        goModels.push(modelFixture({ ...model, api }));
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
      if (model.api === "anthropic-messages") {
        // (anthropic-messages, plain-fallback) has no e2e evidence record and
        // stays unverified with the degraded retention hint.
        assert(
          capability.state === "unverified",
          `opencode-go ${model.api}/${model.id} should stay unverified (plain-fallback), got ${capability.state}`,
        );
        assert(!capability.automaticWarm, `opencode-go ${model.id} must never auto-warm`);
        assert(capability.manualProbe, `opencode-go ${model.id} should permit manual probes`);
        assert(
          capability.reason.includes("manual-only") &&
            capability.reason.includes("savings are n/a"),
          `opencode-go ${model.id} reason must explain the safety and savings limits`,
        );
      } else if (model.api === "openai-completions") {
        // (openai-completions, plain) is verified as no-keepalive: the e2e
        // control showed the native completions cache TTL exceeds 130 min,
        // so the timer adds no measurable benefit within the envelope.
        assert(
          capability.state === "verified",
          `opencode-go ${model.api}/${model.id} should resolve verified (completions plain), got ${capability.state}`,
        );
        assert(
          !capability.automaticWarm,
          `opencode-go ${model.id} verified no-keepalive must not auto-warm`,
        );
        assert(
          !capability.manualProbe,
          `opencode-go ${model.id} verified routes do not use the unverified manual-probe flag`,
        );
        assert(
          capability.reason.includes("verified") &&
            capability.reason.includes("keepalive is not needed"),
          `opencode-go ${model.id} reason must state the verified no-keepalive claim`,
        );
      } else {
        // (openai-responses, plain) is verified with probing at ~4m cadence.
        assert(
          capability.state === "verified",
          `opencode-go ${model.api}/${model.id} should resolve verified (responses plain), got ${capability.state}`,
        );
        assert(
          capability.automaticWarm,
          `opencode-go ${model.id} verified responses route should auto-warm`,
        );
        assert(
          !capability.manualProbe,
          `opencode-go ${model.id} verified routes do not use the unverified manual-probe flag`,
        );
        assert(
          capability.reason.includes("verified"),
          `opencode-go ${model.id} reason must state the verified claim`,
        );
      }
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
    const goGrok = modelFixture({
      id: "grok-4.5",
      provider: "opencode-go",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { sessionAffinityFormat: "openai-nosession" },
    });
    assert(
      resolveProviderCapability(goGrok).state === "verified",
      "the responses model must resolve verified through its registered path",
    );
    const goGrokTrailingSlash = modelFixture({ ...goGrok, baseUrl: "https://opencode.ai/zen/go/v1/" });
    assert(
      resolveProviderCapability(goGrokTrailingSlash).state === "verified",
      "a trailing slash must normalize to the registered path",
    );
    const goGrokExtraPath = modelFixture({ ...goGrok, baseUrl: "https://opencode.ai/zen/go/v1/extra" });
    assert(
      resolveProviderCapability(goGrokExtraPath).state === "unsupported",
      "a longer path must not match via prefix semantics",
    );

    // Wrong-path fixtures: each (provider, api) pair has exactly one path.
    // /zen/go is a prefix of /zen/go/v1 and must not match the wrong transport.
    const goAnthropicOnCompletionsPath = modelFixture({
      id: "minimax-m3",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    assert(
      resolveProviderCapability(goAnthropicOnCompletionsPath).state === "unsupported",
      "an anthropic model on the completions path must fail closed",
    );
    const goCompletionsOnAnthropicPath = modelFixture({
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go",
    });
    assert(
      resolveProviderCapability(goCompletionsOnAnthropicPath).state === "unsupported",
      "a completions model on the anthropic path must fail closed",
    );

    // Wrong-api fixture: an unregistered OpenCode Go transport fails closed.
    const goWrongApi = modelFixture({
      id: "grok-4.5",
      provider: "opencode-go",
      api: "openai-codex-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
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
    const goAnthropicCompat = modelFixture({
      id: "qwen3.7-max",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      compat: { cacheControlFormat: "anthropic" },
    });
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
    const goAnthropicNoCompat = modelFixture({
      id: "qwen3.7-plus",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
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
    const goCompletions = modelFixture({
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    const goCompletionsClean = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    };
    // A clean completions payload is verified as no-keepalive: capability and
    // plan agree that no timer arms. Verified routes do not need the
    // unverified manual-probe escape hatch; /warm now is the probe path.
    const cleanCompletionsCapability = resolveProviderCapability(goCompletions, goCompletionsClean);
    assert(
      cleanCompletionsCapability.state === "verified" &&
        !cleanCompletionsCapability.automaticWarm &&
        !cleanCompletionsCapability.manualProbe,
      "a clean completions payload must resolve verified-no-keepalive",
    );
    const cleanCompletionsStrategy = resolveStrategy(
      goCompletions,
      DEFAULT_CONFIG,
      goCompletionsClean,
    );
    assert(
      cleanCompletionsStrategy.family === "opencode-go-plain" &&
        cleanCompletionsStrategy.intervalMs === null &&
        !cleanCompletionsStrategy.automaticWarm &&
        !cleanCompletionsStrategy.manualProbe,
      "the verified completions-plain plan must agree with the capability: no timer",
    );
    assert(
      !canManualProbe(goCompletions, goCompletionsClean),
      "verified routes do not use the unverified manual-probe escape hatch; /warm now is the probe path",
    );
    assert(
      !supportsManualProbe(goCompletions),
      "supportsManualProbe is the unverified-route escape hatch only",
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
    const goCompletionsAnthropicCompat = modelFixture({
      id: "future-completions-model",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { cacheControlFormat: "anthropic" },
    });
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
    const goGlm = modelFixture({
      id: "glm-5.1",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { maxTokensField: "max_tokens" },
    });
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
    const goAnthropicMarkers = modelFixture({
      id: "qwen3.7-max",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
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
    const goAnthropicFamilyModel = modelFixture({
      id: "qwen3.7-max",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
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
    // automatic warming. The promotion is per (api, family): retained is
    // verified only on the two OpenAI transports (which carry a registry
    // evidence pointer); the anthropic-messages transport has no retained
    // evidence record, so an anthropic retained payload stays unverified
    // while still never probing.

    // Positive case: (openai-completions, retained) is verified no-probe.
    const goRetainedCompletionsModel = modelFixture({
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    const retainedCompletionsCapability = resolveProviderCapability(
      goRetainedCompletionsModel,
      { model: "deepseek-v4-flash", prompt_cache_retention: "24h", messages: [] },
    );
    assert(
      retainedCompletionsCapability.state === "verified" &&
        !retainedCompletionsCapability.automaticWarm,
      "the completions retained family must resolve verified-no-probe",
    );
    assert(
      !retainedCompletionsCapability.manualProbe,
      "the retained family must disable the manual probe even while verified",
    );
    const retainedStrategy = resolveStrategy(goRetainedCompletionsModel, DEFAULT_CONFIG, {
      model: "deepseek-v4-flash",
      prompt_cache_retention: "24h",
      messages: [],
    });
    assert(
      retainedStrategy.family === "opencode-go-retained",
      "a retained payload must resolve the retained family",
    );
    assert(retainedStrategy.intervalMs === null, "retained must never schedule a probe");
    assert(!retainedStrategy.automaticWarm, "retained must never auto-warm");
    assert(
      retainedStrategy.ttlLabel.includes("keepalive not needed"),
      "retained label must state that keepalive is not needed",
    );
    assert(
      retainedStrategy.manualProbe === false,
      "the retained strategy must not permit a manual probe",
    );

    // Negative case: (anthropic-messages, retained) is not promoted because
    // no evidence record exists for it; the family still never probes.
    const anthropicRetainedCapability = resolveProviderCapability(goAnthropicFamilyModel, {
      model: "qwen3.7-max",
      prompt_cache_retention: "24h",
      messages: [],
      system: [],
    });
    assert(
      anthropicRetainedCapability.state === "unverified" &&
        !anthropicRetainedCapability.automaticWarm,
      "the anthropic retained pair must stay unverified (no evidence record)",
    );
    assert(
      !anthropicRetainedCapability.manualProbe,
      "the retained family must disable the manual probe on every transport",
    );
    assert(
      anthropicRetainedCapability.reason.includes("no recorded retained evidence"),
      "the anthropic retained reason must explain why the pair is not promoted",
    );
    assert(
      !supportsManualProbe(goAnthropicFamilyModel, {
        model: "qwen3.7-max",
        prompt_cache_retention: "24h",
        messages: [],
        system: [],
      }),
      "supportsManualProbe must refuse an anthropic retained payload",
    );

    // Negative case: (openai-responses, retained) is also not promoted,
    // because retained-wire.md measured the completions transport only.
    const goResponsesRetainedModel = modelFixture({
      id: "grok-4.5",
      provider: "opencode-go",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    const responsesRetainedCapability = resolveProviderCapability(goResponsesRetainedModel, {
      model: "grok-4.5",
      prompt_cache_retention: "24h",
      input: [],
    });
    assert(
      responsesRetainedCapability.state === "unverified" &&
        !responsesRetainedCapability.automaticWarm &&
        !responsesRetainedCapability.manualProbe,
      "the responses retained pair must stay unverified (no responses-transport evidence)",
    );
    assert(
      responsesRetainedCapability.reason.includes("openai-responses") &&
        responsesRetainedCapability.reason.includes("no recorded retained evidence"),
      "the responses retained reason must name the transport and the missing evidence",
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
    // (anthropic-messages, short-marker) is verified by e2e evidence, so the
    // strategy arms the ~4m best-effort cadence.
    assert(
      shortMarkerStrategy.intervalMs === 4 * 60_000,
      "verified short-marker must arm the ~4m best-effort cadence",
    );
    assert(
      shortMarkerStrategy.automaticWarm,
      "verified short-marker must auto-warm",
    );
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

  // Slice 8: promoted (api, family) pairs. The per-pair verification flips
  // the auditable registry entries (evidence pointer + date); the resolved
  // capability and the plan must stay in agreement with those entries.
  {
    const goAnthropicFamilyModel = modelFixture({
      id: "qwen3.7-max",
      provider: "opencode-go",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });

    // (anthropic-messages, short-marker) is verified with probing at ~4m.
    const shortMarkerCapability = resolveProviderCapability(goAnthropicFamilyModel, {
      model: "qwen3.7-max",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
      system: [],
    });
    assert(
      shortMarkerCapability.state === "verified" &&
        shortMarkerCapability.automaticWarm &&
        !shortMarkerCapability.manualProbe,
      "verified short-marker must auto-warm with no unverified manual-probe flag",
    );
    assert(
      shortMarkerCapability.reason.includes("four-part pass"),
      "the verified short-marker reason must cite the e2e verdict",
    );

    // (openai-responses, plain) is verified, and the automatic-eligibility
    // key gate still blocks an unkeyed payload at the plan level.
    const goResponsesModel = modelFixture({
      id: "grok-4.5",
      provider: "opencode-go",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    const unkeyedResponses = { model: "grok-4.5", input: [{ role: "user", content: "hi" }] };
    const keyedResponses = {
      model: "grok-4.5",
      input: [{ role: "user", content: "hi" }],
      prompt_cache_key: "go-session-1",
    };
    const responsesCapability = resolveProviderCapability(goResponsesModel, keyedResponses);
    assert(
      responsesCapability.state === "verified" && responsesCapability.automaticWarm,
      "verified responses-plain must auto-warm",
    );
    const keyedResponsesStrategy = resolveStrategy(goResponsesModel, DEFAULT_CONFIG, keyedResponses);
    assert(
      keyedResponsesStrategy.intervalMs === 4 * 60_000 && keyedResponsesStrategy.automaticWarm,
      "a keyed responses payload must arm the ~4m cadence",
    );
    const unkeyedResponsesStrategy = resolveStrategy(
      goResponsesModel,
      DEFAULT_CONFIG,
      unkeyedResponses,
    );
    assert(
      unkeyedResponsesStrategy.intervalMs === null && !unkeyedResponsesStrategy.automaticWarm,
      "the responses key gate must still block an unkeyed payload",
    );

    // (openai-completions, plain) is verified as no-keepalive: capability and
    // plan agree that no timer arms, and the manual /warm now probe path is
    // covered by the end-to-end block 11d below.
    const goCompletionsModel = modelFixture({
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    const completionsCapability = resolveProviderCapability(goCompletionsModel, {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    assert(
      completionsCapability.state === "verified" &&
        !completionsCapability.automaticWarm &&
        !completionsCapability.manualProbe,
      "verified completions-plain must be no-keepalive with no unverified manual-probe flag",
    );
    assert(
      completionsCapability.reason.includes("part 4 not satisfied"),
      "the verified completions-plain reason must state part 4 honestly",
    );
    const completionsStrategy = resolveStrategy(goCompletionsModel, DEFAULT_CONFIG, {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    assert(
      completionsStrategy.intervalMs === null &&
        !completionsStrategy.automaticWarm &&
        completionsStrategy.manualProbe === false,
      "the verified completions-plain plan must agree with the capability: no timer",
    );

    // Registry agreement audit: iterate the auditable registry itself. Every
    // entry's resolved capability state must match the entry, and every
    // verified entry must carry an evidence pointer. The key-to-family map and
    // the payload/model helpers are test-local; the registry entries are the
    // single source of truth.
    const keyToFamily = new Map([
      ["short-marker", "opencode-go-short-marker"],
      ["long-marker", "opencode-go-long-marker"],
      ["plain-fallback", "opencode-go-plain"],
      ["plain", "opencode-go-plain"],
      ["retained", "opencode-go-retained"],
    ]);
    const pairPayload = (api: string, family: string) => {
      if (family === "opencode-go-retained") {
        return api === "openai-responses"
          ? { model: "grok-4.5", input: [], prompt_cache_retention: "24h" }
          : { model: "deepseek-v4-flash", messages: [], prompt_cache_retention: "24h" };
      }
      if (family === "opencode-go-short-marker" || family === "opencode-go-long-marker") {
        return {
          model: "qwen3.7-max",
          system: [],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "hi",
                  cache_control:
                    family === "opencode-go-long-marker"
                      ? { type: "ephemeral", ttl: "1h" }
                      : { type: "ephemeral" },
                },
              ],
            },
          ],
        };
      }
      return api === "openai-responses"
        ? { model: "grok-4.5", input: [], prompt_cache_key: "go-session-1" }
        : { model: "deepseek-v4-flash", messages: [] };
    };
    const pairModel = (api: string) =>
      modelFixture({
        id: "pair-model",
        provider: "opencode-go",
        api,
        baseUrl:
          api === "anthropic-messages"
            ? "https://opencode.ai/zen/go"
            : "https://opencode.ai/zen/go/v1",
      });
    for (const registration of PROXY_ROUTE_REGISTRY) {
      if (registration.provider !== "opencode-go") continue;
      for (const [key, familyState] of Object.entries(registration.families)) {
        const family = keyToFamily.get(key);
        assert(family !== undefined, `registry key ${key} must map to a family`);
        const capability = resolveProviderCapability(
          pairModel(registration.api),
          pairPayload(registration.api, family),
        );
        assert(
          capability.state === familyState.state,
          `resolved capability (${registration.api}, ${key}) must agree with the registry: ${familyState.state}, got ${capability.state}`,
        );
        if (familyState.state === "verified") {
          assert(
            familyState.evidence !== null && familyState.evidence.length > 0,
            `verified entry (${registration.api}, ${key}) must carry an evidence pointer`,
          );
        }
      }
    }
  }

  const unknownResponses = modelFixture({
    id: "gpt-compatible",
    provider: "my-proxy",
    api: "openai-responses",
  });
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
  const vibe = modelFixture({
    id: "claude-opus-5",
    provider: "vibeproxy",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
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

  const priced = modelFixture({
    id: "x",
    cost: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  });
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

  // Verified-no-probe families (opencode-go retained, and the verified
  // completions-plain no-keepalive treatment) claim no savings: the anchor
  // derives savingsKnown from the plan timer, so a no-probe route carries
  // savingsKnown false even when model pricing exists.
  const noProbeCapability = {
    state: "verified",
    reason: "test",
    manualProbe: false,
    automaticWarm: false,
  } as const;
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0.12,
      savingsKnown: false,
      pricingSource: "model",
      capability: noProbeCapability,
      provider: "opencode-go",
    }) === "n/a (no keepalive scheduled)",
    "a verified no-keepalive route must render savings as n/a (no keepalive scheduled)",
  );
  // The retained family genuinely never probes, so with zero recorded probes
  // the summary is the terse label.
  assert(
    formatSavingsSummary({
      probeHitCount: 0,
      probeMissCount: 0,
      totalEstimatedSavedUsd: 0.12,
      totalProbeCostUsd: 0.01,
      savingsKnown: false,
      pricingSource: "model",
      capability: noProbeCapability,
      provider: "opencode-go",
    }) === "n/a (no keepalive scheduled)",
    "a no-probe family with no recorded probes must summarize as n/a",
  );
  // The verified completions-plain treatment deliberately keeps /warm now, so
  // a manual probe accumulates telemetry; the summary must show the counts
  // with n/a amounts instead of the terse label.
  assert(
    formatSavingsSummary({
      probeHitCount: 1,
      probeMissCount: 0,
      totalEstimatedSavedUsd: 0.12,
      totalProbeCostUsd: 0.01,
      savingsKnown: false,
      pricingSource: "model",
      capability: noProbeCapability,
      provider: "opencode-go",
    }) ===
      "probeHits=1 probeMisses=0 totalEstimatedSaved=n/a totalProbeCost=n/a net=n/a pricingSource=model savingsUnit=budget-dollars",
    "a no-probe family with recorded manual probes must keep the cumulative telemetry",
  );
  // A key-gated verified route (a pending cache key disables the timer while
  // /warm now probes can still run) gets the terse chip label, but the
  // cumulative summary keeps the probe counts with n/a amounts.
  const keyGatedCapability = {
    state: "verified",
    reason: "test",
    manualProbe: false,
    automaticWarm: true,
  } as const;
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0.12,
      savingsKnown: false,
      pricingSource: "model",
      capability: keyGatedCapability,
      provider: "opencode-go",
    }) === "n/a (no keepalive scheduled)",
    "a key-gated verified route must not claim the no-pricing label",
  );
  assert(
    formatSavingsSummary({
      probeHitCount: 1,
      probeMissCount: 0,
      totalEstimatedSavedUsd: 0.12,
      totalProbeCostUsd: 0.01,
      savingsKnown: false,
      pricingSource: "model",
      capability: keyGatedCapability,
      provider: "opencode-go",
    }) ===
      "probeHits=1 probeMisses=0 totalEstimatedSaved=n/a totalProbeCost=n/a net=n/a pricingSource=model savingsUnit=budget-dollars",
    "a key-gated verified route must keep cumulative probe telemetry with n/a amounts",
  );
  // A verified probing route keeps dollar savings (the fixture above pins the
  // "est. $0.23 saved" phrase with automaticWarm undefined, which is treated
  // as probing); an explicit automaticWarm true is the same path.
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0.23,
      savingsKnown: true,
      pricingSource: "model",
      capability: {
        state: "verified",
        reason: "test",
        manualProbe: false,
        automaticWarm: true,
      },
    }) === "est. $0.23 saved",
    "a verified probing route must keep the dollar savings phrase",
  );

  // Devin Review fix pin: the /warm now failure notification level is chosen
  // by the pure resolveWarmNowFailure helper. A by-design refusal on a
  // verified no-keepalive route (the retained family) renders at warning
  // level with the refusal label, not as a red error toast; real failures on
  // verified routes stay errors; unverified refusals keep the warning level.
  const retainedRefusal = resolveWarmNowFailure({
    ok: false,
    unavailable: true,
    capabilityState: "verified",
    automaticWarm: false,
    xaiBestEffort: false,
  });
  assert(
    retainedRefusal?.level === "warning" &&
      retainedRefusal.failureLabel === "Probe unavailable",
    "a verified no-keepalive refusal must render at warning level, not error",
  );
  const realFailure = resolveWarmNowFailure({
    ok: false,
    unavailable: false,
    capabilityState: "verified",
    automaticWarm: true,
    xaiBestEffort: false,
  });
  assert(
    realFailure?.level === "error" && realFailure.failureLabel === "Probe failed",
    "a real probe failure on a verified route must stay an error",
  );
  const unverifiedRefusal = resolveWarmNowFailure({
    ok: false,
    unavailable: true,
    capabilityState: "unverified",
    automaticWarm: false,
    xaiBestEffort: false,
  });
  assert(
    unverifiedRefusal?.level === "warning" &&
      unverifiedRefusal.failureLabel === "Probe unavailable",
    "an unverified route refusal must keep the warning level",
  );
  const xaiRefusal = resolveWarmNowFailure({
    ok: false,
    unavailable: true,
    capabilityState: "unverified",
    automaticWarm: false,
    xaiBestEffort: true,
  });
  assert(
    xaiRefusal?.failureLabel === "xAI best-effort probe unavailable",
    "xAI routes must keep the xAI failure label",
  );
  const success = resolveWarmNowFailure({
    ok: true,
    unavailable: false,
    capabilityState: "verified",
    automaticWarm: true,
    xaiBestEffort: false,
  });
  assert(success === null, "a successful result must not produce a failure notification");
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
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  const responses = [
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
  const completeStub = completeFixture(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const model = modelFixture({
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: NotifyLevel = "info") => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
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
  });
  const warmer = new SessionWarmer(
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    completeStub,
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
  const reanchoredDueAt = nextDueAtMs(warmer.getStatusText());
  assert(reanchoredDueAt !== null && reanchoredDueAt > Date.now(), "re-anchor should arm the normal strategy timer");
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
  const model = modelFixture({
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
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
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }));
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
    .map(reanchorLog);
  const transition = events.find((event) => event !== null);
  assert(transition !== undefined, "fresh capture should log an anchor_reanchored transition");
  assert(transition.reason === "compacted · waiting for next turn", "transition should preserve the reason");
  assert(
    transition.oldPayloadFingerprint === oldPayloadFingerprint,
    "transition should log the dropped payload fingerprint",
  );
  assert(
    transition.newPayloadFingerprint === stableFingerprint(newPayload),
    "transition should log the fresh payload fingerprint",
  );
  assert(
    transition.oldCacheKeyFingerprint !== null &&
      transition.oldCacheKeyFingerprint !== "reanchor-old-key" &&
      transition.newCacheKeyFingerprint !== null &&
      transition.newCacheKeyFingerprint !== "reanchor-new-key",
    "transition should log only redacted old and new cache-key fingerprints",
  );
  assert(warmer.getStatusText().includes("nextDue=none"), "re-anchor log capture must not retain the old timer");
  warmer.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

// 12) Disable/re-enable preserves "awaiting-reanchor" and "blocked" states
{
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  const responses = [
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
  const completeStub = completeFixture(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const model = modelFixture({
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: NotifyLevel = "info") => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
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
  });

  // Test 1: Disable while in "awaiting-reanchor" state, then re-enable restores "awaiting-reanchor"
  const warmer1 = new SessionWarmer(
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    completeStub,
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
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    completeStub,
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
  const codexModel = modelFixture({
    id: "gpt-5.6",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  });
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
  const codexCompleteStub = completeFixture(async () => {
    return codexResponses.shift();
  });
  const codexCtx = contextFixture({ ...ctx, model: codexModel });
  const warmer3 = new SessionWarmer(
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    codexCompleteStub,
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
  await warmer3.warmNow(codexCtx);
  assert(warmer3.getLifecycleState() === "anchored", "first oversized should soft-skip and stay anchored");

  // Second oversized probe (sticky-block)
  await warmer3.warmNow(codexCtx);
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
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  const responses = [
    { stopReason: "stop" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
    { stopReason: "stop" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
    { stopReason: "stop" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
  ];
  const xaiModel = modelFixture({
    id: "grok-4.5",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    compat: { sessionAffinityFormat: "openai", supportsLongCacheRetention: false },
    cost: { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  });
  const capturedPayload = {
    model: "grok-4.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "keep this exact" }] }],
    prompt_cache_key: "xai-session",
    max_output_tokens: 4096,
    instructions: "Do not change this.",
    reasoning: { effort: "high", summary: "auto" },
    tools: [{ type: "function", name: "bash" }],
  };
  const calls: Array<{ sessionId?: string; cacheRetention?: string; payload: ReturnType<typeof payloadObject> }> = [];
  const completeStub = completeFixture(async (
    _model: Model<any>,
    _context: WarmCompleteContext,
    options?: ProbeRequestOptions,
  ) => {
    const payload = payloadObject(options?.onPayload?.(structuredClone({
      model: "grok-4.5",
      input: [],
      prompt_cache_key: "generated-by-adapter",
    }), xaiModel));
    calls.push({ sessionId: options?.sessionId, cacheRetention: options?.cacheRetention, payload });
    return responses.shift();
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: NotifyLevel = "info") => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
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
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "high" }), completeStub);
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
  assert(calls[0]?.sessionId === "xai-session", "xAI probe should reuse the stable session identity");
  assert(calls[0]?.cacheRetention === "short", "xAI probe should use short cache retention");
  const warmPayload = calls[0]?.payload;
  assert(warmPayload, "xAI probe should send a payload");
  assert(warmPayload.max_output_tokens === OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, "xAI probe should cap output legally");
  assert(warmPayload.prompt_cache_key === capturedPayload.prompt_cache_key, "xAI probe should preserve the cache key");
  assert(warmPayload.instructions === capturedPayload.instructions, "xAI probe should preserve instructions");
  assert(JSON.stringify(warmPayload.reasoning) === JSON.stringify(capturedPayload.reasoning), "xAI probe should preserve reasoning");
  assert(JSON.stringify(warmPayload.tools) === JSON.stringify(capturedPayload.tools), "xAI probe should preserve tools");
  assert(JSON.stringify(warmPayload.input) === JSON.stringify(capturedPayload.input), "xAI probe should preserve the exact prefix");
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
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  let calls = 0;
  const completeStub = completeFixture(async () => {
    calls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    };
  });
  const goModel = modelFixture({
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: NotifyLevel = "info") => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
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
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
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
  assert(calls === 0, "a refused Go completions payload must never reach the provider");
  warmer.dispose();
}

// 11b) The warmer call site passes getModelCompat through: an OpenCode Go
// completions probe on an uncapped captured body writes the declared
// maxTokensField (max_tokens), never the default max_completion_tokens.
{
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  const responses = [
    {
      stopReason: "stop" as const,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
  ];
  const goModel = modelFixture({
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    compat: { maxTokensField: "max_tokens" },
    cost: { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  });
  assert(
    getModelCompat(goModel)?.maxTokensField === "max_tokens",
    "getModelCompat must expose the declared maxTokensField",
  );
  const calls: Array<ReturnType<typeof payloadObject>> = [];
  const completeStub = completeFixture(async (
    _model: Model<any>,
    _context: WarmCompleteContext,
    options?: ProbeRequestOptions,
  ) => {
    calls.push(payloadObject(options?.onPayload?.(
      structuredClone({ model: "deepseek-v4-flash", messages: [] }),
      goModel,
    )));
    return responses.shift();
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: NotifyLevel = "info") => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
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
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
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
  const warmPayload = calls[0];
  assert(warmPayload, "a manual probe must send a payload");
  assert(
    warmPayload.max_tokens === 1,
    "the probe must cap the declared maxTokensField (max_tokens)",
  );
  assert(
    !("max_completion_tokens" in warmPayload),
    "the probe must not write the default max_completion_tokens field",
  );
  assert(
    JSON.stringify(warmPayload.messages) === JSON.stringify(captured.messages),
    "the probe must preserve the exact captured prefix",
  );
  warmer.dispose();
}

// 11c) The retained family never probes end to end: /warm now on a payload
// carrying prompt_cache_retention "24h" is refused before any provider request,
// and the plan and the warmer agree because both derive manual gating from
// capability.manualProbe. Uses the completions transport, where retained is
// verified no-probe (the promoted pair).
{
  let calls = 0;
  const goModel = modelFixture({
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
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
  });
  const completeStub = completeFixture(async () => {
    calls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    };
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
  warmer.bindContext(ctx);
  warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, intervalMs: 60_000 });
  warmer.capturePayload(
    {
      model: "deepseek-v4-flash",
      prompt_cache_retention: "24h",
      messages: [{ role: "user", content: "hi" }],
    },
    ctx,
  );
  const retainedCapability = warmer.getCapability();
  assert(
    retainedCapability.state === "verified" &&
      !retainedCapability.automaticWarm &&
      !retainedCapability.manualProbe,
    "the retained family must resolve verified-no-probe with the manual probe disabled",
  );
  const retainedStatus = warmer.getStatusText();
  assert(
    retainedStatus.includes("strategy=opencode-go-retained") && retainedStatus.includes("nextDue=none"),
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

// 11d) The verified (openai-completions, plain) no-keepalive treatment keeps
// /warm now: capability and plan agree that no timer arms (automaticWarm
// false, intervalMs null) and a manual probe fires exactly once for cold-cache
// protection and TTL uncertainty.
{
  let calls = 0;
  const goModel = modelFixture({
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
    cwd: process.cwd(),
    model: goModel,
    hasUI: false,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "go-completions-plain-session" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "go-key", headers: {}, env: {} }),
    },
  });
  const completeStub = completeFixture(async () => {
    calls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    };
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
  warmer.bindContext(ctx);
  warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, intervalMs: 60_000 });
  warmer.capturePayload(
    {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    },
    ctx,
  );
  const completionsCapability = warmer.getCapability();
  assert(
    completionsCapability.state === "verified" &&
      !completionsCapability.automaticWarm &&
      !completionsCapability.manualProbe,
    "the verified completions-plain route must be no-keepalive",
  );
  const completionsStatus = warmer.getStatusText();
  assert(
    completionsStatus.includes("strategy=opencode-go-plain") &&
      completionsStatus.includes("autoWarm=off") &&
      completionsStatus.includes("intervalMs=none") &&
      completionsStatus.includes("nextDue=none"),
    "the completions-plain plan must agree with the capability: no timer",
  );
  const result = await warmer.warmNow(ctx);
  assert(result.ok === true, "the verified completions-plain route must allow /warm now");
  assert(calls === 1, "the manual probe must fire exactly once on the verified route");
  warmer.dispose();
}

// 11e) A continuing keyed responses session preserves its accumulated savings
// tally across captures: carry-over follows route and pricing continuity, so
// the running total survives and resumes. The flip side is also pinned: a
// turn whose key changes is not a continuation, so it re-anchors with fresh
// stats by design. This is the regression guard for the savings carry-over
// being decoupled from the per-payload plan gate.
{
  const goResponsesModel = modelFixture({
    id: "grok-4.5",
    provider: "opencode-go",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
    cost: { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const ctx = contextFixture({
    cwd: process.cwd(),
    model: goResponsesModel,
    hasUI: false,
    ui,
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "go-responses-continuation-session" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "go-key", headers: {}, env: {} }),
    },
  });
  const completeStub = completeFixture(async () => {
    return {
      stopReason: "stop",
      usage: { input: 10, output: 1, cacheRead: 50_000, cacheWrite: 0, cost: { total: 0.02 } },
    };
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
  warmer.bindContext(ctx);
  warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, intervalMs: 60_000 });
  warmer.capturePayload(
    {
      model: "grok-4.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      prompt_cache_key: "go-session-1",
    },
    ctx,
  );
  const hit = await warmer.warmNow(ctx);
  assert(hit.cacheHit === true, "the keyed responses manual probe must hit");
  assert(warmer.getStatusText().includes("savings=est. $"), "a keyed responses route must claim savings");
  const savedBefore = warmer.getSessionWarmStats().totalEstimatedSavedUsd;
  assert(savedBefore > 0, "the probe hit must accumulate savings");
  // Continuing keyed turn: same key, grew prefix. The tally must survive.
  warmer.capturePayload(
    {
      model: "grok-4.5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "user", content: [{ type: "input_text", text: "second turn" }] },
      ],
      prompt_cache_key: "go-session-1",
    },
    ctx,
  );
  assert(
    warmer.getSessionWarmStats().totalEstimatedSavedUsd === savedBefore,
    "a continuing keyed turn must preserve the accumulated savings tally",
  );
  assert(warmer.getStatusText().includes("savings=est. $"), "the continuing keyed turn must keep claiming savings");
  // A turn whose key changes is not a continuation: it re-anchors with fresh
  // stats by design, so the key-gated state never inherits a prior tally.
  warmer.capturePayload(
    {
      model: "grok-4.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "no key turn" }] }],
    },
    ctx,
  );
  const keylessStatus = warmer.getStatusText();
  assert(
    warmer.getSessionWarmStats().totalEstimatedSavedUsd === 0 && keylessStatus.includes("n/a"),
    "a key change must re-anchor with fresh stats and no savings claim",
  );
  assert(
    keylessStatus.includes("nextDue=none") && keylessStatus.includes("intervalMs=none"),
    "the key-gated turn must not arm a timer",
  );
  warmer.dispose();
}

// 12) Unverified routes remain manual-only: no timer, no verified savings, one safe probe.
{
  let calls = 0;
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  const model = modelFixture({
    id: "grok-4.3",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    cost: { input: 2, cacheRead: 0.3, cacheWrite: 0, output: 6 },
  });
  const payload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "manual only" }] }],
  };
  const completeStub = completeFixture(async (
    _model: Model<any>,
    _context: WarmCompleteContext,
    options?: ProbeRequestOptions,
  ) => {
    calls += 1;
    options?.onPayload?.(structuredClone(payload), model);
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
  });
  const manualUiCalls: Array<{ kind: "status" | "widget"; value: string | string[] | undefined }> = [];
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: (message: string, level: NotifyLevel = "info") => notifications.push({ message, level }),
    setStatus: (_id: string, value?: string) => manualUiCalls.push({ kind: "status", value }),
    setWidget: (_id: string, value?: string[]) => manualUiCalls.push({ kind: "widget", value }),
  };
  const ctx = contextFixture({
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
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
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
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  let warmHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const pi = extensionApiFixture({
    registerFlag: () => undefined,
    getFlag: () => "true",
    on: () => undefined,
    registerCommand: (_name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      warmHandler = command.handler;
    },
  });
  piWarmCache(pi);
  assert(warmHandler !== undefined, "warm command should be registered");
  const ctx = contextFixture({
    model: modelFixture({
      id: "grok-4.3",
      provider: "xai",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    }),
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string, level: NotifyLevel = "info") => notifications.push({ message, level }),
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  });
  await warmHandler("now", ctx);
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
  const model = modelFixture({
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 4 },
  });
  let calls = 0;
  const firstProbe: FirstProbeHooks = {};
  const firstStarted = new Promise<void>((resolve) => {
    firstProbe.started = resolve;
  });
  const completeStub = completeFixture(async () => {
    calls += 1;
    if (calls === 1) {
      firstProbe.started?.();
      return new Promise<ProbeReply>((resolve) => {
        firstProbe.release = resolve;
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
  });
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const makeContext = (sessionId: string) =>
    contextFixture({
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
    });
  const payload = (sessionId: string) => ({
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "concurrency" }] }],
    prompt_cache_key: sessionId,
  });
  const warmerA = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
  const warmerB = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
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
    .map(deferredLog);
  let gateEvent:
    | {
        reason: string | null;
        activeWarmSessions: number | null;
        maxConcurrentWarmSessions: number | null;
        providerRequest: boolean | null;
      }
    | undefined;
  for (const event of events) {
    if (event && event.reason === "concurrency limit") {
      gateEvent = event;
      break;
    }
  }
  assert(gateEvent !== undefined, "concurrency deferral should emit a JSONL event");
  assert(gateEvent.activeWarmSessions === 1, "JSONL deferral should record active warm sessions");
  assert(gateEvent.maxConcurrentWarmSessions === 1, "JSONL deferral should record the configured limit");
  assert(gateEvent.providerRequest === false, "deferred JSONL event must state that no provider request was sent");

  if (!firstProbe.release) throw new Error("the first probe must expose a release hook");
  firstProbe.release({
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
  const model = modelFixture({
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  let calls = 0;
  const completeStub = completeFixture(async () => {
    calls += 1;
    return { stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0 } };
  });
  const ctx = contextFixture({
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
  });
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
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

  const result = await runTimerWarm(warmer);
  assert(result.deferred?.reason === "agent busy", "a busy timer tick should be marked deferred");
  assert(calls === 0, "a busy timer tick must not call the provider");
  assert(warmer.getStatusText().includes("deferred=agent busy"), "status should expose the busy deferral reason");
  warmer.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

// 16) UI surfaces stay concise, distinguish re-anchoring, and hide the widget cleanly.
{
  type UiCall = {
    kind: "widget" | "status" | "notify";
    value: string | string[] | undefined;
    level?: NotifyLevel;
  };
  const calls: UiCall[] = [];
  const ui = {
    theme: { fg: (_color: string, text: string) => text },
    setWidget: (_id: string, value?: string[]) => calls.push({ kind: "widget", value }),
    setStatus: (_id: string, value?: string) => calls.push({ kind: "status", value }),
  };
  const ctx = contextFixture({ hasUI: true, ui });
  const anchor = cacheAnchorFixture({
    cachedTokens: 128_000,
    promptTokens: 128_000,
    probeHitCount: 2,
    probeMissCount: 0,
    savingsKnown: true,
    estimatedSavingsUsd: 0.12,
    capability: { state: "verified", automaticWarm: true },
  });
  const plan = strategyPlanFixture({
    family: "openai-implicit",
    intervalMs: 240_000,
    ttlLabel: "~8m idle cache window",
    waitLabel: "4m",
    automaticWarm: true,
    manualProbe: false,
    cacheRetention: "short",
  });

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
      Array.isArray(call.value) && call.value.some((line) => line.includes("re-anchoring after compaction")),
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

  const xaiCalls: UiCall[] = [];
  const xaiCtx = contextFixture({
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value?: string[]) => xaiCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value?: string) => xaiCalls.push({ kind: "status", value }),
    },
  });
  const xaiAnchor = cacheAnchorFixture({ ...anchor, capability: { state: "verified", automaticWarm: true } });
  const xaiPlan = strategyPlanFixture({
    ...plan,
    family: "xai-best-effort",
    ttlLabel: "xAI best-effort probe cadence",
  });
  renderWaitingUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, xaiAnchor, xaiPlan, Date.now() + 180_000);
  renderWarmHitUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, xaiAnchor, xaiPlan, 128_000);
  renderReanchorUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "prompt_cache_key changed", "xAI best-effort");
  renderProbeRetryUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "read=0 write=0", undefined, "xAI best-effort");
  renderFailureUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "probe miss", "read=0 write=0", undefined, "xAI best-effort");
  renderIdleUi(xaiCtx, { ...DEFAULT_CONFIG, showWidget: true }, "prefix too small", undefined, "xAI best-effort");
  const xaiUiText = xaiCalls
    .flatMap((call) => (Array.isArray(call.value) ? call.value : [String(call.value)]))
    .map(String)
    .join(" ");
  assert(xaiUiText.includes("xAI best-effort"), "xAI UI should label the best-effort policy");
  assert(!xaiUiText.includes("xAI best-effort cache warm · xAI best-effort extension probe hit"), "xAI hit UI should avoid redundant policy labels");

  const capabilityCalls: UiCall[] = [];
  const capabilityCtx = contextFixture({
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value?: string[]) => capabilityCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value?: string) => capabilityCalls.push({ kind: "status", value }),
      notify: (value: string, level: NotifyLevel = "info") => capabilityCalls.push({ kind: "notify", value, level }),
    },
  });
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

  const hiddenCalls: UiCall[] = [];
  const hiddenCtx = contextFixture({
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value?: string[]) => hiddenCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value?: string) => hiddenCalls.push({ kind: "status", value }),
    },
  });
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

// 17) Slice 5 idle-cutoff math, maxidle=/spend= token parsing, and the
// best-effort no-write family truth table (pure functions).
{
  // resolveMaxIdleWarmMs formula: max(30m, 2 x referenceMs), where referenceMs
  // is the family TTL when one exists and the interval otherwise.
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "anthropic-long") === 120 * 60_000,
    "anthropic-long (1h TTL) cutoff must be 120m",
  );
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "opencode-go-long-marker") === 120 * 60_000,
    "opencode-go long-marker (1h TTL) cutoff must be 120m",
  );
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "anthropic-short") === 30 * 60_000,
    "anthropic-short (5m TTL) cutoff must hit the 30m floor",
  );
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "opencode-go-short-marker") === 30 * 60_000,
    "opencode-go short-marker (5m TTL) cutoff must hit the 30m floor",
  );
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "opencode-go-plain") === 30 * 60_000,
    "opencode-go plain (5m TTL) cutoff must hit the 30m floor",
  );
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "openai-explicit") === 60 * 60_000,
    "openai-explicit (30m TTL) cutoff must be 60m",
  );
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "openai-implicit") === 30 * 60_000,
    "openai-implicit (8m TTL) cutoff must hit the 30m floor",
  );
  assert(
    resolveMaxIdleWarmMs(DEFAULT_CONFIG, "xai-best-effort", 4 * 60_000) === 30 * 60_000,
    "xai-best-effort (4m interval) cutoff must hit the 30m floor",
  );
  assert(
    resolveMaxIdleWarmMs(
      { ...DEFAULT_CONFIG, intervalMs: 20 * 60_000 },
      "xai-best-effort",
      20 * 60_000,
    ) === 40 * 60_000,
    "xai-best-effort cutoff must follow the effective interval (2 x 20m)",
  );
  // TTL families ignore interval overrides; only xai is interval-referenced.
  assert(
    resolveMaxIdleWarmMs({ ...DEFAULT_CONFIG, intervalMs: 60_000 }, "anthropic-long") ===
      120 * 60_000,
    "TTL families must ignore interval overrides",
  );
  // Literal config wins over the formula; 0 = no cutoff.
  assert(
    resolveMaxIdleWarmMs({ ...DEFAULT_CONFIG, maxIdleWarmMs: 45 * 60_000 }, "anthropic-short") ===
      45 * 60_000,
    "a positive maxIdleWarmMs must win over the formula",
  );
  assert(
    resolveMaxIdleWarmMs({ ...DEFAULT_CONFIG, maxIdleWarmMs: 0 }, "anthropic-long") === null,
    "maxidle=0 must restore warm-until-failure",
  );

  // maxidle= / spend= token parsing. The literal 0 is special-cased because
  // parseDurationMs("0") returns 1000ms.
  assert(
    parseConfigArgs("maxidle=0").maxIdleWarmMs === 0,
    "maxidle=0 must parse to the literal 0 opt-out",
  );
  assert(
    parseConfigArgs("maxidle=2h").maxIdleWarmMs === 2 * 3_600_000,
    "maxidle=2h must parse to milliseconds",
  );
  assert(
    parseConfigArgs("maxidle=45m").maxIdleWarmMs === 45 * 60_000,
    "maxidle=45m must parse to milliseconds",
  );
  assert(
    parseConfigArgs("maxidle=nope").maxIdleWarmMs === null,
    "an unparseable maxidle token must stay null (formula)",
  );
  assert(
    parseConfigArgs("spend=2.5").warmSpendCeilingUsd === 2.5,
    "spend=2.5 must parse to USD",
  );
  assert(
    parseConfigArgs("spend=0").warmSpendCeilingUsd === 0,
    "spend=0 must parse to the unlimited marker",
  );
  assert(
    parseConfigArgs("spend=abc").warmSpendCeilingUsd === null,
    "a non-numeric spend token must be silently ignored",
  );
  assert(
    parseConfigArgs("spend=-1").warmSpendCeilingUsd === null,
    "a negative spend token must be silently ignored",
  );

  // isBestEffortNoWriteFamily truth table.
  assert(isBestEffortNoWriteFamily("xai-best-effort"), "xAI best-effort is a no-write family");
  assert(
    isBestEffortNoWriteFamily("opencode-go-long-marker"),
    "Go long-marker is a no-write family",
  );
  assert(
    isBestEffortNoWriteFamily("opencode-go-short-marker"),
    "Go short-marker is a no-write family",
  );
  assert(isBestEffortNoWriteFamily("opencode-go-plain"), "Go plain is a no-write family");
  assert(
    !isBestEffortNoWriteFamily("opencode-go-retained"),
    "the retained family never probes and is excluded structurally",
  );
  assert(!isBestEffortNoWriteFamily("anthropic-short"), "anthropic-short is not a no-write family");
  assert(!isBestEffortNoWriteFamily("anthropic-long"), "anthropic-long is not a no-write family");
  assert(!isBestEffortNoWriteFamily("openai-explicit"), "openai-explicit is not a no-write family");
  assert(!isBestEffortNoWriteFamily("openai-implicit"), "openai-implicit is not a no-write family");
  assert(!isBestEffortNoWriteFamily("unverified"), "unverified is not a no-write family");
  assert(!isBestEffortNoWriteFamily("unsupported"), "unsupported is not a no-write family");
}

// 18) Timer-fire idle cutoff boundary: anthropic-long probes at 48m and 96m
// under a 120m cutoff, a boundary probe at the cutoff does not fire, a short
// family stops after 30m idle, and maxidle=0 restores warm-until-failure.
// Fire-time guard simulated by manipulating anchor.lastRealTurnAt and calling
// runWarm("timer") directly with a call-counting stub (test-15 pattern).
{
  const cwd = mkdtempSync(join(tmpdir(), "pi-warm-cache-idle-cutoff-"));
  const anthropicModel = modelFixture({
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
  });
  const longPayload = {
    model: "claude-sonnet-4-5",
    max_tokens: 16000,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }],
      },
    ],
  };
  const shortPayload = {
    model: "claude-sonnet-4-5",
    max_tokens: 16000,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  let calls = 0;
  const completeStub = completeFixture(async () => {
    calls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
    };
  });
  const ctx = contextFixture({
    cwd,
    model: anthropicModel,
    hasUI: false,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "idle-cutoff-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  });

  // anthropic-long: probes at 48m and 96m, aborts at the 120m boundary.
  const longWarmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
  longWarmer.bindContext(ctx);
  longWarmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, logToFile: true });
  longWarmer.capturePayload(longPayload, ctx);
  longWarmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  assert(
    longWarmer.getStatusText().includes("strategy=anthropic-long"),
    "the 1h-marker payload must classify anthropic-long",
  );
  assert(
    resolveMaxIdleWarmMs(longWarmer.getConfig(), "anthropic-long") === 120 * 60_000,
    "the anthropic-long cutoff must be 120m",
  );

  setLastRealTurnAt(longWarmer, Date.now() - 48 * 60_000);
  const at48m = await runTimerWarm(longWarmer);
  assert(at48m.ok && at48m.probeOutcome === "hit", "anthropic-long must still probe at 48m idle");
  assert(Number(calls) === 1, "the 48m probe must be the only provider call so far");
  clearWarmerTimers(longWarmer);

  setLastRealTurnAt(longWarmer, Date.now() - 96 * 60_000);
  const at96m = await runTimerWarm(longWarmer);
  assert(at96m.ok && at96m.probeOutcome === "hit", "anthropic-long must still probe at 96m idle");
  assert(Number(calls) === 2, "the 96m probe must be the second provider call");
  clearWarmerTimers(longWarmer);

  setLastRealTurnAt(longWarmer, Date.now() - 120 * 60_000);
  const at120m = await runTimerWarm(longWarmer);
  assert(
    !at120m.ok && at120m.unavailable === true && at120m.probeOutcome === "unavailable",
    "a timer probe at exactly the 120m cutoff must not fire",
  );
  assert(Number(calls) === 2, "the cutoff abort must never call the provider");
  assert(
    longWarmer.getStatusText().includes("nextDue=none"),
    "the cutoff abort must clear timers (no re-arm loop)",
  );
  assert(
    longWarmer.getStatusText().includes("probeFailStreak=0/3"),
    "the cutoff abort must never count as a probe failure",
  );
  // /warm now bypasses the idle cutoff entirely.
  const manualBypass = await longWarmer.warmNow(ctx);
  assert(manualBypass.ok, "/warm now must bypass the idle cutoff");
  assert(Number(calls) === 3, "the manual bypass must be the third provider call");
  // The reschedule() arm path must also refuse to arm once idle is past the
  // cutoff: agent_settled after the abort must not re-arm a timer.
  longWarmer.onAgentSettled(ctx);
  assert(
    longWarmer.getStatusText().includes("nextDue=none"),
    "reschedule must not arm a timer past the idle cutoff",
  );
  longWarmer.dispose();

  // anthropic-short: fires at 20m, stops at the 30m floor; maxidle=0 restores
  // warm-until-failure.
  const shortWarmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
  shortWarmer.bindContext(ctx);
  shortWarmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10 });
  shortWarmer.capturePayload(shortPayload, ctx);
  shortWarmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  assert(shortWarmer.getStatusText().includes("strategy=anthropic-short"), "the short payload must classify anthropic-short");
  assert(
    resolveMaxIdleWarmMs(shortWarmer.getConfig(), "anthropic-short") === 30 * 60_000,
    "the anthropic-short cutoff must be 30m",
  );

  setLastRealTurnAt(shortWarmer, Date.now() - 20 * 60_000);
  const at20m = await runTimerWarm(shortWarmer);
  assert(at20m.ok, "a short family must still probe at 20m idle");
  clearWarmerTimers(shortWarmer);

  setLastRealTurnAt(shortWarmer, Date.now() - 30 * 60_000);
  const at30m = await runTimerWarm(shortWarmer);
  assert(
    !at30m.ok && at30m.unavailable === true && at30m.probeOutcome === "unavailable",
    "a short family must stop at the 30m idle cutoff",
  );
  assert(
    shortWarmer.getStatusText().includes("probeFailStreak=0/3"),
    "the short-family cutoff abort must not count as a probe failure",
  );

  shortWarmer.setConfig({ ...shortWarmer.getConfig(), maxIdleWarmMs: 0 });
  setLastRealTurnAt(shortWarmer, Date.now() - 5 * 3_600_000);
  const unlimited = await runTimerWarm(shortWarmer);
  assert(unlimited.ok, "maxidle=0 must restore warm-until-failure after the cutoff");
  shortWarmer.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

// 19) Per-provider probe-spend ceiling: dollar stop, spend=0 unlimited, the
// 250-probe fallback for zero-cost pricing, and a real-turn reset that clears
// the per-instance soft block.
{
  resetProbeSpendLedgerForTest();
  const cwd = mkdtempSync(join(tmpdir(), "pi-warm-cache-spend-ledger-"));
  const model = modelFixture({
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  let calls = 0;
  const completeStub = completeFixture(async () => {
    calls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
    };
  });
  const ctx = contextFixture({
    cwd,
    model,
    hasUI: false,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "spend-ledger-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  });
  const payload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "keep warm" }] }],
    prompt_cache_key: "spend-test",
  };

  // Dollar ceiling: 1 cent. One probe costs 1 cent, so the second timer fire
  // must soft-block without calling the provider.
  const warmer = new SessionWarmer(extensionApiFixture({ getThinkingLevel: () => "off" }), completeStub);
  warmer.bindContext(ctx);
  warmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    warmSpendCeilingUsd: 0.01,
  });
  warmer.capturePayload(payload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });

  const first = await runTimerWarm(warmer);
  assert(first.ok && first.probeOutcome === "hit", "the first timer probe must fire under the ceiling");
  assert(Number(calls) === 1, "one probe must cost one cent against the 1-cent ceiling");

  const blocked = await runTimerWarm(warmer);
  assert(
    !blocked.ok && blocked.unavailable === true && blocked.probeOutcome === "unavailable",
    "a timer probe over the spend ceiling must soft-block",
  );
  assert(Number(calls) === 1, "the soft-block must never call the provider");
  assert(
    warmer.getStatusText().includes("spendCeiling=probe spend ceiling reached"),
    "status must expose the distinct spendCeiling field",
  );
  assert(
    warmer.getStatusText().includes("lifecycle=anchored"),
    "the spend soft-block must never set lifecycleState blocked",
  );
  // /warm now bypasses the ceiling, but the timer stays soft-blocked.
  const manualBypass = await warmer.warmNow(ctx);
  assert(manualBypass.ok, "/warm now must bypass the spend ceiling");
  const stillBlocked = await runTimerWarm(warmer);
  assert(
    !stillBlocked.ok && stillBlocked.unavailable === true,
    "a timer probe must stay soft-blocked even after a manual bypass",
  );
  assert(
    Number(calls) === 2,
    "the manual bypass is the second call; the timer stays blocked",
  );

  // A real turn clears this instance's soft block and resets the campaign ledger.
  warmer.capturePayload(payload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  const resumed = await runTimerWarm(warmer);
  assert(resumed.ok, "a real turn must clear the soft block and reset the ledger");
  assert(Number(calls) === 3, "the post-reset probe must be the third provider call");
  warmer.dispose();

  // spend=0 means unlimited: probes never trip the ceiling.
  const unlimitedWarmer = new SessionWarmer(
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    completeStub,
  );
  unlimitedWarmer.bindContext(ctx);
  unlimitedWarmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    warmSpendCeilingUsd: 0,
  });
  unlimitedWarmer.capturePayload(payload, ctx);
  unlimitedWarmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  const u1 = await runTimerWarm(unlimitedWarmer);
  const u2 = await runTimerWarm(unlimitedWarmer);
  assert(u1.ok && u2.ok, "spend=0 must keep the ceiling inactive for every provider");
  assert(
    unlimitedWarmer.getStatusText().includes("spendCeiling=ok"),
    "an inactive ceiling must report spendCeiling=ok",
  );
  unlimitedWarmer.dispose();

  // 250-probe fallback: a zero-cost provider never trips the dollar ceiling,
  // so the probe-count ceiling stops the campaign instead.
  resetProbeSpendLedgerForTest();
  let zeroCostCalls = 0;
  const zeroCostStub = completeFixture(async () => {
    zeroCostCalls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0 },
    };
  });
  const fallbackWarmer = new SessionWarmer(
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    zeroCostStub,
  );
  fallbackWarmer.bindContext(ctx);
  fallbackWarmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    warmSpendCeilingUsd: 1.0,
  });
  fallbackWarmer.capturePayload(payload, ctx);
  fallbackWarmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  for (let i = 0; i < 250; i++) {
    const probe = await runTimerWarm(fallbackWarmer);
    assert(probe.ok, `probe ${i + 1} must fire under the 250-probe fallback`);
  }
  const fallbackBlocked = await runTimerWarm(fallbackWarmer);
  assert(
    !fallbackBlocked.ok &&
      fallbackBlocked.unavailable === true &&
      String(fallbackBlocked.error).includes("probe count ceiling"),
    "the 251st timer probe must trip the probe-count fallback",
  );
  assert(
    Number(zeroCostCalls) === 250,
    "the probe-count fallback must stop after exactly 250 provider calls",
  );
  fallbackWarmer.dispose();

  // Config change resumes a soft-blocked session: raising the ceiling or
  // disabling it (spend=0) clears this instance's soft block immediately,
  // matching the documented spend=0 opt-out.
  let resumeCalls = 0;
  const resumeStub = completeFixture(async () => {
    resumeCalls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
    };
  });
  const resumeWarmer = new SessionWarmer(
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    resumeStub,
  );
  resumeWarmer.bindContext(ctx);
  resumeWarmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    warmSpendCeilingUsd: 0.01,
  });
  resumeWarmer.capturePayload(payload, ctx);
  resumeWarmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  const r1 = await runTimerWarm(resumeWarmer);
  assert(r1.ok, "the first probe must fire against the 1-cent ceiling");
  const rBlocked = await runTimerWarm(resumeWarmer);
  assert(!rBlocked.ok, "the second timer fire must soft-block");
  assert(Number(resumeCalls) === 1, "the soft block must hold before any config change");
  // spend=0 (unlimited) resumes warming without waiting for a real turn.
  resumeWarmer.setConfig({ ...resumeWarmer.getConfig(), warmSpendCeilingUsd: 0 });
  const rUnlimited = await runTimerWarm(resumeWarmer);
  assert(rUnlimited.ok, "spend=0 must resume a soft-blocked session immediately");
  assert(Number(resumeCalls) === 2, "the resumed probe must be the second provider call");
  assert(
    resumeWarmer.getStatusText().includes("spendCeiling=ok"),
    "the resumed session must report spendCeiling=ok",
  );
  // A lowered ceiling keeps the block; a raised ceiling resumes it.
  resumeWarmer.setConfig({ ...resumeWarmer.getConfig(), warmSpendCeilingUsd: 0.01 });
  const rLowered = await runTimerWarm(resumeWarmer);
  assert(
    !rLowered.ok && rLowered.unavailable === true,
    "a lowered ceiling must keep the session soft-blocked",
  );
  assert(Number(resumeCalls) === 2, "no provider call while the lowered ceiling holds");
  resumeWarmer.setConfig({ ...resumeWarmer.getConfig(), warmSpendCeilingUsd: 5 });
  const rRaised = await runTimerWarm(resumeWarmer);
  assert(rRaised.ok, "a raised ceiling must resume a soft-blocked session");
  assert(Number(resumeCalls) === 3, "the resumed probe must be the third provider call");
  resumeWarmer.dispose();

  // The 250-probe fallback must NOT fire while the campaign has real spend: a
  // priced session is bounded by dollars, never by the unrelated probe count.
  resetProbeSpendLedgerForTest();
  let pricedCalls = 0;
  const pricedStub = completeFixture(async () => {
    pricedCalls += 1;
    return {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
    };
  });
  const pricedWarmer = new SessionWarmer(
    extensionApiFixture({ getThinkingLevel: () => "off" }),
    pricedStub,
  );
  pricedWarmer.bindContext(ctx);
  pricedWarmer.setConfig({
    ...DEFAULT_CONFIG,
    minCachedTokens: 10,
    intervalMs: 60_000,
    warmSpendCeilingUsd: 100,
  });
  pricedWarmer.capturePayload(payload, ctx);
  pricedWarmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  for (let i = 0; i < 250; i++) {
    const probe = await runTimerWarm(pricedWarmer);
    assert(probe.ok, `priced probe ${i + 1} must fire past the fallback count`);
  }
  const priced251 = await runTimerWarm(pricedWarmer);
  assert(
    priced251.ok,
    "the 250-probe fallback must not fire while the campaign has real spend",
  );
  assert(
    Number(pricedCalls) === 251,
    "a priced campaign must be bounded by dollars, not the probe count",
  );
  pricedWarmer.dispose();
  resetProbeSpendLedgerForTest();
  rmSync(cwd, { recursive: true, force: true });
}

// 20) OpenCode Go outcome classification joins the transient/no-write set, and
// an awaiting-reanchor invalidation resets the failure budget without ever
// counting as a warm-probe failure (regression pin).
{
  // Pure classification: Go marker/plain families retry quietly first, then
  // escalate to payload-drift once the failure budget is exhausted. The
  // retained family is excluded structurally.
  assert(
    classifyProbeOutcome({
      cacheFamily: "opencode-go-short-marker",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 0,
      maxConsecutiveFailures: 3,
    }) === "transient-miss",
    "first Go short-marker no-read/no-write must retry quietly",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "opencode-go-long-marker",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 0,
      maxConsecutiveFailures: 3,
    }) === "transient-miss",
    "first Go long-marker no-read/no-write must retry quietly",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "opencode-go-plain",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 1,
      maxConsecutiveFailures: 3,
    }) === "miss",
    "a repeated Go no-read/no-write must stay retryable mid-budget",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "opencode-go-plain",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    }) === "payload-drift",
    "a budget-exhausted Go plain result must request a re-anchor",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "opencode-go-long-marker",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    }) === "payload-drift",
    "a budget-exhausted Go long-marker result must request a re-anchor",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "opencode-go-retained",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 0,
      maxConsecutiveFailures: 3,
    }) === "miss",
    "the retained family must never join the transient set",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "opencode-go-short-marker",
      cacheRead: 0,
      cacheWrite: 100,
      consecutiveFailuresBefore: 0,
    }) === "payload-drift",
    "write-without-read must stay a drift candidate for Go families",
  );
  // The xAI truth table stays byte-identical.
  assert(
    classifyProbeOutcome({
      cacheFamily: "xai-best-effort",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 0,
      maxConsecutiveFailures: 3,
    }) === "transient-miss",
    "first xAI no-read/no-write must retry quietly",
  );
  assert(
    classifyProbeOutcome({
      cacheFamily: "xai-best-effort",
      cacheRead: 0,
      cacheWrite: 0,
      consecutiveFailuresBefore: 2,
      maxConsecutiveFailures: 3,
    }) === "payload-drift",
    "budget-exhausted xAI must still request a re-anchor",
  );

  // Regression pin: a compaction invalidation resets the failure budget, and
  // the awaiting-reanchor window is never counted as a warm-probe failure, so
  // stale misses do not carry into the post-re-anchor session.
  const cwd = mkdtempSync(join(tmpdir(), "pi-warm-cache-reanchor-budget-"));
  const model = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as any;
  const responses: Array<unknown> = [
    {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
    {
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
    },
  ];
  const completeStub = async (): Promise<any> => responses.shift();
  const ctx = {
    cwd,
    model,
    hasUI: false,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    thinkingLevel: "off",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "reanchor-budget-test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
    },
  } as any;
  const oldPayload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "old prefix" }] }],
    prompt_cache_key: "budget-old",
  };
  const newPayload = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "new prefix" }] }],
    prompt_cache_key: "budget-new",
  };
  const warmer = new SessionWarmer({ getThinkingLevel: () => "off" } as any, completeStub as any);
  warmer.bindContext(ctx);
  warmer.setConfig({ ...DEFAULT_CONFIG, minCachedTokens: 10, intervalMs: 60_000 });
  warmer.capturePayload(oldPayload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  const staleMiss = await warmer.warmNow(ctx);
  assert(
    staleMiss.probeOutcome === "transient-miss",
    "the stale probe must be an ordinary miss, not a failure",
  );
  assert(
    warmer.getStatusText().includes("probeFailStreak=1/3"),
    "the stale miss must count against the failure budget",
  );
  warmer.invalidateAnchor(ctx, "compacted · waiting for next turn");
  assert(
    warmer.getLifecycleState() === "awaiting-reanchor",
    "compaction must enter awaiting-reanchor",
  );
  const waiting = await warmer.warmNow(ctx);
  assert(waiting.unavailable === true, "the awaiting-reanchor window must not probe");
  warmer.capturePayload(newPayload, ctx);
  warmer.noteAssistantUsage(ctx, { input: 20, cacheRead: 100, cacheWrite: 0, output: 2 });
  assert(
    warmer.getLifecycleState() === "anchored",
    "the fresh capture must finish the re-anchor",
  );
  assert(
    warmer.getStatusText().includes("probeFailStreak=0/3"),
    "a re-anchor must reset the failure budget so stale misses do not carry",
  );
  const postReanchorHit = await warmer.warmNow(ctx);
  assert(
    postReanchorHit.probeOutcome === "hit",
    "the post-re-anchor session must probe cleanly with a reset budget",
  );
  assert(
    warmer.getStatusText().includes("probeFailStreak=0/3"),
    "the post-re-anchor hit must keep the failure budget reset",
  );
  warmer.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

// 21) Slice 6 diagnostics: completions/azure cache-key fingerprinting, xAI
// key-change gating pins, best-effort family labels, budget-dollar savings
// framing, and the label-driven UI copy.
{
  // getPromptCacheKey accepts openai-completions and azure-openai-responses;
  // openai-responses stays unchanged; the new apis never affect the
  // responses-key gate.
  const completionsPayload = {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    prompt_cache_key: "go-session-1",
  };
  assert(
    getPromptCacheKey(completionsPayload, "openai-completions") === "go-session-1",
    "completions key detector should return the captured key",
  );
  assert(
    getPromptCacheKey(
      { ...completionsPayload, prompt_cache_key: undefined },
      "openai-completions",
    ) === null,
    "absent completions key must return null",
  );
  assert(
    getPromptCacheKey({ ...completionsPayload, prompt_cache_key: " " }, "openai-completions") ===
      null,
    "unstable completions key must return null",
  );
  const azurePayload = {
    model: "gpt-5.6",
    input: [{ role: "user", content: "hi" }],
    prompt_cache_key: "azure-session",
  };
  assert(
    getPromptCacheKey(azurePayload, "azure-openai-responses") === "azure-session",
    "azure responses key detector should return the captured key",
  );
  assert(
    getPromptCacheKey({ input: [], prompt_cache_key: "openai-key" }, "openai-responses") ===
      "openai-key",
    "openai-responses key detection must stay unchanged",
  );
  // The new apis never affect hasStableResponsesCacheKey, which passes the
  // literal "openai-responses" and requires the exact Responses replay shape.
  assert(
    !hasStableResponsesCacheKey({ messages: [], prompt_cache_key: "k" }),
    "completions-shaped payloads must never satisfy the responses key gate",
  );
  assert(
    hasStableResponsesCacheKey({ input: [], prompt_cache_key: "k" }),
    "responses-shaped payloads must still satisfy the responses key gate",
  );

  // Fingerprint audit: redacted 8-hex, stable, never the raw key, "none" when
  // absent. The same holds for the newly accepted apis.
  const completionsFp = getPromptCacheKeyFingerprint(completionsPayload, "openai-completions");
  assert(
    /^[0-9a-f]{8}$/.test(completionsFp),
    `completions fingerprint must be 8 hex chars, got ${completionsFp}`,
  );
  assert(completionsFp !== "go-session-1", "fingerprint must never expose the raw completions key");
  assert(
    getPromptCacheKeyFingerprint(completionsPayload, "openai-completions") === completionsFp,
    "completions fingerprint must be stable for the same key",
  );
  assert(
    getPromptCacheKeyFingerprint({ messages: [] }, "openai-completions") === "none",
    "absent completions key must fingerprint as none",
  );
  assert(
    getPromptCacheKeyFingerprint(azurePayload, "azure-openai-responses") !== "none",
    "azure responses fingerprint should be present for a keyed payload",
  );
  assert(
    getPromptCacheKeyFingerprint({ input: [], prompt_cache_key: "openai-key" }, "openai-responses") !==
      "none",
    "openai-responses fingerprint must stay present",
  );

  // Injected prompt_cache_key on an opencode-go completions payload changes no
  // gate: the route stays verified no-keepalive (no automatic timer), the
  // family is unchanged, and the key shows only in the redacted fingerprint.
  const goCompletionsModel = {
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
  } as any;
  const goCompletionsPayload = {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    prompt_cache_key: "injected-go-key",
  };
  const injectedStrategy = resolveStrategy(goCompletionsModel, DEFAULT_CONFIG, goCompletionsPayload);
  assert(
    injectedStrategy.capability.state === "verified" &&
      !injectedStrategy.capability.automaticWarm,
    "injected key must not change the verified no-keepalive completions route",
  );
  assert(!injectedStrategy.automaticWarm, "injected key must not arm an automatic timer");
  assert(
    injectedStrategy.family === "opencode-go-plain",
    "injected key must not change the Go family",
  );
  assert(
    getPromptCacheKeyFingerprint(goCompletionsPayload, "openai-completions") !== "none",
    "injected key must appear only in the redacted fingerprint",
  );

  // bestEffortFamilyLabel truth table: family-driven only, never model-id
  // driven, and never the collapsed unverified family.
  assert(bestEffortFamilyLabel("xai-best-effort") === "xAI best-effort", "xai family label");
  assert(
    bestEffortFamilyLabel("opencode-go-long-marker") === "OpenCode Go best-effort",
    "Go long-marker family label",
  );
  assert(
    bestEffortFamilyLabel("opencode-go-short-marker") === "OpenCode Go best-effort",
    "Go short-marker family label",
  );
  assert(
    bestEffortFamilyLabel("opencode-go-plain") === "OpenCode Go best-effort",
    "Go plain family label",
  );
  assert(bestEffortFamilyLabel("opencode-go-retained") === null, "retained never labels");
  assert(bestEffortFamilyLabel("anthropic-short") === null, "anthropic never labels");
  assert(bestEffortFamilyLabel("openai-implicit") === null, "openai never labels");
  assert(bestEffortFamilyLabel("unverified") === null, "collapsed family never labels");
  assert(bestEffortFamilyLabel(undefined) === null, "missing family never labels");

  // Capture-path fingerprint audit: capturePayload stores the redacted 8-hex
  // fingerprint for first-party OpenAI completions and opencode-go completions,
  // and neither status nor the JSONL mirror ever leaks the raw key.
  const cwd = mkdtempSync(join(tmpdir(), "pi-warm-cache-slice6-"));
  const makeWarmCtx = (sessionId: string, model: any) =>
    ({
      cwd,
      model,
      hasUI: false,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
      thinkingLevel: "off",
      isIdle: () => true,
      sessionManager: { getSessionId: () => sessionId },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
      },
    }) as any;
  const readWarmEvents = (): Array<Record<string, unknown>> =>
    readFileSync(join(cwd, ".pi", "warm-cache.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const rotationHarness = (
    sessionId: string,
    model: any,
    payloads: Array<Record<string, unknown>>,
  ) => {
    const ctx = makeWarmCtx(sessionId, model);
    const warmer = new SessionWarmer(
      { getThinkingLevel: () => "off" } as any,
      async (): Promise<any> => ({ stopReason: "stop", usage: {} }),
    );
    warmer.bindContext(ctx);
    warmer.setConfig({ ...DEFAULT_CONFIG, logToFile: true, minCachedTokens: 10 });
    for (const payload of payloads) warmer.capturePayload(payload, ctx);
    const events = readWarmEvents();
    const rawKeys = payloads
      .map((payload) => payload.prompt_cache_key)
      .filter((key): key is string => typeof key === "string");
    const jsonl = readFileSync(join(cwd, ".pi", "warm-cache.jsonl"), "utf8");
    assert(
      rawKeys.every((key) => !jsonl.includes(key)),
      "the JSONL mirror must never contain a raw cache key",
    );
    const status = warmer.getStatusText();
    assert(
      rawKeys.every((key) => !status.includes(key)),
      "status must never contain a raw cache key",
    );
    return { warmer, events };
  };

  const openaiCompletionsModel = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  } as any;
  const openaiSecret = "openai-rotation-key-abc123";
  const openaiFp = rotationHarness("openai-fp-session", openaiCompletionsModel, [
    {
      model: "gpt-5.6",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: openaiSecret,
    },
  ]);
  assert(
    /^[0-9a-f]{8}$/.test((openaiFp.warmer as any).anchor.cacheKeyFingerprint),
    "first-party OpenAI completions capture must store the redacted fingerprint",
  );
  assert(
    (openaiFp.warmer as any).anchor.cacheKeyFingerprint !== openaiSecret,
    "the OpenAI anchor must never store the raw completions key",
  );
  const goSecret = "go-rotation-key-xyz789";
  const goFp = rotationHarness("go-fp-session", goCompletionsModel, [
    { ...goCompletionsPayload, prompt_cache_key: goSecret },
  ]);
  assert(
    /^[0-9a-f]{8}$/.test((goFp.warmer as any).anchor.cacheKeyFingerprint),
    "opencode-go completions capture must store the redacted fingerprint",
  );
  assert(
    (goFp.warmer as any).anchor.cacheKeyFingerprint !== goSecret,
    "the Go anchor must never store the raw completions key",
  );

  // xAI key-change gating pins. The gate requires provider === "xai" &&
  // api === "openai-responses": xai responses rotation uses the xAI reason;
  // xai completions rotation and opencode-go responses rotation use the
  // generic "prefix changed" re-anchor with cacheKeyChanged=false.
  const xaiResponsesModel = {
    id: "grok-4.5",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    compat: { sessionAffinityFormat: "openai", supportsLongCacheRetention: false },
  } as any;
  const xaiResponsesRotation = rotationHarness("xai-responses-rotation", xaiResponsesModel, [
    {
      model: "grok-4.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      prompt_cache_key: "xai-responses-key-alpha",
    },
    {
      model: "grok-4.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      prompt_cache_key: "xai-responses-key-beta",
    },
  ]);
  assert(
    xaiResponsesRotation.warmer.getLatestRealTurnObservation()?.reason ===
      "xAI best-effort prompt_cache_key changed",
    "xai responses rotation must use the xAI reason",
  );
  const xaiCaptures = xaiResponsesRotation.events.filter((event) => event.event === "capture");
  assert(
    (xaiCaptures.at(-1) as any)?.cacheKeyChanged === true,
    "xai responses rotation must set cacheKeyChanged=true",
  );
  assert(
    (xaiCaptures.at(-1) as any)?.prefixChanged === true,
    "xai responses rotation must re-anchor on the changed key",
  );

  const xaiCompletionsModel = {
    id: "grok-4.5",
    provider: "xai",
    api: "openai-completions",
    baseUrl: "https://api.x.ai/v1",
  } as any;
  const xaiCompletionsRotation = rotationHarness("xai-completions-rotation", xaiCompletionsModel, [
    {
      model: "grok-4.5",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "xai-completions-key-alpha",
    },
    {
      model: "grok-4.5",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "xai-completions-key-beta",
    },
  ]);
  assert(
    xaiCompletionsRotation.warmer.getLatestRealTurnObservation()?.reason === "prefix changed",
    "xai completions rotation must use the generic prefix-changed reason",
  );
  const xaiCompletionsCaptures = xaiCompletionsRotation.events.filter(
    (event) => event.event === "capture",
  );
  assert(
    (xaiCompletionsCaptures.at(-1) as any)?.cacheKeyChanged === false,
    "xai completions rotation must keep cacheKeyChanged=false",
  );
  assert(
    (xaiCompletionsCaptures.at(-1) as any)?.prefixChanged === true,
    "xai completions rotation must still re-anchor via the generic path",
  );

  const goResponsesModel = {
    id: "deepseek-v4-flash",
    provider: "opencode-go",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
  } as any;
  const goResponsesRotation = rotationHarness("go-responses-rotation", goResponsesModel, [
    {
      model: "deepseek-v4-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      prompt_cache_key: "go-responses-key-alpha",
    },
    {
      model: "deepseek-v4-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      prompt_cache_key: "go-responses-key-beta",
    },
  ]);
  assert(
    goResponsesRotation.warmer.getLatestRealTurnObservation()?.reason === "prefix changed",
    "opencode-go responses rotation must use the generic prefix-changed reason",
  );
  const goResponsesCaptures = goResponsesRotation.events.filter(
    (event) => event.event === "capture",
  );
  assert(
    (goResponsesCaptures.at(-1) as any)?.cacheKeyChanged === false,
    "opencode-go responses rotation must keep cacheKeyChanged=false",
  );
  assert(
    (goResponsesCaptures.at(-1) as any)?.prefixChanged === true,
    "opencode-go responses rotation must re-anchor via the generic path",
  );

  // isXaiRoute() stays provider-keyed: an opencode-go grok-4.5 route is not
  // xAI even when the model id matches a direct xAI best-effort model.
  const goGrokCtx = makeWarmCtx("go-grok-route", {
    provider: "opencode-go",
    id: "grok-4.5",
    api: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  const goGrokWarmer = new SessionWarmer(
    { getThinkingLevel: () => "off" } as any,
    async (): Promise<any> => ({ stopReason: "stop", usage: {} }),
  );
  goGrokWarmer.bindContext(goGrokCtx);
  assert(!goGrokWarmer.isXaiRoute(), "an opencode-go grok-4.5 route must not be xAI-keyed");
  const xaiGrokCtx = makeWarmCtx("xai-grok-route", xaiResponsesModel);
  const xaiGrokWarmer = new SessionWarmer(
    { getThinkingLevel: () => "off" } as any,
    async (): Promise<any> => ({ stopReason: "stop", usage: {} }),
  );
  xaiGrokWarmer.bindContext(xaiGrokCtx);
  assert(xaiGrokWarmer.isXaiRoute(), "a direct xai grok-4.5 route must be xAI-keyed");

  // Label-driven UI copy: Go best-effort waiting/hit lines render the Go label
  // and never xAI; the " session" join and the title-case difference are
  // snapshot-pinned. A past nextDueAt pins the wait label to the plan interval.
  const goUiCalls: Array<{ kind: "widget" | "status"; value: unknown }> = [];
  const goUiCtx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value: unknown) => goUiCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value: unknown) => goUiCalls.push({ kind: "status", value }),
    },
  } as any;
  const goAnchor = {
    cachedTokens: 128_000,
    promptTokens: 128_000,
    probeHitCount: 2,
    probeMissCount: 0,
    savingsKnown: true,
    estimatedSavingsUsd: 0.12,
    // A verified probing route: automaticWarm true, so savings render.
    capability: { state: "verified", automaticWarm: true },
    provider: "opencode-go",
  } as any;
  const goPlan = {
    family: "opencode-go-plain",
    intervalMs: 240_000,
    ttlLabel: "best-effort probe cadence (~4m)",
    waitLabel: "4m",
    automaticWarm: true,
    manualProbe: false,
    cacheRetention: "short",
  } as any;
  renderWaitingUi(goUiCtx, { ...DEFAULT_CONFIG, showWidget: true }, goAnchor, goPlan, Date.now() - 60_000);
  renderWarmHitUi(goUiCtx, { ...DEFAULT_CONFIG, showWidget: true }, goAnchor, goPlan, 128_000);
  const goWidgets = goUiCalls
    .filter((call) => call.kind === "widget")
    .map((call) => call.value as string[]);
  assert(
    goWidgets[0]![0] === "⚡ OpenCode Go best-effort cache-warm wait · extension probe in 4m",
    "Go waiting L1 must use the Go label with lowercase cache-warm",
  );
  assert(
    goWidgets[0]![1] === "OpenCode Go best-effort cadence · ~128k prefix",
    "Go waiting L2 must use the Go label cadence line",
  );
  assert(
    goWidgets[0]![2].includes("OpenCode Go best-effort session est. $0.12 saved"),
    "Go savings prefix must join the label with ' session'",
  );
  assert(
    goWidgets[1]![0] === "⚡ OpenCode Go best-effort cache warm · extension probe hit · ~128k",
    "Go hit L1 must use the Go label",
  );
  assert(
    goWidgets[1]![1] === "Next extension probe in 4m · no fixed cache lifetime promised.",
    "Go hit L2 must avoid the xAI lifetime wording",
  );
  const goUiText = goUiCalls
    .flatMap((call) => (Array.isArray(call.value) ? call.value : [String(call.value)]))
    .map(String)
    .join(" ");
  assert(!goUiText.includes("xAI"), "Go UI must never render the xAI label");
  const goStatus = goUiCalls
    .filter((call) => call.kind === "status")
    .map((call) => String(call.value));
  assert(
    goStatus.some((status) => status.startsWith("OpenCode Go best-effort warm 4m ·")),
    "Go status must carry the Go label prefix",
  );

  // xAI waiting/hit lines stay byte-identical when the same renderers compute
  // the label from an xai-best-effort family.
  const xaiPinCalls: Array<{ kind: "widget" | "status"; value: unknown }> = [];
  const xaiPinCtx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value: unknown) => xaiPinCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value: unknown) => xaiPinCalls.push({ kind: "status", value }),
    },
  } as any;
  const xaiPinAnchor = { ...goAnchor, provider: "xai" } as any;
  const xaiPinPlan = {
    ...goPlan,
    family: "xai-best-effort",
    ttlLabel: "xAI best-effort probe cadence",
  } as any;
  renderWaitingUi(xaiPinCtx, { ...DEFAULT_CONFIG, showWidget: true }, xaiPinAnchor, xaiPinPlan, Date.now() - 60_000);
  renderWarmHitUi(xaiPinCtx, { ...DEFAULT_CONFIG, showWidget: true }, xaiPinAnchor, xaiPinPlan, 128_000);
  const xaiPinWidgets = xaiPinCalls
    .filter((call) => call.kind === "widget")
    .map((call) => call.value as string[]);
  assert(
    xaiPinWidgets[0]![0] === "⚡ xAI best-effort cache-warm wait · extension probe in 4m",
    "xai waiting L1 must stay byte-identical",
  );
  assert(
    xaiPinWidgets[0]![1] === "xAI best-effort cadence · ~128k prefix",
    "xai waiting L2 must stay byte-identical",
  );
  assert(
    xaiPinWidgets[0]![2].includes("xAI best-effort session est. $0.12 saved"),
    "xai savings prefix must stay byte-identical",
  );
  assert(
    xaiPinWidgets[1]![0] === "⚡ xAI best-effort cache warm · extension probe hit · ~128k",
    "xai hit L1 must stay byte-identical",
  );
  assert(
    xaiPinWidgets[1]![1] === "Next extension probe in 4m · no fixed xAI cache lifetime promised.",
    "xai hit L2 must keep its exact wording",
  );
  const xaiPinStatus = xaiPinCalls
    .filter((call) => call.kind === "status")
    .map((call) => String(call.value));
  assert(
    xaiPinStatus.some((status) => status.startsWith("xAI best-effort warm 4m ·")),
    "xai status must stay byte-identical",
  );

  // An explicit non-xai label wins over "xai" in detail text (the
  // post-promotion conflation path: a Go gateway error containing xai must not
  // label the widget as xAI). Without a label, the sniff still applies.
  const labelWinCalls: Array<{ kind: "widget" | "status"; value: unknown }> = [];
  const labelWinCtx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value: unknown) => labelWinCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value: unknown) => labelWinCalls.push({ kind: "status", value }),
    },
  } as any;
  renderFailureUi(
    labelWinCtx,
    { ...DEFAULT_CONFIG, showWidget: true },
    "probe miss",
    "gateway xai error: timeout",
    undefined,
    "OpenCode Go best-effort",
  );
  const labelWinText = labelWinCalls
    .flatMap((call) => (Array.isArray(call.value) ? call.value : [String(call.value)]))
    .map(String)
    .join(" ");
  assert(
    !labelWinText.includes("xAI best-effort"),
    "an explicit non-xai label must beat xai in detail text",
  );
  const sniffCalls: Array<{ kind: "widget" | "status"; value: unknown }> = [];
  const sniffCtx = {
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, value: unknown) => sniffCalls.push({ kind: "widget", value }),
      setStatus: (_id: string, value: unknown) => sniffCalls.push({ kind: "status", value }),
    },
  } as any;
  renderFailureUi(
    sniffCtx,
    { ...DEFAULT_CONFIG, showWidget: true },
    "probe miss",
    "gateway xai error: timeout",
  );
  const sniffText = sniffCalls
    .flatMap((call) => (Array.isArray(call.value) ? call.value : [String(call.value)]))
    .map(String)
    .join(" ");
  assert(
    sniffText.includes("xAI best-effort"),
    "the xai sniff must still apply when no label is given",
  );

  // Budget-dollar savings framing: the marker keys on the billing identity
  // (provider === "opencode-go"), never on payload instrumentation.
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0.23,
      savingsKnown: true,
      pricingSource: "model",
      provider: "opencode-go",
      capability: {
        state: "verified",
        reason: "fixture",
        automaticWarm: true,
        manualProbe: false,
      },
    }) === "est. $0.23 saved (subscription budget-dollars)",
    "Go positive savings must carry the budget-dollars phrase",
  );
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: -0.0023,
      savingsKnown: true,
      pricingSource: "model",
      provider: "opencode-go",
    }).includes("(subscription budget-dollars)"),
    "Go negative-net savings must carry the budget-dollars phrase",
  );
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0.23,
      savingsKnown: true,
      pricingSource: "model",
      provider: "openai",
    }) === "est. $0.23 saved",
    "non-Go routes must stay byte-identical",
  );
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0,
      savingsKnown: false,
      pricingSource: "unknown",
      provider: "opencode-go",
    }) === "n/a (no model pricing)",
    "n/a branches never carry the budget-dollars phrase",
  );
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0,
      savingsKnown: false,
      pricingSource: "unknown",
      capability: {
        state: "unverified",
        reason: "fixture",
        automaticWarm: false,
        manualProbe: true,
      },
      provider: "opencode-go",
    }) === "n/a (unverified route)",
    "unverified n/a branch never carries the budget-dollars phrase",
  );
  assert(
    formatSavingsSummary({
      probeHitCount: 2,
      probeMissCount: 1,
      totalEstimatedSavedUsd: 0.0045,
      totalProbeCostUsd: 0.01,
      savingsKnown: true,
      pricingSource: "model",
      provider: "opencode-go",
    }) ===
      "probeHits=2 probeMisses=1 totalEstimatedSaved=$0.0045 totalProbeCost=$0.01 net=-$0.0055 pricingSource=model savingsUnit=budget-dollars",
    "Go summary must append savingsUnit=budget-dollars as the last field",
  );
  assert(
    formatSavingsSummary({
      probeHitCount: 2,
      probeMissCount: 1,
      totalEstimatedSavedUsd: 0.0045,
      totalProbeCostUsd: 0.01,
      savingsKnown: true,
      pricingSource: "model",
      provider: "openai",
    }) ===
      "probeHits=2 probeMisses=1 totalEstimatedSaved=$0.0045 totalProbeCost=$0.01 net=-$0.0055 pricingSource=model",
    "non-Go summary must stay byte-identical",
  );
  assert(
    formatSavingsSummary({
      probeHitCount: 2,
      probeMissCount: 1,
      totalEstimatedSavedUsd: 0.0045,
      totalProbeCostUsd: 0.01,
      savingsKnown: true,
      pricingSource: "model",
    }) ===
      "probeHits=2 probeMisses=1 totalEstimatedSaved=$0.0045 totalProbeCost=$0.01 net=-$0.0055 pricingSource=model",
    "missing provider must emit no savingsUnit marker",
  );

  rmSync(cwd, { recursive: true, force: true });
}

console.log("provider.test.ts: all assertions passed");
