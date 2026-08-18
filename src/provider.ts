import type { CacheRetention, Model } from "@earendil-works/pi-ai";
import { formatDurationShort } from "./config.ts";
import type { PayloadObject } from "./capability.ts";
import {
  classifyOpencodeGoFamily,
  getPromptCacheKey,
  hasStableResponsesCacheKey,
  isDirectXaiGrokRoute,
  isSafeReplayPayload,
  isSafeXaiReplayPayload,
  payloadObject,
  resolveProviderCapability,
} from "./capability.ts";
import type {
  AnthropicTtlMode,
  CacheFamily,
  ProviderCapability,
  ProbeOutcome,
  RealTurnObservation,
  StrategyPlan,
  WarmCacheConfig,
} from "./types.ts";

export {
  canManualProbe,
  classifyOpencodeGoFamily,
  getPromptCacheKey,
  hasStableResponsesCacheKey,
  hasXaiPromptCacheKey,
  isDirectXaiGrokRoute,
  isSafeReplayPayload,
  isSafeXaiReplayPayload,
  isStablePromptCacheKey,
  opencodeGoForeignInstrumentationReason,
  payloadHasCacheControl,
  payloadObject,
  PROXY_ROUTE_REGISTRY,
  resolveProviderCapability,
} from "./capability.ts";
export type { ProviderCapability, ProviderCapabilityState } from "./types.ts";

/** Anthropic short TTL. Ping inside the window. */
export const ANTHROPIC_SHORT_TTL_MS = 5 * 60_000;
/** Anthropic long TTL when cache_control.ttl = 1h. */
export const ANTHROPIC_LONG_TTL_MS = 60 * 60_000;
/** OpenAI explicit prompt_cache_options.ttl = 30m (minimum lifetime). */
export const OPENAI_EXPLICIT_TTL_MS = 30 * 60_000;
/** Older OpenAI in-memory idle window. Conservative. */
export const OPENAI_IMPLICIT_TTL_MS = 8 * 60_000;
/** xAI Grok best-effort cadence. This is an operational heuristic, not a TTL. */
export const XAI_BEST_EFFORT_INTERVAL_MS = 4 * 60_000;

/** Default ping delay as a fraction of TTL (stay safely inside). */
const DEFAULT_TTL_FRACTION = 0.8;

/** Idle-cutoff floor shared by every family (max(30m, 2 x referenceMs)). */
const MIN_IDLE_CUTOFF_MS = 30 * 60_000;

/**
 * True for families whose probes may not report cache-write usage: direct xAI
 * best-effort and the OpenCode Go marker/plain families. The retained Go
 * family never probes and is excluded structurally.
 */
export function isBestEffortNoWriteFamily(family: CacheFamily): boolean {
  return (
    family === "xai-best-effort" ||
    family === "opencode-go-long-marker" ||
    family === "opencode-go-short-marker" ||
    family === "opencode-go-plain"
  );
}

/**
 * Human label for a best-effort cache family, or null for every other family.
 *
 * Family-driven only: never model-id driven. Unverified routes collapse the
 * family to "unverified", so a caller that still needs an xAI label on that
 * collapsed surface (for example the warmer idle/reanchor/failure UI) falls
 * back on provider identity after this returns null.
 */
export function bestEffortFamilyLabel(family: CacheFamily | undefined): string | null {
  if (family === "xai-best-effort") return "xAI best-effort";
  if (
    family === "opencode-go-long-marker" ||
    family === "opencode-go-short-marker" ||
    family === "opencode-go-plain"
  ) {
    return "OpenCode Go best-effort";
  }
  return null;
}

/**
 * Idle warm cutoff for a family: max(30m, 2 x referenceMs), where referenceMs
 * is the family TTL when one exists and the effective interval otherwise.
 * Only xai-best-effort is interval-referenced; TTL families ignore interval
 * overrides.
 *
 * - config.maxIdleWarmMs null: formula.
 * - config.maxIdleWarmMs 0: no cutoff (warm until failure), returns null.
 * - config.maxIdleWarmMs positive: literal cutoff.
 */
export function resolveMaxIdleWarmMs(
  config: WarmCacheConfig,
  family: CacheFamily,
  effectiveIntervalMs?: number,
): number | null {
  if (config.maxIdleWarmMs !== null) {
    return config.maxIdleWarmMs === 0 ? null : config.maxIdleWarmMs;
  }
  let referenceMs: number;
  switch (family) {
    case "anthropic-long":
    case "opencode-go-long-marker":
      referenceMs = ANTHROPIC_LONG_TTL_MS;
      break;
    case "openai-explicit":
      referenceMs = OPENAI_EXPLICIT_TTL_MS;
      break;
    case "openai-implicit":
      referenceMs = OPENAI_IMPLICIT_TTL_MS;
      break;
    case "xai-best-effort":
      referenceMs = effectiveIntervalMs ?? XAI_BEST_EFFORT_INTERVAL_MS;
      break;
    default:
      referenceMs = ANTHROPIC_SHORT_TTL_MS;
      break;
  }
  return Math.max(MIN_IDLE_CUTOFF_MS, 2 * referenceMs);
}

/** Backoff when warm is deferred because agent is busy or gate is full. */
export const DEFER_BACKOFF_MS = 30_000;

export function isAnthropicModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  if (model.api === "anthropic-messages") return true;
  if (model.provider === "anthropic") return true;
  return getModelCompat(model)?.cacheControlFormat === "anthropic";
}

export function isOpenAIModel(model: Model<any> | undefined): boolean {
  if (!model || isAnthropicModel(model)) return false;
  return (
    (model.provider === "openai" &&
      (model.api === "openai-responses" || model.api === "openai-completions")) ||
    (model.provider === "openai-codex" && model.api === "openai-codex-responses") ||
    (model.provider === "azure-openai-responses" && model.api === "azure-openai-responses")
  );
}

export function isXaiBestEffortModel(model: Model<any> | undefined): boolean {
  return isDirectXaiGrokRoute(model);
}

export function supportsPromptCache(model: Model<any> | undefined): boolean {
  return resolveProviderCapability(model).state !== "unsupported";
}

/** True when the route has a verified automatic keepalive strategy. */
export function supportsAutomaticWarm(model: Model<any> | undefined): boolean {
  return resolveProviderCapability(model).automaticWarm;
}

/** True when the route is allowed to make a one-shot manual probe. */
export function supportsManualProbe<Payload = undefined>(model: Model<any> | undefined, payload?: Payload): boolean {
  // The payload is passed through so payload-dependent gates (the direct xAI
  // key gate and the opencode-go foreign-instrumentation refusal) can disable
  // the manual probe for an unsafe exact payload. With no payload supplied the
  // resolution is unchanged: undefined payloads never trigger those gates.
  const capability = resolveProviderCapability(model, payload);
  if (!capability.manualProbe) return false;
  return payload === undefined ? true : isSafeReplayPayload(payload, model?.api);
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
  /**
   * The output-cap field this model accepts for openai-completions payloads.
   * All OpenCode Go completions models declare "max_tokens" and some upstreams
   * reject the unknown default field. Default when unset: "max_completion_tokens".
   */
  maxTokensField?: string;
};

/**
 * Return the model compat record.
 *
 * Exported for the warmer call site of `applyWarmOutputLimit`, which must pass
 * `maxTokensField` through so an uncapped completions payload is capped on the
 * field the model actually accepts.
 */
export function getModelCompat(model: Model<any> | undefined): ModelCompat | undefined {
  const compat = model?.compat;
  if (!compat) return undefined;
  return {
    cacheControlFormat:
      "cacheControlFormat" in compat ? compat.cacheControlFormat : undefined,
    supportsLongCacheRetention:
      "supportsLongCacheRetention" in compat ? compat.supportsLongCacheRetention : undefined,
    supportsExplicitPromptCacheMode:
      "supportsExplicitPromptCacheMode" in compat
        ? compat.supportsExplicitPromptCacheMode
        : undefined,
    maxTokensField: "maxTokensField" in compat ? compat.maxTokensField : undefined,
  };
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
export function payloadHasAnthropicLongTtl<Payload>(payload: Payload): boolean {
  let found = false;
  function visit<Node>(node: Node): void {
    if (found) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const body = payloadObject(node);
    if (!body) return;
    const cacheControl = payloadObject(body.cache_control);
    if (cacheControl?.type === "ephemeral" && cacheControl.ttl === "1h") {
      found = true;
      return;
    }
    for (const value of Object.values(body)) visit(value);
  }
  visit(payload);
  return found;
}

export type StrategyResolution = StrategyPlan & {
  capability: ProviderCapability;
  /**
   * User asked for 1h, but we stayed on short because either:
   * - model/route rejects long retention, or
   * - real session payload still uses short TTL (extension does not rewrite real turns)
   */
  longTtlDegradedReason: string | null;
};

function resolveVerifiedCacheFamily<Payload = undefined>(
  model: Model<any>,
  anthropicTtl: AnthropicTtlMode,
  payload?: Payload,
): CacheFamily {
  if (isAnthropicModel(model)) {
    // Actual on-wire TTL wins. We never inject 1h onto real turns.
    if (payloadHasAnthropicLongTtl(payload)) return "anthropic-long";
    if (anthropicTtl === "1h" && modelSupportsLongCacheRetention(model)) {
      // User wants 1h cadence, but payload is still short. Stay short until Pi emits 1h.
      return "anthropic-short";
    }
    return "anthropic-short";
  }
  if (isXaiBestEffortModel(model)) return "xai-best-effort";
  if (isOpenAIModel(model)) {
    return modelSupportsExplicitPromptCacheMode(model) ? "openai-explicit" : "openai-implicit";
  }
  return "unsupported";
}

const OPENCODE_GO_FAMILIES = new Set<CacheFamily>([
  "opencode-go-retained",
  "opencode-go-long-marker",
  "opencode-go-short-marker",
  "opencode-go-plain",
]);

function isOpencodeGoFamily(family: CacheFamily): boolean {
  return OPENCODE_GO_FAMILIES.has(family);
}

/**
 * Cadence label for an OpenCode Go family.
 *
 * No OpenCode Go family renders a numeric lifetime: only "best-effort probe
 * cadence" wording is allowed until an e2e evidence record exists for that
 * family. The retained family never probes.
 */
function opencodeGoFamilyCadence(family: CacheFamily): string | null {
  switch (family) {
    case "opencode-go-retained":
      return "24h retention on the wire; keepalive not needed";
    case "opencode-go-long-marker":
      return "best-effort probe cadence (~48m)";
    case "opencode-go-short-marker":
    case "opencode-go-plain":
      return "best-effort probe cadence (~4m)";
    default:
      return null;
  }
}

export function resolveCacheFamily<Payload = undefined>(
  model: Model<any> | undefined,
  anthropicTtl: AnthropicTtlMode,
  payload?: Payload,
): CacheFamily {
  const capability = resolveProviderCapability(model, payload);
  // OpenCode Go families are payload-driven and resolve before any
  // capability-state collapse, so an unverified Go route still surfaces its
  // family, cadence label, and hints in diagnostics. This runs before
  // isAnthropicModel / isOpenAIModel so a Go anthropic-messages route never
  // inherits a first-party family.
  if (model?.provider === "opencode-go" && capability.state !== "unsupported") {
    return classifyOpencodeGoFamily(payload);
  }
  if (capability.state === "unverified") return "unverified";
  if (capability.state === "unsupported" || !model) return "unsupported";
  return resolveVerifiedCacheFamily(model, anthropicTtl, payload);
}

export function resolveCacheRetention(family: CacheFamily): CacheRetention {
  switch (family) {
    case "anthropic-long":
    case "opencode-go-long-marker":
      return "long";
    case "anthropic-short":
    case "openai-explicit":
    case "openai-implicit":
    case "xai-best-effort":
    case "opencode-go-short-marker":
    case "opencode-go-plain":
      return "short";
    case "opencode-go-retained":
    case "unverified":
    case "unsupported":
    default:
      return "none";
  }
}

export function resolveStrategy<Payload = undefined>(
  model: Model<any> | undefined,
  config: WarmCacheConfig,
  payload?: Payload,
): StrategyResolution {
  const capability = resolveProviderCapability(model, payload);
  const family = resolveCacheFamily(model, config.anthropicTtl, payload);
  const cacheRetention = resolveCacheRetention(family);

  if (capability.state !== "verified") {
    // Unverified OpenCode Go routes keep their payload-derived family and
    // cadence label so diagnostics show what the route would do if promoted.
    // The interval stays null: an unverified route never arms a timer.
    const goCadence = isOpencodeGoFamily(family) ? opencodeGoFamilyCadence(family) : null;
    return {
      capability,
      family,
      cacheRetention,
      intervalMs: null,
      ttlLabel:
        goCadence ??
        (capability.state === "unverified" ? capability.reason : "unsupported route"),
      waitLabel: null,
      automaticWarm: false,
      manualProbe: capability.manualProbe,
      longTtlDegradedReason: null,
    };
  }

  if (family === "xai-best-effort" && payload !== undefined && !isSafeXaiReplayPayload(payload)) {
    return {
      capability,
      family,
      cacheRetention,
      intervalMs: null,
      ttlLabel: "xAI best-effort probe waiting for a stable prompt-cache key",
      waitLabel: null,
      automaticWarm: false,
      manualProbe: false,
      longTtlDegradedReason: null,
    };
  }

  // OpenCode Go openai-responses automatic eligibility requires a stable
  // prompt-cache key in the captured body, mirroring direct xAI. The gate is
  // the generalized `hasStableResponsesCacheKey` predicate. Keyed-but-
  // unretained is not a separate family; it behaves like plain on the wire.
  if (
    family === "opencode-go-plain" &&
    model?.api === "openai-responses" &&
    payload !== undefined &&
    !hasStableResponsesCacheKey(payload)
  ) {
    return {
      capability,
      family,
      cacheRetention,
      intervalMs: null,
      ttlLabel: "OpenCode Go responses probe waiting for a stable prompt-cache key",
      waitLabel: null,
      automaticWarm: false,
      manualProbe: false,
      longTtlDegradedReason: null,
    };
  }

  let longTtlDegradedReason: string | null = null;
  if (
    isAnthropicModel(model) &&
    config.anthropicTtl === "1h" &&
    family !== "anthropic-long" &&
    !isOpencodeGoFamily(family)
  ) {
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
    case "xai-best-effort":
      ttlMs = XAI_BEST_EFFORT_INTERVAL_MS;
      ttlLabel = "xAI best-effort probe cadence";
      break;
    case "opencode-go-retained":
      // The retained family never schedules a probe. The verified capability
      // carries automaticWarm false via the explicit override, so this plan
      // (intervalMs null, automaticWarm false) stays in agreement with it.
      return {
        capability,
        family,
        cacheRetention,
        intervalMs: null,
        ttlLabel: "24h retention on the wire; keepalive not needed",
        waitLabel: null,
        automaticWarm: false,
        manualProbe: capability.manualProbe,
        longTtlDegradedReason: null,
      };
    case "opencode-go-long-marker":
      ttlMs = ANTHROPIC_LONG_TTL_MS;
      ttlLabel = "best-effort probe cadence (~48m)";
      break;
    case "opencode-go-short-marker":
    case "opencode-go-plain":
      // (openai-completions, plain) is verified as no-keepalive: the e2e
      // control showed the native completions cache TTL exceeds 130 min, so
      // a timer adds no measurable benefit within the measured envelope. The
      // plan agrees with the verified capability (automaticWarm false,
      // intervalMs null). /warm now stays available for cold-cache
      // protection and TTL uncertainty.
      if (family === "opencode-go-plain" && model?.api === "openai-completions") {
        return {
          capability,
          family,
          cacheRetention,
          intervalMs: null,
          ttlLabel:
            "native completions TTL exceeds 130m; keepalive not needed within the measured envelope",
          waitLabel: null,
          automaticWarm: false,
          manualProbe: capability.manualProbe,
          longTtlDegradedReason: null,
        };
      }
      ttlMs = ANTHROPIC_SHORT_TTL_MS;
      ttlLabel = "best-effort probe cadence (~4m)";
      break;
    default:
      return {
        capability: {
          ...capability,
          state: "unsupported",
          automaticWarm: false,
          manualProbe: false,
          reason: `verified route resolved to an unsupported cache family: ${family}`,
        },
        family: "unsupported",
        cacheRetention: "none",
        intervalMs: null,
        ttlLabel: "unsupported route",
        waitLabel: null,
        automaticWarm: false,
        manualProbe: false,
        longTtlDegradedReason: null,
      };
  }

  const intervalMs =
    config.intervalMs ??
    (family === "xai-best-effort"
      ? XAI_BEST_EFFORT_INTERVAL_MS
      : Math.max(30_000, Math.floor(ttlMs * DEFAULT_TTL_FRACTION)));

  return {
    capability,
    family,
    cacheRetention,
    intervalMs,
    ttlLabel,
    waitLabel: formatDurationShort(intervalMs),
    automaticWarm: true,
    manualProbe: false,
    longTtlDegradedReason,
  };
}

/**
 * Classify a no-read warm-probe response before retry state is incremented.
 * The first no-read/no-write response on an implicit route is transient.
 */
export function classifyProbeOutcome(args: {
  cacheFamily: CacheFamily;
  cacheRead: number;
  cacheWrite: number;
  consecutiveFailuresBefore: number;
  maxConsecutiveFailures?: number;
}): ProbeOutcome {
  if (args.cacheWrite > 0 && args.cacheRead === 0) return "payload-drift";

  const noReadNoWrite = args.cacheRead === 0 && args.cacheWrite === 0;
  // The best-effort no-write-reporting families (direct xAI and the OpenCode
  // Go marker/plain families) may not report a separate cache-write token
  // count. After the configured retry budget, repeated no-read results become
  // a re-anchor candidate instead of an endless replay loop. The escalation
  // branch stays BEFORE the transient branch so a budget-exhausted result is
  // never mislabelled as a quiet retry.
  const maxFailures = Math.max(1, args.maxConsecutiveFailures ?? 3);
  if (
    isBestEffortNoWriteFamily(args.cacheFamily) &&
    noReadNoWrite &&
    args.consecutiveFailuresBefore + 1 >= maxFailures
  ) {
    return "payload-drift";
  }

  const transientFamily =
    args.cacheFamily === "openai-implicit" || isBestEffortNoWriteFamily(args.cacheFamily);
  if (noReadNoWrite && transientFamily && args.consecutiveFailuresBefore === 0) {
    return "transient-miss";
  }

  return "miss";
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

export type CodexOversizedAction = {
  decision: CodexOversizedDecision;
  consecutiveAfter: number;
};

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
): CodexOversizedAction {
  if (outputTokens < threshold) {
    return { decision: "ok", consecutiveAfter: 0 };
  }
  const consecutiveAfter = consecutiveOversizedBefore + 1;
  if (consecutiveAfter < 2) {
    return { decision: "soft-skip", consecutiveAfter };
  }
  return { decision: "sticky-block", consecutiveAfter };
}

function isPrimitiveString<Value>(value: Value): value is Value & string {
  return (
    value !== Object(value) &&
    Object.prototype.toString.call(value) === "[object String]"
  );
}

/** Detect ChatGPT Codex request bodies (no max_output_tokens support). */
export function isCodexPayload<Payload>(payload: Payload): boolean {
  const body = payloadObject(payload);
  if (!body) return false;
  // Codex bodies use instructions + input + store:false and never ship max_output_tokens.
  return (
    isPrimitiveString(body.instructions) &&
    Array.isArray(body.input) &&
    body.store === false &&
    isPrimitiveString(body.prompt_cache_key)
  );
}

/**
 * Append a constrained warm user turn AFTER the cached prefix.
 * Does not edit earlier messages/tools/instructions (prefix stays cacheable).
 * This steers the model away from continuing the agent trajectory on replay.
 */
export function appendWarmUserTurn<Payload>(
  payload: Payload,
  text: string,
  api?: string,
): Payload {
  const body = payloadObject(payload);
  if (!body || !text || !text.trim()) return payload;
  const content = text.trim();

  if (Array.isArray(body.input)) {
    // OpenAI Responses / Codex shape
    body.input = [
      ...body.input,
      {
        role: "user",
        content: [{ type: "input_text", text: content }],
      },
    ];
    return payload;
  }

  if (Array.isArray(body.messages)) {
    // Anthropic Messages / Chat Completions shape
    const anthropic =
      api === "anthropic-messages" ||
      (Array.isArray(body.system) && isPrimitiveString(body.model));
    body.messages = [
      ...body.messages,
      anthropic
        ? { role: "user", content: [{ type: "text", text: content }] }
        : { role: "user", content },
    ];
    return payload;
  }

  return payload;
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
 * - OpenAI Completions (uncapped only): write `compat.maxTokensField` when the
 *   model declares it, else the default "max_completion_tokens". Some upstreams
 *   (all OpenCode Go completions models today) reject the unknown default field.
 */
export function applyWarmOutputLimit<Payload>(
  payload: Payload,
  maxOutputTokens: number,
  api?: string,
  compat?: ModelCompat,
): Payload {
  const body = payloadObject(payload);
  if (!body) return payload;

  const codex = api === "openai-codex-responses" || isCodexPayload(body);
  if (codex) {
    // Codex rejects hard output caps. Strip if a caller injected them.
    delete body.max_output_tokens;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    // Leave reasoning.effort / tool_choice identical (no same-session proof yet).
    return payload;
  }

  let floor = minimumOutputTokensForPayload(body, maxOutputTokens);
  const openAiResponses =
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    ("max_output_tokens" in body && Array.isArray(body.input));
  if (openAiResponses) {
    floor = Math.max(floor, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
  }

  let touched = false;
  if ("max_output_tokens" in body) {
    body.max_output_tokens = floor;
    touched = true;
  }
  if ("max_completion_tokens" in body) {
    body.max_completion_tokens = floor;
    touched = true;
  }
  if ("max_tokens" in body) {
    body.max_tokens = floor;
    touched = true;
  }

  // Only add a cap when we know the API and the original body had none.
  if (!touched) {
    if (api === "anthropic-messages") {
      body.max_tokens = floor;
    } else if (api === "openai-responses" || api === "azure-openai-responses") {
      body.max_output_tokens = floor;
    } else if (api === "openai-completions") {
      body[compat?.maxTokensField ?? "max_completion_tokens"] = floor;
    }
    // Unknown API shapes: leave unchanged rather than guess a rejected field.
  }

  return payload;
}

/**
 * Apply the only output mutation used by the direct xAI Responses strategy.
 * xAI accepts max_output_tokens; do not add or rewrite max_tokens or Codex
 * fields, and leave reasoning/tool/cache-routing fields untouched.
 */
export function applyXaiWarmOutputLimit<Payload>(payload: Payload, preferred: number): Payload {
  const body = payloadObject(payload);
  if (!body) return payload;
  body.max_output_tokens = Math.max(
    OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
    Math.max(1, preferred),
  );
  return payload;
}

/** Lowest legal output cap that still satisfies thinking-budget constraints. */
export function minimumOutputTokensForPayload(
  payload: PayloadObject,
  preferred: number,
): number {
  let floor = Math.max(1, preferred);

  const thinking = payload.thinking;
  const thinkingBody = payloadObject(thinking);
  if (thinkingBody) {
    const budget = thinkingBody.budget_tokens;
    if (
      thinkingBody.type === "enabled" &&
      budget !== Object(budget) &&
      Object.prototype.toString.call(budget) === "[object Number]" &&
      Number(budget) >= 0
    ) {
      // Anthropic: max_tokens must be greater than budget_tokens.
      floor = Math.max(floor, Math.floor(Number(budget)) + 1);
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

/**
 * Return true when the new real-turn payload keeps the old provider payload as
 * an exact prefix and only appends conversation items.
 * Anthropic cache markers are ignored because Pi moves the marker to the new
 * last cacheable block on each turn.
 *
 * A payload fingerprint changes on every normal turn, so fingerprint equality
 * alone cannot identify continuity.  This check deliberately stays strict:
 * if any non-conversation field changes, the next real-turn classification is
 * unknown instead of claiming a miss caused by the provider.
 */
export function isPayloadContinuation<Previous, Current>(
  previous: Previous,
  current: Current,
  api: string | undefined,
): boolean {
  const previousBody = payloadObject(previous);
  const currentBody = payloadObject(current);
  if (!previousBody || !currentBody) return false;
  const conversationKey =
    api === "anthropic-messages" || api === "openai-completions" ? "messages" : "input";
  const previousItems = previousBody[conversationKey];
  const currentItems = currentBody[conversationKey];

  if (!Array.isArray(previousItems) || !Array.isArray(currentItems)) return false;
  if (currentItems.length < previousItems.length) return false;
  if (cacheControlSignature(previous) !== cacheControlSignature(current)) return false;

  const keys = new Set([...Object.keys(previousBody), ...Object.keys(currentBody)]);
  keys.delete(conversationKey);
  for (const key of keys) {
    if (!deepPayloadEqual(previousBody[key], currentBody[key], true)) return false;
  }

  for (let i = 0; i < previousItems.length; i++) {
    if (!deepPayloadEqual(previousItems[i], currentItems[i], true)) return false;
  }

  return true;
}

/**
 * Classify cache usage from a real assistant turn.
 *
 * A no-read response is only called a miss when the payload is comparable to
 * the previous turn and the prompt is large enough for the configured cache
 * threshold.  All other cases remain unknown while preserving raw usage.
 */
export function classifyRealTurnObservation(args: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  minCachedTokens: number;
  continuity: boolean;
  continuityReason: string;
  provider?: string;
  modelId?: string;
  api?: string;
  payloadFingerprint?: string;
  observedAt?: number;
}): RealTurnObservation {
  const input = args.input ?? 0;
  const cacheRead = args.cacheRead ?? 0;
  const cacheWrite = args.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  let state: RealTurnObservation["state"] = "unknown";
  let reason = args.continuityReason;

  if (!args.continuity) {
    state = "unknown";
  } else if (promptTokens <= 0 || promptTokens < args.minCachedTokens) {
    state = "unknown";
    reason = `prompt below minimum (${promptTokens} < ${args.minCachedTokens})`;
  } else if (cacheRead > 0) {
    state = "hit";
    reason = "comparable continuation with cache read";
  } else {
    state = "miss";
    reason = "comparable continuation with no cache read";
  }

  return {
    state,
    cacheRead,
    cacheWrite,
    input,
    promptTokens,
    provider: args.provider ?? "",
    modelId: args.modelId ?? "",
    api: args.api ?? "",
    payloadFingerprint: args.payloadFingerprint ?? "",
    observedAt: args.observedAt ?? Date.now(),
    reason,
  };
}

function cacheControlSignature<Payload>(payload: Payload): string {
  const controls: string[] = [];
  function visit<Node>(node: Node): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const body = payloadObject(node);
    if (!body) return;
    if (payloadObject(body.cache_control)) {
      controls.push(JSON.stringify(body.cache_control));
    }
    for (const value of Object.values(body)) visit(value);
  }
  visit(payload);
  return controls.sort().join("|");
}

function deepPayloadEqual<Actual, Expected>(
  actual: Actual,
  expected: Expected,
  ignoreCacheControl = false,
): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      return false;
    }
    for (let i = 0; i < actual.length; i++) {
      if (!deepPayloadEqual(actual[i], expected[i], ignoreCacheControl)) return false;
    }
    return true;
  }

  const actualBody = payloadObject(actual);
  const expectedBody = payloadObject(expected);
  if (!actualBody || !expectedBody) return false;
  const keys = new Set([...Object.keys(actualBody), ...Object.keys(expectedBody)]);
  for (const key of keys) {
    if (ignoreCacheControl && key === "cache_control") continue;
    if (!deepPayloadEqual(actualBody[key], expectedBody[key], ignoreCacheControl)) return false;
  }
  return true;
}

/** Fast stable-ish fingerprint for payload identity / logging. */
export function stableFingerprint<Payload>(payload: Payload): string {
  const json = JSON.stringify(payload);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}:${json.length}`;
}

/**
 * Return a short redacted fingerprint for a provider cache-routing key.
 * Always exactly 8 hex characters (left-padded) or "none".
 * Never include the key itself in status text or diagnostic events.
 */
export function getPromptCacheKeyFingerprint<Payload>(payload: Payload, api: string | undefined): string {
  const key = getPromptCacheKey(payload, api);
  return key
    ? stableFingerprint(key).split(":")[0]!.slice(0, 8).padStart(8, "0")
    : "none";
}
