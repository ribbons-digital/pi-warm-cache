#!/usr/bin/env node
/**
 * Slice 7 TTL finder (independent-trial design).
 *
 * Each candidate idle gap W is measured against an INDEPENDENT cache entry:
 * a unique nonce is embedded in the prefix (and session id), so no replay
 * refreshes another trial's entry and a cold write never re-arms a live one.
 *
 * All cold writes happen at t=0; each trial replays once at its own W.
 * A hit at W means TTL > W for that entry; a miss means TTL <= W.
 *
 * Usage: node scripts/ttl-finder.mjs <model-id> <W1,W2,W3,...> [prefix-file]
 *   e.g. node scripts/ttl-finder.mjs deepseek-v4-flash 20,40,60,90,120 \
 *        /tmp/pi-warm-cache-campaign-test/bigprefix-control.txt
 * The prefix file is required: each trial embeds a nonce into it, so any
 * text file works, but it must exist (clear error otherwise).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import { OPENCODE_GO_MODELS } from "../node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.models.js";

const modelId = process.argv[2];
const trialWs = (process.argv[3] ?? "20,40,60,90,120")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);

const prefixFile = process.argv[4];
if (!prefixFile) {
  console.error("missing required prefix-file argument (see usage)");
  process.exit(2);
}
let basePrefix;
try {
  basePrefix = readFileSync(prefixFile, "utf8");
} catch (err) {
  console.error(`cannot read prefix file ${prefixFile}: ${err.message}`);
  process.exit(2);
}
const BASE_PREFIX = basePrefix;

const model = Object.values(OPENCODE_GO_MODELS).find(
  (m) => m.provider === "opencode-go" && m.id === modelId,
);
if (!model) {
  console.error(`model not found in registry: ${modelId}`);
  process.exit(1);
}

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

async function request(nonce, message) {
  const prefix = `${BASE_PREFIX}\n\n[ttl-trial ${nonce}]\n`;
  return complete(
    model,
    { systemPrompt: prefix, messages: [{ role: "user", content: message }] },
    {
      apiKey: opencodeGoApiKey(),
      maxTokens: 1,
      cacheRetention: "short",
      sessionId: `ttl-${modelId}-${nonce}`,
    },
  );
}

async function main() {
  const apiKey = opencodeGoApiKey();
  if (!apiKey) {
    console.error("NO API KEY RESOLVED");
    process.exit(1);
  }
  const nonces = trialWs.map((w) => `w${w}m-${Math.random().toString(36).slice(2, 8)}`);
  console.log(`[${modelId}] cold writes at t=0 for trials: ${trialWs.join(", ")}m`);
  // Record each cold write's completion time so every replay fires at an
  // absolute deadline of writeTime + W. Sequential writes and replay time
  // must never shift a trial's true idle age.
  const writeDoneAt = [];
  for (const nonce of nonces) {
    const t0 = Date.now();
    await request(nonce, "ttl write");
    writeDoneAt.push(Date.now());
    if (Date.now() - t0 > 5000) {
      console.log(`[${modelId}] note: write for ${nonce} took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
  console.log(`[${modelId}] all ${nonces.length} entries written; waiting for first replay`);

  const results = [];
  const deadlineAt = trialWs.map((w, i) => writeDoneAt[i] + w * 60_000);
  for (let i = 0; i < trialWs.length; i++) {
    const w = trialWs[i];
    const waitMs = deadlineAt[i] - Date.now();
    if (waitMs > 0) {
      console.log(`[${modelId}] waiting ${(waitMs / 60000).toFixed(1)}m (absolute t+${w}m)`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const usage = (await request(nonces[i], "ttl check")).usage ?? {};
    const read = usage.cacheRead ?? 0;
    const hit = read > 0;
    results.push({ w, read, hit });
    console.log(`[${modelId}] t+${w}m: cacheRead=${read} cacheWrite=${usage.cacheWrite ?? 0} -> ${hit ? "HOT" : "EXPIRED"}`);
    if (!hit) {
      const prevHot = results.slice(0, -1).filter((r) => r.hit).pop();
      console.log(
        `[${modelId}] TTL boundary: ${prevHot ? `> ${prevHot.w}m and <= ${w}m` : `<= ${w}m`}`,
      );
      process.exit(0);
    }
  }
  console.log(`[${modelId}] still HOT at t+${trialWs.at(-1)}m (TTL >= ${trialWs.at(-1)}m)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
