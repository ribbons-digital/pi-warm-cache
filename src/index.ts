/**
 * pi-warm-cache
 *
 * Keeps Anthropic / OpenAI prompt caches warm during long idle gaps in a Pi session.
 *
 * Core idea:
 * 1. Snapshot the exact provider payload on each real turn (`before_provider_request`).
 *    This hook is READ-ONLY. We never rewrite real user turns.
 * 2. After the agent settles, start a provider-specific timer (4m / 50m / 24m / ...).
 * 3. On tick, replay that payload with a minimal legal output cap via `complete({ onPayload })`.
 * 4. Never use `sendUserMessage` for warming (would pollute the session and run tools).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseConfigArgs } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { SessionWarmer } from "./warmer.ts";
import { clearWarmUi } from "./ui.ts";

export default function piWarmCache(pi: ExtensionAPI) {
  const warmer = new SessionWarmer(pi);
  let config = { ...DEFAULT_CONFIG };

  // Optional CLI: pi --warm-cache / pi --warm-cache=off
  pi.registerFlag("warm-cache", {
    description: "Enable or configure pi-warm-cache (true/false or config tokens)",
    type: "string",
    default: "true",
  });

  pi.on("session_start", async (event, ctx) => {
    warmer.bindContext(ctx);

    // Opt-in file diagnostics. Never default-write into the project cwd.
    const envDebug = process.env.PI_WARM_CACHE_DEBUG;
    if (envDebug === "1" || envDebug === "true" || envDebug === "on") {
      config = { ...config, logToFile: true };
    }

    const flag = pi.getFlag("warm-cache");
    if (typeof flag === "string") {
      if (flag === "false" || flag === "0" || flag === "off") {
        config = { ...config, enabled: false };
      } else if (flag === "true" || flag === "1" || flag === "on") {
        config = { ...config, enabled: true };
      } else {
        config = parseConfigArgs(flag, config);
      }
    }

    warmer.setConfig(config);

    // Payload anchors are never restored across resume (turn-specific).
    // Stats persistence can be added later via appendEntry.

    if (event.reason === "startup" && config.enabled && ctx.hasUI) {
      if (warmer.getCapability().state === "verified") {
        ctx.ui.setStatus(
          "pi-warm-cache",
          ctx.ui.theme.fg("dim", "warm ready · waiting for first cached turn"),
        );
      } else {
        clearWarmUi(ctx);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    warmer.dispose();
  });

  pi.on("model_select", async (_event, ctx) => {
    warmer.bindContext(ctx);
    warmer.onModelChange(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    // Effort is part of many cache keys. Force re-anchor.
    warmer.bindContext(ctx);
    warmer.onModelChange(ctx);
  });

  // Compaction changes the prompt prefix. Old payload must not be replayed.
  pi.on("session_compact", async (_event, ctx) => {
    warmer.invalidateAnchor(ctx, "compacted · waiting for next turn");
  });

  // Branch / tree navigation changes the active prefix.
  pi.on("session_tree", async (_event, ctx) => {
    warmer.invalidateAnchor(ctx, "branch changed · waiting for next turn");
  });

  pi.on("agent_start", async (_event, ctx) => {
    warmer.bindContext(ctx);
    warmer.onAgentStart(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    warmer.bindContext(ctx);
    warmer.onAgentSettled(ctx);
  });

  /**
   * CRITICAL PATH: capture the real serialized provider payload.
   * READ-ONLY - do not return a modified payload.
   * Rewriting real turns (e.g. forcing ttl:1h) can 400 unsupported routes
   * and silently doubles cache-write cost outside Pi's retention gates.
   */
  pi.on("before_provider_request", (event, ctx) => {
    if (warmer.isWarming()) return;
    warmer.capturePayload(event.payload, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = (event.message as {
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
    }).usage;
    if (!usage) return;
    warmer.noteAssistantUsage(ctx, usage);
  });

  pi.registerCommand("warm", {
    description:
      "Control prompt-cache warming. Usage: /warm [on|off|status|now|resume|codex-on|codex-off|5m|1h|auto|log|nolog|interval=4m|max=3]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "status") {
        ctx.ui.notify(warmer.getStatusText(), "info");
        return;
      }
      if (trimmed === "now") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Agent is busy. Try /warm now when idle.", "warning");
          return;
        }
        // Manual ping is allowed even when auto-warm is sticky-blocked.
        const result = await warmer.warmNow(ctx);
        const route = `${result.provider ?? "unknown"}/${result.modelId ?? "unknown"} api=${result.api ?? "unknown"}`;
        const capability =
          `capability=${result.capabilityState ?? "unknown"} reason=${result.capabilityReason ?? "unknown"}`;
        const usage =
          `read=${result.cacheRead} write=${result.cacheWrite} in=${result.input} ` +
          `out=${result.output} cost=$${result.costUsd.toFixed(4)}`;
        const fingerprint = `pfp=${result.fingerprint ? result.fingerprint.slice(0, 8) : "none"}`;
        const strategy =
          `strategy=${result.family ?? "unknown"} cadence=${result.strategyLabel ?? "unknown"} ` +
          `intervalMs=${result.intervalMs ?? "none"}`;
        const cacheKey = `cacheKey=${result.cacheKeyFingerprint ?? "none"}`;
        const retry = `retry=${result.retryState ?? "none"}`;
        const diagnostics = `${route}; ${capability}; ${strategy}; ${cacheKey}; ${usage}; ${fingerprint}; ${retry}`;
        if (!result.ok) {
          const failureLabel =
            result.unavailable || result.capabilityState === "unsupported"
              ? "Probe unavailable"
              : "Probe failed";
          ctx.ui.notify(`${failureLabel}: ${result.error} (${diagnostics})`, "error");
          return;
        }
        if (result.capabilityState === "unverified") {
          ctx.ui.notify(
            `Unverified probe ${result.cacheHit ? "hit" : "miss"} (${diagnostics}). No active keepalive or verified savings claim.`,
            result.cacheHit ? "info" : "warning",
          );
          return;
        }
        const probeLabel =
          result.family === "xai-best-effort" ? "Best-effort probe" : "Probe";
        if (result.probeOutcome === "transient-miss") {
          ctx.ui.notify(
            `${probeLabel} miss (transient; retry scheduled) (${diagnostics})`,
            "info",
          );
          return;
        }
        if (result.probeOutcome === "payload-drift") {
          ctx.ui.notify(`${probeLabel} miss (payload drift; re-anchor required) (${diagnostics})`, "warning");
          return;
        }
        ctx.ui.notify(
          result.cacheHit
            ? `${probeLabel} hit (${diagnostics})`
            : `${probeLabel} miss (${diagnostics})`,
          result.cacheHit ? "info" : "warning",
        );
        return;
      }

      const lower = trimmed.toLowerCase();
      const resumeRequested =
        lower === "resume" ||
        lower === "on" ||
        lower.split(/\s+/).includes("resume") ||
        lower.split(/\s+/).includes("on");

      if (lower === "resume") {
        warmer.bindContext(ctx);
        warmer.clearAutoWarmBlock("user /warm resume");
        ctx.ui.notify("pi-warm-cache sticky block cleared. Timers resume if enabled (use /warm codex-off to disable Codex auto-warm).", "info");
        warmer.onAgentSettled(ctx);
        return;
      }

      if (lower === "codex-on" || lower === "codex-off") {
        config = parseConfigArgs(trimmed, warmer.getConfig());
        warmer.bindContext(ctx);
        if (lower === "codex-on") {
          warmer.clearAutoWarmBlock("user /warm codex-on");
        }
        warmer.setConfig(config);
        ctx.ui.notify(
          lower === "codex-on"
            ? "Codex auto-warm enabled (OK-suffix path). Sticky block still applies if out is huge."
            : "Codex auto-warm disabled. /warm now still works for a one-shot probe.",
          "info",
        );
        warmer.onAgentSettled(ctx);
        return;
      }

      config = parseConfigArgs(trimmed, warmer.getConfig());
      warmer.bindContext(ctx);
      if (resumeRequested && config.enabled) {
        warmer.clearAutoWarmBlock("user /warm on");
      }
      warmer.setConfig(config);

      if (!config.enabled) {
        clearWarmUi(ctx);
        ctx.ui.notify("pi-warm-cache disabled", "info");
        return;
      }

      if (config.anthropicTtl === "1h") {
        ctx.ui.notify(
          "1h mode follows Pi's on-wire long TTL. This extension does not rewrite real turns. Set Pi cache retention to long if you want 1h caches.",
          "info",
        );
      }

      const block = warmer.getAutoWarmBlockReason();
      ctx.ui.notify(
        `pi-warm-cache on (ttl=${config.anthropicTtl}, interval=${config.intervalMs ?? "auto"}, max=${config.maxConcurrentWarmSessions}, log=${config.logToFile ? "on" : "off"}${block ? `, autoWarm=blocked` : ""})`,
        "info",
      );
      warmer.onAgentSettled(ctx);
    },
  });
}
