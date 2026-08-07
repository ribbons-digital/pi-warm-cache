import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDurationShort } from "./config.ts";
import { formatSavingsLabel } from "./savings.ts";
import type {
  CacheAnchor,
  ProviderCapability,
  StrategyPlan,
  WarmCacheConfig,
} from "./types.ts";

const WIDGET_ID = "pi-warm-cache";
const STATUS_ID = "pi-warm-cache";

export function clearWarmUi(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_ID, undefined);
  ctx.ui.setStatus(STATUS_ID, undefined);
}

/** Explain a rejected route without leaving the active warming surface visible. */
export function renderCapabilityNotice(
  ctx: ExtensionContext,
  capability: ProviderCapability,
): void {
  if (!ctx.hasUI) return;
  clearWarmUi(ctx);
  const xai = /xai/i.test(capability.reason);
  const routeLabel = xai ? "xAI best-effort" : "pi-warm-cache";
  if (capability.state === "unverified") {
    const mode = capability.manualProbe ? "manual-only route" : "unverified route";
    const probe = capability.manualProbe
      ? "Use /warm now for one safe captured-payload probe."
      : "No safe manual probe is available for this captured route.";
    ctx.ui.notify(
      `${routeLabel} ${mode}: ${capability.reason}. Automatic warming is disabled. ${probe} Savings are n/a (unverified route).`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(
    `${xai ? "xAI best-effort inactive" : "pi-warm-cache inactive"} (unsupported route): ${capability.reason}. Automatic and manual warming are disabled.`,
    "info",
  );
}

export function renderWaitingUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  anchor: CacheAnchor,
  plan: StrategyPlan,
  nextDueAt: number,
): void {
  if (!ctx.hasUI) return;

  const remainingMs = Math.max(0, nextDueAt - Date.now());
  const waitLabel = formatDurationShort(remainingMs || plan.intervalMs || 0);
  const tokens = formatStatusTokens(anchor.cachedTokens || anchor.promptTokens);
  const ratio = formatProbeRatio(anchor);
  const bestEffort = plan.family === "xai-best-effort";
  const savings = formatSessionSavings(anchor, bestEffort);
  // showWidget controls the editor widget only. The status line remains available
  // as the compact extension surface when the widget is hidden.
  const lines = [
    ctx.ui.theme.fg(
      "accent",
      bestEffort
        ? `⚡ xAI best-effort cache-warm wait · extension probe in ${waitLabel}`
        : `⚡ Cache-warm wait · extension probe in ${waitLabel}`,
    ),
    ctx.ui.theme.fg(
      "dim",
      bestEffort
        ? `xAI best-effort cadence · ~${tokens} prefix`
        : `Inside ${plan.ttlLabel} · ~${tokens} prefix`,
    ),
    ctx.ui.theme.fg("warning", `${savings} · extension probes ${ratio}`),
  ];

  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, lines);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      "dim",
      `${bestEffort ? "xAI best-effort " : ""}warm ${waitLabel} · ${ratio} · ~${formatStatusTokens(anchor.cachedTokens || anchor.promptTokens)}`,
    ),
  );
}

export function renderWarmHitUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  anchor: CacheAnchor,
  plan: StrategyPlan,
  cacheRead: number,
): void {
  if (!ctx.hasUI) return;

  const tokens = formatStatusTokens(cacheRead || anchor.cachedTokens);
  const ratio = formatProbeRatio(anchor);
  const bestEffort = plan.family === "xai-best-effort";
  const nextLabel = bestEffort
    ? `Next extension probe in ${plan.waitLabel ?? "n/a"} · no fixed xAI cache lifetime promised.`
    : `Next extension probe in ${plan.waitLabel ?? "n/a"} · ${plan.ttlLabel}`;
  const lines = [
    ctx.ui.theme.fg(
      "success",
      `⚡ ${bestEffort ? "xAI best-effort cache warm" : "Cache warm"} · extension probe hit · ~${tokens}`,
    ),
    ctx.ui.theme.fg("dim", nextLabel),
    ctx.ui.theme.fg("warning", `${formatSessionSavings(anchor, bestEffort)} · extension probes ${ratio}`),
  ];

  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, lines);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      "success",
      `${bestEffort ? "xAI best-effort " : ""}warm ${plan.waitLabel ?? "n/a"} · ${ratio} · ~${formatStatusTokens(cacheRead || anchor.cachedTokens)}`,
    ),
  );
}

/**
 * Neutral idle/info state (not an error).
 * Used for waiting-for-first-turn, disabled, unsupported, prefix-too-small.
 */
export function renderIdleUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  reason: string,
  detail?: string,
  bestEffort = false,
): void {
  if (!ctx.hasUI) return;

  const xai = bestEffort || isXaiText(reason) || isXaiText(detail);
  const title = xai ? "xAI best-effort cache-warm idle" : "Cache-warm idle";
  if (config.showWidget) {
    const lines = [
      ctx.ui.theme.fg("dim", `⚡ ${title} · ${compactUiText(reason)}`),
    ];
    if (detail && detail.length > 0) {
      lines.push(ctx.ui.theme.fg("dim", compactUiText(detail)));
    }
    ctx.ui.setWidget(WIDGET_ID, lines.slice(0, 2));
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg("dim", `${xai ? "xAI best-effort " : ""}warm · idle · ${compactUiText(reason, 48)}`),
  );
}

/**
 * Non-alarming state shown after a hard invalidation.
 * No extension probe is allowed until the next real turn captures a new payload.
 */
export function renderReanchorUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  reason: string,
  bestEffort = false,
): void {
  if (!ctx.hasUI) return;

  const xai = bestEffort || isXaiText(reason);
  const prefix = xai ? "xAI best-effort " : "";
  const cause = reanchorCause(reason);
  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, [
      ctx.ui.theme.fg("accent", `⚡ ${prefix}cache-warm paused · re-anchoring ${cause}`),
      ctx.ui.theme.fg("dim", `${xai ? "xAI best-effort extension probes paused" : "Waiting for next real turn. Extension probes paused."}`),
    ]);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `${prefix}warm · re-anchoring`));
}

/**
 * Quiet retry state for the first implicit-cache no-read/no-write response.
 * This is intentionally neutral rather than an error notification.
 */
export function renderProbeRetryUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  detail: string,
  nextDueAt?: number,
  bestEffort = false,
): void {
  if (!ctx.hasUI) return;

  const xai = bestEffort || isXaiText(detail);
  const retryLine =
    typeof nextDueAt === "number" && nextDueAt > Date.now()
      ? `Next extension probe in ${formatDurationShort(nextDueAt - Date.now())}.`
      : "Retrying the extension probe.";
  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, [
      ctx.ui.theme.fg(
        "warning",
        `⚡ ${xai ? "xAI best-effort " : "Cache-warm "}retry · extension probe transient miss`,
      ),
      ctx.ui.theme.fg("dim", `${compactUiText(detail)} · ${retryLine}`),
    ]);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
  ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `${xai ? "xAI best-effort " : ""}warm · retrying probe`));
}

/**
 * Real failure / retry panel. Keep visible so a dead loop never looks healthy.
 * Always show retry timing when nextDueAt is in the future.
 */
export function renderFailureUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  reason: string,
  detail?: string,
  nextDueAt?: number,
  bestEffort = false,
): void {
  if (!ctx.hasUI) return;

  const xai = bestEffort || isXaiText(reason) || isXaiText(detail);
  const blocked = /blocked/i.test(reason);
  const retryLine = blocked
    ? `${xai ? "xAI best-effort auto-warm stays off" : "Auto-warm stays off"} until /warm resume.`
    : typeof nextDueAt === "number" && nextDueAt > Date.now()
      ? `Next extension probe in ${formatDurationShort(nextDueAt - Date.now())}.`
      : "Warming stopped until the next real turn or /warm now.";
  const error = /error|failed|no model/i.test(reason);
  const title = error ? "Cache-warm error" : "Cache-warm warning";
  const statusKind = error ? "error" : "warning";
  const prefix = xai ? "xAI best-effort " : "";

  if (config.showWidget) {
    const lines = [
      ctx.ui.theme.fg(statusKind, `⚡ ${prefix}${title} · ${shortProblem(reason)}`),
    ];
    if (detail && detail.length > 0) {
      lines.push(ctx.ui.theme.fg("dim", compactUiText(detail)));
    }
    lines.push(ctx.ui.theme.fg("dim", retryLine));
    ctx.ui.setWidget(WIDGET_ID, lines.slice(0, 3));
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      statusKind,
      `${prefix}warm · ${error ? "error" : "warning"}: ${shortProblem(reason)}`,
    ),
  );
}

function formatSessionSavings(anchor: CacheAnchor, bestEffort = false): string {
  const prefix = bestEffort ? "xAI best-effort session" : "Session";
  return anchor.savingsKnown
    ? `${prefix} ${formatSavingsLabel(anchor)}`
    : `${prefix} savings ${formatSavingsLabel(anchor)}`;
}

function formatProbeRatio(anchor: Pick<CacheAnchor, "probeHitCount" | "probeMissCount">): string {
  const total = anchor.probeHitCount + anchor.probeMissCount;
  return `${anchor.probeHitCount}/${total}`;
}

function formatStatusTokens(tokens: number): string {
  if (tokens < 1000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function reanchorCause(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("compact")) return "after compaction";
  if (lower.includes("branch") || lower.includes("tree")) return "after branch change";
  if (lower.includes("model") || lower.includes("thinking")) {
    return "after model or thinking-level change";
  }
  if (lower.includes("prompt_cache_key")) return "after cache-key change";
  if (lower.includes("payload") || lower.includes("prefix") || lower.includes("drift")) {
    return "after prefix drift";
  }
  return "after session change";
}

function shortProblem(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("too many failures")) return "too many probe failures";
  if (lower.includes("codex") && lower.includes("blocked")) return "Codex auto-warm blocked";
  if (lower.includes("codex") && lower.includes("output")) return "Codex probe output high";
  if (lower.includes("payload") && lower.includes("re-anchor")) return "probe payload drift";
  if (lower.includes("probe miss")) return "extension probe miss";
  if (lower.includes("probe error")) return "extension probe error";
  return compactUiText(reason, 48);
}

function compactUiText(value: string, max = 72): string {
  const compact = value.trim().replace(/\s+/g, " ");
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
}

function isXaiText(value: string | undefined): boolean {
  return typeof value === "string" && /xai/i.test(value);
}
