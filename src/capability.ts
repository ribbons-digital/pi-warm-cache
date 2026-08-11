import type { Model } from "@earendil-works/pi-ai";
import type { CacheFamily, ProviderCapability, ProviderCapabilityState } from "./types.ts";

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

/** Payload shapes a registered proxy transport can legally carry. */
type PayloadEligibilityRule = "messages" | "input" | "messages-and-system";

/** Per-family verification state for one proxy route transport. */
type ProxyRouteFamilyState = {
  /**
   * All families start unverified. Promotion is a data change that flips this
   * entry to "verified" and cites an e2e evidence record.
   */
  state: "unverified" | "verified";
  /** e2e evidence record (pi-ai version, model, real baseUrl). Null until promoted. */
  evidence: string | null;
};

function unverifiedFamily(): ProxyRouteFamilyState {
  return { state: "unverified", evidence: null };
}

/**
 * One registered manual-only proxy route, keyed on (provider, api).
 *
 * The per-api eligibility gate is the registration itself: the API transport
 * must be registered for the provider and the baseUrl must match the exact
 * registered path. OpenRouter additionally keeps its compat routing-format
 * gate (`sessionAffinityFormat: "openrouter"`); OpenCode Go routes are gated
 * by the per-api registration and exact baseUrl path instead of any compat
 * field, because `sessionAffinityFormat` is emitted only by the OpenAI
 * Responses adapter and pi-ai never sets it on the completions or
 * anthropic-messages transports.
 *
 * BaseUrl matching is exact-path equality after trailing-slash normalization.
 * `/zen/go` is a prefix of `/zen/go/v1` and must never match it.
 *
 * This list is not an OpenAI/Anthropic compatibility fallback.
 */
type ProxyRouteRegistration = {
  provider: string;
  label: string;
  api: string;
  host: string;
  /** Exact path after trailing-slash normalization, e.g. "/zen/go/v1". */
  baseUrlPath: string;
  /**
   * The payload shapes this transport can legally carry. `isSafeReplayPayload`
   * enforces the same shapes on a captured payload before a manual probe.
   */
  payloadEligibility: PayloadEligibilityRule;
  /** Optional compat routing-format gate; OpenRouter requires "openrouter". */
  sessionAffinityFormat?: NonNullable<RouteCompat["sessionAffinityFormat"]>;
  /** Per-family verification state for this transport. */
  families: Readonly<Record<string, ProxyRouteFamilyState>>;
};

/**
 * Routes in this table are deliberately manual-only.
 *
 * Provider identity, API transport, exact proxy endpoint path, and (where the
 * entry declares one) the adapter's routing format must all match before a
 * captured payload can be probed.
 */
const PROXY_ROUTE_REGISTRY: readonly ProxyRouteRegistration[] = [
  // OpenRouter: both OpenAI transports at /api/v1 with the routing-format gate
  // unchanged from the previous registration. No per-family verification state
  // applies; the family registry below belongs to OpenCode Go transports.
  {
    provider: "openrouter",
    label: "OpenRouter",
    api: "openai-responses",
    host: "openrouter.ai",
    baseUrlPath: "/api/v1",
    payloadEligibility: "input",
    sessionAffinityFormat: "openrouter",
    families: {},
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    api: "openai-completions",
    host: "openrouter.ai",
    baseUrlPath: "/api/v1",
    payloadEligibility: "messages",
    sessionAffinityFormat: "openrouter",
    families: {},
  },
  // OpenCode Go: three API shapes with distinct exact baseUrl paths. The
  // anthropic-messages transport lives at /zen/go; both OpenAI transports
  // live at /zen/go/v1.
  {
    provider: "opencode-go",
    label: "OpenCode Go",
    api: "anthropic-messages",
    host: "opencode.ai",
    baseUrlPath: "/zen/go",
    payloadEligibility: "messages-and-system",
    families: {
      "short-marker": unverifiedFamily(),
      "long-marker": unverifiedFamily(),
      "plain-fallback": unverifiedFamily(),
    },
  },
  {
    provider: "opencode-go",
    label: "OpenCode Go",
    api: "openai-completions",
    host: "opencode.ai",
    baseUrlPath: "/zen/go/v1",
    payloadEligibility: "messages",
    families: {
      plain: unverifiedFamily(),
      retained: unverifiedFamily(),
    },
  },
  {
    provider: "opencode-go",
    label: "OpenCode Go",
    api: "openai-responses",
    host: "opencode.ai",
    baseUrlPath: "/zen/go/v1",
    payloadEligibility: "input",
    families: {
      plain: unverifiedFamily(),
      retained: unverifiedFamily(),
    },
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

/**
 * Exact-path baseUrl equality for a registered proxy route.
 *
 * The scheme must be https and the hostname must match the registered host.
 * The path must equal the registered path after trailing-slash
 * normalization: `/zen/go` is a prefix of `/zen/go/v1` and never matches it.
 */
function hasExactProxyBaseUrl(
  model: Model<any>,
  registration: ProxyRouteRegistration,
): boolean {
  if (!model.baseUrl) return false;
  try {
    const url = new URL(model.baseUrl);
    if (url.protocol !== "https:") return false;
    if (url.hostname.toLowerCase() !== registration.host) return false;
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return path === registration.baseUrlPath;
  } catch {
    return false;
  }
}

/**
 * Return a refusal reason when an OpenCode Go completions payload carries
 * `cache_control` the route compat cannot legally carry, else null.
 *
 * The rule is compat-conditional: an `openai-completions` payload may only
 * carry `cache_control` when the route compat declares `cacheControlFormat:
 * "anthropic"`. No opencode-go completions model declares it today, so a
 * captured completions payload containing `cache_control` is evidence of
 * third-party mutation, for example the community `pi-opencode-go-cache`
 * rewriter, and is unsafe to replay.
 *
 * There is no model-id denylist anywhere. A future completions model that
 * declares the format is handled without a code change, and the same shape
 * rule protects non-GLM models from replaying a rewritten body.
 *
 * The anthropic-messages transport carries `cache_control` by design, so the
 * refusal never fires for it.
 */
export function opencodeGoForeignInstrumentationReason(
  model: Model<any> | undefined,
  payload?: unknown,
): string | null {
  if (!model || model.provider !== "opencode-go") return null;
  if (model.api !== "openai-completions") return null;
  if (getCompat(model)?.cacheControlFormat === "anthropic") return null;
  if (!payloadHasCacheControl(payload)) return null;
  return "opencode-go openai-completions captured payload carries cache_control, but this route's compat does not declare cacheControlFormat: \"anthropic\"; the payload shows foreign instrumentation (for example the community pi-opencode-go-cache rewriter) and is refused for replay. Capture is read-only on before_provider_request, so a rewriter editing before capture yields this refused body and one editing after capture yields a cache miss, never an error";
}

/**
 * Resolve a registered manual-only proxy route.
 *
 * A provider match always returns a decision, never null: a registered proxy
 * provider can never fall through to a first-party verified branch, even when
 * its compat copies first-party metadata (for example `cacheControlFormat:
 * "anthropic"`).
 *
 * `payload` is threaded for the payload-dependent foreign-instrumentation
 * gate: an opencode-go completions payload carrying `cache_control` without
 * `cacheControlFormat: "anthropic"` compat is refused for replay. The route
 * stays unverified and the payload-specific refusal disables the manual probe
 * for that payload only; a later clean real-turn payload resolves normally.
 */
function resolveProxyRouteCapability(
  model: Model<any>,
  payload?: unknown,
): ProviderCapability | null {
  const registrations = PROXY_ROUTE_REGISTRY.filter(
    (route) => route.provider === model.provider,
  );
  if (registrations.length === 0) return null;
  const label = registrations[0]!.label;

  const registration = registrations.find((route) => route.api === model.api);
  if (!registration) {
    return capability(
      "unsupported",
      `${label} route API ${model.api || "unknown"} is not registered for manual-only probing; automatic and manual warming are disabled`,
    );
  }

  if (!model.baseUrl) {
    return capability(
      "unsupported",
      `${label} manual-only route requires an explicit baseUrl on ${registration.host}; automatic and manual warming are disabled without the registered proxy endpoint`,
    );
  }
  if (!hasExactProxyBaseUrl(model, registration)) {
    return capability(
      "unsupported",
      `${label} manual-only route baseUrl is not the registered ${registration.host}${registration.baseUrlPath} endpoint; automatic and manual warming are disabled for this route`,
    );
  }

  const sessionAffinityFormat = getCompat(model)?.sessionAffinityFormat;
  if (registration.sessionAffinityFormat !== undefined) {
    if (sessionAffinityFormat === undefined) {
      return capability(
        "unsupported",
        `${label} manual-only route requires cache-routing metadata; automatic and manual warming are disabled without a registered sessionAffinityFormat`,
      );
    }
    if (sessionAffinityFormat !== registration.sessionAffinityFormat) {
      return capability(
        "unsupported",
        `${label} manual-only route has unsupported cache-routing metadata; automatic and manual warming are disabled for this route`,
      );
    }
  }

  const foreignReason = opencodeGoForeignInstrumentationReason(model, payload);
  if (foreignReason) {
    // The route is registered but this exact payload is unsafe to replay.
    // manualProbe stays false, so the refusal gates /warm now and the manual
    // probe flags for this payload only.
    return capability("unverified", foreignReason);
  }

  // The Go family is payload-driven. The retained family never probes:
  // manualProbe stays false so /warm now cannot fire against a payload that
  // already requests 24h retention on the wire. The plan and the warmer both
  // derive manual gating from this flag, so they agree with this decision.
  const goFamily =
    model.provider === "opencode-go" ? classifyOpencodeGoFamily(payload) : null;
  if (goFamily === "opencode-go-retained") {
    return capability(
      "unverified",
      `${label} route is explicitly registered for manual-only probing; automatic warming is disabled and savings are n/a (unverified route); the captured payload requests 24h retention on the wire, so no keepalive or manual probe is scheduled`,
    );
  }

  // The plain family carries a degraded hint steering the user onto the keyed
  // 24h retention path where keepalive is not needed. The hint folds into
  // capability.reason, which already renders in the banner and notify paths.
  // Family classification is payload-driven and independent of capability
  // state, so a registered Go route without instrumentation shows the hint.
  const plainHint =
    goFamily === "opencode-go-plain"
      ? "; set Pi cache retention to long for keyed 24h Go caching"
      : "";

  return capability(
    "unverified",
    `${label} route is explicitly registered for manual-only probing; automatic warming is disabled and savings are n/a (unverified route)${plainHint}`,
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

/**
 * Return the provider cache-routing key from a supported payload.
 *
 * Accepted apis: openai-responses, openai-codex-responses,
 * openai-completions, and azure-openai-responses. Diagnostics only: the key
 * feeds the redacted fingerprint and never any gate beyond the literal
 * "openai-responses" keyed checks.
 */
export function getPromptCacheKey(payload: unknown, api: string | undefined): string | null {
  if (
    api !== "openai-responses" &&
    api !== "openai-codex-responses" &&
    api !== "openai-completions" &&
    api !== "azure-openai-responses"
  ) {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const key = (payload as Record<string, unknown>).prompt_cache_key;
  return isStablePromptCacheKey(key) ? key : null;
}

/**
 * Generalized family predicate: true when an OpenAI Responses payload carries
 * a stable provider cache-routing key.
 *
 * This generalizes the direct xAI key gate for automatic eligibility;
 * OpenCode Go `openai-responses` routes use the same predicate. A
 * keyed-but-unretained payload is not a separate family and behaves like
 * plain, because the gateway in-memory TTL is still the default.
 */
export function hasStableResponsesCacheKey(payload: unknown): boolean {
  return (
    isSafeReplayPayload(payload, "openai-responses") &&
    Boolean(getPromptCacheKey(payload, "openai-responses"))
  );
}

/**
 * xAI Responses needs a provider cache key in the captured body before a
 * best-effort probe can be armed. This is the route's stable cache identity.
 */
export function hasXaiPromptCacheKey(payload: unknown): boolean {
  return hasStableResponsesCacheKey(payload);
}

/** True when a captured direct xAI payload is safe for automatic replay. */
export function isSafeXaiReplayPayload(payload: unknown): boolean {
  return hasStableResponsesCacheKey(payload);
}

/**
 * True when the payload carries a `cache_control` key anywhere in its tree.
 *
 * This is the foreign-instrumentation detector. It scans nested objects and
 * arrays, matching the deep-walk precedent of `payloadHasAnthropicLongTtl`.
 * Key presence counts regardless of value: a rewriter writes the key, so even
 * a null or empty value is evidence of mutation.
 */
export function payloadHasCacheControl(payload: unknown): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, "cache_control")) {
      found = true;
      return;
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(payload);
  return found;
}

/**
 * True when a `cache_control` object with the given TTL appears anywhere in
 * the payload tree. Deep-walks nested objects and arrays, matching the
 * `payloadHasCacheControl` precedent.
 */
function payloadHasCacheControlTtl(payload: unknown, ttl: string): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.cache_control && typeof obj.cache_control === "object") {
      const cc = obj.cache_control as Record<string, unknown>;
      if (cc.ttl === ttl) {
        found = true;
        return;
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(payload);
  return found;
}

/**
 * Classify an OpenCode Go captured payload by its observed cache
 * instrumentation into one of four families.
 *
 * The family is classified from the instrumentation observed in the captured
 * payload, never from model metadata. Four-way precedence, applied in order:
 *
 * 1. `prompt_cache_retention === "24h"` present -> `opencode-go-retained`
 *    (retention wins over markers, because it is the stronger lifetime signal).
 * 2. `cache_control` with `ttl: "1h"` present -> `opencode-go-long-marker`.
 * 3. Any other `cache_control` present -> `opencode-go-short-marker`.
 * 4. Otherwise -> `opencode-go-plain`.
 *
 * Marker families are anthropic-messages-transport observations. A
 * keyed-but-unretained payload (`prompt_cache_key` without
 * `prompt_cache_retention`) is not a separate family and behaves like plain,
 * because the gateway in-memory TTL is still the default.
 */
export function classifyOpencodeGoFamily(payload?: unknown): CacheFamily {
  if (!payload || typeof payload !== "object") return "opencode-go-plain";
  const body = payload as Record<string, unknown>;
  if (body.prompt_cache_retention === "24h") return "opencode-go-retained";
  if (payloadHasCacheControlTtl(payload, "1h")) return "opencode-go-long-marker";
  if (payloadHasCacheControl(payload)) return "opencode-go-short-marker";
  return "opencode-go-plain";
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
  const proxyRoute = resolveProxyRouteCapability(model, payload);
  if (proxyRoute) return proxyRoute;

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
  const resolved = resolveProviderCapability(model, payload);
  return resolved.manualProbe && isSafeReplayPayload(payload, model?.api);
}

export type { ProviderCapability, ProviderCapabilityState } from "./types.ts";
