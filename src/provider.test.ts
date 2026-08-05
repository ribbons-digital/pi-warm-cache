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
  OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
  payloadHasAnthropicLongTtl,
  resolveProviderCapability,
  resolveStrategy,
  stableFingerprint,
  WARM_MUTABLE_PAYLOAD_KEYS,
} from "./provider.ts";
import {
  buildWarmResult,
  estimateSavedUsd,
  formatSavingsLabel,
  resolveModelPricing,
} from "./savings.ts";
import { SessionWarmer } from "./warmer.ts";
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

  const openaiExplicit = {
    id: "gpt-5.6",
    provider: "openai",
    api: "openai-responses",
    compat: { supportsExplicitPromptCacheMode: true },
  } as any;
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

  const directXai = {
    id: "grok-4.5",
    provider: "xai",
    api: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
  } as any;
  const xaiCapability = resolveProviderCapability(directXai);
  assert(xaiCapability.state === "unverified", "direct xAI must be unverified");
  assert(!xaiCapability.automaticWarm, "unverified xAI must not auto-warm");
  assert(xaiCapability.manualProbe, "direct xAI may expose a manual probe");
  const insecureXai = { ...directXai, baseUrl: "http://api.x.ai/v1" } as any;
  assert(
    resolveProviderCapability(insecureXai).state === "unsupported",
    "HTTP xAI routes must not receive first-party capability",
  );
  const xai = resolveStrategy(directXai, DEFAULT_CONFIG);
  assert(xai.family === "unverified", "xAI must not inherit OpenAI family wording");
  assert(xai.intervalMs === null, "unverified xAI must not receive a timer interval");
  assert(xai.ttlLabel.includes("unverified"), "xAI must not receive a fixed TTL label");

  const xaiPayload = {
    model: "grok-4.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };
  assert(isSafeReplayPayload(xaiPayload, directXai.api), "Responses payload should be probe-safe");
  assert(canManualProbe(directXai, xaiPayload), "safe xAI payload should allow a manual probe");
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
  assert(
    resolveProviderCapability(unknownResponses).state === "unsupported",
    "unknown OpenAI-compatible routes must be unsupported",
  );
  assert(!canManualProbe(unknownResponses, xaiPayload), "unknown routes must reject manual probes");

  const unverifiedProbe = buildWarmResult({
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
  assert(unverifiedProbe.cacheHit, "unverified probe should retain observed cache-read result");
  assert(unverifiedProbe.probeOutcome === "hit", "probe result should identify a probe hit");
  assert(unverifiedProbe.estimatedSavedUsd === 0, "unverified probe must not claim savings");
  const rejectedProbe = buildWarmResult({
    fingerprint: "unsafe-xai-payload",
    error: "captured payload shape is not safe",
    unavailable: true,
    anchor: {
      inputPricePerMTok: 2,
      cacheReadPricePerMTok: 0.3,
      savingsKnown: false,
      capability: xaiCapability,
    },
  });
  assert(rejectedProbe.unavailable === true, "policy rejection must be marked unavailable");
  assert(rejectedProbe.probeOutcome === "unavailable", "rejected probe should be unavailable, not a miss");
  assert(
    formatSavingsLabel({
      estimatedSavingsUsd: 0,
      savingsKnown: false,
      pricingSource: "model",
      capability: xaiCapability,
    }) === "n/a (unverified route)",
    "unverified route must not use the no-pricing message for savings",
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

// 9) Session warmer keeps real-turn observations, probe outcomes, and retries separate.
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
  warmer.capturePayload(
    {
      model: model.id,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      prompt_cache_key: "warmer-test",
    },
    ctx,
  );
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
  assert(warmer.getLatestProbeObservation()?.outcome === "payload-drift", "status should retain payload drift");
  assert(warmer.getStatusText().includes("payload=none"), "payload drift should clear the replay payload");
  assert(notifications.some((entry) => entry.level === "warning"), "payload drift should warn immediately");
  warmer.dispose();
}

console.log("provider.test.ts: all assertions passed");
