import type { CacheRetention, Model, ThinkingLevel } from "@earendil-works/pi-ai";

/** Capability state for the exact provider route, not only the model name. */
export type ProviderCapabilityState = "verified" | "unverified" | "unsupported";

export type WarmLifecycleState =
  | "idle"
  | "anchored"
  | "awaiting-reanchor"
  | "disabled"
  | "blocked";

export interface ProviderCapability {
  state: ProviderCapabilityState;
  /** Why this route received its capability state. */
  reason: string;
  /** Whether a timer may invoke the provider for this route. */
  automaticWarm: boolean;
  /** Whether an explicit one-shot probe may be attempted for this route. */
  manualProbe: boolean;
}

export type RealTurnCacheState = "hit" | "miss" | "unknown";

/** Cache usage observed on a real assistant turn, never from a warm probe. */
export interface RealTurnObservation {
  state: RealTurnCacheState;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  promptTokens: number;
  provider: string;
  modelId: string;
  api: string;
  payloadFingerprint: string;
  observedAt: number | null;
  /** Explains an unknown state or the continuity evidence used. */
  reason: string;
}

export type ProbeOutcome =
  | "hit"
  | "transient-miss"
  | "miss"
  | "payload-drift"
  | "error"
  | "unavailable";

export type WarmDeferralReason = "agent busy" | "concurrency limit";

/** A scheduled warm probe that was postponed before a provider request. */
export interface WarmDeferralState {
  reason: WarmDeferralReason;
  /** Number of in-flight warm requests when the deferral was recorded. */
  activeWarmSessions: number;
  maxConcurrentWarmSessions: number;
  deferredAt: number;
}

/** One provider response from the extension's warm probe path. */
export interface ProbeObservation {
  outcome: ProbeOutcome;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  costUsd: number;
  provider: string;
  modelId: string;
  api: string;
  payloadFingerprint: string;
  observedAt: number;
  error?: string;
}

/** Detected cache family for interval + payload strategy. */
export type CacheFamily =
  | "anthropic-short"
  | "anthropic-long"
  | "openai-explicit"
  | "openai-implicit"
  | "xai-best-effort"
  | "opencode-go-retained"
  | "opencode-go-long-marker"
  | "opencode-go-short-marker"
  | "opencode-go-plain"
  | "unverified"
  | "unsupported";

export type AnthropicTtlMode = "5m" | "1h" | "auto";

export interface WarmCacheConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /**
   * Anthropic TTL mode.
   * - 5m: short retention, ping every ~4m
   * - 1h: long retention (2x write), ping every ~50m
   * - auto: follow Pi cacheRetention / model support
   */
  anthropicTtl: AnthropicTtlMode;
  /** Override keepalive interval in ms. Null = strategy default. */
  intervalMs: number | null;
  /** Max sessions that may run concurrent warm pings in this process. */
  maxConcurrentWarmSessions: number;
  /** Minimum cached prefix tokens before warming is useful. */
  minCachedTokens: number;
  /** Stop after this many consecutive probe failures. */
  maxConsecutiveFailures: number;
  /** Show the editor widget while waiting / after a probe hit. */
  showWidget: boolean;
  /** Append a tiny warm user turn instead of replaying the exact last prefix only. */
  warmSuffix: string;
  /** Max output tokens on a warm request. Keep at 1. */
  maxOutputTokens: number;
  /**
   * Write JSONL diagnostics to .pi/warm-cache.jsonl.
   * Default false. Enable with PI_WARM_CACHE_DEBUG=1 or /warm log.
   */
  logToFile: boolean;
  /**
   * Allow timer-based auto-warm on openai-codex-responses.
   * Default true after measured timer ticks with Codex OK-suffix stayed cheap
   * (e.g. read=39424 write=0 out=32). Sticky block still trips if out is huge.
   * Disable with /warm codex-off.
   */
  allowCodexAutoWarm: boolean;
}

export const DEFAULT_CONFIG: WarmCacheConfig = {
  enabled: true,
  anthropicTtl: "auto",
  intervalMs: null,
  maxConcurrentWarmSessions: 3,
  minCachedTokens: 512,
  maxConsecutiveFailures: 3,
  showWidget: true,
  warmSuffix:
    "Reply with exactly the single word: OK. Do not think. Do not explain. Do nothing else.",
  maxOutputTokens: 1,
  logToFile: false,
  allowCodexAutoWarm: true,
};

/** Snapshot of the prefix we must hit on the next warm request. */
export interface CacheAnchor {
  /** Stable id for this session's cache routing (OpenAI prompt_cache_key / session affinity). */
  sessionId: string;
  provider: string;
  modelId: string;
  modelApi: string;
  thinkingLevel: ThinkingLevel | "off" | undefined;
  capability: ProviderCapability;
  /** True when this captured payload has a safe manual-probe shape. */
  manualProbeAvailable: boolean;
  cacheFamily: CacheFamily;
  cacheRetention: CacheRetention;
  /** Hash of the captured provider payload (identity / logging). */
  payloadFingerprint: string;
  /** Redacted identity of the provider cache-routing key, when present. */
  cacheKeyFingerprint: string;
  /** Compatibility prompt-size hint; authoritative values live in observations. */
  cachedTokens: number;
  /** Compatibility prompt-size hint; authoritative values live in observations. */
  promptTokens: number;
  /** Model cache-read price $/MTok when known. */
  cacheReadPricePerMTok: number;
  /** Model input price $/MTok when known. */
  inputPricePerMTok: number;
  /** False when neither model.cost nor published fallback yields a savings delta. */
  savingsKnown: boolean;
  /** Where input/cacheRead prices came from. */
  pricingSource: "model" | "unknown";
  /** Wall clock of last real agent activity that refreshed the cache. */
  lastActivityAt: number;
  /** Wall clock of the last successful warm-probe hit. */
  lastProbeAt: number | null;
  /** Estimated USD saved by warm-probe hits this session (vs cold input re-read). */
  estimatedSavingsUsd: number;
  /** Cumulative estimated savings before probe costs are subtracted. */
  totalEstimatedSavedUsd: number;
  /** Cumulative provider cost for warm probes. */
  totalProbeCostUsd: number;
  /** Number of provider responses returned by the warm-probe path. */
  probeCount: number;
  probeHitCount: number;
  probeMissCount: number;
  /** Consecutive probe failures. Real turns reset this retry state. */
  consecutiveFailures: number;
  /** Latest real-turn usage and classification. Never updated by a probe. */
  latestRealTurn: RealTurnObservation;
  /** Latest warm-probe response. Never updated by a real turn. */
  latestProbe: ProbeObservation | null;
}

export interface WarmResult {
  ok: boolean;
  cacheHit: boolean;
  probeOutcome?: ProbeOutcome;
  capabilityState?: ProviderCapabilityState;
  capabilityReason?: string;
  /** Consecutive probe retry state at the time of this result. */
  retryState?: string;
  /** Named cache strategy used by this route. */
  family?: CacheFamily;
  /** Human-readable strategy or cadence label. */
  strategyLabel?: string;
  /** Configured delay before the next automatic probe. */
  intervalMs?: number | null;
  /** Redacted identity of the provider cache-routing key, when present. */
  cacheKeyFingerprint?: string;
  /** True when a probe was rejected before any provider request. */
  unavailable?: boolean;
  /** Set when the attempt was postponed before any provider request. */
  deferred?: WarmDeferralState;
  provider?: string;
  modelId?: string;
  api?: string;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  costUsd: number;
  estimatedSavedUsd: number;
  error?: string;
  fingerprint: string;
}

export interface StrategyPlan {
  family: CacheFamily;
  cacheRetention: CacheRetention;
  /** Delay from last activity until next warm attempt. Null means no timer. */
  intervalMs: number | null;
  /** Human label for UI, e.g. "5m prompt-cache TTL". */
  ttlLabel: string;
  /** Human label for deferred wait, e.g. "4m". Null means no timer. */
  waitLabel: string | null;
  /** Whether this plan is allowed to arm an automatic timer. */
  automaticWarm: boolean;
  /** Whether this plan permits a manual one-shot probe. */
  manualProbe: boolean;
}

export interface ResolvedModelRef {
  model: Model<any>;
  provider: string;
  modelId: string;
}
