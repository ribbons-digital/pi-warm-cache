import { DEFAULT_CONFIG, type AnthropicTtlMode, type WarmCacheConfig } from "./types.ts";

export function parseConfigArgs(args: string, base: WarmCacheConfig = DEFAULT_CONFIG): WarmCacheConfig {
  const next = { ...base };
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return next;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "on" || lower === "enable" || lower === "enabled") {
      next.enabled = true;
      continue;
    }
    if (lower === "off" || lower === "disable" || lower === "disabled") {
      next.enabled = false;
      continue;
    }
    if (lower === "5m" || lower === "short") {
      next.anthropicTtl = "5m";
      continue;
    }
    if (lower === "1h" || lower === "long") {
      next.anthropicTtl = "1h";
      continue;
    }
    if (lower === "auto") {
      next.anthropicTtl = "auto";
      continue;
    }
    if (lower === "widget") {
      next.showWidget = true;
      continue;
    }
    if (lower === "nowidget" || lower === "hide") {
      next.showWidget = false;
      continue;
    }
    if (lower === "log" || lower === "debug") {
      next.logToFile = true;
      continue;
    }
    if (lower === "nolog" || lower === "nodebug") {
      next.logToFile = false;
      continue;
    }
    if (lower === "codex-on" || lower === "codexon") {
      next.allowCodexAutoWarm = true;
      continue;
    }
    if (lower === "codex-off" || lower === "codexoff") {
      next.allowCodexAutoWarm = false;
      continue;
    }

    const kv = token.match(/^([a-zA-Z_]+)=(.+)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!;

    if (key === "interval" || key === "intervalms") {
      next.intervalMs = parseDurationMs(value);
      continue;
    }
    if (key === "max" || key === "maxconcurrent") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) next.maxConcurrentWarmSessions = Math.floor(n);
      continue;
    }
    if (key === "mincached" || key === "mintokens") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) next.minCachedTokens = Math.floor(n);
      continue;
    }
    if (key === "ttl") {
      if (value === "5m" || value === "1h" || value === "auto") {
        next.anthropicTtl = value as AnthropicTtlMode;
      }
      continue;
    }
    if (key === "log" || key === "debug") {
      next.logToFile = value !== "0" && value !== "false" && value !== "off";
    }
  }

  return next;
}

/** Parse "4m", "240s", "240000", "4.5m". */
export function parseDurationMs(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(1_000, Math.floor(Number(s)));
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "ms") return Math.floor(n);
  if (unit === "s") return Math.floor(n * 1_000);
  if (unit === "m") return Math.floor(n * 60_000);
  return Math.floor(n * 3_600_000);
}

export function formatDurationShort(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = ms / 60_000;
  if (minutes < 10 && !Number.isInteger(minutes)) return `${minutes.toFixed(1)}m`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (!Number.isInteger(hours) && hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

