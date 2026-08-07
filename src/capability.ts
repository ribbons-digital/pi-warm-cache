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

type ManualOnlyRouteRegistration = {
  provider: string;
  label: string;
  apis: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
  sessionAffinityFormats: ReadonlySet<NonNullable<RouteCompat["sessionAffinityFormat"]>>;
};

/**
 * Routes in this list are deliberately manual-only.
 *
 * Provider identity, API transport, first-party proxy endpoint, and the
 * adapter's routing format must all match before a captured payload can be
 * probed. This list is not an OpenAI/Anthropic compatibility fallback.
 */
const MANUAL_ONLY_PROXY_ROUTES: readonly ManualOnlyRouteRegistration[] = [
  {
    provider: "openrouter",
    label: "OpenRouter",
    apis: new Set(["openai-responses", "openai-completions"]),
    hosts: new Set(["openrouter.ai"]),
    sessionAffinityFormats: new Set(["openrouter"]),
  },
  {
    provider: "opencode-go",
    label: "OpenCode Go",
    apis: new Set(["openai-responses", "openai-completions"]),
    hosts: new Set(["opencode.ai"]),
    sessionAffinityFormats: new Set(["openai", "openai-nosession"]),
  },
];

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

function resolveManualOnlyProxyCapability(model: Model<any>): ProviderCapability | null {
  const registration = MANUAL_ONLY_PROXY_ROUTES.find(
    (route) => route.provider === model.provider,
  );
  if (!registration) return null;

  if (!registration.apis.has(model.api)) {
    return capability(
      "unsupported",
      `${registration.label} route API ${model.api || "unknown"} is not registered for manual-only probing; automatic and manual warming are disabled`,
    );
  }

  if (!model.baseUrl) {
    return capability(
      "unsupported",
      `${registration.label} manual-only route requires an explicit baseUrl on ${[...registration.hosts][0]}; automatic and manual warming are disabled without the registered proxy endpoint`,
    );
  }
  if (!hasFirstPartyBaseUrl(model, new Set(registration.hosts))) {
    return capability(
      "unsupported",
      `${registration.label} manual-only route baseUrl is not the registered ${[...registration.hosts][0]} endpoint; automatic and manual warming are disabled for this route`,
    );
  }

  const sessionAffinityFormat = getCompat(model)?.sessionAffinityFormat;
  if (
    sessionAffinityFormat !== undefined &&
    !registration.sessionAffinityFormats.has(sessionAffinityFormat)
  ) {
    return capability(
      "unsupported",
      `${registration.label} manual-only route has unsupported cache-routing metadata; automatic and manual warming are disabled for this route`,
    );
  }

  return capability(
    "unverified",
    `${registration.label} route is explicitly registered for manual-only probing; automatic warming is disabled and savings are n/a (unverified route)`,
    true,
  );
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

/**
 * Return true when a cache-routing key is a stable value that can be replayed.
 *
 * xAI documents a UUID or application session id, but does not require one
 * exact format. Keep the check strict about accidental whitespace and control
 * characters without inventing a provider-specific length or character rule.
 */
export function isStablePromptCacheKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

/** Return the provider cache-routing key from an OpenAI Responses payload. */
export function getPromptCacheKey(payload: unknown, api: string | undefined): string | null {
  if (api !== "openai-responses" && api !== "openai-codex-responses") return null;
  if (!payload || typeof payload !== "object") return null;
  const key = (payload as Record<string, unknown>).prompt_cache_key;
  return isStablePromptCacheKey(key) ? key : null;
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
  const normalizedReason = reason.trim();
  return {
    state,
    reason: normalizedReason || "capability decision has no reason",
    automaticWarm: state === "verified",
    // Manual probes are an explicit unverified-route escape hatch. Keep the
    // flags consistent even if a future branch passes an incorrect value.
    manualProbe: state === "unverified" && manualProbe,
  };
}

function directXaiPayloadRejectionReason(payload: unknown): string | null {
  const rawKey =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).prompt_cache_key
      : undefined;
  if (!isStablePromptCacheKey(rawKey)) {
    const detail = rawKey === undefined ? "is missing" : "is not a stable string";
    return `direct xAI Grok 4.5 best-effort route has no stable prompt-cache key (prompt_cache_key ${detail}) in the captured payload; automatic warming is disabled`;
  }
  if (!isSafeReplayPayload(payload, "openai-responses")) {
    return "direct xAI Grok 4.5 best-effort captured payload is not a safe OpenAI Responses replay shape; automatic warming is disabled";
  }
  return null;
}

/**
 * Classify the exact provider route before selecting a cache family.
 *
 * API-compatible transports do not inherit a first-party provider strategy.
 * New routes must be added here with an explicit capability decision.
 * When a captured payload is supplied, payload-dependent cache identity is
 * verified at the same gate as the provider route.
 */
export function resolveProviderCapability(
  model: Model<any> | undefined,
  payload?: unknown,
): ProviderCapability {
  if (!model) {
    return capability("unsupported", "no active model route; select a model before warming");
  }

  const route = routeLabel(model);
  const compat = getCompat(model);

  // Selected proxy routes have their own explicit manual-only registration.
  // Resolve them before generic Anthropic/OpenAI compatibility checks so a
  // proxy cannot become verified merely by copying first-party metadata.
  const manualOnlyProxy = resolveManualOnlyProxyCapability(model);
  if (manualOnlyProxy) return manualOnlyProxy;

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
  if (
    model.provider === "anthropic" &&
    model.api === "anthropic-messages" &&
    Boolean(model.baseUrl) &&
    !hasFirstPartyBaseUrl(model, ANTHROPIC_FIRST_PARTY_HOSTS)
  ) {
    return capability(
      "unsupported",
      "Anthropic Messages route baseUrl is not api.anthropic.com; automatic warming requires the first-party endpoint or explicit Anthropic cache-marker metadata",
    );
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
  if (
    model.provider === "openai" &&
    OPENAI_COMPAT_APIS.has(model.api) &&
    Boolean(model.baseUrl) &&
    !hasFirstPartyBaseUrl(model, OPENAI_FIRST_PARTY_HOSTS)
  ) {
    return capability(
      "unsupported",
      "OpenAI route baseUrl is not api.openai.com; API-compatible routes do not inherit first-party cache strategies",
    );
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
    if (!model.baseUrl) {
      return capability(
        "unsupported",
        "direct xAI Grok 4.5 best-effort route requires an explicit baseUrl on api.x.ai; automatic warming is disabled without a first-party endpoint",
      );
    }
    if (!hasFirstPartyBaseUrl(model, XAI_FIRST_PARTY_HOSTS)) {
      return capability(
        "unsupported",
        "direct xAI Grok 4.5 best-effort route baseUrl is not api.x.ai; use the direct first-party xAI endpoint",
      );
    }
    if (!hasXaiCacheRoutingMetadata(model)) {
      return capability(
        "unsupported",
        "direct xAI Grok 4.5 best-effort route has unsupported cache-routing metadata; use the registered direct xAI routing format",
      );
    }
    if (payload !== undefined) {
      const payloadReason = directXaiPayloadRejectionReason(payload);
      if (payloadReason) return capability("unverified", payloadReason);
    }
    return capability(
      "verified",
      "direct xAI Grok 4.5 best-effort Responses route with prompt-cache routing",
    );
  }

  // Other direct xAI routes remain observable through a clearly labelled
  // manual probe until each route receives its own validated strategy.
  if (model.provider === "xai" && XAI_PROBE_APIS.has(model.api)) {
    if (!model.baseUrl) {
      return capability(
        "unsupported",
        "direct xAI best-effort manual probes require an explicit baseUrl on api.x.ai; automatic and manual warming are disabled without a first-party endpoint",
      );
    }
    if (!hasFirstPartyBaseUrl(model, XAI_FIRST_PARTY_HOSTS)) {
      return capability(
        "unsupported",
        "direct xAI best-effort route baseUrl is not api.x.ai; automatic and manual warming are disabled for this route",
      );
    }
    return capability(
      "unverified",
      "direct xAI best-effort route has no verified automatic keepalive strategy; automatic warming is disabled, but a safe captured payload may be probed once with /warm now",
      true,
    );
  }

  if (model.api === "anthropic-messages" || OPENAI_COMPAT_APIS.has(model.api)) {
    return capability(
      "unsupported",
      `provider route ${route} is not explicitly registered; API-compatible routes do not inherit first-party cache strategies, so automatic and manual warming are disabled`,
    );
  }

  return capability(
    "unsupported",
    `provider route ${route} has no registered cache strategy; automatic and manual warming are disabled`,
  );
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
      isStablePromptCacheKey(body.prompt_cache_key)
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
