// Offline safety checks. Providers below are synthetic and cannot make HTTP calls.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveProviderCapability, payloadObject, type PayloadObject } from "./capability.ts";
import { resolveStrategy, stableFingerprint } from "./provider.ts";
import { SessionWarmer, resetProbeSpendLedgerForTest, type CompleteRequest } from "./warmer.ts";
import { DEFAULT_CONFIG, type WarmRouteProfile } from "./types.ts";

const model: Model<any> = {
  id: "gpt-5.6-luna", name: "Offline", provider: "openai", api: "openai-responses",
  baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"],
  contextWindow: 32768, maxTokens: 128,
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
};
const payload: PayloadObject = {
  model: model.id, input: [{ role: "user", content: "Synthetic request." }],
  store: false, prompt_cache_key: "offline-safety-key",
};
const reply: AssistantMessage = {
  role: "assistant", provider: model.provider, model: model.id, api: model.api,
  content: [{ type: "text", text: "Offline." }], timestamp: 0, stopReason: "stop",
  usage: { input: 20, output: 1, cacheRead: 1024, cacheWrite: 0, totalTokens: 1045,
    cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 } },
};

type TimerDriver = { runWarm(reason: "timer"): ReturnType<SessionWarmer["warmNow"]> };

function contextFixture<Fixture>(context: Fixture): ExtensionContext {
  // SAFETY: The fixture supplies each public field that this test's warmer reads.
  return context as ExtensionContext;
}

function timerFixture<Fixture>(warmer: Fixture): TimerDriver {
  // SAFETY: SessionWarmer has this private timer entry point, exercised without a network.
  return warmer as TimerDriver;
}

function fixture(auth: WarmRouteProfile["auth"] = "api-key", selected = model,
  body = payload, thinking: WarmRouteProfile["thinkingLevel"] = "off") {
  const requests: Array<{ body: PayloadObject; retries?: number; timeout?: number; signal?: AbortSignal }> = [];
  const controls = { auth, delayPayloadMs: 0, delayReplyMs: 0, hang: false, error: false, idle: true,
    sessionId: "offline-safety-session", onPrepare: () => {}, onReply: () => {} };
  const complete: CompleteRequest = async (active, _context, options) => {
    if (controls.delayPayloadMs) mock.timers.tick(controls.delayPayloadMs);
    controls.onPrepare();
    const replay = payloadObject(await options?.onPayload?.({}, active));
    assert(replay);
    requests.push({ body: structuredClone(replay), retries: options?.maxRetries,
      timeout: options?.timeoutMs, signal: options?.signal });
    if (controls.error) throw new Error("synthetic failure");
    if (controls.hang) {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    }
    if (controls.delayReplyMs) mock.timers.tick(controls.delayReplyMs);
    controls.onReply();
    return reply;
  };
  // SAFETY: These fixtures supply exactly the public fields exercised by the warmer.
  const ctx = contextFixture({
    cwd: process.cwd(), model: selected, thinkingLevel: thinking, hasUI: false,
    isIdle: () => controls.idle,
    ui: { setWidget: () => undefined, setStatus: () => undefined, notify: () => undefined,
      theme: { fg: (_color: string, text: string) => text } },
    sessionManager: { getSessionId: () => controls.sessionId },
    modelRegistry: { complete, isUsingOAuth: () => controls.auth === "oauth",
      hasConfiguredAuth: () => controls.auth !== "unknown" },
  });
  // SAFETY: SessionWarmer reads only this getThinkingLevel method from the API fixture.
  const pi = { getThinkingLevel: () => ctx.thinkingLevel } as ExtensionAPI;
  const warmer = new SessionWarmer(pi);
  warmer.bindContext(ctx);
  warmer.capturePayload(body, ctx);
  warmer.noteAssistantUsage(ctx, reply.usage);
  // SAFETY: Fire the private timer path without waiting through provider TTLs.
  const timer = () => timerFixture(warmer).runWarm("timer");
  return { ctx, warmer, requests, controls, timer };
}

mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
try {
  for (const [id, thinking, effort, allowed] of [
    ["gpt-5.6-luna", "off", undefined, true],
    ["gpt-6.1-sol", "low", "low", true],
    ["gpt-5.6-luna", "low", "low", false],
    ["gpt-6.1-sol", "off", undefined, false],
    ["gpt-6-astra", "off", undefined, false],
  ] as const) {
    const selected = { ...model, id };
    const body: PayloadObject = { ...payload, model: id };
    if (effort) body.reasoning = { effort };
    const f = fixture("oauth", selected, body, thinking);
    try {
      f.warmer.setConfig({ ...DEFAULT_CONFIG, intervalMs: 1000, maxOutputTokens: 200 });
      f.warmer.onAgentSettled(f.ctx);
      assert.equal(f.warmer.getCapability().state, "unverified");
      assert.equal(f.warmer.getCapability().manualProbe, allowed);
      assert.equal((await f.timer()).ok, false);
      assert.equal(f.requests.length, 0);
      const result = await f.warmer.warmNow(f.ctx);
      assert.equal(result.ok, allowed);
      assert.equal(f.requests.length, allowed ? 1 : 0);
      if (allowed) {
        const { max_output_tokens: cap, ...replayed } = f.requests[0].body;
        assert.equal(cap, 16);
        assert.deepEqual(replayed, body, "subscription replay changes only its output cap");
        assert.equal(f.requests[0].retries, 0);
        assert.equal(f.requests[0].timeout, 45_000);
        assert.match(f.warmer.getSavingsSummaryText(), /n\/a/);
      }
      mock.timers.tick(60_000);
      await nextTurn();
      assert.equal(f.requests.length, allowed ? 1 : 0, "manual action must never queue a follow-up");
      assert.match(f.warmer.getStatusText(), /nextDue=none/);
    } finally { f.warmer.dispose(); }
  }

  for (const [auth, selected, body] of [
    ["unknown", model, payload],
    ["oauth", { ...model, api: "openai-completions" }, { ...payload, messages: payload.input }],
    ["oauth", { ...model, baseUrl: "https://api.openai.com/v1/" }, payload],
    ["oauth", { ...model, baseUrl: "https://proxy.invalid/v1" }, payload],
    ["oauth", model, { ...payload, store: true }],
    ["oauth", model, { ...payload, input: "not-an-array" }],
    ["oauth", model, { ...payload, prompt_cache_key: " " }],
    ["oauth", model, { ...payload, reasoning: { effort: "low" } }],
    ["oauth", model, { ...payload, prompt_cache_options: { ttl: "30m" } }],
  ] as const) {
    const f = fixture(auth, selected, body);
    try {
      assert.equal((await f.warmer.warmNow(f.ctx)).ok, false);
      assert.equal((await f.timer()).ok, false);
      assert.equal(f.requests.length, 0, "unknown or unsafe subscription routes fail closed");
      assert.equal(f.warmer.ownsAutomaticRoute(f.ctx), true,
        "a refused OpenAI auth/profile must not fall back to native automatic warming");
    } finally { f.warmer.dispose(); }
  }

  const explicit = { ...model, compat: { supportsExplicitPromptCacheMode: true } };
  assert.equal(resolveStrategy(explicit, DEFAULT_CONFIG, payload).family, "openai-implicit");
  assert.equal(resolveStrategy(model, DEFAULT_CONFIG, { ...payload, prompt_cache_options: { ttl: "30m" } }).family,
    "openai-explicit", "wire retention, not metadata, selects the explicit window");
  const anthropic = { ...model, provider: "anthropic", api: "anthropic-messages" as const,
    baseUrl: "https://api.anthropic.com" };
  const marked: PayloadObject = { system: [{ type: "text", text: "Offline", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Offline" }] };
  const blockedCases: Array<[Model<any>, PayloadObject]> = [
    [explicit, { ...payload, prompt_cache_options: { mode: "explicit" }, prompt_cache_key: undefined }],
    [model, { ...payload, prompt_cache_key: undefined }],
    [anthropic, { system: [], messages: [] }],
    [anthropic, { ...marked, thinking: { type: "enabled", budget_tokens: 8000 } }],
    [{ ...anthropic, provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go" },
      { ...marked, thinking: { type: "enabled", budget_tokens: 8000 } }],
  ];
  for (const [selected, body] of blockedCases) {
    const f = fixture("api-key", selected, body);
    try {
      assert.equal(f.warmer.getCapability().automaticWarm, false);
      assert.equal(f.warmer.ownsAutomaticRoute(f.ctx), true, "restricted verified routes retain the native veto");
      assert.equal((await f.timer()).ok, false);
      assert.equal(f.requests.length, 0, "cache opt-out and budget thinking cannot dispatch an automatic probe");
    } finally { f.warmer.dispose(); }
  }

  // Settlement must not move the cache deadline past the real capture.
  for (const latePayload of [false, true]) {
    const f = fixture("api-key", anthropic, marked);
    try {
      f.warmer.setConfig({ ...DEFAULT_CONFIG, intervalMs: 600_000, maxIdleWarmMs: 0 });
      if (latePayload) {
        mock.timers.tick(299_000);
        f.controls.delayPayloadMs = 1000;
      } else {
        mock.timers.tick(300_000);
        f.warmer.noteAssistantUsage(f.ctx, reply.usage);
        f.warmer.onAgentSettled(f.ctx);
      }
      assert.equal((await f.timer()).ok, false);
      assert.equal(f.requests.length, 0, "expired replay must stop even after delayed payload preparation");
      assert.equal(f.warmer.getLifecycleState(), "awaiting-reanchor");
    } finally { f.warmer.dispose(); }
  }

  // Deferral and successful replay use the capture/dispatch clock, not reply time.
  const deferred = fixture("api-key", anthropic, marked);
  try {
    mock.timers.tick(280_000);
    deferred.controls.idle = false;
    assert((await deferred.timer()).deferred);
    mock.timers.tick(30_000);
    await nextTurn();
    assert.equal(deferred.requests.length, 0);
    assert.equal(deferred.warmer.getLifecycleState(), "awaiting-reanchor");
  } finally { deferred.warmer.dispose(); }

  for (const beforeDispatch of [false, true]) {
    for (const changed of ["auth", "thinking", "endpoint", "session"] as const) {
      const f = fixture("api-key");
      const change = () => {
        if (changed === "auth") f.controls.auth = "oauth";
        if (changed === "thinking") f.ctx.thinkingLevel = "low";
        if (changed === "endpoint") f.ctx.model = { ...model, baseUrl: "https://proxy.invalid/v1" };
        if (changed === "session") f.controls.sessionId = "another-session";
      };
      try {
        if (beforeDispatch) f.controls.onPrepare = change;
        else change();
        assert.equal((await f.warmer.warmNow(f.ctx)).ok, false);
        assert.equal(f.requests.length, 0, "route changes must be checked again inside the payload hook");
      } finally { f.warmer.dispose(); }
    }
  }

  const lateIdleCutoff = fixture("api-key", anthropic, marked);
  try {
    lateIdleCutoff.warmer.setConfig({ ...DEFAULT_CONFIG, maxIdleWarmMs: 1000 });
    lateIdleCutoff.controls.delayPayloadMs = 1000;
    assert.equal((await lateIdleCutoff.timer()).ok, false);
    assert.equal(lateIdleCutoff.requests.length, 0, "idle cutoff must be rechecked after payload preparation");
  } finally { lateIdleCutoff.warmer.dispose(); }

  const codex = { ...model, provider: "openai-codex", api: "openai-codex-responses" as const };
  const lateCodexOff = fixture("api-key", codex, { ...payload, instructions: "Synthetic instructions." });
  try {
    lateCodexOff.warmer.setConfig({ ...DEFAULT_CONFIG, allowCodexAutoWarm: true });
    lateCodexOff.controls.onPrepare = () =>
      lateCodexOff.warmer.setConfig({ ...DEFAULT_CONFIG, allowCodexAutoWarm: false });
    assert.equal((await lateCodexOff.timer()).ok, false);
    assert.equal(lateCodexOff.requests.length, 0, "Codex off must be rechecked before dispatch");
  } finally { lateCodexOff.warmer.dispose(); }

  const delayedReply = fixture("api-key", anthropic, marked);
  try {
    delayedReply.warmer.setConfig({ ...DEFAULT_CONFIG, intervalMs: 600_000, maxIdleWarmMs: 0 });
    mock.timers.tick(240_000);
    delayedReply.controls.delayReplyMs = 60_000;
    assert.equal((await delayedReply.timer()).ok, true);
    mock.timers.tick(240_000);
    assert.equal((await delayedReply.timer()).ok, false,
      "successful replay deadline must start at dispatch, not the delayed reply");
    assert.equal(delayedReply.requests.length, 1);
  } finally { delayedReply.warmer.dispose(); }

  const holding = fixture("oauth");
  const queued = fixture("oauth");
  holding.controls.hang = true;
  queued.warmer.setConfig({ ...DEFAULT_CONFIG, maxConcurrentWarmSessions: 1 });
  const held = holding.warmer.warmNow(holding.ctx);
  try {
    await nextTurn();
    assert.equal((await queued.warmer.warmNow(queued.ctx)).deferred?.reason, "concurrency limit");
    mock.timers.tick(45_000);
    await held;
    mock.timers.tick(60_000);
    await nextTurn();
    assert.equal(queued.requests.length, 0, "manual concurrency refusal must not queue a later request");
  } finally {
    holding.warmer.dispose();
    queued.warmer.dispose();
    await held;
  }

  const ownership = fixture();
  try {
    ownership.warmer.setConfig({ ...DEFAULT_CONFIG, enabled: false });
    ownership.warmer.capturePayload(payload, ownership.ctx);
    assert.equal((await ownership.warmer.warmNow(ownership.ctx)).ok, false);
    ownership.warmer.setConfig(DEFAULT_CONFIG);
    assert.equal((await ownership.warmer.warmNow(ownership.ctx)).ok, false);
    ownership.warmer.capturePayload(payload, ownership.ctx);
    assert.equal((await ownership.warmer.warmNow(ownership.ctx)).ok, true);
  } finally { ownership.warmer.dispose(); }

  resetProbeSpendLedgerForTest();
  const budget = fixture("oauth");
  try {
    budget.warmer.setConfig({ ...DEFAULT_CONFIG, warmSpendCeilingUsd: 0.005 });
    assert.equal((await budget.warmer.warmNow(budget.ctx)).ok, true);
    assert.equal((await budget.warmer.warmNow(budget.ctx)).ok, false);
    assert.equal(budget.requests.length, 1, "new subscription manual action must honor configured spend");
  } finally { budget.warmer.dispose(); }

  const failed = fixture("oauth");
  try {
    failed.controls.error = true;
    assert.equal((await failed.warmer.warmNow(failed.ctx)).ok, false);
    mock.timers.tick(60_000);
    await nextTurn();
    assert.equal(failed.requests.length, 1, "failed manual action cannot retry or schedule a follow-up");
  } finally { failed.warmer.dispose(); }

  const timeout = fixture("oauth");
  try {
    timeout.controls.hang = true;
    const pending = timeout.warmer.warmNow(timeout.ctx);
    await nextTurn();
    mock.timers.tick(44_999);
    assert.equal(timeout.requests[0].signal?.aborted, false);
    mock.timers.tick(1);
    const result = await pending;
    assert.match(result.error ?? "", /timed out after 45 seconds/);
    assert.equal(timeout.requests[0].signal?.aborted, true);
    assert.equal(timeout.warmer.getActiveWarmSessions(), 0);
    mock.timers.tick(60_000);
    await nextTurn();
    assert.equal(timeout.requests.length, 1);
  } finally { timeout.warmer.dispose(); }

  const retiredTimeout = fixture("oauth");
  try {
    retiredTimeout.controls.delayReplyMs = 45_000;
    retiredTimeout.controls.onReply = () => {
      retiredTimeout.warmer.onAgentStart(retiredTimeout.ctx);
      retiredTimeout.warmer.capturePayload(payload, retiredTimeout.ctx);
    };
    assert.equal((await retiredTimeout.warmer.warmNow(retiredTimeout.ctx)).ok, false);
    assert.match(retiredTimeout.warmer.getStatusText(), /last=none/,
      "a retired timeout cannot write failure status onto a new real-turn anchor");
  } finally { retiredTimeout.warmer.dispose(); }

  assert.equal(stableFingerprint(payload), stableFingerprint(structuredClone(payload)));
  assert.equal(resolveProviderCapability(model, payload, { auth: "oauth", thinkingLevel: "off" }).manualProbe, true);
  console.log("[safety] PASS: auth/profile/payload gates, exact cap, expiry/deferral, ownership toggles, spend, cancellation and no follow-ups; synthetic only");
} finally {
  mock.timers.reset();
  resetProbeSpendLedgerForTest();
}
