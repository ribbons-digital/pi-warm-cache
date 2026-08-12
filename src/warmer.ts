import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendWarmUserTurn,
  applyWarmOutputLimit,
  applyXaiWarmOutputLimit,
  bestEffortFamilyLabel,
  classifyProbeOutcome,
  classifyRealTurnObservation,
  CODEX_WARM_OUTPUT_ABORT_TOKENS,
  decideCodexOversizedAction,
  DEFER_BACKOFF_MS,
  getModelCompat,
  getPromptCacheKey,
  getPromptCacheKeyFingerprint,
  isBestEffortNoWriteFamily,
  isPayloadContinuation,
  isSafeReplayPayload,
  isSafeXaiReplayPayload,
  resolveMaxIdleWarmMs,
  resolveProviderCapability,
  resolveStrategy,
  stableFingerprint,
} from "./provider.ts";
import { formatDurationShort } from "./config.ts";
import { appendWarmLog, warmLogPath, type WarmLogEvent } from "./log.ts";
import {
  buildWarmResult,
  formatSavingsLabel,
  formatSavingsSummary,
  resolveModelPricing,
} from "./savings.ts";
import {
  clearWarmUi,
  formatDeferralStatus,
  renderFailureUi,
  renderIdleUi,
  renderManualOnlyUi,
  renderProbeRetryUi,
  renderReanchorUi,
  renderWaitingUi,
  renderWarmHitUi,
} from "./ui.ts";
import type { StrategyResolution } from "./provider.ts";
import type {
  CacheAnchor,
  CacheFamily,
  ProbeObservation,
  ProbeOutcome,
  ProviderCapability,
  RealTurnObservation,
  WarmCacheConfig,
  WarmDeferralReason,
  WarmDeferralState,
  WarmLifecycleState,
  WarmResult,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

/** Process-wide gate so many sessions do not warm at once. */
class WarmConcurrencyGate {
  private active = 0;

  getActive(): number {
    return this.active;
  }

  tryEnter(max: number): boolean {
    if (this.active >= max) return false;
    this.active += 1;
    return true;
  }
  leave(): void {
    this.active = Math.max(0, this.active - 1);
  }
}

const globalGate = new WarmConcurrencyGate();

/**
 * Per-provider probe-spend ledger, keyed by provider (spendUsd + probeCount).
 *
 * Module-level beside globalGate because the spend ceiling is per provider per
 * campaign, not per session: every Go session shares one dollar-capped
 * subscription. The ledger resets on real-turn activity for that provider
 * (capturePayload + noteAssistantUsage), so it bounds each idle stretch rather
 * than the process lifetime.
 */
class ProbeSpendLedger {
  private spendUsd = new Map<string, number>();
  private probeCount = new Map<string, number>();

  reset(provider: string): void {
    this.spendUsd.delete(provider);
    this.probeCount.delete(provider);
  }

  resetAll(): void {
    this.spendUsd.clear();
    this.probeCount.clear();
  }

  add(provider: string, costUsd: number): void {
    this.spendUsd.set(provider, (this.spendUsd.get(provider) ?? 0) + costUsd);
    this.probeCount.set(provider, (this.probeCount.get(provider) ?? 0) + 1);
  }

  getSpendUsd(provider: string): number {
    return this.spendUsd.get(provider) ?? 0;
  }

  getProbeCount(provider: string): number {
    return this.probeCount.get(provider) ?? 0;
  }
}

const probeSpendLedger = new ProbeSpendLedger();

/** Default spend ceiling when `warmSpendCeilingUsd` is null: $1.00 for opencode-go. */
const DEFAULT_SPEND_CEILING_USD = 1.0;

/** Probe-count fallback ceiling when model cost fields are zero or unusable. */
const SPEND_PROBE_COUNT_FALLBACK = 250;

/**
 * Resolve the spend ceiling for a provider, or null when the provider is not
 * ceiling-active. warmSpendCeilingUsd 0 = unlimited (ceiling inactive for all
 * providers, including opencode-go).
 */
function resolveProviderSpendCeilingUsd(
  config: WarmCacheConfig,
  provider: string,
): number | null {
  if (config.warmSpendCeilingUsd !== null) {
    return config.warmSpendCeilingUsd > 0 ? config.warmSpendCeilingUsd : null;
  }
  return provider === "opencode-go" ? DEFAULT_SPEND_CEILING_USD : null;
}

/**
 * Exported test seam: the module-level ledger is shared across test blocks in
 * one process, so tests reset it explicitly before exercising the ceiling.
 */
export function resetProbeSpendLedgerForTest(): void {
  probeSpendLedger.resetAll();
}

type CompleteRequest = typeof complete;

type PendingReanchor = {
  reason: string;
  oldPayloadFingerprint: string | null;
  oldCacheKeyFingerprint: string;
  invalidatedAt: number;
};

export type RescheduleOptions = {
  /** Explicit delay. When set, skips TTL-from-lastActivity math. */
  delayMs?: number;
  /** Why we are waiting (for status text). */
  reason?: string;
};

export class SessionWarmer {
  private readonly pi: ExtensionAPI;
  private readonly completeRequest: CompleteRequest;
  private config: WarmCacheConfig = { ...DEFAULT_CONFIG };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private warming = false;
  private disposed = false;
  private nextDueAt = 0;
  private anchor: CacheAnchor | null = null;
  private lifecycleState: WarmLifecycleState = "idle";
  /** Links the next fresh real-turn capture to the invalidation that dropped the old anchor. */
  private pendingReanchor: PendingReanchor | null = null;
  /** Capture time used to avoid adding settlement latency after a hard re-anchor. */
  private reanchorCaptureAt: number | null = null;
  /** Lifecycle state captured before entering "disabled", for restore on re-enable. */
  private stateBeforeDisabled: WarmLifecycleState | null = null;
  /** Retained probe diagnostics after a drift invalidation, never used for replay. */
  private lastInvalidatedProbe: ProbeObservation | null = null;
  private lastPayload: unknown | null = null;
  private capability: ProviderCapability | null = null;
  private ctx: ExtensionContext | null = null;
  /** Continuity boundary applied to the next captured real turn. */
  private realTurnBoundaryReason = "first real turn";
  private realTurnContinuity = false;
  private plan: StrategyResolution | null = null;
  private lastLongTtlWarning: string | null = null;
  private logFile: string | null = null;
  /**
   * Sticky session block for auto-warm (survives next real-turn re-anchor).
   * Used when Codex produces uncapped large output. Cleared only by explicit
   * /warm on|resume (not by capturePayload / agent_settled).
   */
  private autoWarmBlockReason: string | null = null;
  /**
   * Per-instance probe-spend soft block. Cleared ONLY by this instance's
   * capturePayload; other sessions' capturePayload clears only their own
   * field. Never sets lifecycleState "blocked".
   */
  private spendBlockReason: string | null = null;
  /** Consecutive Codex warm ticks with out >= CODEX_WARM_OUTPUT_ABORT_TOKENS. */
  private consecutiveCodexOversized = 0;
  /** Last scheduled probe deferral, retained until a probe gets a slot. */
  private deferredProbe: WarmDeferralState | null = null;
  /** Last warm attempt error/result summary for /warm status. */
  private lastAttempt: {
    at: number;
    reason: "timer" | "manual" | "system";
    ok: boolean;
    detail: string;
  } | null = null;

  constructor(pi: ExtensionAPI, completeRequest: CompleteRequest = complete) {
    this.pi = pi;
    this.completeRequest = completeRequest;
  }

  isWarming(): boolean {
    return this.warming;
  }

  getConfig(): WarmCacheConfig {
    return this.config;
  }

  getCapability(): ProviderCapability {
    return this.currentCapability();
  }

  /** True when the active or captured route belongs to xAI. */
  isXaiRoute(): boolean {
    return this.anchor?.provider === "xai" || this.ctx?.model?.provider === "xai";
  }

  getLifecycleState(): WarmLifecycleState {
    return this.lifecycleState;
  }

  getActiveWarmSessions(): number {
    return globalGate.getActive();
  }

  getDeferredProbe(): WarmDeferralState | null {
    return this.deferredProbe;
  }

  getSessionWarmStats(): Pick<
    CacheAnchor,
    "totalEstimatedSavedUsd" | "totalProbeCostUsd" | "probeHitCount" | "probeMissCount" | "lastProbeAt"
  > {
    return {
      totalEstimatedSavedUsd: this.anchor?.totalEstimatedSavedUsd ?? 0,
      totalProbeCostUsd: this.anchor?.totalProbeCostUsd ?? 0,
      probeHitCount: this.anchor?.probeHitCount ?? 0,
      probeMissCount: this.anchor?.probeMissCount ?? 0,
      lastProbeAt: this.anchor?.lastProbeAt ?? null,
    };
  }

  getSavingsSummaryText(): string {
    return formatSavingsSummary(
      this.anchor ?? {
        probeHitCount: 0,
        probeMissCount: 0,
        totalEstimatedSavedUsd: 0,
        totalProbeCostUsd: 0,
        savingsKnown: false,
        pricingSource: "unknown",
        capability: this.ctx ? this.currentCapability(this.ctx) : undefined,
      },
    );
  }

  getLatestRealTurnObservation(): RealTurnObservation | null {
    return this.anchor?.latestRealTurn ?? null;
  }

  getLatestProbeObservation(): ProbeObservation | null {
    return this.anchor?.latestProbe ?? this.lastInvalidatedProbe;
  }

  private currentCapability(ctx?: ExtensionContext | null): ProviderCapability {
    const context = ctx ?? this.ctx;
    return this.anchor?.capability ?? this.capability ?? resolveProviderCapability(context?.model);
  }

  getLogFile(): string | null {
    return this.logFile ?? (this.ctx ? warmLogPath(this.ctx.cwd) : null);
  }

  setConfig(config: WarmCacheConfig): void {
    this.config = { ...config };
    // Re-evaluate the per-instance spend soft block when the ceiling changes:
    // raising the ceiling or disabling it (spend=0) resumes warming for this
    // instance, matching the documented spend=0 opt-out. A lowered ceiling
    // keeps the block until this instance's next real turn. Other sessions'
    // config changes never touch this field.
    if (this.spendBlockReason && this.anchor && !this.spendCeilingTripped(this.anchor.provider)) {
      this.spendBlockReason = null;
      this.log({
        event: "spend_block_cleared",
        source: "system",
        sessionId: this.anchor.sessionId,
        provider: this.anchor.provider,
        reason: "ceiling raised or disabled via config",
      });
    }
    if (!this.config.enabled) {
      this.stop("disabled");
      return;
    }
    if (this.lifecycleState === "disabled") {
      // Restore the lifecycle state captured before entering "disabled"
      if (this.stateBeforeDisabled === "awaiting-reanchor") {
        this.lifecycleState = "awaiting-reanchor";
      } else if (this.stateBeforeDisabled === "blocked" && this.autoWarmBlockReason) {
        // Only restore "blocked" if the block reason is still active
        this.lifecycleState = "blocked";
      } else if (this.stateBeforeDisabled === "blocked" && !this.autoWarmBlockReason) {
        // Block was cleared while disabled, restore to anchored/idle instead
        this.lifecycleState = this.anchor && this.lastPayload ? "anchored" : "idle";
      } else {
        // Default restoration based on anchor/payload for other states
        this.lifecycleState = this.anchor && this.lastPayload ? "anchored" : "idle";
      }
      this.stateBeforeDisabled = null;
    }
    if (this.ctx?.model && this.lastPayload) {
      this.plan = resolveStrategy(this.ctx.model, this.config, this.lastPayload);
    }
    this.reschedule();
  }

  /** Clear sticky auto-warm block (explicit user re-enable only). */
  clearAutoWarmBlock(reason = "user resumed"): void {
    const hadBlock = Boolean(this.autoWarmBlockReason);
    this.consecutiveCodexOversized = 0;
    if (!hadBlock) return;
    this.log({
      event: "auto_warm_block_cleared",
      sessionId: this.anchor?.sessionId,
      previous: this.autoWarmBlockReason,
      reason,
    });
    this.autoWarmBlockReason = null;
    if (this.lifecycleState === "blocked") {
      this.lifecycleState = this.anchor && this.lastPayload ? "anchored" : "idle";
    }
  }

  getAutoWarmBlockReason(): string | null {
    return this.autoWarmBlockReason;
  }

  private blockAutoWarm(reason: string): void {
    this.autoWarmBlockReason = reason;
    this.lifecycleState = "blocked";
    this.clearTimers();
    this.log({
      event: "auto_warm_blocked",
      sessionId: this.anchor?.sessionId,
      reason,
    });
  }

  bindContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    if (!this.config.enabled) {
      this.stateBeforeDisabled = this.lifecycleState;
      this.lifecycleState = "disabled";
    }
    this.logFile = warmLogPath(ctx.cwd);
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleState = "disabled";
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
    this.anchor = null;
    this.lastInvalidatedProbe = null;
    this.lastPayload = null;
    this.pendingReanchor = null;
    this.reanchorCaptureAt = null;
    this.deferredProbe = null;
    this.capability = null;
    this.realTurnBoundaryReason = "session ended";
    this.realTurnContinuity = false;
    if (this.ctx) clearWarmUi(this.ctx);
    this.ctx = null;
  }

  private enterAwaitingReanchor(
    ctx: ExtensionContext,
    reason: string,
    preserveProbe = false,
  ): void {
    const previousAnchor = this.anchor;
    const previousPayload = this.lastPayload;
    const previousCacheKeyFingerprint =
      previousAnchor?.cacheKeyFingerprint ??
      getPromptCacheKeyFingerprint(previousPayload, ctx.model?.api);
    const previousPayloadFingerprint =
      previousAnchor?.payloadFingerprint ??
      (previousPayload ? stableFingerprint(previousPayload) : null);
    const priorPendingReanchor = this.pendingReanchor;
    const invalidatedAt = Date.now();
    const oldCacheKeyFingerprint =
      previousCacheKeyFingerprint !== "none"
        ? previousCacheKeyFingerprint
        : (priorPendingReanchor?.oldCacheKeyFingerprint ?? "none");
    const pendingReanchor: PendingReanchor = {
      reason,
      oldPayloadFingerprint:
        previousPayloadFingerprint ?? priorPendingReanchor?.oldPayloadFingerprint ?? null,
      oldCacheKeyFingerprint,
      invalidatedAt,
    };

    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    this.lastInvalidatedProbe = preserveProbe ? (this.anchor?.latestProbe ?? null) : null;
    this.anchor = null;
    this.lastPayload = null;
    this.pendingReanchor = pendingReanchor;
    this.reanchorCaptureAt = null;
    this.deferredProbe = null;
    this.realTurnBoundaryReason = reason;
    this.realTurnContinuity = false;
    this.plan = null;
    this.lifecycleState = this.config.enabled ? "awaiting-reanchor" : "disabled";
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
    this.log({
      event: "anchor_invalidated",
      source: "system",
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
      api: ctx.model?.api,
      capabilityState: this.capability.state,
      capabilityReason: this.capability.reason,
      cacheKeyFingerprint: oldCacheKeyFingerprint,
      payloadFingerprint: pendingReanchor.oldPayloadFingerprint,
      oldCacheKeyFingerprint,
      oldPayloadFingerprint: pendingReanchor.oldPayloadFingerprint,
      reason,
      invalidatedAt,
    });
  }

  /**
   * Drop the cache anchor after events that make the previous provider prefix unusable:
   * model/effort change, compaction, tree navigation, or probe-detected payload drift.
   *
   * Idle custom_message / advisor injections do not invalidate the provider cache
   * from the last real turn. Those must not call this method.
   */
  invalidateAnchor(ctx: ExtensionContext, reason: string): void {
    this.enterAwaitingReanchor(ctx, reason);
    this.recordAttempt("system", false, `invalidated: ${reason}`);
    const capability = this.capability;
    if (!capability || capability.state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    // Compaction / branch / model change are expected idle states, not errors.
    this.showReanchoring(ctx, reason);
  }

  /** Capture the exact provider payload from a real agent turn. Read-only. */
  capturePayload(payload: unknown, ctx: ExtensionContext): void {
    if (this.warming) return;
    if (!payload || typeof payload !== "object") return;

    this.ctx = ctx;
    this.logFile = warmLogPath(ctx.cwd);
    this.deferredProbe = null;
    // Any real capture clears this instance's probe-spend soft block and
    // resets the per-provider campaign ledger (the ledger is per-campaign:
    // it bounds each idle stretch rather than the process lifetime).
    this.spendBlockReason = null;
    const reanchorWasPending =
      this.lifecycleState === "awaiting-reanchor" || this.pendingReanchor !== null;
    const payloadFingerprint = stableFingerprint(payload);
    const model = ctx.model;
    if (model) probeSpendLedger.reset(model.provider);
    const cacheKeyFingerprint = getPromptCacheKeyFingerprint(payload, model?.api);
    this.capability = resolveProviderCapability(model, payload);

    if (!model || this.capability.state === "unsupported") {
      this.anchor = null;
      this.lastInvalidatedProbe = null;
      this.lastPayload = null;
      this.pendingReanchor = null;
      this.reanchorCaptureAt = null;
      this.lifecycleState = this.config.enabled ? "blocked" : "disabled";
      this.realTurnBoundaryReason = this.capability.reason;
      this.realTurnContinuity = false;
      this.plan = null;
      this.clearTimers();
      this.abort?.abort();
      this.abort = null;
      this.log({
        event: "capture",
        source: "real_turn",
        provider: model?.provider,
        modelId: model?.id,
        api: model?.api,
        payloadFingerprint,
        cacheKeyFingerprint,
        capabilityState: this.capability.state,
        capabilityReason: this.capability.reason,
        ignored: true,
      });
      this.clearCapabilityUi(ctx);
      return;
    }

    let prev = this.anchor;
    let previousPayload = this.lastPayload;
    const sameModelRoute = Boolean(
      prev &&
        prev.provider === model.provider &&
        prev.modelId === model.id &&
        prev.modelApi === model.api,
    );
    const sameRoute = Boolean(
      sameModelRoute &&
        prev &&
        prev.capability.state === this.capability.state &&
        prev.capability.reason === this.capability.reason,
    );
    const xaiCacheKeyChanged = Boolean(
      sameModelRoute &&
        previousPayload &&
        model.provider === "xai" &&
        model.api === "openai-responses" &&
        getPromptCacheKey(previousPayload, model.api) !== getPromptCacheKey(payload, model.api),
    );
    const previousCacheKeyFingerprint = prev?.cacheKeyFingerprint;
    // A payload-drift probe deliberately clears lastPayload. Do not treat a
    // later fingerprint match as continuity unless the old payload is still
    // available for comparison.
    const samePayload = Boolean(
      prev && previousPayload && prev.payloadFingerprint === payloadFingerprint,
    );
    const payloadContinuation = Boolean(
      sameRoute &&
        previousPayload &&
        (samePayload || isPayloadContinuation(previousPayload, payload, model.api)),
    );
    const previousTurnObserved = Boolean(prev && prev.latestRealTurn.observedAt !== null);
    const comparableContinuation = payloadContinuation && previousTurnObserved;
    const continuityReason = !prev
      ? this.realTurnBoundaryReason
      : xaiCacheKeyChanged
        ? getPromptCacheKey(payload, model.api)
          ? "xAI best-effort prompt_cache_key changed"
          : "xAI best-effort prompt_cache_key missing or invalid"
        : !sameRoute
          ? "model or provider route changed"
          : !payloadContinuation
            ? "prefix changed"
            : comparableContinuation
              ? "comparable continuation"
              : "no comparable prior real turn";
    const prefixChanged = Boolean(prev && !payloadContinuation);
    if (prefixChanged) {
      const driftReason = xaiCacheKeyChanged
        ? getPromptCacheKey(payload, model.api)
          ? "xAI best-effort prompt_cache_key changed"
          : "xAI best-effort prompt_cache_key missing or invalid"
        : !sameRoute
          ? "model or provider route changed"
          : "prefix changed";
      this.enterAwaitingReanchor(ctx, `${driftReason} · waiting for next turn`);
      prev = null;
      previousPayload = null;
    }

    // enterAwaitingReanchor recomputes the capability without the payload,
    // which would drop payload-derived refusals (for example the opencode-go
    // foreign-instrumentation gate on a completions payload carrying illegal
    // cache_control) and re-enable /warm now on an unsafe exact payload.
    // Restore the payload-aware resolution so the re-anchored anchor keeps the
    // refusal and manualProbeAvailable stays false for this captured body.
    this.capability = resolveProviderCapability(model, payload);

    this.lastInvalidatedProbe = null;
    this.lastPayload = structuredClone(payload);
    this.plan = resolveStrategy(model, this.config, this.lastPayload);
    const reanchorTransition = this.pendingReanchor;
    const capturedAt = Date.now();
    const manualProbeAvailable =
      this.capability.manualProbe && isSafeReplayPayload(this.lastPayload, model.api);

    if (this.plan.longTtlDegradedReason && this.plan.longTtlDegradedReason !== this.lastLongTtlWarning) {
      this.lastLongTtlWarning = this.plan.longTtlDegradedReason;
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-warm-cache: 1h mode degraded - ${this.plan.longTtlDegradedReason}`, "warning");
      }
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const pricing = resolveModelPricing(model);
    // Savings are claimed only when the resolved plan actually runs a
    // keepalive timer. The capability alone is not enough: a verified
    // no-keepalive family (opencode-go retained, and the verified
    // completions-plain treatment) resolves automaticWarm false, and a
    // payload-level gate can disable the timer on a verified route (the
    // responses key gate). The plan is the authoritative result after those
    // gates, so the active savings flag follows plan.automaticWarm.
    //
    // Carry-over of a continuing session's accumulated totals follows route
    // and pricing continuity only: a temporarily gated turn (for example a
    // responses turn whose payload fails the key gate) suppresses new savings
    // claims but must not wipe the prior tally, so the next ungated turn
    // resumes it. Today the plan gate is constant within any continuation
    // (the key is a payload-continuity field), which makes the two predicates
    // equal there; the split keeps them correct by construction if a future
    // gate ever trips without breaking continuity.
    const routeSavingsKnown =
      this.capability.state === "verified" && pricing.savingsKnown;
    const savingsKnown =
      this.capability.state === "verified" &&
      this.plan?.automaticWarm === true &&
      pricing.savingsKnown;
    const preserveSessionStats = payloadContinuation;
    const realTurn = makeUnknownRealTurnObservation({
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      payloadFingerprint,
      reason: continuityReason,
    });

    this.anchor = {
      sessionId,
      provider: model.provider,
      modelId: model.id,
      modelApi: model.api,
      thinkingLevel: ctx.thinkingLevel ?? this.pi.getThinkingLevel?.(),
      capability: this.capability,
      manualProbeAvailable,
      cacheFamily: this.plan.family,
      cacheRetention: this.plan.cacheRetention,
      payloadFingerprint,
      cacheKeyFingerprint,
      // These fields remain as compatibility aliases for the scheduler and
      // older integrations. The authoritative observations are below.
      cachedTokens: 0,
      promptTokens: 0,
      cacheReadPricePerMTok: pricing.cacheReadPricePerMTok,
      inputPricePerMTok: pricing.inputPricePerMTok,
      savingsKnown,
      pricingSource: pricing.source,
      lastActivityAt: capturedAt,
      // Idle-cutoff base: only real turns refresh this clock. Probe hits never
      // touch it, so an idle session stops probing once the cutoff is reached.
      lastRealTurnAt: capturedAt,
      // Keep the latest probe alongside a continuing real-turn observation so
      // /warm can show whether that probe preceded the next real turn. A
      // changed prefix starts a new anchor and must not inherit old evidence.
      lastProbeAt: preserveSessionStats ? (prev?.lastProbeAt ?? null) : null,
      estimatedSavingsUsd:
        routeSavingsKnown && preserveSessionStats ? (prev?.estimatedSavingsUsd ?? 0) : 0,
      totalEstimatedSavedUsd:
        routeSavingsKnown && preserveSessionStats ? (prev?.totalEstimatedSavedUsd ?? 0) : 0,
      totalProbeCostUsd: preserveSessionStats ? (prev?.totalProbeCostUsd ?? 0) : 0,
      probeCount: preserveSessionStats ? (prev?.probeCount ?? 0) : 0,
      probeHitCount: preserveSessionStats ? (prev?.probeHitCount ?? 0) : 0,
      probeMissCount: preserveSessionStats ? (prev?.probeMissCount ?? 0) : 0,
      consecutiveFailures: 0,
      latestRealTurn: realTurn,
      latestProbe: preserveSessionStats ? (prev?.latestProbe ?? null) : null,
    };
    this.lifecycleState = !this.config.enabled
      ? "disabled"
      : this.autoWarmBlockReason
        ? "blocked"
        : "anchored";
    if (reanchorWasPending || reanchorTransition || prefixChanged) {
      this.reanchorCaptureAt = capturedAt;
    }
    this.realTurnBoundaryReason = "awaiting real-turn usage";
    this.realTurnContinuity = comparableContinuation;

    this.log({
      event: "capture",
      source: "real_turn",
      sessionId,
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      family: this.plan.family,
      capabilityState: this.capability.state,
      capabilityReason: this.capability.reason,
      automaticWarm: this.capability.automaticWarm,
      manualProbe: this.capability.manualProbe,
      manualProbeAvailable,
      payloadFingerprint,
      cacheKeyFingerprint,
      previousCacheKeyFingerprint,
      cacheKeyChanged: xaiCacheKeyChanged,
      prefixChanged,
      reanchor: Boolean(reanchorTransition),
      oldPayloadFingerprint: reanchorTransition?.oldPayloadFingerprint,
      newPayloadFingerprint: reanchorTransition ? payloadFingerprint : undefined,
      oldCacheKeyFingerprint: reanchorTransition?.oldCacheKeyFingerprint,
      newCacheKeyFingerprint: reanchorTransition ? cacheKeyFingerprint : undefined,
      realTurnContinuity: comparableContinuation ? "comparable" : "unknown",
      realTurnContinuityReason: continuityReason,
      modelCost: model.cost ?? null,
      pricingSource: pricing.source,
      savingsKnown,
      inputPricePerMTok: pricing.inputPricePerMTok,
      cacheReadPricePerMTok: pricing.cacheReadPricePerMTok,
    });

    if (reanchorTransition) {
      this.log({
        event: "anchor_reanchored",
        source: "real_turn",
        sessionId,
        provider: model.provider,
        modelId: model.id,
        api: model.api,
        family: this.plan.family,
        capabilityState: this.capability.state,
        capabilityReason: this.capability.reason,
        reason: reanchorTransition.reason,
        invalidatedAt: new Date(reanchorTransition.invalidatedAt).toISOString(),
        reanchoredAt: new Date(capturedAt).toISOString(),
        reanchorDelayMs: Math.max(0, capturedAt - reanchorTransition.invalidatedAt),
        oldPayloadFingerprint: reanchorTransition.oldPayloadFingerprint,
        newPayloadFingerprint: payloadFingerprint,
        oldCacheKeyFingerprint: reanchorTransition.oldCacheKeyFingerprint,
        newCacheKeyFingerprint: cacheKeyFingerprint,
        automaticWarm: this.capability.automaticWarm,
        manualProbe: this.capability.manualProbe,
      });
      this.pendingReanchor = null;
    }

    if (this.capability.state !== "verified") {
      this.clearTimers();
      this.clearCapabilityUi(ctx);
    }
  }

  /** Update token stats after a real assistant message. */
  noteAssistantUsage(
    ctx: ExtensionContext,
    usage: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    },
  ): void {
    this.ctx = ctx;
    // Real-turn activity resets the per-provider campaign ledger so it bounds
    // each idle stretch rather than the process lifetime.
    const ledgerProvider = this.anchor?.provider ?? ctx.model?.provider;
    if (ledgerProvider) probeSpendLedger.reset(ledgerProvider);
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const promptTokens = input + cacheRead + cacheWrite;

    if (!this.anchor) {
      this.log({
        event: "usage",
        source: "real_turn",
        provider: ctx.model?.provider,
        modelId: ctx.model?.id,
        api: ctx.model?.api,
        capabilityState: this.capability?.state,
        capabilityReason: this.capability?.reason,
        cacheKeyFingerprint: getPromptCacheKeyFingerprint(this.lastPayload, ctx.model?.api),
        cacheRead,
        cacheWrite,
        input,
        output,
        promptTokens,
        realTurnState: "unknown",
        realTurnReason: "no anchor",
      });
      return;
    }

    const observation = classifyRealTurnObservation({
      input,
      output,
      cacheRead,
      cacheWrite,
      minCachedTokens: this.config.minCachedTokens,
      continuity: this.realTurnContinuity,
      continuityReason: this.anchor.latestRealTurn.reason,
      provider: this.anchor.provider,
      modelId: this.anchor.modelId,
      api: this.anchor.modelApi,
      payloadFingerprint: this.anchor.payloadFingerprint,
    });
    this.anchor.latestRealTurn = observation;
    // Keep these legacy anchor fields useful for scheduling and integrations,
    // but do not use them as the probe counters or real-turn classification.
    if (cacheRead > 0) this.anchor.cachedTokens = cacheRead;
    if (promptTokens > 0) this.anchor.promptTokens = promptTokens;
    this.anchor.lastActivityAt = Date.now();
    // A real turn refreshes the idle-cutoff base. Probe hits never do.
    this.anchor.lastRealTurnAt = Date.now();
    this.anchor.consecutiveFailures = 0;
    this.log({
      event: "usage",
      source: "real_turn",
      sessionId: this.anchor.sessionId,
      provider: this.anchor.provider,
      modelId: this.anchor.modelId,
      api: this.anchor.modelApi,
      capabilityState: this.anchor.capability.state,
      capabilityReason: this.anchor.capability.reason,
      cacheRead,
      cacheWrite,
      input,
      output,
      promptTokens,
      realTurnState: observation.state,
      realTurnReason: observation.reason,
      cacheKeyFingerprint: this.anchor.cacheKeyFingerprint,
      payloadFingerprint: observation.payloadFingerprint,
      retryState: "probe failure streak reset by real turn",
    });
  }

  onAgentStart(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    if (!this.config.enabled) {
      this.stateBeforeDisabled = this.lifecycleState;
      this.lifecycleState = "disabled";
    } else if (this.autoWarmBlockReason) {
      this.lifecycleState = "blocked";
    }
    this.clearTimers();
    if (this.capability.state === "verified" && ctx.hasUI) {
      ctx.ui.setStatus("pi-warm-cache", ctx.ui.theme.fg("dim", "warm paused · agent active"));
    } else if (this.capability.state !== "verified") {
      this.clearCapabilityUi(ctx);
    }
    this.log({
      event: "agent_start",
      source: "system",
      sessionId: this.anchor?.sessionId,
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
      api: ctx.model?.api,
      capabilityState: this.capability.state,
      capabilityReason: this.capability.reason,
      cacheKeyFingerprint:
        this.anchor?.cacheKeyFingerprint ?? getPromptCacheKeyFingerprint(this.lastPayload, ctx.model?.api),
    });
  }

  onAgentSettled(ctx: ExtensionContext): void {
    this.ctx = ctx;
    if (!this.config.enabled) {
      this.stateBeforeDisabled = this.lifecycleState;
      this.lifecycleState = "disabled";
      this.showIdle(ctx, "disabled");
      return;
    }
    const preservingReanchorCaptureTime = this.reanchorCaptureAt !== null;
    if (this.anchor && !preservingReanchorCaptureTime) {
      this.anchor.lastActivityAt = Date.now();
    }
    if (this.anchor && preservingReanchorCaptureTime) {
      this.anchor.lastActivityAt = this.reanchorCaptureAt!;
    }
    this.log({
      event: "agent_settled",
      source: "system",
      sessionId: this.anchor?.sessionId,
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
      api: ctx.model?.api,
      capabilityState: this.anchor?.capability.state ?? this.capability?.state,
      capabilityReason: this.anchor?.capability.reason ?? this.capability?.reason,
      hasPayload: Boolean(this.lastPayload),
      cachedTokens: this.anchor?.cachedTokens ?? 0,
      cacheKeyFingerprint:
        this.anchor?.cacheKeyFingerprint ?? getPromptCacheKeyFingerprint(this.lastPayload, ctx.model?.api),
      realTurnState: this.anchor?.latestRealTurn.state,
      realTurnReason: this.anchor?.latestRealTurn.reason,
      probeOutcome: this.anchor?.latestProbe?.outcome,
      probeHits: this.anchor?.probeHitCount,
      probeMisses: this.anchor?.probeMissCount,
      retryState: this.anchor
        ? `${this.anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}`
        : undefined,
      scheduleFromCapture: preservingReanchorCaptureTime,
    });
    this.reschedule({ reason: preservingReanchorCaptureTime ? "fresh re-anchor" : undefined });
    this.reanchorCaptureAt = null;
  }

  onModelChange(ctx: ExtensionContext): void {
    this.invalidateAnchor(ctx, "model or thinking level changed · waiting for next turn");
  }

  /** Manual warm for /warm now */
  async warmNow(ctx: ExtensionContext): Promise<WarmResult> {
    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    const result = await this.runWarm("manual");
    return this.withRouteDiagnostics(result);
  }

  getStatusText(): string {
    const log =
      this.config.logToFile && this.getLogFile() ? `log=${this.getLogFile()}` : "";
    const capability = this.currentCapability(this.ctx);
    const model = this.ctx?.model;
    const anchor = this.anchor;
    const route = anchor
      ? `${anchor.provider}/${anchor.modelId}`
      : model
        ? `${model.provider}/${model.id}`
        : "none";
    const api = anchor?.modelApi ?? model?.api ?? "none";
    const xaiRoute = this.isXaiRoute();
    const cacheKey =
      anchor?.cacheKeyFingerprint ?? getPromptCacheKeyFingerprint(this.lastPayload, model?.api);
    const realTurn = anchor ? formatRealTurnStatus(anchor.latestRealTurn) : "none";
    const probe = formatProbeStatus(anchor?.latestProbe ?? this.lastInvalidatedProbe);
    const retry = anchor
      ? `probeFailStreak=${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}`
      : "probeFailStreak=none";
    const last = this.lastAttempt
      ? `last=${this.lastAttempt.detail} at=${new Date(this.lastAttempt.at).toISOString()}`
      : "last=none";
    const autoWarm = this.autoWarmBlockReason
      ? "autoWarm=blocked"
      : capability.automaticWarm
        ? "autoWarm=on"
        : "autoWarm=off";
    const strategy = anchor?.cacheFamily ?? this.plan?.family ?? "none";
    const cadence = this.plan?.ttlLabel ?? "none";
    const intervalMs = this.plan?.intervalMs ?? null;
    const nextDue = this.nextDueAt ? new Date(this.nextDueAt).toISOString() : "none";
    const activeWarmSessions = globalGate.getActive();
    const deferredProbe = this.getDeferredProbe();
    const probeHits = anchor?.probeHitCount ?? 0;
    const probeMisses = anchor?.probeMissCount ?? 0;
    const stableBlock = [
      `lifecycle=${this.lifecycleState}`,
      `capability=${capability.state}`,
      `capabilityReason=${capability.reason}`,
      `provider=${route}`,
      `api=${api}`,
      xaiRoute ? "policy=xAI-best-effort" : "",
      `strategy=${strategy}`,
      `cadence=${cadence}`,
      `intervalMs=${intervalMs ?? "none"}`,
      `nextDue=${nextDue}`,
      `activeWarmSessions=${activeWarmSessions}/${this.config.maxConcurrentWarmSessions}`,
      `deferred=${deferredProbe ? formatDeferralStatus(deferredProbe) : "none"}`,
      `realTurn=${realTurn}`,
      `probe=${probe}`,
      "probeSource=extension-only",
      `probeHits=${probeHits}`,
      `probeMisses=${probeMisses}`,
      retry,
      `savingsSummary=${this.getSavingsSummaryText()}`,
      `cacheKey=${cacheKey}`,
      anchor ? `pfp=${anchor.payloadFingerprint.slice(0, 8)}` : "pfp=none",
      autoWarm,
      anchor?.modelApi === "openai-codex-responses" && this.config.allowCodexAutoWarm
        ? "codexAuto=on"
        : "",
      this.autoWarmBlockReason ? `blockReason=${this.autoWarmBlockReason}` : "",
      this.spendBlockReason ? `spendCeiling=${this.spendBlockReason}` : "spendCeiling=ok",
      anchor ? `probes=${anchor.probeCount}` : "probes=0",
      anchor ? `savings=${formatSavingsLabel(anchor)}` : "",
      anchor ? `pricing=${anchor.pricingSource}` : "",
      anchor
        ? `realRead=${anchor.latestRealTurn.cacheRead} realWrite=${anchor.latestRealTurn.cacheWrite} probeRead=${anchor.latestProbe?.cacheRead ?? "none"} prompt≈${getKnownPromptTokens(anchor)}`
        : "",
      last,
      log,
    ]
      .filter(Boolean)
      .join("\n");

    if (!this.config.enabled) {
      return ["disabled", stableBlock].join("\n");
    }

    if (capability.state !== "verified") {
      const manualProbe = anchor
        ? anchor.manualProbeAvailable
          ? "ready"
          : "unsafe-payload"
        : capability.manualProbe
          ? "waiting-for-safe-payload"
          : "off";
      return [
        `inactive capability=${capability.state}`,
        `reason=${capability.reason}`,
        `manualProbe=${manualProbe}`,
        stableBlock,
      ].join("\n");
    }

    if (!anchor) {
      return [
        "idle (no anchor)",
        this.lifecycleState === "awaiting-reanchor"
          ? "payload=none (needs re-anchor)"
          : "payload=none (waiting for first real turn)",
        stableBlock,
      ].join("\n");
    }

    if (!this.lastPayload) {
      return [
        `enabled family=${anchor.cacheFamily}`,
        "payload=none (needs re-anchor)",
        stableBlock,
      ].join("\n");
    }

    if (!this.plan || !this.plan.automaticWarm || this.plan.intervalMs === null) {
      return [
        "inactive capability=verified",
        `reason=${this.plan?.ttlLabel ?? "no automatic strategy"}`,
        stableBlock,
      ].join("\n");
    }

    return [`enabled family=${anchor.cacheFamily}`, stableBlock].join("\n");
  }

  /**
   * Arm the next warm attempt.
   * Pass delayMs for deferral paths (busy / concurrency) so we do not collapse
   * into a 1s retry loop once lastActivityAt is older than the TTL interval.
   */
  reschedule(options: RescheduleOptions = {}): void {
    if (this.disposed || !this.config.enabled) return;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.lifecycleState === "awaiting-reanchor") {
      this.clearTimers();
      return;
    }
    const capability = this.currentCapability(ctx);
    this.capability = capability;
    if (capability.state !== "verified" || !capability.automaticWarm) {
      this.clearTimers();
      this.log({
        event: "schedule_skipped",
        source: "system",
        sessionId: this.anchor?.sessionId,
        provider: this.anchor?.provider ?? ctx.model?.provider,
        modelId: this.anchor?.modelId ?? ctx.model?.id,
        api: this.anchor?.modelApi ?? ctx.model?.api,
        capabilityState: capability.state,
        capabilityReason: capability.reason,
        automaticWarm: capability.automaticWarm,
        cacheKeyFingerprint:
          this.anchor?.cacheKeyFingerprint ?? getPromptCacheKeyFingerprint(this.lastPayload, ctx.model?.api),
        reason: "capability does not permit automatic warming",
      });
      this.clearCapabilityUi(ctx);
      return;
    }
    if (this.autoWarmBlockReason) {
      this.showIdle(
        ctx,
        "auto-warm blocked",
        `${this.autoWarmBlockReason} · /warm resume to re-enable`,
      );
      return;
    }
    // Codex has no output-token cap. Measured first-tick out≈1127 on GPT-5.6 Luna.
    // Do not auto-schedule unless the user explicitly opts in.
    const api = this.anchor?.modelApi ?? ctx.model?.api;
    if (api === "openai-codex-responses" && !this.config.allowCodexAutoWarm) {
      this.showIdle(
        ctx,
        "codex auto-warm off",
        "Codex OK-suffix warm can hit cache cheaply, but auto-warm is disabled for this session. /warm codex-on to enable timers, or /warm now for one probe.",
      );
      return;
    }
    const anchor = this.anchor;
    const payload = this.lastPayload;
    const plan = this.plan;
    if (!anchor || !payload || !plan) {
      this.showIdle(ctx, options.reason ?? "waiting for next turn");
      return;
    }
    if (!plan.automaticWarm || plan.intervalMs === null) {
      this.showIdle(
        ctx,
        "automatic warming unavailable",
        "No verified keepalive strategy is available for this route.",
      );
      return;
    }
    const knownPromptTokens = getKnownPromptTokens(anchor);
    if (knownPromptTokens < this.config.minCachedTokens) {
      this.showIdle(ctx, `prefix < ${this.config.minCachedTokens} tok`);
      return;
    }
    if (anchor.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.showFailure(
        ctx,
        "too many failures",
        this.lastAttempt?.detail ?? "see /warm and .pi/warm-cache.jsonl",
      );
      return;
    }

    this.clearTimers();

    let delay: number;
    if (typeof options.delayMs === "number") {
      delay = Math.max(1_000, options.delayMs);
    } else {
      const elapsed = Date.now() - anchor.lastActivityAt;
      delay = Math.max(1_000, plan.intervalMs - elapsed);
    }

    // Idle warm cutoff, checked after the delayMs deferral paths merge so a
    // busy/concurrency deferral also stops once the session has been idle past
    // the bound. Do not pre-compute fire-time idle here; the runWarm fire
    // check enforces the strict boundary at fire time.
    const cutoffMs = resolveMaxIdleWarmMs(
      this.config,
      anchor.cacheFamily,
      anchor.cacheFamily === "xai-best-effort" ? (plan.intervalMs ?? undefined) : undefined,
    );
    if (cutoffMs !== null) {
      const idleMs = Date.now() - anchor.lastRealTurnAt;
      if (idleMs >= cutoffMs) {
        this.clearTimers();
        const idleLabel = formatDurationShort(idleMs);
        this.log({
          event: "idle_cutoff",
          source: "system",
          sessionId: anchor.sessionId,
          provider: anchor.provider,
          modelId: anchor.modelId,
          api: anchor.modelApi,
          capabilityState: anchor.capability.state,
          capabilityReason: anchor.capability.reason,
          automaticWarm: anchor.capability.automaticWarm,
          family: anchor.cacheFamily,
          cacheKeyFingerprint: anchor.cacheKeyFingerprint,
          idleMs,
          cutoffMs,
          reason: "idle warm cutoff reached",
        });
        this.showIdle(
          ctx,
          "idle cutoff reached",
          `no real turn for ${idleLabel} (cutoff ${formatDurationShort(cutoffMs)}); warming paused until the next real turn`,
        );
        return;
      }
    }
    this.nextDueAt = Date.now() + delay;

    renderWaitingUi(ctx, this.config, anchor, plan, this.nextDueAt, this.getDeferredProbe());
    this.log({
      event: "schedule",
      source: "system",
      sessionId: anchor.sessionId,
      provider: anchor.provider,
      modelId: anchor.modelId,
      api: anchor.modelApi,
      capabilityState: anchor.capability.state,
      capabilityReason: anchor.capability.reason,
      automaticWarm: anchor.capability.automaticWarm,
      family: anchor.cacheFamily,
      cacheKeyFingerprint: anchor.cacheKeyFingerprint,
      delayMs: delay,
      nextDueAt: new Date(this.nextDueAt).toISOString(),
      reason: options.reason ?? "ttl",
    });

    this.timer = setTimeout(() => {
      void this.runWarm("timer");
    }, delay);
    // Keep the warm timer referenced in interactive sessions.
    if (!ctx.hasUI) unrefTimer(this.timer);

    this.uiTimer = setInterval(() => {
      if (!this.ctx || !this.anchor || !this.plan || this.plan.intervalMs === null) return;
      renderWaitingUi(
        this.ctx,
        this.config,
        this.anchor,
        this.plan,
        this.nextDueAt,
        this.getDeferredProbe(),
      );
    }, 15_000);
    unrefTimer(this.uiTimer);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.timer = null;
    this.uiTimer = null;
    this.nextDueAt = 0;
  }

  private stop(reason: string): void {
    if (reason === "disabled") {
      // Capture the current lifecycle state before entering "disabled"
      this.stateBeforeDisabled = this.lifecycleState;
      this.lifecycleState = "disabled";
    }
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
    if (reason === "disabled") this.deferredProbe = null;
    if (!this.ctx) return;
    if (this.currentCapability(this.ctx).state === "verified") {
      this.showIdle(this.ctx, reason);
    } else {
      this.clearCapabilityUi(this.ctx);
    }
  }

  private clearCapabilityUi(ctx: ExtensionContext): void {
    const capability = this.currentCapability(ctx);
    if (
      this.config.enabled &&
      capability.state === "unverified" &&
      capability.manualProbe
    ) {
      renderManualOnlyUi(
        ctx,
        this.config,
        capability,
        Boolean(this.anchor?.manualProbeAvailable),
      );
      return;
    }
    clearWarmUi(ctx);
  }

  /** Benign non-warming states (not painted as errors). */
  private showIdle(ctx: ExtensionContext, reason: string, detail?: string): void {
    if (this.currentCapability(ctx).state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    renderIdleUi(ctx, this.config, reason, detail, this.bestEffortUiLabel());
  }

  /** Non-alarming hard-invalidation state. No probe is allowed before re-anchor. */
  private showReanchoring(ctx: ExtensionContext, reason: string): void {
    if (this.currentCapability(ctx).state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    renderReanchorUi(ctx, this.config, reason, this.bestEffortUiLabel());
  }

  /** Real failures / retries (keep panel visible with reason). */
  private showFailure(ctx: ExtensionContext, reason: string, detail?: string): void {
    if (this.currentCapability(ctx).state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    renderFailureUi(
      ctx,
      this.config,
      reason,
      detail,
      this.nextDueAt > Date.now() ? this.nextDueAt : undefined,
      this.bestEffortUiLabel(),
    );
  }

  /**
   * Best-effort UI label for this instance: family label first, then a
   * provider-keyed fallback for collapsed-family surfaces (unverified routes
   * collapse the family to "unverified", so isXaiRoute() keeps the xAI label
   * there). Never model-id driven.
   */
  private bestEffortUiLabel(): string | null {
    return (
      bestEffortFamilyLabel(this.plan?.family ?? this.anchor?.cacheFamily) ??
      (this.isXaiRoute() ? "xAI best-effort" : null)
    );
  }

  private observeProbeResult(
    anchor: CacheAnchor,
    result: WarmResult,
    model: NonNullable<ExtensionContext["model"]>,
    outcome: ProbeOutcome,
    fingerprint: string,
  ): ProbeObservation {
    anchor.probeCount += 1;
    if (anchor.savingsKnown && result.cacheHit) {
      anchor.totalEstimatedSavedUsd += result.estimatedSavedUsd;
    }
    const probeCost = Number.isFinite(result.costUsd) && result.costUsd >= 0 ? result.costUsd : 0;
    anchor.totalProbeCostUsd += probeCost;
    // Module-level per-provider campaign ledger. Incremented on every provider
    // response; the spend ceiling checks it in runWarm before the gate.
    probeSpendLedger.add(anchor.provider, probeCost);
    anchor.estimatedSavingsUsd = anchor.savingsKnown
      ? anchor.totalEstimatedSavedUsd - anchor.totalProbeCostUsd
      : 0;
    if (result.cacheHit) {
      anchor.probeHitCount += 1;
      anchor.cachedTokens = result.cacheRead;
      anchor.promptTokens = result.input + result.cacheRead + result.cacheWrite;
      anchor.lastProbeAt = Date.now();
    } else {
      anchor.probeMissCount += 1;
    }
    if (result.input + result.cacheRead + result.cacheWrite > 0) {
      anchor.promptTokens = result.input + result.cacheRead + result.cacheWrite;
    }
    result.probeOutcome = outcome;
    const observation: ProbeObservation = {
      outcome,
      cacheRead: result.cacheRead,
      cacheWrite: result.cacheWrite,
      input: result.input,
      output: result.output,
      costUsd: result.costUsd,
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      payloadFingerprint: fingerprint,
      observedAt: Date.now(),
      error: result.error,
    };
    anchor.latestProbe = observation;
    return observation;
  }

  private observeProbeError(
    anchor: CacheAnchor,
    model: NonNullable<ExtensionContext["model"]>,
    fingerprint: string,
    error: string,
  ): void {
    anchor.latestProbe = {
      outcome: "error",
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      costUsd: 0,
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      payloadFingerprint: fingerprint,
      observedAt: Date.now(),
      error,
    };
  }

  private recordAttempt(
    reason: "timer" | "manual" | "system",
    ok: boolean,
    detail: string,
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      costTotal?: number;
    },
    probeOutcome?: ProbeOutcome,
  ): void {
    this.lastAttempt = { at: Date.now(), reason, ok, detail };
    const capability = this.currentCapability(this.ctx);
    this.log({
      event: "attempt",
      source: reason === "system" ? "system" : "warm_probe",
      sessionId: this.anchor?.sessionId,
      provider: this.anchor?.provider ?? this.ctx?.model?.provider,
      modelId: this.anchor?.modelId ?? this.ctx?.model?.id,
      api: this.anchor?.modelApi ?? this.ctx?.model?.api,
      capabilityState: capability?.state,
      capabilityReason: capability?.reason,
      automaticWarm: capability?.automaticWarm,
      manualProbe: capability?.manualProbe,
      reason,
      ok,
      detail,
      probeOutcome,
      family: this.anchor?.cacheFamily,
      cacheKeyFingerprint:
        this.anchor?.cacheKeyFingerprint ?? getPromptCacheKeyFingerprint(this.lastPayload, this.ctx?.model?.api),
      payloadFingerprint: this.anchor?.payloadFingerprint,
      retryState: this.anchor
        ? `${this.anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}`
        : undefined,
      // Raw usage for diagnosis (input/output/cacheRead/cacheWrite).
      // Note: OpenAI/Codex implicit caching often leaves cacheWrite at 0 even on
      // cold prompts; do not treat write=0 as incomplete mapping by itself.
      usage: usage
        ? {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            cacheRead: usage.cacheRead ?? 0,
            cacheWrite: usage.cacheWrite ?? 0,
            costTotal: usage.costTotal ?? 0,
          }
        : undefined,
    });
  }

  private log(event: Omit<WarmLogEvent, "ts">): void {
    if (!this.config.logToFile) return;
    const { event: eventName, ...fields } = event;
    const logEvent: WarmLogEvent = {
      ts: new Date().toISOString(),
      event: eventName as string,
      ...fields,
    };
    const path = appendWarmLog(this.ctx?.cwd, logEvent);
    if (path) this.logFile = path;
  }

  private withRouteDiagnostics(result: WarmResult): WarmResult {
    const anchor = this.anchor;
    const model = this.ctx?.model;
    const capability = this.currentCapability(this.ctx);
    return {
      ...result,
      capabilityState: result.capabilityState ?? capability.state,
      capabilityReason: result.capabilityReason ?? capability.reason,
      provider: result.provider ?? anchor?.provider ?? model?.provider,
      modelId: result.modelId ?? anchor?.modelId ?? model?.id,
      api: result.api ?? anchor?.modelApi ?? model?.api,
      family: result.family ?? anchor?.cacheFamily ?? this.plan?.family,
      strategyLabel: result.strategyLabel ?? this.plan?.ttlLabel,
      intervalMs:
        result.intervalMs !== undefined ? result.intervalMs : (this.plan?.intervalMs ?? null),
      cacheKeyFingerprint:
        result.cacheKeyFingerprint ??
        anchor?.cacheKeyFingerprint ??
        getPromptCacheKeyFingerprint(this.lastPayload, model?.api),
      retryState:
        result.retryState ??
        (anchor ? `${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}` : "none"),
    };
  }

  /**
   * True when the probe-spend ceiling (or its zero-cost probe-count fallback) is
   * tripped for a provider under the current config. Used by setConfig to
   * re-evaluate a soft block and by runWarm before the concurrency gate.
   */
  private spendCeilingTripped(provider: string): boolean {
    const ceilingUsd = resolveProviderSpendCeilingUsd(this.config, provider);
    if (ceilingUsd === null) return false;
    const spend = probeSpendLedger.getSpendUsd(provider);
    const count = probeSpendLedger.getProbeCount(provider);
    return spend >= ceilingUsd || (spend === 0 && count >= SPEND_PROBE_COUNT_FALLBACK);
  }

  private deferProbe(
    reason: WarmDeferralReason,
    attemptReason: "timer" | "manual",
  ): WarmDeferralState {
    const deferral: WarmDeferralState = {
      reason,
      activeWarmSessions: globalGate.getActive(),
      maxConcurrentWarmSessions: this.config.maxConcurrentWarmSessions,
      deferredAt: Date.now(),
    };
    this.deferredProbe = deferral;
    const detail = `warm ${attemptReason} deferred - ${formatDeferralStatus(deferral)}`;
    const capability = this.currentCapability(this.ctx);
    this.log({
      event: "warm_deferred",
      source: "warm_probe",
      sessionId: this.anchor?.sessionId,
      provider: this.anchor?.provider ?? this.ctx?.model?.provider,
      modelId: this.anchor?.modelId ?? this.ctx?.model?.id,
      api: this.anchor?.modelApi ?? this.ctx?.model?.api,
      capabilityState: capability.state,
      capabilityReason: capability.reason,
      automaticWarm: capability.automaticWarm,
      manualProbe: capability.manualProbe,
      family: this.anchor?.cacheFamily,
      cacheKeyFingerprint:
        this.anchor?.cacheKeyFingerprint ?? getPromptCacheKeyFingerprint(this.lastPayload, this.ctx?.model?.api),
      payloadFingerprint: this.anchor?.payloadFingerprint,
      reason,
      attemptReason,
      detail,
      deferred: true,
      activeWarmSessions: deferral.activeWarmSessions,
      maxConcurrentWarmSessions: deferral.maxConcurrentWarmSessions,
      providerRequest: false,
    });
    return deferral;
  }

  private buildDeferredWarmResult(anchor: CacheAnchor, deferral: WarmDeferralState): WarmResult {
    return {
      ...buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: deferral.reason,
        anchor,
      }),
      deferred: deferral,
    };
  }

  private async runWarm(reason: "timer" | "manual"): Promise<WarmResult> {
    const ctx = this.ctx;
    const anchor = this.anchor;
    const payload = this.lastPayload;
    const plan = this.plan;
    const capability = this.currentCapability(ctx);

    if (capability.state === "unsupported") {
      this.clearTimers();
      this.recordAttempt(reason, false, `unsupported: ${capability.reason}`);
      if (ctx) this.clearCapabilityUi(ctx);
      return {
        ok: false,
        cacheHit: false,
        probeOutcome: "unavailable",
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        costUsd: 0,
        estimatedSavedUsd: 0,
        error: capability.reason,
        unavailable: true,
        fingerprint: anchor?.payloadFingerprint ?? "",
      };
    }

    if (capability.state === "unverified" && reason === "timer") {
      this.clearTimers();
      this.recordAttempt(reason, false, `automatic warming disabled: ${capability.reason}`);
      if (ctx) this.clearCapabilityUi(ctx);
      return {
        ok: false,
        cacheHit: false,
        probeOutcome: "unavailable",
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        costUsd: 0,
        estimatedSavedUsd: 0,
        error: "automatic warming is disabled for an unverified route",
        unavailable: true,
        fingerprint: anchor?.payloadFingerprint ?? "",
      };
    }

    if (this.lifecycleState === "awaiting-reanchor") {
      const detail = "awaiting a new real-turn payload";
      this.clearTimers();
      this.recordAttempt(reason, false, detail);
      if (ctx) this.clearCapabilityUi(ctx);
      return {
        ok: false,
        cacheHit: false,
        probeOutcome: "unavailable",
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        costUsd: 0,
        estimatedSavedUsd: 0,
        error: detail,
        unavailable: true,
        fingerprint: "",
      };
    }

    if (reason === "timer" && this.autoWarmBlockReason) {
      this.recordAttempt(reason, false, `blocked: ${this.autoWarmBlockReason}`);
      if (ctx) {
        this.showIdle(ctx, "auto-warm blocked", `${this.autoWarmBlockReason} · /warm resume`);
      }
      return {
        ok: false,
        cacheHit: false,
        probeOutcome: "unavailable",
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        costUsd: 0,
        estimatedSavedUsd: 0,
        error: "auto-warm blocked",
        fingerprint: anchor?.payloadFingerprint ?? "",
      };
    }

    // Per-instance probe-spend soft block. Cleared only by this instance's
    // capturePayload, so another session's real turn cannot resume our probes
    // by resetting the shared module-level ledger.
    if (reason === "timer" && this.spendBlockReason) {
      const detail = `spend ceiling: ${this.spendBlockReason}`;
      this.recordAttempt(reason, false, detail);
      this.clearTimers();
      if (ctx) {
        this.showIdle(
          ctx,
          "spend ceiling reached",
          `${this.spendBlockReason} · a real turn resets the campaign ledger; /warm now bypasses the ceiling`,
        );
      }
      return {
        ok: false,
        cacheHit: false,
        probeOutcome: "unavailable",
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        costUsd: 0,
        estimatedSavedUsd: 0,
        error: this.spendBlockReason,
        unavailable: true,
        fingerprint: anchor?.payloadFingerprint ?? "",
      };
    }

    if (!ctx || !anchor || !payload || !plan) {
      const detail =
        capability.state === "unverified"
          ? `no safe captured payload for manual probe: ${capability.reason}`
          : "no anchor";
      this.recordAttempt(reason, false, detail);
      if (ctx) this.clearCapabilityUi(ctx);
      return {
        ok: false,
        cacheHit: false,
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        costUsd: 0,
        estimatedSavedUsd: 0,
        error: detail,
        unavailable: capability.state === "unverified",
        fingerprint: "",
      };
    }

    if (anchor.cacheFamily === "xai-best-effort" && !isSafeXaiReplayPayload(payload)) {
      const detail =
        "xAI best-effort probe requires an exact Responses payload with a stable prompt_cache_key; no provider request was sent";
      this.clearTimers();
      this.recordAttempt(reason, false, detail);
      this.showIdle(ctx, "xAI probe unavailable", detail);
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: detail,
        unavailable: true,
        anchor,
      });
    }

    // The retained family never probes, even when verified: the wire already
    // requests 24h retention, so keepalive is not needed. The refusal is
    // family-specific and independent of capability state, mirroring the xAI
    // key-safety gate above; a verified retained route bypasses the
    // unverified manual-probe gate below, so this check must stand alone.
    if (anchor.cacheFamily === "opencode-go-retained") {
      const detail =
        "the retained OpenCode Go family never probes; the captured payload requests 24h retention on the wire, so keepalive is not needed";
      this.clearTimers();
      this.recordAttempt(reason, false, detail);
      this.clearCapabilityUi(ctx);
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: detail,
        unavailable: true,
        anchor,
      });
    }

    if (capability.state === "unverified" && !anchor.manualProbeAvailable) {
      const detail = "captured payload shape is not safe for an unverified manual probe";
      this.recordAttempt(reason, false, detail);
      this.clearCapabilityUi(ctx);
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: detail,
        unavailable: true,
        anchor,
      });
    }

    // Timer-fire idle cutoff. A timer probe fires only while idle since the
    // last real turn is strictly below the cutoff at fire time. This early
    // return (before this.warming = true) means the finally reschedule never
    // runs, so the abort cannot re-arm the loop. Never counts as a probe
    // failure and never touches consecutiveFailures.
    if (reason === "timer") {
      const cutoffMs = resolveMaxIdleWarmMs(
        this.config,
        anchor.cacheFamily,
        anchor.cacheFamily === "xai-best-effort" ? (plan.intervalMs ?? undefined) : undefined,
      );
      if (cutoffMs !== null) {
        const idleMs = Date.now() - anchor.lastRealTurnAt;
        if (idleMs >= cutoffMs) {
          const detail = `idle warm cutoff reached (idle ${formatDurationShort(idleMs)} >= ${formatDurationShort(cutoffMs)})`;
          this.clearTimers();
          this.recordAttempt(reason, false, detail);
          if (ctx) {
            this.showIdle(
              ctx,
              "idle cutoff reached",
              "no real turn since the last warm boundary; warming paused until the next real turn",
            );
          }
          return {
            ok: false,
            cacheHit: false,
            probeOutcome: "unavailable",
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
            costUsd: 0,
            estimatedSavedUsd: 0,
            error: detail,
            unavailable: true,
            fingerprint: anchor.payloadFingerprint,
          };
        }
      }
    }

    if (!ctx.isIdle() && reason === "timer") {
      const deferral = this.deferProbe("agent busy", reason);
      this.recordAttempt(reason, false, `agent busy - ${formatDeferralStatus(deferral)}`);
      this.reschedule({ delayMs: DEFER_BACKOFF_MS, reason: "agent busy" });
      return this.buildDeferredWarmResult(anchor, deferral);
    }

    if (this.warming) {
      this.recordAttempt(reason, false, "already warming");
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: "already warming",
        anchor,
      });
    }

    const model = ctx.model;
    if (!model) {
      this.recordAttempt(reason, false, "no model");
      this.showFailure(ctx, "no model");
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: "no model",
        anchor,
      });
    }

    // Spec decision #14: pass the exact captured payload so payload-derived
    // capability reasons (the opencode-go plain hint, marker families, and the
    // foreign-instrumentation refusal) match the anchor and do not fire a
    // spurious route-changed invalidation on every warm probe. this.lastPayload
    // is nulled on invalidation and only set alongside a fresh anchor, so it is
    // the payload that produced anchor.capability.reason.
    const currentCapability = resolveProviderCapability(model, payload);
    if (
      model.provider !== anchor.provider ||
      model.id !== anchor.modelId ||
      model.api !== anchor.modelApi ||
      currentCapability.state !== anchor.capability.state ||
      currentCapability.reason !== anchor.capability.reason
    ) {
      this.recordAttempt(reason, false, "model/provider route changed");
      this.onModelChange(ctx);
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: "model changed",
        anchor,
      });
    }

    // Per-provider probe-spend ceiling, checked before the concurrency gate so
    // a ceiling-active provider never spends while a slot is waiting. Scoped to
    // timer fires only; /warm now bypasses both guards.
    if (reason === "timer") {
      const ceilingUsd = resolveProviderSpendCeilingUsd(this.config, anchor.provider);
      if (ceilingUsd !== null) {
        const campaignSpend = probeSpendLedger.getSpendUsd(anchor.provider);
        const campaignProbes = probeSpendLedger.getProbeCount(anchor.provider);
        const overSpend = campaignSpend >= ceilingUsd;
        // The probe-count fallback applies only while the campaign has no
        // measurable spend: when model cost fields are zero or unusable,
        // costUsd is always zero and a dollar ceiling never trips, so the
        // count ceiling bounds the campaign instead. A priced session is
        // bounded by dollars, never by this count.
        const overProbeCount =
          campaignSpend === 0 && campaignProbes >= SPEND_PROBE_COUNT_FALLBACK;
        if (overSpend || overProbeCount) {
          this.spendBlockReason = overSpend
            ? `probe spend ceiling reached ($${ceilingUsd.toFixed(2)} for ${anchor.provider}; campaign total $${campaignSpend.toFixed(2)})`
            : `probe count ceiling reached (${SPEND_PROBE_COUNT_FALLBACK} probes for ${anchor.provider} this campaign)`;
          const detail = `spend ceiling: ${this.spendBlockReason}`;
          this.clearTimers();
          this.recordAttempt(reason, false, detail);
          if (ctx) {
            this.showIdle(
              ctx,
              "spend ceiling reached",
              `${this.spendBlockReason} · a real turn resets the campaign ledger`,
            );
          }
          return {
            ok: false,
            cacheHit: false,
            probeOutcome: "unavailable",
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
            costUsd: 0,
            estimatedSavedUsd: 0,
            error: this.spendBlockReason,
            unavailable: true,
            fingerprint: anchor.payloadFingerprint,
          };
        }
      }
    }

    if (!globalGate.tryEnter(this.config.maxConcurrentWarmSessions)) {
      const deferral = this.deferProbe("concurrency limit", reason);
      this.recordAttempt(reason, false, formatDeferralStatus(deferral));
      this.reschedule({ delayMs: DEFER_BACKOFF_MS, reason: "concurrency limit" });
      return this.buildDeferredWarmResult(anchor, deferral);
    }

    this.deferredProbe = null;
    this.warming = true;
    this.abort = new AbortController();
    const fingerprint = anchor.payloadFingerprint;
    let shouldRescheduleAfter = true;

    const unverifiedProbe = anchor.capability.state === "unverified";
    if (ctx.hasUI && !unverifiedProbe) {
      ctx.ui.setStatus("pi-warm-cache", ctx.ui.theme.fg("dim", "warm ping · in flight"));
    }
    this.log({
      event: "warm_start",
      source: "warm_probe",
      sessionId: anchor.sessionId,
      reason,
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      capabilityState: anchor.capability.state,
      capabilityReason: anchor.capability.reason,
      automaticWarm: anchor.capability.automaticWarm,
      manualProbe: anchor.capability.manualProbe,
      family: anchor.cacheFamily,
      cacheKeyFingerprint: anchor.cacheKeyFingerprint,
      payloadFingerprint: fingerprint,
    });

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? "missing api key" : auth.error);
      }

      const response = await this.completeRequest(
        model,
        {
          systemPrompt: "cache-warm",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: this.config.warmSuffix }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal: this.abort.signal,
          maxTokens: this.config.maxOutputTokens,
          cacheRetention: plan.cacheRetention,
          sessionId: anchor.sessionId,
          onPayload: () => {
            // 1) Clone last real payload (exact tools/system/history prefix).
            // 2) Codex only: append constrained warm user turn so the model is
            //    not asked to continue the agent trajectory (no output cap).
            //    Do NOT append on Anthropic: max_tokens already yields out≈1, and
            //    a second consecutive user role can 400 (roles must alternate).
            // 3) Apply API-legal output limits only.
            // Note: complete()'s dummy warmSuffix message is discarded here; the
            // body that wins is this onPayload result (by design).
            const cloned = structuredClone(payload);
            const codex = model.api === "openai-codex-responses";
            const xaiBestEffort = anchor.cacheFamily === "xai-best-effort";
            const shaped = codex
              ? appendWarmUserTurn(cloned, this.config.warmSuffix, model.api)
              : cloned;
            return xaiBestEffort
              ? applyXaiWarmOutputLimit(shaped, this.config.maxOutputTokens)
              : applyWarmOutputLimit(
                  shaped,
                  this.config.maxOutputTokens,
                  model.api,
                  getModelCompat(model),
                );
          },
        },
      );

      if (response.stopReason === "aborted") {
        throw new Error("aborted");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "provider error");
      }

      const result = buildWarmResult({
        fingerprint,
        usage: response.usage,
        anchor,
      });
      const usageSnap = {
        input: result.input,
        output: result.output,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
        costTotal: result.costUsd,
      };

      // Classify probe outcome once before observation and updates.
      const outcome: ProbeOutcome = result.cacheHit
        ? "hit"
        : classifyProbeOutcome({
            cacheFamily: anchor.cacheFamily,
            cacheRead: result.cacheRead,
            cacheWrite: result.cacheWrite,
            consecutiveFailuresBefore: anchor.consecutiveFailures,
            maxConsecutiveFailures: this.config.maxConsecutiveFailures,
          });
      this.observeProbeResult(anchor, result, model, outcome, fingerprint);

      if (unverifiedProbe) {
        const payloadDrift = outcome === "payload-drift";
        const unverifiedProbeLabel =
          model.provider === "xai" ? "xAI best-effort manual probe" : "unverified probe";
        const detail =
          `${unverifiedProbeLabel} ${payloadDrift ? "payload-drift" : result.cacheHit ? "hit" : "miss"} provider=${model.provider} api=${model.api} ` +
          `read=${result.cacheRead} write=${result.cacheWrite} in=${result.input} ` +
          `out=${result.output} cost=${result.costUsd}`;
        this.recordAttempt(reason, result.cacheHit, detail, usageSnap, outcome);
        if (payloadDrift) {
          this.enterAwaitingReanchor(
            ctx,
            "unverified probe payload drift · waiting for next turn",
            true,
          );
        }
        // The /warm now command owns the user-facing warning and full
        // diagnostics. Keep this lifecycle layer silent to avoid duplicate toasts.
        this.clearCapabilityUi(ctx);
        return result;
      }

      // Codex has no API output cap. OK-suffix ticks are usually small (out≈5-32).
      // First oversized tick: soft-skip and reschedule. Second consecutive: sticky block.
      const codexApi = model.api === "openai-codex-responses";
      if (codexApi) {
        const policy = decideCodexOversizedAction(result.output, this.consecutiveCodexOversized);
        this.consecutiveCodexOversized = policy.consecutiveAfter;
        if (policy.decision !== "ok") {
          if (result.cacheHit) {
            anchor.lastActivityAt = Date.now();
          }
          const usageBit =
            `out=${result.output} read=${result.cacheRead} write=${result.cacheWrite} in=${result.input}`;
          if (policy.decision === "soft-skip") {
            const detail =
              `Codex probe oversized (${usageBit}). Soft-skip #${policy.consecutiveAfter}; ` +
              `sticky-block on a second consecutive spike (threshold=${CODEX_WARM_OUTPUT_ABORT_TOKENS}).`;
            this.recordAttempt(reason, false, detail, usageSnap, outcome);
            if (ctx.hasUI) ctx.ui.notify(`pi-warm-cache: ${detail}`, "warning");
            this.showFailure(ctx, "codex probe output high · retry", detail);
            return result;
          }
          shouldRescheduleAfter = false;
          const detail =
            `Codex probe oversized twice (${usageBit}). ` +
            `Auto-warm blocked for this session until /warm resume.`;
          this.blockAutoWarm(detail);
          this.recordAttempt(reason, false, detail, usageSnap, outcome);
          if (ctx.hasUI) ctx.ui.notify(`pi-warm-cache: ${detail}`, "warning");
          this.showFailure(ctx, "codex auto-warm blocked", detail);
          return result;
        }
      }

      if (result.cacheHit) {
        anchor.lastActivityAt = Date.now();
        anchor.consecutiveFailures = 0;
        const bestEffortHit = isBestEffortNoWriteFamily(anchor.cacheFamily);
        this.recordAttempt(
          reason,
          true,
          `${bestEffortHit ? `${bestEffortFamilyLabel(anchor.cacheFamily) ?? "best-effort"} probe hit` : "probe hit"} ` +
            `read=${result.cacheRead} write=${result.cacheWrite} out=${result.output} in=${result.input}`,
          usageSnap,
          outcome,
        );
        renderWarmHitUi(ctx, this.config, anchor, plan, result.cacheRead);
      } else {
        const payloadDrift = outcome === "payload-drift";
        const bestEffortNoWrite = isBestEffortNoWriteFamily(anchor.cacheFamily);
        // classifyProbeOutcome upgrades the final budgeted no-read result to
        // payload-drift because these routes may not report cache writes.
        const noWriteReanchor =
          bestEffortNoWrite && result.cacheRead === 0 && result.cacheWrite === 0;
        const transientImplicitMiss = outcome === "transient-miss";
        const bestEffortLabel = bestEffortFamilyLabel(anchor.cacheFamily) ?? "best-effort";
        // The xAI branch keeps its exact current wording; the Go marker/plain
        // families use the gateway phrasing.
        const omitWritePhrase =
          anchor.cacheFamily === "xai-best-effort"
            ? "xAI may omit cache-write usage"
            : "the gateway may omit cache-write usage";
        anchor.consecutiveFailures += 1;
        const detail = noWriteReanchor
          ? `${bestEffortLabel} probe ${outcome} read=0 write=0; ${omitWritePhrase}; ` +
            `retry=${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures} ` +
            `in=${result.input} out=${result.output} cost=${result.costUsd}`
          : `probe ${outcome} read=${result.cacheRead} write=${result.cacheWrite} ` +
            `in=${result.input} out=${result.output} cost=${result.costUsd}`;
        this.recordAttempt(reason, false, detail, usageSnap, outcome);

        if (payloadDrift) {
          const reanchorDetail = noWriteReanchor
            ? `${bestEffortLabel} probes returned no cached reads or writes for ${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures} attempts. ` +
              `${omitWritePhrase}, so the configured failure budget is exhausted and a new real-turn anchor is required.`
            : `write=${result.cacheWrite} read=0. Payload likely diverged from provider cache.`;
          if (ctx.hasUI) {
            ctx.ui.notify(
              `pi-warm-cache: ${bestEffortNoWrite ? `${bestEffortLabel} probe miss` : "probe miss"}; re-anchor required (${reanchorDetail})`,
              "warning",
            );
          }
          const reanchorReason = `probe payload drift · ${reanchorDetail}`;
          this.enterAwaitingReanchor(ctx, reanchorReason, true);
          shouldRescheduleAfter = false;
          this.showReanchoring(ctx, reanchorReason);
          return result;
        }

        if (transientImplicitMiss) {
          // The first implicit-cache no-read/no-write response is retryable and
          // intentionally quiet. The manual command still reports raw usage.
          renderProbeRetryUi(
            ctx,
            this.config,
            noWriteReanchor
              ? `${bestEffortLabel} probe returned read=0 write=0; ${omitWritePhrase}. ` +
                `Retrying within the configured failure budget (${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}).`
              : `read=${result.cacheRead} write=${result.cacheWrite} · retry scheduled`,
            this.nextDueAt > Date.now() ? this.nextDueAt : undefined,
            bestEffortFamilyLabel(anchor.cacheFamily),
          );
        } else {
          const persistentMissDetail = noWriteReanchor
            ? `${bestEffortLabel} probe still returned no cached reads or writes. ` +
              `${omitWritePhrase}; retry ${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures} remains within the configured failure budget.`
            : `read=${result.cacheRead} write=${result.cacheWrite}`;
          if (ctx.hasUI) {
            ctx.ui.notify(
              `pi-warm-cache: ${bestEffortNoWrite ? `${bestEffortLabel} probe miss` : "persistent probe miss"} (${persistentMissDetail})`,
              "warning",
            );
          }
          this.showFailure(
            ctx,
            `${bestEffortNoWrite ? `${bestEffortLabel} probe miss` : "probe miss"} · retry ${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}`,
            persistentMissDetail,
          );
        }
      }

      return result;
    } catch (err) {
      if (!unverifiedProbe) anchor.consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      const xaiBestEffort = model.provider === "xai";
      const probeErrorLabel = xaiBestEffort
        ? "xAI best-effort probe error"
        : unverifiedProbe
          ? "unverified probe error"
          : "probe error";
      this.observeProbeError(anchor, model, fingerprint, message);
      this.recordAttempt(
        reason,
        false,
        `${probeErrorLabel}: ${message}`,
        undefined,
        "error",
      );
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-warm-cache: ${probeErrorLabel} - ${message}`, "error");
      }
      if (unverifiedProbe) this.clearCapabilityUi(ctx);
      else this.showFailure(ctx, probeErrorLabel, message);
      return buildWarmResult({
        fingerprint,
        error: message,
        anchor,
      });
    } finally {
      this.warming = false;
      this.abort = null;
      globalGate.leave();
      if (!this.disposed && this.config.enabled && shouldRescheduleAfter) {
        this.reschedule();
      }
    }
  }
}

function formatRealTurnStatus(observation: RealTurnObservation): string {
  return [
    observation.state,
    `(read=${observation.cacheRead}`,
    `write=${observation.cacheWrite}`,
    `input=${observation.input}`,
    `prompt=${observation.promptTokens}`,
    `reason=${compactDiagnostic(observation.reason)})`,
  ].join(" ");
}

function formatProbeStatus(observation: ProbeObservation | null): string {
  if (!observation) return "none";
  return [
    observation.outcome,
    `(read=${observation.cacheRead}`,
    `write=${observation.cacheWrite}`,
    `in=${observation.input}`,
    `out=${observation.output}`,
    `cost=$${observation.costUsd.toFixed(4)}`,
    `pfp=${observation.payloadFingerprint.slice(0, 8)}${observation.error ? ` error=${compactDiagnostic(observation.error)}` : ""})`,
  ]
    .filter(Boolean)
    .join(" ");
}

function getKnownPromptTokens(anchor: CacheAnchor): number {
  const probePrompt = anchor.latestProbe
    ? anchor.latestProbe.input + anchor.latestProbe.cacheRead + anchor.latestProbe.cacheWrite
    : 0;
  return Math.max(anchor.latestRealTurn.promptTokens, probePrompt, anchor.promptTokens);
}

function makeUnknownRealTurnObservation(args: {
  provider: string;
  modelId: string;
  api: string;
  payloadFingerprint: string;
  reason: string;
}): RealTurnObservation {
  return {
    state: "unknown",
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    promptTokens: 0,
    provider: args.provider,
    modelId: args.modelId,
    api: args.api,
    payloadFingerprint: args.payloadFingerprint,
    observedAt: null,
    reason: args.reason,
  };
}

function compactDiagnostic(value: string): string {
  return value.trim().replace(/\s+/g, "_");
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  const t = timer as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}
