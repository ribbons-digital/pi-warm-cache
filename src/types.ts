import type { CacheRetention, Model, ThinkingLevel } from "@earendil-works/pi-ai";

/** Detected cache family for interval + payload strategy. */
export type CacheFamily =
  | "anthropic-short"
  | "anthropic-long"
  | "openai-explicit"
  | "openai-implicit"
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
  /** Stop after this many consecutive warm failures. */
  maxConsecutiveFailures: number;
  /** Show the editor widget while waiting / after a warm hit. */
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
  cacheFamily: CacheFamily;
  cacheRetention: CacheRetention;
  /** Hash of the captured provider payload (identity / logging). */
  payloadFingerprint: string;
  /** Last observed cache-read tokens from a real or warm response. */
  cachedTokens: number;
  /** Last known input+cache tokens that form the billable prompt. */
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
  /** Wall clock of last successful warm hit. */
  lastWarmAt: number | null;
  /** Estimated USD saved by warm hits this session (vs cold input re-read). */
  estimatedSavingsUsd: number;
  warmHitCount: number;
  warmMissCount: number;
  consecutiveFailures: number;
}

export interface WarmResult {
  ok: boolean;
  cacheHit: boolean;
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
  /** Delay from last activity until next warm attempt. */
  intervalMs: number;
  /** Human label for UI, e.g. "5m prompt-cache TTL". */
  ttlLabel: string;
  /** Human label for deferred wait, e.g. "4m". */
  waitLabel: string;
}

export interface ResolvedModelRef {
  model: Model<any>;
  provider: string;
  modelId: string;
}
