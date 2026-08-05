import type { Model } from "@earendil-works/pi-ai";
import type { ProviderCapability, ProviderCapabilityState } from "./types.ts";

type RouteCompat = {
  cacheControlFormat?: string;
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
};

const OPENAI_COMPAT_APIS = new Set(["openai-responses", "openai-completions"]);
const XAI_PROBE_APIS = new Set(["openai-responses", "openai-completions"]);
const XAI_BEST_EFFORT_MODEL_IDS = new Set(["grok-4.5"]);
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

function hasExplicitFirstPartyBaseUrl(model: Model<any>, hosts: Set<string>): boolean {
  if (!model.baseUrl) return false;
  return hasFirstPartyBaseUrl(model, hosts);
}

function hasXaiCacheRoutingMetadata(model: Model<any>): boolean {
  const sessionAffinityFormat = getCompat(model)?.sessionAffinityFormat;
  // The xAI provider uses the OpenAI Responses adapter. An omitted format is
  // safe because that adapter defaults direct first-party routes to "openai".
  return (
    sessionAffinityFormat === undefined ||
    sessionAffinityFormat === "openai" ||
    sessionAffinityFormat === "openai-nosession"
  );
}

function routeLabel(model: Model<any>): string {
  return `${model.provider || "unknown"}/${model.api || "unknown"}`;
}

/**
 * Identify the first explicitly supported direct xAI route.
 * Provider identity, API transport, model id, endpoint, and routing metadata
 * must all agree. Display names and proxy base URLs do not qualify.
 */
export function isDirectXaiGrokRoute(model: Model<any> | undefined): boolean {
  if (!model || model.provider !== "xai" || model.api !== "openai-responses") return false;
  if (!XAI_BEST_EFFORT_MODEL_IDS.has(model.id)) return false;
  if (!hasExplicitFirstPartyBaseUrl(model, XAI_FIRST_PARTY_HOSTS)) return false;
  return hasXaiCacheRoutingMetadata(model);
}

/** Return the provider cache-routing key from an OpenAI Responses payload. */
export function getPromptCacheKey(payload: unknown, api: string | undefined): string | null {
  if (
    api !== "openai-responses" &&
    api !== "openai-codex-responses"
  ) {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const key = (payload as Record<string, unknown>).prompt_cache_key;
  return typeof key === "string" && key.trim().length > 0 ? key : null;
}

/**
 * xAI Responses needs a provider cache key in the captured body before a
 * best-effort probe can be armed. This is the route's stable cache identity.
 */
export function hasXaiPromptCacheKey(payload: unknown): boolean {
  return (
    isSafeReplayPayload(payload, "openai-responses") &&
    Boolean(getPromptCacheKey(payload, "openai-responses"))
  );
}

/** True when a captured direct xAI payload is safe for automatic replay. */
export function isSafeXaiReplayPayload(payload: unknown): boolean {
  return hasXaiPromptCacheKey(payload);
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

  // Direct xAI Grok 4.5 Responses is a named best-effort strategy. The model
  // id is an exact route identity, not a display-name match. A missing or
  // proxy endpoint fails closed before any automatic probe can be scheduled.
  if (
    model.provider === "xai" &&
    model.api === "openai-responses" &&
    model.id === "grok-4.5"
  ) {
    if (!hasExplicitFirstPartyBaseUrl(model, XAI_FIRST_PARTY_HOSTS)) {
      return capability(
        "unsupported",
        "direct xAI Grok 4.5 requires an explicit https://api.x.ai first-party endpoint",
      );
    }
    if (!hasXaiCacheRoutingMetadata(model)) {
      return capability(
        "unsupported",
        "direct xAI Grok 4.5 route has unsupported cache-routing metadata",
      );
    }
    return capability(
      "verified",
      "direct xAI Grok 4.5 Responses route with best-effort prompt-cache routing",
    );
  }

  // Other direct xAI routes remain observable through a clearly labelled
  // manual probe until each route receives its own validated strategy.
  if (
    model.provider === "xai" &&
    XAI_PROBE_APIS.has(model.api) &&
    hasExplicitFirstPartyBaseUrl(model, XAI_FIRST_PARTY_HOSTS)
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
