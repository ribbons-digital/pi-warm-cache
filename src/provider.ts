import type { CacheRetention, Model } from "@earendil-works/pi-ai";
import type { AnthropicTtlMode, CacheFamily, StrategyPlan, WarmCacheConfig } from "./types.ts";
import { formatDurationShort } from "./config.ts";

/** Anthropic short TTL. Ping inside the window. */
export const ANTHROPIC_SHORT_TTL_MS = 5 * 60_000;
/** Anthropic long TTL when cache_control.ttl = 1h. */
export const ANTHROPIC_LONG_TTL_MS = 60 * 60_000;
/** OpenAI explicit prompt_cache_options.ttl = 30m (minimum lifetime). */
export const OPENAI_EXPLICIT_TTL_MS = 30 * 60_000;
/** Older OpenAI in-memory idle window. Conservative. */
export const OPENAI_IMPLICIT_TTL_MS = 8 * 60_000;

/** Default ping delay as a fraction of TTL (stay safely inside). */
const DEFAULT_TTL_FRACTION = 0.8;

/** Backoff when warm is deferred because agent is busy or gate is full. */
export const DEFER_BACKOFF_MS = 30_000;

export function isAnthropicModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  if (model.api === "anthropic-messages") return true;
  if (model.provider === "anthropic") return true;
  const compat = (model as { compat?: { cacheControlFormat?: string } }).compat;
  return compat?.cacheControlFormat === "anthropic";
}

export function isOpenAIModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  if (isAnthropicModel(model)) return false;
  return (
    model.api === "openai-responses" ||
    model.api === "openai-completions" ||
    model.api === "openai-codex-responses" ||
    model.api === "azure-openai-responses" ||
    model.provider === "openai" ||
    model.provider === "openai-codex"
  );
}

export function supportsPromptCache(model: Model<any> | undefined): boolean {
  if (!model) return false;
  return isAnthropicModel(model) || isOpenAIModel(model);
}

type ModelCompat = {
  cacheControlFormat?: string;
  /** Default true when unset. Explicit false rejects long retention fields. */
  supportsLongCacheRetention?: boolean;
  /**
   * Whether the model accepts prompt_cache_options (OpenAI GPT-5.6+ explicit prompt caching).
   * Older OpenAI models reject the parameter. Default: false.
   */
  supportsExplicitPromptCacheMode?: boolean;
};

function getModelCompat(model: Model<any> | undefined): ModelCompat | undefined {
  return (model as { compat?: ModelCompat } | undefined)?.compat;
}

/**
 * Pi defaults supportsLongCacheRetention to true when unset.
 * Only an explicit false means the route rejects long retention fields.
 */
export function modelSupportsLongCacheRetention(model: Model<any> | undefined): boolean {
  if (!model) return false;
  if (getModelCompat(model)?.supportsLongCacheRetention === false) return false;
  return true;
}

/**
 * Authoritative OpenAI explicit prompt-cache flag from pi-ai.
 * Do not guess from model id strings (o3/gpt-4.1 false positives, future id misses).
 */
export function modelSupportsExplicitPromptCacheMode(model: Model<any> | undefined): boolean {
  if (!model) return false;
  return getModelCompat(model)?.supportsExplicitPromptCacheMode === true;
}

/** True when the real provider payload already carries Anthropic 1h cache markers. */
export function payloadHasAnthropicLongTtl(payload: unknown): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.cache_control && typeof obj.cache_control === "object") {
      const cc = obj.cache_control as Record<string, unknown>;
      if (cc.type === "ephemeral" && cc.ttl === "1h") {
        found = true;
        return;
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(payload);
  return found;
}

export type StrategyResolution = StrategyPlan & {
  /**
   * User asked for 1h, but we stayed on short because either:
   * - model/route rejects long retention, or
   * - real session payload still uses short TTL (extension does not rewrite real turns)
   */
  longTtlDegradedReason: string | null;
};

export function resolveCacheFamily(
  model: Model<any> | undefined,
  anthropicTtl: AnthropicTtlMode,
  payload?: unknown,
): CacheFamily {
  if (!model) return "unsupported";
  if (isAnthropicModel(model)) {
    // Actual on-wire TTL wins. We never inject 1h onto real turns.
    if (payloadHasAnthropicLongTtl(payload)) return "anthropic-long";
    if (anthropicTtl === "1h" && modelSupportsLongCacheRetention(model)) {
      // User wants 1h cadence, but payload is still short. Stay short until Pi emits 1h.
      return "anthropic-short";
    }
    return "anthropic-short";
  }
  if (isOpenAIModel(model)) {
    return modelSupportsExplicitPromptCacheMode(model) ? "openai-explicit" : "openai-implicit";
  }
  return "unsupported";
}

export function resolveCacheRetention(family: CacheFamily): CacheRetention {
  switch (family) {
    case "anthropic-long":
      return "long";
    case "anthropic-short":
    case "openai-explicit":
    case "openai-implicit":
      return "short";
    default:
      return "none";
  }
}

export function resolveStrategy(
  model: Model<any> | undefined,
  config: WarmCacheConfig,
  payload?: unknown,
): StrategyResolution {
  const family = resolveCacheFamily(model, config.anthropicTtl, payload);
  const cacheRetention = resolveCacheRetention(family);

  let longTtlDegradedReason: string | null = null;
  if (isAnthropicModel(model) && config.anthropicTtl === "1h" && family !== "anthropic-long") {
    if (!modelSupportsLongCacheRetention(model)) {
      longTtlDegradedReason = "model/route does not support long cache retention";
    } else {
      longTtlDegradedReason =
        "session payload still uses short TTL; set Pi cache retention to long (extension does not rewrite real turns)";
    }
  }

  let ttlMs = ANTHROPIC_SHORT_TTL_MS;
  let ttlLabel = "5m prompt-cache TTL";

  switch (family) {
    case "anthropic-short":
      ttlMs = ANTHROPIC_SHORT_TTL_MS;
      ttlLabel = "5m prompt-cache TTL";
      break;
    case "anthropic-long":
      ttlMs = ANTHROPIC_LONG_TTL_MS;
      ttlLabel = "1h prompt-cache TTL";
      break;
    case "openai-explicit":
      ttlMs = OPENAI_EXPLICIT_TTL_MS;
      ttlLabel = "30m prompt-cache TTL";
      break;
    case "openai-implicit":
      ttlMs = OPENAI_IMPLICIT_TTL_MS;
      ttlLabel = "~8m idle cache window";
      break;
    default:
      ttlMs = ANTHROPIC_SHORT_TTL_MS;
      ttlLabel = "unsupported";
  }

  const intervalMs =
    config.intervalMs ?? Math.max(30_000, Math.floor(ttlMs * DEFAULT_TTL_FRACTION));

  return {
    family,
    cacheRetention,
    intervalMs,
    ttlLabel,
    waitLabel: formatDurationShort(intervalMs),
    longTtlDegradedReason,
  };
}

/**
 * OpenAI Responses rejects max_output_tokens below 16.
 * Source in pi-ai: dist/api/openai-responses.js
 *   "OpenAI Responses rejects max_output_tokens below 16"
 *   https://github.com/earendil-works/pi/issues/6265
 */
export const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * Codex has no hard output-token field. OK-suffix ticks measured out=5/17/32;
 * bare replay hit out=1127. Threshold is for clearly abnormal suffix ticks,
 * not normal variance. First oversized tick soft-skips; a second consecutive
 * oversized tick sticky-blocks until /warm resume.
 */
export const CODEX_WARM_OUTPUT_ABORT_TOKENS = 256;

export type CodexOversizedDecision = "ok" | "soft-skip" | "sticky-block";

/**
 * Pure policy for Codex oversized warm ticks.
 * - under threshold: reset streak, continue normally
 * - first oversized: soft-skip (reschedule, no sticky block)
 * - second consecutive oversized: sticky-block until /warm resume
 */
export function decideCodexOversizedAction(
  outputTokens: number,
  consecutiveOversizedBefore: number,
  threshold: number = CODEX_WARM_OUTPUT_ABORT_TOKENS,
): { decision: CodexOversizedDecision; consecutiveAfter: number } {
  if (outputTokens < threshold) {
    return { decision: "ok", consecutiveAfter: 0 };
  }
  const consecutiveAfter = consecutiveOversizedBefore + 1;
  if (consecutiveAfter < 2) {
    return { decision: "soft-skip", consecutiveAfter };
  }
  return { decision: "sticky-block", consecutiveAfter };
}

/** Detect ChatGPT Codex request bodies (no max_output_tokens support). */
export function isCodexPayload(payload: Record<string, unknown>): boolean {
  // Codex bodies use instructions + input + store:false and never ship max_output_tokens.
  return (
    typeof payload.instructions === "string" &&
    Array.isArray(payload.input) &&
    payload.store === false &&
    typeof payload.prompt_cache_key === "string"
  );
}

/**
 * Append a constrained warm user turn AFTER the cached prefix.
 * Does not edit earlier messages/tools/instructions (prefix stays cacheable).
 * This steers the model away from continuing the agent trajectory on replay.
 */
export function appendWarmUserTurn(
  payload: unknown,
  text: string,
  api?: string,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (!text || !text.trim()) return payload;
  const p = payload as Record<string, unknown>;
  const content = text.trim();

  if (Array.isArray(p.input)) {
    // OpenAI Responses / Codex shape
    p.input = [
      ...(p.input as unknown[]),
      {
        role: "user",
        content: [{ type: "input_text", text: content }],
      },
    ];
    return p;
  }

  if (Array.isArray(p.messages)) {
    // Anthropic Messages / Chat Completions shape
    const anthropic =
      api === "anthropic-messages" ||
      (Array.isArray(p.system) && typeof p.model === "string");
    p.messages = [
      ...(p.messages as unknown[]),
      anthropic
        ? { role: "user", content: [{ type: "text", text: content }] }
        : { role: "user", content },
    ];
    return p;
  }

  return p;
}

/**
 * Mutate a cloned provider payload so the warm request stays on the same
 * cached prefix but emits almost no *completion* tokens.
 *
 * SAFETY RULES:
 * - Never edit earlier prefix content: instructions/system, prior input/messages,
 *   tools, cache_control. Those are the cache identity.
 * - Codex-only: a trailing warm user turn MAY be appended (appendWarmUserTurn).
 *   That is intentional suffix steering after the cached region, not mid-prefix edits.
 *   Not used for Anthropic (output already capped; consecutive user roles can 400).
 * - Anthropic: thinking budget is cache-sensitive; only raise max_tokens above it.
 * - Codex: max_output_tokens is unsupported (API error). Do not inject it.
 *   Do not change reasoning.effort unless a same-session probe proves cache-safe.
 * - OpenAI Responses (non-Codex): max_output_tokens floor is 16
 *   (pi-ai / github.com/earendil-works/pi/issues/6265).
 */
export function applyWarmOutputLimit(
  payload: unknown,
  maxOutputTokens: number,
  api?: string,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;

  const codex = api === "openai-codex-responses" || isCodexPayload(p);
  if (codex) {
    // Codex rejects hard output caps. Strip if a caller injected them.
    delete p.max_output_tokens;
    delete p.max_tokens;
    delete p.max_completion_tokens;
    // Leave reasoning.effort / tool_choice identical (no same-session proof yet).
    return p;
  }

  let floor = minimumOutputTokensForPayload(p, maxOutputTokens);
  const openAiResponses =
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    ("max_output_tokens" in p && Array.isArray(p.input));
  if (openAiResponses) {
    floor = Math.max(floor, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
  }

  let touched = false;
  if ("max_output_tokens" in p) {
    p.max_output_tokens = floor;
    touched = true;
  }
  if ("max_completion_tokens" in p) {
    p.max_completion_tokens = floor;
    touched = true;
  }
  if ("max_tokens" in p) {
    p.max_tokens = floor;
    touched = true;
  }

  // Only add a cap when we know the API and the original body had none.
  if (!touched) {
    if (api === "anthropic-messages") {
      p.max_tokens = floor;
    } else if (api === "openai-responses" || api === "azure-openai-responses") {
      p.max_output_tokens = floor;
    } else if (api === "openai-completions") {
      p.max_completion_tokens = floor;
    }
    // Unknown API shapes: leave unchanged rather than guess a rejected field.
  }

  return p;
}

/** Lowest legal output cap that still satisfies thinking-budget constraints. */
export function minimumOutputTokensForPayload(
  payload: Record<string, unknown>,
  preferred: number,
): number {
  let floor = Math.max(1, preferred);

  const thinking = payload.thinking;
  if (thinking && typeof thinking === "object") {
    const t = thinking as Record<string, unknown>;
    if (t.type === "enabled" && typeof t.budget_tokens === "number" && t.budget_tokens >= 0) {
      // Anthropic: max_tokens must be greater than budget_tokens.
      floor = Math.max(floor, Math.floor(t.budget_tokens) + 1);
    }
  }

  return floor;
}

/**
 * Fields that applyWarmOutputLimit is allowed to change.
 * Used by tests to assert deep equality elsewhere.
 */
export const WARM_MUTABLE_PAYLOAD_KEYS = new Set([
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
]);

/** Fast stable-ish fingerprint for payload identity / logging. */
export function stableFingerprint(payload: unknown): string {
  const json = JSON.stringify(payload);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}:${json.length}`;
}
