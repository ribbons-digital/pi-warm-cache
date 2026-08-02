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
  CODEX_WARM_OUTPUT_ABORT_TOKENS,
  decideCodexOversizedAction,
  isCodexPayload,
  minimumOutputTokensForPayload,
  modelSupportsLongCacheRetention,
  OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
  payloadHasAnthropicLongTtl,
  resolveStrategy,
  stableFingerprint,
  WARM_MUTABLE_PAYLOAD_KEYS,
} from "./provider.ts";
import { estimateSavedUsd, formatSavingsLabel, resolveModelPricing } from "./savings.ts";
import { DEFAULT_CONFIG } from "./types.ts";

function assert(cond: unknown, msg: string): void {
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
  assert(short.intervalMs < 5 * 60_000, "short interval must be inside 5m");
  assert(short.intervalMs >= 3 * 60_000, "short interval should be roughly 4m");

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
  assert(long.intervalMs < 60 * 60_000, "long interval must be inside 1h");
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
  assert(oai.intervalMs < 30 * 60_000, "openai interval inside 30m");

  const openaiOld = {
    id: "o3",
    provider: "openai",
    api: "openai-responses",
  } as any;
  const old = resolveStrategy(openaiOld, DEFAULT_CONFIG);
  assert(old.family === "openai-implicit", "without compat flag, OpenAI stays implicit");
}

// 4) minimumOutputTokensForPayload helper
{
  const n = minimumOutputTokensForPayload({ thinking: { type: "enabled", budget_tokens: 100 } }, 1);
  assert(n === 101, `expected 101, got ${n}`);
}

// 5) Payload fingerprint changes when payload changes
{
  const a = stableFingerprint({ messages: [{ role: "user", content: "a" }] });
  const b = stableFingerprint({ messages: [{ role: "user", content: "b" }] });
  assert(a !== b, "different payloads must fingerprint differently");
  assert(a === stableFingerprint({ messages: [{ role: "user", content: "a" }] }), "stable");
}

// 6) Savings pricing: zero-cost proxy => n/a (do not invent catalog rates)
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

console.log("provider.test.ts: all assertions passed");
