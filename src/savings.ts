import type { Model } from "@earendil-works/pi-ai";
import type { CacheAnchor, WarmResult } from "./types.ts";

export type PricingSource = "model" | "unknown";

export type ResolvedPricing = {
  inputPricePerMTok: number;
  cacheReadPricePerMTok: number;
  cacheWritePricePerMTok: number;
  outputPricePerMTok: number;
  /** True when a positive cold-vs-read delta is available from model.cost. */
  savingsKnown: boolean;
  source: PricingSource;
};

export function hasUsableSavingsPricing(input: number, cacheRead: number): boolean {
  return Number.isFinite(input) && Number.isFinite(cacheRead) && input > 0 && input > cacheRead;
}

/**
 * Resolve pricing for savings estimates from the active model entry only.
 * Do not invent published catalog rates for zero-cost proxies (e.g. vibeproxy).
 * Missing/zero cost => savings n/a.
 */
export function resolveModelPricing(model: Model<any> | undefined): ResolvedPricing {
  const cost = model?.cost;
  const input = cost?.input ?? 0;
  const cacheRead = cost?.cacheRead ?? 0;
  const cacheWrite = cost?.cacheWrite ?? 0;
  const output = cost?.output ?? 0;

  if (hasUsableSavingsPricing(input, cacheRead)) {
    return {
      inputPricePerMTok: input,
      cacheReadPricePerMTok: cacheRead,
      cacheWritePricePerMTok: cacheWrite,
      outputPricePerMTok: output,
      savingsKnown: true,
      source: "model",
    };
  }

  return {
    inputPricePerMTok: 0,
    cacheReadPricePerMTok: 0,
    cacheWritePricePerMTok: 0,
    outputPricePerMTok: 0,
    savingsKnown: false,
    source: "unknown",
  };
}

/**
 * Estimate USD saved by a warm-probe cache hit versus a full cold input re-read.
 * Uses (inputPrice - cacheReadPrice) * cacheReadTokens.
 */
export function estimateSavedUsd(
  cacheReadTokens: number,
  inputPricePerMTok: number,
  cacheReadPricePerMTok: number,
): number {
  if (cacheReadTokens <= 0) return 0;
  if (!hasUsableSavingsPricing(inputPricePerMTok, cacheReadPricePerMTok)) return 0;
  const delta = inputPricePerMTok - cacheReadPricePerMTok;
  return (cacheReadTokens / 1_000_000) * delta;
}

/**
 * Full phrase for widget/status.
 * Known: "est. $0.23 saved"
 * Unknown: "savings n/a (no model pricing)"
 */
export function formatSavingsLabel(
  anchor: Pick<CacheAnchor, "estimatedSavingsUsd" | "savingsKnown" | "pricingSource"> &
    Partial<Pick<CacheAnchor, "capability">>,
): string {
  if (anchor.capability?.state === "unverified") return "n/a (unverified route)";
  if (anchor.capability?.state === "unsupported") return "n/a (unsupported route)";
  if (!anchor.savingsKnown) return "n/a (no model pricing)";
  const n = anchor.estimatedSavingsUsd;
  // Large probe output can make net negative even on a cache hit.
  if (n < 0) {
    const loss = Math.abs(n) < 0.01 ? Math.abs(n).toFixed(4) : Math.abs(n).toFixed(2);
    return `est. net cost $${loss} (warm output expensive)`;
  }
  const amount = n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return `est. ${amount} saved`;
}

export type SavingsSummaryInput = Pick<
  CacheAnchor,
  | "probeHitCount"
  | "probeMissCount"
  | "totalEstimatedSavedUsd"
  | "totalProbeCostUsd"
  | "savingsKnown"
  | "pricingSource"
> &
  Partial<Pick<CacheAnchor, "capability">>;

/**
 * Stable cumulative savings text for the /warm status and command output.
 * Monetary values stay n/a when the active model has no usable pricing.
 */
export function formatSavingsSummary(anchor: SavingsSummaryInput): string {
  if (anchor.capability?.state === "unverified") return "n/a (unverified route)";
  if (anchor.capability?.state === "unsupported") return "n/a (unsupported route)";

  const amount = (value: number): string =>
    anchor.savingsKnown ? formatUsd(value) : "n/a";
  const net = anchor.totalEstimatedSavedUsd - anchor.totalProbeCostUsd;

  return [
    `probeHits=${anchor.probeHitCount}`,
    `probeMisses=${anchor.probeMissCount}`,
    `totalEstimatedSaved=${amount(anchor.totalEstimatedSavedUsd)}`,
    `totalProbeCost=${amount(anchor.totalProbeCostUsd)}`,
    `net=${anchor.savingsKnown ? formatUsd(net) : "n/a"}`,
    `pricingSource=${anchor.pricingSource}`,
  ].join(" ");
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const absolute = Math.abs(value);
  const digits = absolute < 0.01 ? 4 : 2;
  return `${value < 0 ? "-" : ""}$${absolute.toFixed(digits)}`;
}

export function buildWarmResult(args: {
  fingerprint: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  error?: string;
  unavailable?: boolean;
  anchor: Pick<CacheAnchor, "inputPricePerMTok" | "cacheReadPricePerMTok" | "savingsKnown"> &
    Partial<Pick<CacheAnchor, "capability">>;
}): WarmResult {
  if (args.error) {
    return {
      ok: false,
      cacheHit: false,
      probeOutcome: args.unavailable ? "unavailable" : "error",
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      costUsd: 0,
      estimatedSavedUsd: 0,
      error: args.error,
      unavailable: args.unavailable,
      fingerprint: args.fingerprint,
    };
  }

  const usage = args.usage ?? {};
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const costUsd = usage.cost?.total ?? 0;
  const cacheHit = cacheRead > 0 && cacheRead >= cacheWrite;

  return {
    ok: true,
    cacheHit,
    probeOutcome: cacheHit ? "hit" : "miss",
    cacheRead,
    cacheWrite,
    input,
    output,
    costUsd,
    estimatedSavedUsd:
      cacheHit &&
      args.anchor.savingsKnown &&
      (args.anchor.capability === undefined || args.anchor.capability.state === "verified")
        ? estimateSavedUsd(cacheRead, args.anchor.inputPricePerMTok, args.anchor.cacheReadPricePerMTok)
        : 0,
    fingerprint: args.fingerprint,
  };
}
