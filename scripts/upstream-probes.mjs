#!/usr/bin/env node
/**
 * Slice 7 post-campaign side probes.
 *
 * Run ONLY after the keepalive/control campaign sessions finish: these
 * requests carry the same big prefix to the campaign models and would
 * otherwise warm the cache the campaign is measuring.
 *
 * Probes:
 *   1. Minimum legal output cap per completions upstream: max_tokens =
 *      1, 2, 4, 8, 16 until the gateway accepts.
 *   2. Retained-wire observation: what the adapter puts on the wire with
 *      cacheRetention "long" (prompt_cache_retention / cache_control).
 *
 * Usage: node scripts/upstream-probes.mjs
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import { OPENCODE_GO_MODELS } from "../node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.models.js";

// The cap and retained-wire probes are model and adapter properties, not
// prefix-size dependent, so they run with a minimal prompt (no prefix file).

// Real registry objects, exactly as the extension sees them. kimi-k3 is
// excluded: its display name carries "(2x usage)" billing.
const ALL_GO = Object.values(OPENCODE_GO_MODELS);
const COMPLETIONS_MODELS = ALL_GO.filter(
  (m) =>
    m.provider === "opencode-go" &&
    m.api === "openai-completions" &&
    m.id !== "kimi-k3",
);

function opencodeGoApiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
    );
    const key = (auth["opencode-go"] ?? auth["opencode"])?.key;
    if (Object.prototype.toString.call(key) === "[object String]" && key.length > 0) return key;
  } catch {
    // fall through
  }
  return null;
}

async function probeMinimumMaxTokens(model) {
  const apiKey = opencodeGoApiKey();
  if (!apiKey) {
    console.log(`${model.id}: NO API KEY RESOLVED`);
    return null;
  }
  for (const maxTokens of [1, 2, 4, 8, 16]) {
    try {
      const result = await complete(
        model,
        { systemPrompt: "", messages: [{ role: "user", content: "hi" }] },
        { apiKey, maxTokens, cacheRetention: "short" },
      );
      console.log(
        `${model.id}: max_tokens=${maxTokens} ACCEPTED out=${result.usage?.output ?? "?"}`,
      );
      return maxTokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `${model.id}: max_tokens=${maxTokens} REJECTED: ${message.slice(0, 140)}`,
      );
      if (maxTokens === 16) return null;
    }
  }
  return null;
}

async function retainedWireObservation() {
  const apiKey = opencodeGoApiKey();
  if (!apiKey) {
    console.log("retained-wire: NO API KEY RESOLVED");
    return;
  }
  const model = COMPLETIONS_MODELS.find((m) => m.id === "deepseek-v4-flash");
  try {
    let wirePayload = null;
    await complete(
      model,
      { systemPrompt: "", messages: [{ role: "user", content: "hi" }] },
      {
        apiKey,
        maxTokens: 1,
        cacheRetention: "long",
        onPayload: (payload) => {
          wirePayload = payload;
          return payload;
        },
      },
    );
    console.log(
      "retained-wire (completions, long):",
      JSON.stringify({
        prompt_cache_retention: wirePayload?.prompt_cache_retention ?? null,
        prompt_cache_key: wirePayload?.prompt_cache_key ?? null,
        has_cache_control: Boolean(
          wirePayload && JSON.stringify(wirePayload).includes("cache_control"),
        ),
      }),
    );
  } catch (err) {
    console.log(
      "retained-wire (completions, long) ERROR:",
      err instanceof Error ? err.message.slice(0, 200) : String(err),
    );
  }
}

async function anthropicLongMarkerObservation() {
  // Long-marker replay uses the anthropic-messages transport at
  // https://opencode.ai/zen/go. Record the emitted cache_control and whether
  // the gateway accepts the ttl "1h" payload (beta-header behavior applies
  // identically to capture and replay: the adapter sets anthropic-beta).
  const apiKey = opencodeGoApiKey();
  if (!apiKey) {
    console.log("anthropic-long-marker: NO API KEY RESOLVED");
    return;
  }
  const model = ALL_GO.find(
    (m) => m.provider === "opencode-go" && m.id === "minimax-m3",
  );
  try {
    let wirePayload = null;
    const result = await complete(
      model,
      { systemPrompt: "", messages: [{ role: "user", content: "hi" }] },
      {
        apiKey,
        maxTokens: 1,
        cacheRetention: "long",
        onPayload: (payload) => {
          wirePayload = payload;
          return payload;
        },
      },
    );
    const controls = [];
    const visit = (node) => {
      if (!node || node !== Object(node)) return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node.cache_control && node.cache_control === Object(node.cache_control)) {
        controls.push(JSON.stringify(node.cache_control));
      }
      Object.values(node).forEach(visit);
    };
    visit(wirePayload);
    console.log(
      "anthropic-long-marker (minimax-m3, long):",
      JSON.stringify({
        accepted: true,
        cache_controls: controls,
        cache_read: result.usage?.cacheRead ?? 0,
      }),
    );
  } catch (err) {
    console.log(
      "anthropic-long-marker (minimax-m3, long) ERROR:",
      err instanceof Error ? err.message.slice(0, 200) : String(err),
    );
  }
}

async function main() {
  console.log("=== minimum legal output cap per completions upstream ===");
  console.log(`models: ${COMPLETIONS_MODELS.map((m) => m.id).join(", ")}`);
  for (const model of COMPLETIONS_MODELS) {
    await probeMinimumMaxTokens(model);
  }
  console.log("=== retained-wire observation (completions, long) ===");
  await retainedWireObservation();
  console.log("=== anthropic long-marker replay (minimax-m3, long) ===");
  await anthropicLongMarkerObservation();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
