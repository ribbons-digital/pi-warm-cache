import type { Model } from "@earendil-works/pi-ai";
import type { ProviderCapability, ProviderCapabilityState } from "./types.ts";

type RouteCompat = {
  cacheControlFormat?: string;
};

const OPENAI_COMPAT_APIS = new Set(["openai-responses", "openai-completions"]);
const XAI_PROBE_APIS = new Set(["openai-responses", "openai-completions"]);
const ANTHROPIC_FIRST_PARTY_HOSTS = new Set(["api.anthropic.com"]);
const OPENAI_FIRST_PARTY_HOSTS = new Set(["api.openai.com"]);
const XAI_FIRST_PARTY_HOSTS = new Set(["api.x.ai"]);

function getCompat(model: Model<any>): RouteCompat | undefined {
  return (model as { compat?: RouteCompat }).compat;
}

function hasFirstPartyBaseUrl(model: Model<any>, hosts: Set<string>): boolean {
  // Unit fixtures and older host adapters may omit baseUrl. Provider identity is
  // the explicit route registration in that case.
  if (!model.baseUrl) return true;
  try {
    const url = new URL(model.baseUrl);
    return url.protocol === "https:" && hosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function routeLabel(model: Model<any>): string {
  return `${model.provider || "unknown"}/${model.api || "unknown"}`;
}

function capability(
  state: ProviderCapabilityState,
  reason: string,
  manualProbe = false,
): ProviderCapability {
  return {
    state,
    reason,
    automaticWarm: state === "verified",
    manualProbe,
  };
}

/**
 * Classify the exact provider route before selecting a cache family.
 *
 * API-compatible transports do not inherit a first-party provider strategy.
 * New routes must be added here with an explicit capability decision.
 */
export function resolveProviderCapability(
  model: Model<any> | undefined,
): ProviderCapability {
  if (!model) {
    return capability("unsupported", "no active model route");
  }

  const route = routeLabel(model);
  const compat = getCompat(model);

  // Anthropic-compatible routes are verified only when the route metadata says
  // that Anthropic cache markers are emitted, or when the provider is first-party.
  if (
    model.api === "anthropic-messages" &&
    model.provider === "anthropic" &&
    hasFirstPartyBaseUrl(model, ANTHROPIC_FIRST_PARTY_HOSTS)
  ) {
    return capability("verified", "first-party Anthropic Messages route with cache markers");
  }
  if (model.api === "anthropic-messages" && compat?.cacheControlFormat === "anthropic") {
    return capability("verified", "route metadata explicitly enables Anthropic cache markers");
  }

  // Direct OpenAI and Azure routes keep their existing strategies. The API
  // transport and provider identity must agree; an API shape alone is not enough.
  if (
    model.provider === "openai" &&
    OPENAI_COMPAT_APIS.has(model.api) &&
    hasFirstPartyBaseUrl(model, OPENAI_FIRST_PARTY_HOSTS)
  ) {
    return capability("verified", "first-party OpenAI route with a registered OpenAI transport");
  }
  if (model.provider === "azure-openai-responses" && model.api === "azure-openai-responses") {
    return capability("verified", "registered Azure OpenAI Responses route");
  }

  if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
    return capability("verified", "registered OpenAI Codex Responses route");
  }

  // Direct xAI is intentionally observable but not automatically warmed until
  // the provider-specific strategy is validated. Do not use model names here.
  if (
    model.provider === "xai" &&
    XAI_PROBE_APIS.has(model.api) &&
    hasFirstPartyBaseUrl(model, XAI_FIRST_PARTY_HOSTS)
  ) {
    return capability(
      "unverified",
      "direct xAI route has no verified automatic keepalive strategy",
      true,
    );
  }

  if (model.api === "anthropic-messages" || OPENAI_COMPAT_APIS.has(model.api)) {
    return capability(
      "unsupported",
      `provider route ${route} is not explicitly registered; API-compatible routes do not inherit a cache strategy`,
    );
  }

  return capability("unsupported", `provider route ${route} has no registered cache strategy`);
}

/**
 * Check whether an exact captured payload has a known replay shape for a
 * one-shot unverified probe.
 */
export function isSafeReplayPayload(payload: unknown, api: string | undefined): boolean {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as Record<string, unknown>;

  if (api === "openai-responses" || api === "azure-openai-responses") {
    return Array.isArray(body.input);
  }
  if (api === "openai-completions") {
    return Array.isArray(body.messages);
  }
  if (api === "anthropic-messages") {
    return Array.isArray(body.messages) && Array.isArray(body.system);
  }
  if (api === "openai-codex-responses") {
    return (
      typeof body.instructions === "string" &&
      Array.isArray(body.input) &&
      body.store === false &&
      typeof body.prompt_cache_key === "string"
    );
  }
  return false;
}

/** True when a route can accept a manual replay after payload-shape checks. */
export function canManualProbe(
  model: Model<any> | undefined,
  payload: unknown,
): boolean {
  const resolved = resolveProviderCapability(model);
  return resolved.manualProbe && isSafeReplayPayload(payload, model?.api);
}

export type { ProviderCapability, ProviderCapabilityState } from "./types.ts";
