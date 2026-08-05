import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDurationShort, formatTokens } from "./config.ts";
import { formatSavingsLabel } from "./savings.ts";
import type { CacheAnchor, StrategyPlan, WarmCacheConfig } from "./types.ts";

const WIDGET_ID = "pi-warm-cache";
const STATUS_ID = "pi-warm-cache";

export function clearWarmUi(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_ID, undefined);
  ctx.ui.setStatus(STATUS_ID, undefined);
}

export function renderWaitingUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  anchor: CacheAnchor,
  plan: StrategyPlan,
  nextDueAt: number,
): void {
  if (!ctx.hasUI || !config.showWidget) return;

  const remainingMs = Math.max(0, nextDueAt - Date.now());
  const waitLabel = formatDurationShort(remainingMs || plan.intervalMs || 0);
  const tokens = formatTokens(anchor.cachedTokens || anchor.promptTokens);
  const saved = formatSavingsLabel(anchor);

  const bestEffort = plan.family === "xai-best-effort";
  const title = bestEffort
    ? `Cache-warm wait · xAI best-effort monitor`
    : `Cache-warm wait · 1 monitor on duty`;
  const line1 = bestEffort
    ? `Best-effort probe scheduled in ${waitLabel}. xAI cache retention is not guaranteed.`
    : `Continuation deferred ${waitLabel} - the timed wake stays inside the ${plan.ttlLabel}.`;
  const line2 =
    anchor.probeHitCount > 0
      ? anchor.savingsKnown
        ? `~${tokens} tokens kept warm · ${saved} vs cold re-reads`
        : `~${tokens} tokens kept warm · savings ${saved}`
      : bestEffort
        ? `~${tokens} tokens kept warm · waiting for first observed xAI probe hit`
        : `~${tokens} tokens kept warm · waiting for first verified probe hit`;

  ctx.ui.setWidget(WIDGET_ID, [
    ctx.ui.theme.fg("accent", `⚡ ${title}`),
    ctx.ui.theme.fg("dim", line1),
    ctx.ui.theme.fg("warning", line2),
  ]);

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg("dim", `warm ${waitLabel} · ~${tokens}`),
  );
}

export function renderWarmHitUi(
  ctx: ExtensionContext,
  config: WarmCacheConfig,
  anchor: CacheAnchor,
  plan: StrategyPlan,
  cacheRead: number,
): void {
  if (!ctx.hasUI || !config.showWidget) return;
  const tokens = formatTokens(cacheRead || anchor.cachedTokens);
  const saved = formatSavingsLabel(anchor);
  const bestEffort = plan.family === "xai-best-effort";
  const hitLabel = bestEffort ? "xAI best-effort probe hit" : "probe hit";
  const nextLabel = bestEffort
    ? `Next best-effort probe in ${plan.waitLabel ?? "n/a"}. ` +
      "No fixed xAI cache lifetime is promised."
    : `Next probe in ${plan.waitLabel ?? "n/a"} (${plan.ttlLabel}).`;

  ctx.ui.setWidget(WIDGET_ID, [
    ctx.ui.theme.fg("success", `⚡ Cache warm · ${hitLabel} ~${tokens} tokens`),
    ctx.ui.theme.fg("dim", nextLabel),
    ctx.ui.theme.fg(
      "warning",
      anchor.savingsKnown
        ? `Session ${saved} across ${anchor.probeHitCount} probe hit(s).`
        : `Session savings ${saved} · ${anchor.probeHitCount} probe hit(s).`,
    ),
  ]);

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg("success", `${hitLabel} · ~${tokens}`),
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
): void {
  if (!ctx.hasUI) return;

  if (config.showWidget) {
    const lines = [
      ctx.ui.theme.fg("dim", `⚡ Cache-warm idle · ${reason}`),
    ];
    if (detail && detail.length > 0) {
      lines.push(ctx.ui.theme.fg("dim", detail));
    }
    ctx.ui.setWidget(WIDGET_ID, lines);
  }

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg("dim", `warm idle · ${reason}`),
  );
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
): void {
  if (!ctx.hasUI) return;

  const retryLine =
    typeof nextDueAt === "number" && nextDueAt > Date.now()
      ? `Next probe in ${formatDurationShort(nextDueAt - Date.now())}.`
      : "Retrying the probe.";
  if (config.showWidget) {
    ctx.ui.setWidget(WIDGET_ID, [
      ctx.ui.theme.fg("warning", "⚡ Cache-warm retry · transient probe miss"),
      ctx.ui.theme.fg("dim", detail),
      ctx.ui.theme.fg("dim", retryLine),
    ]);
  }
  ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", "probe retry · transient miss"));
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
): void {
  if (!ctx.hasUI) return;

  const when = new Date().toISOString().slice(11, 19);
  const blocked = /blocked/i.test(reason);
  const retryLine = blocked
    ? "Auto-warm stays off until /warm resume (or /warm on)."
    : typeof nextDueAt === "number" && nextDueAt > Date.now()
      ? `Next try in ${formatDurationShort(nextDueAt - Date.now())}.`
      : "Warming stopped until the next real turn or /warm now.";

  if (config.showWidget) {
    const lines = [
      ctx.ui.theme.fg("error", `⚡ Cache-warm issue · ${reason}`),
    ];
    if (detail && detail.length > 0) {
      lines.push(ctx.ui.theme.fg("dim", detail));
    }
    lines.push(ctx.ui.theme.fg("dim", retryLine));
    lines.push(ctx.ui.theme.fg("warning", `${when} UTC · run /warm for full status`));
    ctx.ui.setWidget(WIDGET_ID, lines);
  }

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg("error", `warm · ${reason}`),
  );
}
