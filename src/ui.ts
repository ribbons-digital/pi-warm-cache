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
  const waitLabel = formatDurationShort(remainingMs || plan.intervalMs);
  const tokens = formatTokens(anchor.cachedTokens || anchor.promptTokens);
  const saved = formatSavingsLabel(anchor);

  const title = `Cache-warm wait · 1 monitor on duty`;
  const line1 = `Continuation deferred ${waitLabel} - the timed wake stays inside the ${plan.ttlLabel}.`;
  const line2 =
    anchor.warmHitCount > 0
      ? anchor.savingsKnown
        ? `~${tokens} tokens kept warm · ${saved} vs cold re-reads`
        : `~${tokens} tokens kept warm · savings ${saved}`
      : `~${tokens} tokens kept warm · waiting for first verified cache hit`;

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

  ctx.ui.setWidget(WIDGET_ID, [
    ctx.ui.theme.fg("success", `⚡ Cache warm · hit ~${tokens} tokens`),
    ctx.ui.theme.fg("dim", `Next ping in ${plan.waitLabel} (${plan.ttlLabel}).`),
    ctx.ui.theme.fg(
      "warning",
      anchor.savingsKnown
        ? `Session ${saved} across ${anchor.warmHitCount} warm hit(s).`
        : `Session savings ${saved} · ${anchor.warmHitCount} warm hit(s).`,
    ),
  ]);

  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg("success", `warm hit · ~${tokens}`),
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
