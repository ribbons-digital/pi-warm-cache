import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendWarmUserTurn,
  applyWarmOutputLimit,
  applyXaiWarmOutputLimit,
  classifyProbeOutcome,
  classifyRealTurnObservation,
  CODEX_WARM_OUTPUT_ABORT_TOKENS,
  decideCodexOversizedAction,
  DEFER_BACKOFF_MS,
  getPromptCacheKey,
  isPayloadContinuation,
  isSafeReplayPayload,
  isSafeXaiReplayPayload,
  resolveProviderCapability,
  resolveStrategy,
  stableFingerprint,
} from "./provider.ts";
import { appendWarmLog, warmLogPath, type WarmLogEvent } from "./log.ts";
import {
  buildWarmResult,
  formatSavingsLabel,
  formatSavingsSummary,
  resolveModelPricing,
} from "./savings.ts";
import {
  clearWarmUi,
  renderFailureUi,
  renderIdleUi,
  renderProbeRetryUi,
  renderReanchorUi,
  renderWaitingUi,
  renderWarmHitUi,
} from "./ui.ts";
import type { StrategyResolution } from "./provider.ts";
import type {
  CacheAnchor,
  ProbeObservation,
  ProbeOutcome,
  ProviderCapability,
  RealTurnObservation,
  WarmCacheConfig,
  WarmLifecycleState,
  WarmResult,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

/** Process-wide gate so many sessions do not warm at once. */
class WarmConcurrencyGate {
  private active = 0;
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

type CompleteRequest = typeof complete;

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
  /** Consecutive Codex warm ticks with out >= CODEX_WARM_OUTPUT_ABORT_TOKENS. */
  private consecutiveCodexOversized = 0;
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

  getLifecycleState(): WarmLifecycleState {
    return this.lifecycleState;
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
    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    this.lastInvalidatedProbe = preserveProbe ? (this.anchor?.latestProbe ?? null) : null;
    this.anchor = null;
    this.lastPayload = null;
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
      reason,
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
    const payloadFingerprint = stableFingerprint(payload);
    const model = ctx.model;
    this.capability = resolveProviderCapability(model);

    if (!model || this.capability.state === "unsupported") {
      this.anchor = null;
      this.lastInvalidatedProbe = null;
      this.lastPayload = null;
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
        capabilityState: this.capability.state,
        capabilityReason: this.capability.reason,
        ignored: true,
      });
      this.clearCapabilityUi(ctx);
      return;
    }

    let prev = this.anchor;
    let previousPayload = this.lastPayload;
    const sameRoute = Boolean(
      prev &&
        prev.provider === model.provider &&
        prev.modelId === model.id &&
        prev.modelApi === model.api &&
        prev.capability.state === this.capability.state &&
        prev.capability.reason === this.capability.reason,
    );
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
      : !sameRoute
        ? "model or provider route changed"
        : !payloadContinuation
          ? "prefix changed"
          : comparableContinuation
            ? "comparable continuation"
            : "no comparable prior real turn";
    const prefixChanged = Boolean(prev && !payloadContinuation);
    if (prefixChanged) {
      const driftReason = !sameRoute ? "model or provider route changed" : "prefix changed";
      this.enterAwaitingReanchor(ctx, `${driftReason} · waiting for next turn`);
      prev = null;
      previousPayload = null;
    }

    this.lastInvalidatedProbe = null;
    this.lastPayload = structuredClone(payload);
    this.plan = resolveStrategy(model, this.config, this.lastPayload);
    const cacheKey = getPromptCacheKey(this.lastPayload, model.api);
    const cacheKeyFingerprint = cacheKey
      ? stableFingerprint(cacheKey).split(":")[0]!.slice(0, 8)
      : "none";
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
    const savingsKnown = this.capability.state === "verified" && pricing.savingsKnown;
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
      lastActivityAt: Date.now(),
      // Keep the latest probe alongside a continuing real-turn observation so
      // /warm can show whether that probe preceded the next real turn. A
      // changed prefix starts a new anchor and must not inherit old evidence.
      lastProbeAt: preserveSessionStats ? (prev?.lastProbeAt ?? null) : null,
      estimatedSavingsUsd:
        savingsKnown && preserveSessionStats ? (prev?.estimatedSavingsUsd ?? 0) : 0,
      totalEstimatedSavedUsd:
        savingsKnown && preserveSessionStats ? (prev?.totalEstimatedSavedUsd ?? 0) : 0,
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
      prefixChanged,
      realTurnContinuity: comparableContinuation ? "comparable" : "unknown",
      realTurnContinuityReason: continuityReason,
      modelCost: model.cost ?? null,
      pricingSource: pricing.source,
      savingsKnown,
      inputPricePerMTok: pricing.inputPricePerMTok,
      cacheReadPricePerMTok: pricing.cacheReadPricePerMTok,
    });

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
    if (this.anchor) {
      this.anchor.lastActivityAt = Date.now();
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
      cacheKeyFingerprint: this.anchor?.cacheKeyFingerprint,
      realTurnState: this.anchor?.latestRealTurn.state,
      realTurnReason: this.anchor?.latestRealTurn.reason,
      probeOutcome: this.anchor?.latestProbe?.outcome,
      probeHits: this.anchor?.probeHitCount,
      probeMisses: this.anchor?.probeMissCount,
      retryState: this.anchor
        ? `${this.anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}`
        : undefined,
    });
    this.reschedule();
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
    const cacheKey = anchor?.cacheKeyFingerprint ?? "none";
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
    const probeHits = anchor?.probeHitCount ?? 0;
    const probeMisses = anchor?.probeMissCount ?? 0;
    const stableBlock = [
      `lifecycle=${this.lifecycleState}`,
      `capability=${capability.state}`,
      `capabilityReason=${capability.reason}`,
      `provider=${route}`,
      `api=${api}`,
      `strategy=${strategy}`,
      `cadence=${cadence}`,
      `intervalMs=${intervalMs ?? "none"}`,
      `nextDue=${nextDue}`,
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
    this.nextDueAt = Date.now() + delay;

    renderWaitingUi(ctx, this.config, anchor, plan, this.nextDueAt);
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
      renderWaitingUi(this.ctx, this.config, this.anchor, this.plan, this.nextDueAt);
    }, 15_000);
    unrefTimer(this.uiTimer);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.timer = null;
    this.uiTimer = null;
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
    if (!this.ctx) return;
    if (this.currentCapability(this.ctx).state === "verified") {
      this.showIdle(this.ctx, reason);
    } else {
      this.clearCapabilityUi(this.ctx);
    }
  }

  private clearCapabilityUi(ctx: ExtensionContext): void {
    clearWarmUi(ctx);
  }

  /** Benign non-warming states (not painted as errors). */
  private showIdle(ctx: ExtensionContext, reason: string, detail?: string): void {
    if (this.currentCapability(ctx).state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    renderIdleUi(ctx, this.config, reason, detail);
  }

  /** Non-alarming hard-invalidation state. No probe is allowed before re-anchor. */
  private showReanchoring(ctx: ExtensionContext, reason: string): void {
    if (this.currentCapability(ctx).state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    renderReanchorUi(ctx, this.config, reason);
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
      cacheKeyFingerprint: this.anchor?.cacheKeyFingerprint,
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
      cacheKeyFingerprint: result.cacheKeyFingerprint ?? anchor?.cacheKeyFingerprint,
      retryState:
        result.retryState ??
        (anchor ? `${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}` : "none"),
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
        "xAI best-effort probe requires an exact Responses payload with a stable prompt_cache_key";
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

    if (!ctx.isIdle() && reason === "timer") {
      this.recordAttempt(reason, false, "agent busy");
      this.reschedule({ delayMs: DEFER_BACKOFF_MS, reason: "agent busy" });
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: "agent busy",
        anchor,
      });
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

    const currentCapability = resolveProviderCapability(model);
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

    if (!globalGate.tryEnter(this.config.maxConcurrentWarmSessions)) {
      this.recordAttempt(reason, false, "concurrency limit");
      this.reschedule({ delayMs: DEFER_BACKOFF_MS, reason: "concurrency limit" });
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: "concurrency limit",
        anchor,
      });
    }

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
              : applyWarmOutputLimit(shaped, this.config.maxOutputTokens, model.api);
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
        const detail =
          `unverified probe ${payloadDrift ? "payload-drift" : result.cacheHit ? "hit" : "miss"} provider=${model.provider} api=${model.api} ` +
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
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-warm-cache: ${detail}. No active keepalive or verified savings claim.`,
            result.cacheHit ? "info" : "warning",
          );
        }
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
        this.recordAttempt(
          reason,
          true,
          `probe hit read=${result.cacheRead} write=${result.cacheWrite} out=${result.output} in=${result.input}`,
          usageSnap,
          outcome,
        );
        renderWarmHitUi(ctx, this.config, anchor, plan, result.cacheRead);
      } else {
        const payloadDrift = outcome === "payload-drift";
        // classifyProbeOutcome upgrades the final budgeted xAI no-read result
        // to payload-drift because this route may not report cache writes.
        const xaiNoWriteReanchor =
          anchor.cacheFamily === "xai-best-effort" &&
          result.cacheRead === 0 &&
          result.cacheWrite === 0;
        const transientImplicitMiss = outcome === "transient-miss";
        anchor.consecutiveFailures += 1;
        const detail =
          `probe ${outcome} read=${result.cacheRead} write=${result.cacheWrite} ` +
          `in=${result.input} out=${result.output} cost=${result.costUsd}`;
        this.recordAttempt(reason, false, detail, usageSnap, outcome);

        if (payloadDrift) {
          const reanchorDetail = xaiNoWriteReanchor
            ? "Repeated xAI no-read/no-write probes; xAI does not expose cache-write usage, so re-anchor is required."
            : `write=${result.cacheWrite} read=0. Payload likely diverged from provider cache.`;
          if (ctx.hasUI) {
            ctx.ui.notify(
              `pi-warm-cache: probe miss; re-anchor required (${reanchorDetail})`,
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
            `read=${result.cacheRead} write=${result.cacheWrite} · retry scheduled`,
            this.nextDueAt > Date.now() ? this.nextDueAt : undefined,
          );
        } else {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `pi-warm-cache: persistent probe miss (read=${result.cacheRead} write=${result.cacheWrite}).`,
              "warning",
            );
          }
          this.showFailure(
            ctx,
            `probe miss · retry ${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}`,
            `read=${result.cacheRead} write=${result.cacheWrite}`,
          );
        }
      }

      return result;
    } catch (err) {
      if (!unverifiedProbe) anchor.consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.observeProbeError(anchor, model, fingerprint, message);
      this.recordAttempt(
        reason,
        false,
        `${unverifiedProbe ? "unverified probe error" : "probe error"}: ${message}`,
        undefined,
        "error",
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-warm-cache: ${unverifiedProbe ? "unverified probe error" : "probe error"} - ${message}`,
          "error",
        );
      }
      if (unverifiedProbe) this.clearCapabilityUi(ctx);
      else this.showFailure(ctx, "probe error", message);
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
