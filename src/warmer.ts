import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendWarmUserTurn,
  applyWarmOutputLimit,
  CODEX_WARM_OUTPUT_ABORT_TOKENS,
  decideCodexOversizedAction,
  DEFER_BACKOFF_MS,
  isSafeReplayPayload,
  resolveProviderCapability,
  resolveStrategy,
  stableFingerprint,
} from "./provider.ts";
import { appendWarmLog, warmLogPath, type WarmLogEvent } from "./log.ts";
import { buildWarmResult, formatSavingsLabel, resolveModelPricing } from "./savings.ts";
import {
  clearWarmUi,
  renderFailureUi,
  renderIdleUi,
  renderWaitingUi,
  renderWarmHitUi,
} from "./ui.ts";
import type { StrategyResolution } from "./provider.ts";
import type {
  CacheAnchor,
  ProviderCapability,
  WarmCacheConfig,
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

export type RescheduleOptions = {
  /** Explicit delay. When set, skips TTL-from-lastActivity math. */
  delayMs?: number;
  /** Why we are waiting (for status text). */
  reason?: string;
};

export class SessionWarmer {
  private config: WarmCacheConfig = { ...DEFAULT_CONFIG };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private warming = false;
  private disposed = false;
  private nextDueAt = 0;
  private anchor: CacheAnchor | null = null;
  private lastPayload: unknown | null = null;
  private capability: ProviderCapability | null = null;
  private ctx: ExtensionContext | null = null;
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

  constructor(private readonly pi: ExtensionAPI) {}

  isWarming(): boolean {
    return this.warming;
  }

  getConfig(): WarmCacheConfig {
    return this.config;
  }

  getCapability(): ProviderCapability {
    return this.capability ?? resolveProviderCapability(this.ctx?.model);
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
  }

  getAutoWarmBlockReason(): string | null {
    return this.autoWarmBlockReason;
  }

  private blockAutoWarm(reason: string): void {
    this.autoWarmBlockReason = reason;
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
    this.logFile = warmLogPath(ctx.cwd);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
    this.anchor = null;
    this.lastPayload = null;
    this.capability = null;
    if (this.ctx) clearWarmUi(this.ctx);
    this.ctx = null;
  }

  /**
   * Drop the cache anchor after events that make the previous provider prefix unusable:
   * model/effort change, compaction, or tree navigation.
   *
   * Idle custom_message / advisor injections do not invalidate the provider cache
   * from the last real turn. Those must not call this method.
   */
  invalidateAnchor(ctx: ExtensionContext, reason: string): void {
    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    this.anchor = null;
    this.lastPayload = null;
    this.plan = null;
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
    this.recordAttempt("system", false, `invalidated: ${reason}`);
    this.log({
      event: "anchor_invalidated",
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
      api: ctx.model?.api,
      capabilityState: this.capability.state,
      capabilityReason: this.capability.reason,
      reason,
    });
    if (this.capability.state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    // Compaction / branch / model change are expected idle states, not errors.
    this.showIdle(ctx, reason);
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
      this.lastPayload = null;
      this.plan = null;
      this.clearTimers();
      this.abort?.abort();
      this.abort = null;
      this.log({
        event: "capture",
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

    const prev = this.anchor;
    const prefixChanged = Boolean(prev && prev.payloadFingerprint !== payloadFingerprint);

    this.lastPayload = structuredClone(payload);
    this.plan = resolveStrategy(model, this.config, this.lastPayload);
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
    const preserveSessionStats = Boolean(
      prev &&
        prev.provider === model.provider &&
        prev.modelId === model.id &&
        prev.modelApi === model.api &&
        prev.capability.state === this.capability.state &&
        prev.capability.reason === this.capability.reason,
    );

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
      cachedTokens: prefixChanged || !preserveSessionStats ? 0 : (prev?.cachedTokens ?? 0),
      promptTokens: prefixChanged || !preserveSessionStats ? 0 : (prev?.promptTokens ?? 0),
      cacheReadPricePerMTok: pricing.cacheReadPricePerMTok,
      inputPricePerMTok: pricing.inputPricePerMTok,
      savingsKnown,
      pricingSource: pricing.source,
      lastActivityAt: Date.now(),
      lastWarmAt:
        this.capability.state === "verified" && !prefixChanged
          ? (prev?.lastWarmAt ?? null)
          : null,
      estimatedSavingsUsd:
        savingsKnown && preserveSessionStats ? (prev?.estimatedSavingsUsd ?? 0) : 0,
      warmHitCount:
        this.capability.state === "verified" && preserveSessionStats
          ? (prev?.warmHitCount ?? 0)
          : 0,
      warmMissCount:
        this.capability.state === "verified" && preserveSessionStats
          ? (prev?.warmMissCount ?? 0)
          : 0,
      probeCount:
        this.capability.state === "unverified" && preserveSessionStats && !prefixChanged
          ? (prev?.probeCount ?? 0)
          : 0,
      probeHitCount:
        this.capability.state === "unverified" && preserveSessionStats && !prefixChanged
          ? (prev?.probeHitCount ?? 0)
          : 0,
      probeMissCount:
        this.capability.state === "unverified" && preserveSessionStats && !prefixChanged
          ? (prev?.probeMissCount ?? 0)
          : 0,
      consecutiveFailures: 0,
    };

    this.log({
      event: "capture",
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
      prefixChanged,
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
    if (!this.anchor) return;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const input = usage.input ?? 0;
    const promptTokens = input + cacheRead + cacheWrite;
    if (cacheRead > 0) this.anchor.cachedTokens = cacheRead;
    if (promptTokens > 0) this.anchor.promptTokens = promptTokens;
    this.anchor.lastActivityAt = Date.now();
    this.anchor.consecutiveFailures = 0;
    this.ctx = ctx;
    this.log({
      event: "usage",
      sessionId: this.anchor.sessionId,
      provider: this.anchor.provider,
      modelId: this.anchor.modelId,
      api: this.anchor.modelApi,
      capabilityState: this.anchor.capability.state,
      capabilityReason: this.anchor.capability.reason,
      cacheRead,
      cacheWrite,
      input,
      promptTokens,
    });
  }

  onAgentStart(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    this.clearTimers();
    if (this.capability.state === "verified" && ctx.hasUI && this.config.showWidget) {
      ctx.ui.setStatus("pi-warm-cache", ctx.ui.theme.fg("dim", "warm paused · agent active"));
    } else if (this.capability.state !== "verified") {
      this.clearCapabilityUi(ctx);
    }
    this.log({
      event: "agent_start",
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
      this.showIdle(ctx, "disabled");
      return;
    }
    if (this.anchor) {
      this.anchor.lastActivityAt = Date.now();
    }
    this.log({
      event: "agent_settled",
      sessionId: this.anchor?.sessionId,
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
      api: ctx.model?.api,
      capabilityState: this.anchor?.capability.state ?? this.capability?.state,
      capabilityReason: this.anchor?.capability.reason ?? this.capability?.reason,
      hasPayload: Boolean(this.lastPayload),
      cachedTokens: this.anchor?.cachedTokens ?? 0,
    });
    this.reschedule();
  }

  onModelChange(ctx: ExtensionContext): void {
    this.invalidateAnchor(ctx, "waiting for next turn");
  }

  /** Manual warm for /warm now */
  async warmNow(ctx: ExtensionContext): Promise<WarmResult> {
    this.ctx = ctx;
    this.capability = resolveProviderCapability(ctx.model);
    const result = await this.runWarm("manual");
    return this.withRouteDiagnostics(result);
  }

  getStatusText(): string {
    if (!this.config.enabled) return "disabled";
    const log =
      this.config.logToFile && this.getLogFile() ? ` log=${this.getLogFile()}` : "";
    const capability = this.capability ?? resolveProviderCapability(this.ctx?.model);
    const model = this.ctx?.model;
    const route = this.anchor
      ? `${this.anchor.provider}/${this.anchor.modelId}`
      : model
        ? `${model.provider}/${model.id}`
        : "none";
    const api = this.anchor?.modelApi ?? model?.api ?? "none";
    const last = this.lastAttempt
      ? `last=${this.lastAttempt.detail} at=${new Date(this.lastAttempt.at).toISOString()}`
      : "last=none";
    const blocked = this.autoWarmBlockReason
      ? "autoWarm=blocked"
      : capability.automaticWarm
        ? "autoWarm=on"
        : "autoWarm=off";

    if (capability.state !== "verified") {
      const probe = this.anchor
        ? this.anchor.manualProbeAvailable
          ? "ready"
          : "unsafe-payload"
        : capability.manualProbe
          ? "waiting-for-safe-payload"
          : "off";
      return [
        `inactive capability=${capability.state}`,
        `provider=${route}`,
        `api=${api}`,
        `reason=${capability.reason}`,
        `manualProbe=${probe}`,
        this.anchor ? `probes=${this.anchor.probeCount} probeHits=${this.anchor.probeHitCount}` : "",
        last,
        log.trim(),
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (!this.anchor) {
      return [
        "idle (no anchor)",
        "capability=verified",
        `provider=${route}`,
        `api=${api}`,
        blocked,
        last,
        log.trim(),
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (!this.lastPayload) {
      return [
        `enabled family=${this.anchor.cacheFamily}`,
        "payload=none (needs re-anchor)",
        "capability=verified",
        `provider=${route}`,
        `api=${api}`,
        `hits=${this.anchor.warmHitCount}`,
        `misses=${this.anchor.warmMissCount}`,
        last,
        log.trim(),
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (!this.plan || !this.plan.automaticWarm || this.plan.intervalMs === null) {
      return [
        "inactive capability=verified",
        `provider=${route}`,
        `api=${api}`,
        "reason=no automatic strategy",
        last,
        log.trim(),
      ]
        .filter(Boolean)
        .join(" ");
    }

    const due = this.nextDueAt ? new Date(this.nextDueAt).toISOString() : "n/a";
    return [
      `enabled family=${this.anchor.cacheFamily}`,
      "capability=verified",
      `capabilityReason=${this.anchor.capability.reason}`,
      `provider=${route}`,
      `api=${api}`,
      `cached≈${this.anchor.cachedTokens}`,
      `hits=${this.anchor.warmHitCount}`,
      `misses=${this.anchor.warmMissCount}`,
      `failStreak=${this.anchor.consecutiveFailures}`,
      `savings=${formatSavingsLabel(this.anchor)}`,
      `pricing=${this.anchor.pricingSource}`,
      `nextDue=${due}`,
      `pfp=${this.anchor.payloadFingerprint.slice(0, 8)}`,
      blocked,
      this.anchor.modelApi === "openai-codex-responses" && this.config.allowCodexAutoWarm
        ? "codexAuto=on"
        : "",
      this.autoWarmBlockReason ? `blockReason=${this.autoWarmBlockReason}` : "",
      last,
      log.trim(),
    ]
      .filter(Boolean)
      .join(" ");
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
    const capability = this.anchor?.capability ?? resolveProviderCapability(ctx.model);
    this.capability = capability;
    if (capability.state !== "verified" || !capability.automaticWarm) {
      this.clearTimers();
      this.log({
        event: "schedule_skipped",
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
      this.clearCapabilityUi(ctx);
      return;
    }
    if ((anchor.cachedTokens || anchor.promptTokens) < this.config.minCachedTokens) {
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
      sessionId: anchor.sessionId,
      provider: anchor.provider,
      modelId: anchor.modelId,
      api: anchor.modelApi,
      capabilityState: anchor.capability.state,
      capabilityReason: anchor.capability.reason,
      automaticWarm: anchor.capability.automaticWarm,
      family: anchor.cacheFamily,
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
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
    if (!this.ctx) return;
    if ((this.capability ?? resolveProviderCapability(this.ctx.model)).state === "verified") {
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
    if ((this.capability ?? resolveProviderCapability(ctx.model)).state !== "verified") {
      this.clearCapabilityUi(ctx);
      return;
    }
    renderIdleUi(ctx, this.config, reason, detail);
  }

  /** Real failures / retries (keep panel visible with reason). */
  private showFailure(ctx: ExtensionContext, reason: string, detail?: string): void {
    if ((this.anchor?.capability ?? this.capability ?? resolveProviderCapability(ctx.model)).state !== "verified") {
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
  ): void {
    this.lastAttempt = { at: Date.now(), reason, ok, detail };
    const capability = this.anchor?.capability ?? this.capability;
    this.log({
      event: "attempt",
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
    const capability = anchor?.capability ?? this.capability ?? resolveProviderCapability(model);
    return {
      ...result,
      capabilityState: result.capabilityState ?? capability.state,
      capabilityReason: result.capabilityReason ?? capability.reason,
      provider: result.provider ?? anchor?.provider ?? model?.provider,
      modelId: result.modelId ?? anchor?.modelId ?? model?.id,
      api: result.api ?? anchor?.modelApi ?? model?.api,
    };
  }

  private async runWarm(reason: "timer" | "manual"): Promise<WarmResult> {
    const ctx = this.ctx;
    const anchor = this.anchor;
    const payload = this.lastPayload;
    const plan = this.plan;
    const capability = anchor?.capability ?? this.capability ?? resolveProviderCapability(ctx?.model);

    if (capability.state === "unsupported") {
      this.clearTimers();
      this.recordAttempt(reason, false, `unsupported: ${capability.reason}`);
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
        error: capability.reason,
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
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        costUsd: 0,
        estimatedSavedUsd: 0,
        error: "automatic warming is disabled for an unverified route",
        fingerprint: anchor?.payloadFingerprint ?? "",
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
        fingerprint: "",
      };
    }

    if (capability.state === "unverified" && !anchor.manualProbeAvailable) {
      const detail = "captured payload shape is not safe for an unverified manual probe";
      this.recordAttempt(reason, false, detail);
      this.clearCapabilityUi(ctx);
      return buildWarmResult({
        fingerprint: anchor.payloadFingerprint,
        error: detail,
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
      sessionId: anchor.sessionId,
      reason,
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      capabilityState: anchor.capability.state,
      capabilityReason: anchor.capability.reason,
      automaticWarm: anchor.capability.automaticWarm,
      manualProbe: anchor.capability.manualProbe,
      payloadFingerprint: fingerprint,
    });

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? "missing api key" : auth.error);
      }

      const response = await complete(
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
            const shaped = codex
              ? appendWarmUserTurn(cloned, this.config.warmSuffix, model.api)
              : cloned;
            return applyWarmOutputLimit(shaped, this.config.maxOutputTokens, model.api);
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

      if (unverifiedProbe) {
        anchor.probeCount += 1;
        if (result.cacheHit) {
          anchor.probeHitCount += 1;
          anchor.cachedTokens = result.cacheRead;
          anchor.promptTokens = result.input + result.cacheRead + result.cacheWrite;
        } else {
          anchor.probeMissCount += 1;
        }
        const outcome = result.cacheHit ? "observed cache read" : "no cache read observed";
        const detail =
          `unverified probe ${outcome} provider=${model.provider} api=${model.api} ` +
          `read=${result.cacheRead} write=${result.cacheWrite} in=${result.input} ` +
          `out=${result.output} cost=${result.costUsd}`;
        this.recordAttempt(reason, result.cacheHit, detail, usageSnap);
        if (ctx.hasUI) {
          ctx.ui.notify(`pi-warm-cache: ${detail}. No active keepalive or verified savings claim.`, result.cacheHit ? "info" : "warning");
        }
        this.clearCapabilityUi(ctx);
        return result;
      }

      if (anchor.savingsKnown && result.costUsd > 0) {
        anchor.estimatedSavingsUsd -= result.costUsd;
      }

      // Codex has no API output cap. OK-suffix ticks are usually small (out≈5-32).
      // First oversized tick: soft-skip and reschedule. Second consecutive: sticky block.
      const codexApi = model.api === "openai-codex-responses";
      if (codexApi) {
        const policy = decideCodexOversizedAction(result.output, this.consecutiveCodexOversized);
        this.consecutiveCodexOversized = policy.consecutiveAfter;
        if (policy.decision !== "ok") {
          if (result.cacheHit) {
            anchor.warmHitCount += 1;
            anchor.cachedTokens = result.cacheRead;
            anchor.promptTokens = result.input + result.cacheRead + result.cacheWrite;
            anchor.lastWarmAt = Date.now();
            anchor.lastActivityAt = Date.now();
          } else {
            anchor.warmMissCount += 1;
          }
          const usageBit =
            `out=${result.output} read=${result.cacheRead} write=${result.cacheWrite} in=${result.input}`;
          if (policy.decision === "soft-skip") {
            const detail =
              `Codex warm oversized (${usageBit}). Soft-skip #${policy.consecutiveAfter}; ` +
              `sticky-block on a second consecutive spike (threshold=${CODEX_WARM_OUTPUT_ABORT_TOKENS}).`;
            this.recordAttempt(reason, false, detail, usageSnap);
            if (ctx.hasUI) ctx.ui.notify(`pi-warm-cache: ${detail}`, "warning");
            this.showFailure(ctx, "codex out high · retry", detail);
            return result;
          }
          shouldRescheduleAfter = false;
          const detail =
            `Codex warm oversized twice (${usageBit}). ` +
            `Auto-warm blocked for this session until /warm resume.`;
          this.blockAutoWarm(detail);
          this.recordAttempt(reason, false, detail, usageSnap);
          if (ctx.hasUI) ctx.ui.notify(`pi-warm-cache: ${detail}`, "warning");
          this.showFailure(ctx, "codex auto-warm blocked", detail);
          return result;
        }
      }

      if (result.cacheHit) {
        anchor.warmHitCount += 1;
        anchor.cachedTokens = result.cacheRead;
        anchor.promptTokens = result.input + result.cacheRead + result.cacheWrite;
        if (anchor.savingsKnown) {
          anchor.estimatedSavingsUsd += result.estimatedSavedUsd;
        }
        anchor.lastWarmAt = Date.now();
        anchor.lastActivityAt = Date.now();
        anchor.consecutiveFailures = 0;
        this.recordAttempt(
          reason,
          true,
          `hit read=${result.cacheRead} write=${result.cacheWrite} out=${result.output} in=${result.input}`,
          usageSnap,
        );
        renderWarmHitUi(ctx, this.config, anchor, plan, result.cacheRead);
      } else {
        anchor.warmMissCount += 1;
        anchor.consecutiveFailures += 1;
        this.recordAttempt(
          reason,
          false,
          `miss read=${result.cacheRead} write=${result.cacheWrite} in=${result.input} out=${result.output}`,
          usageSnap,
        );
        if (ctx.hasUI) {
          ctx.ui.notify(
            `pi-warm-cache: warm miss (read=${result.cacheRead} write=${result.cacheWrite}).`,
            "warning",
          );
        }
        if (result.cacheWrite > 0 && result.cacheRead === 0) {
          this.lastPayload = null;
          shouldRescheduleAfter = false;
          this.showFailure(
            ctx,
            "warm miss · re-anchor needed",
            `write=${result.cacheWrite} read=0. Payload likely diverged from provider cache.`,
          );
          return result;
        }
        this.showFailure(
          ctx,
          `warm miss · retry ${anchor.consecutiveFailures}/${this.config.maxConsecutiveFailures}`,
          `read=${result.cacheRead} write=${result.cacheWrite}`,
        );
      }

      return result;
    } catch (err) {
      if (!unverifiedProbe) anchor.consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.recordAttempt(
        reason,
        false,
        `${unverifiedProbe ? "unverified probe error" : "error"}: ${message}`,
      );
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-warm-cache: ${unverifiedProbe ? "unverified probe error" : "warm error"} - ${message}`, "error");
      }
      if (unverifiedProbe) this.clearCapabilityUi(ctx);
      else this.showFailure(ctx, "warm error", message);
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

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  const t = timer as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}
