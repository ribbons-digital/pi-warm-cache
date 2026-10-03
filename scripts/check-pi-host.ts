// Offline contract check against the installed Pi host and its real Responses adapter.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { HAS_NATIVE_WARMING } from "../src/provider.ts";
import { SessionWarmer } from "../src/warmer.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { payloadObject, type PayloadObject } from "../src/capability.ts";

const workspace = await mkdtemp(join(tmpdir(), "warm-host-contract-"));
const bodies: PayloadObject[] = [];
const captured: PayloadObject[] = [];
const errors: string[] = [];
const notices: string[] = [];
let rejectNext = false;
let rejectStatus = 400;
let hangNext = false;
const requestSignals: AbortSignal[] = [];
let settled = 0;
let started = 0;
let shutdown = 0;
let session: AgentSession | undefined;
let hostApi: ExtensionAPI | undefined;
let hostContext: ExtensionContext | undefined;

// No outbound fallback: even an unexpected request fails locally.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  assert.equal(url, "https://api.openai.com/v1/responses");
  const request = input instanceof Request ? input : new Request(input, init);
  const body = payloadObject(JSON.parse(await request.text()));
  assert(body, "serialized request must be an object");
  bodies.push(body);
  requestSignals.push(request.signal);
  if (hangNext) {
    hangNext = false;
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("synthetic cancellation", "AbortError")), { once: true });
    });
  }
  if (rejectNext) {
    rejectNext = false;
    return new Response(JSON.stringify({ error: { message: "synthetic rejection" } }), {
      status: rejectStatus,
      headers: { "content-type": "application/json" },
    });
  }
  const response = {
    id: `offline-${bodies.length}`,
    status: "completed",
    output: [{
      type: "message", id: "offline-message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Offline response.", annotations: [] }],
    }],
    usage: { input_tokens: 4096, output_tokens: 3, input_tokens_details: { cached_tokens: 2048 } },
  };
  return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
};

try {
  const credentials = new InMemoryCredentialStore();
  let modelRuntime = await ModelRuntime.create({
    credentials,
    authPath: join(workspace, "auth.json"),
    modelsPath: join(workspace, "models.json"),
    modelsStorePath: join(workspace, "catalog.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("openai", {
    api: "openai-responses",
    apiKey: "sk-offline-contract-only",
    baseUrl: "https://api.openai.com/v1",
    models: ["offline-primary", "offline-alternate"].map((id) => ({
      id, name: id, reasoning: true, input: ["text" as const],
      contextWindow: 32768, maxTokens: 128,
      cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
    })),
  });
  const settings = {
    cacheRetention: "short" as const,
    cacheWarming: "off" as const,
    compaction: { enabled: false },
    retry: { enabled: false },
  };
  const settingsManager = SettingsManager.inMemory(settings);
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: workspace,
    settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    noContextFiles: true,
    systemPrompt: "Offline host contract check.",
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    extensionFactories: [(pi) => {
      hostApi = pi;
      pi.on("before_provider_request", (event) => {
        const payload = payloadObject(JSON.parse(JSON.stringify(event.payload)));
        assert(payload);
        captured.push(payload);
      });
      pi.on("agent_settled", () => { settled++; });
      pi.on("session_start", (_event, ctx) => {
        hostContext = ctx;
        started++;
        ctx.ui.notify = (message) => { notices.push(message); };
      });
      pi.on("session_shutdown", () => { shutdown++; });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "actual extension must load");
  assert(loader.getExtensions().extensions.some((extension) =>
    extension.commands.has("warm") && extension.flags.has("warm-cache")));
  const model = modelRuntime.getModel("openai", "offline-primary");
  const alternate = modelRuntime.getModel("openai", "offline-alternate");
  assert(model && alternate);
  ({ session } = await createAgentSession({
    cwd: workspace, agentDir: workspace, modelRuntime, model, thinkingLevel: "off",
    settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(workspace),
    noTools: "all",
  }));
  await session.bindExtensions({ onError: (error) => { errors.push(error.error); } });
  assert.equal(started, 1);

  await session.prompt("Synthetic first turn.");
  assert.equal(bodies.length, 1);
  assert.equal(settled, 1, "host must emit agent_settled");
  assert.deepEqual(captured, [bodies[0]], "capture must not rewrite the real request");
  const firstAssistant = session.messages.find((message) => message.role === "assistant");
  assert(firstAssistant?.role === "assistant");
  assert.equal(firstAssistant.usage.cacheRead, 2048, "adapter must parse synthetic cache usage");
  const messagesBeforeProbe = structuredClone(session.messages);
  await session.prompt("/warm now");
  assert.equal(bodies.length, 2, "manual probe must dispatch through ModelRegistry.complete");
  assert.equal(bodies[1].max_output_tokens, 16);
  assert(notices.at(-1)?.startsWith("Extension probe hit"), "command must report the synthetic hit");
  const { max_output_tokens: realCap, ...realPayload } = bodies[0];
  const { max_output_tokens: probeCap, ...probePayload } = bodies[1];
  assert(realCap !== probeCap);
  assert.deepEqual(probePayload, realPayload, "probe must replay the exact anchor except its cap");
  assert.deepEqual(session.messages, messagesBeforeProbe, "probe must not enter the conversation");
  assert.equal(captured.length, 1, "nested probe must not become a real-turn capture");

  rejectNext = true;
  await session.prompt("/warm now");
  assert.equal(bodies.length, 3, "synthetic HTTP 400 must be handled without retrying");
  assert(notices.at(-1)?.startsWith("Probe failed"), "command must report the synthetic failure");
  assert.deepEqual(session.messages, messagesBeforeProbe, "failed probe must not enter the conversation");
  await session.prompt("/warm off");
  await session.reload();
  assert.equal(shutdown, 1, "reload must shut down the old extension runtime");
  assert.equal(started, 2, "reload must start a fresh extension runtime");
  assert.deepEqual(loader.getExtensions().errors, [], "actual extension must reload");
  await session.prompt("/warm now");
  assert.equal(bodies.length, 3, "reload must discard the old anchor");

  await session.prompt("Synthetic second turn.");
  assert.equal(bodies.length, 4);
  assert.equal(settled, 2);
  await session.setModel(alternate);
  await session.prompt("/warm now");
  assert.equal(bodies.length, 4, "model selection must invalidate the anchor");
  await session.prompt("Synthetic third turn.");
  assert.equal(bodies.length, 5);
  session.setThinkingLevel("low");
  await session.prompt("/warm now");
  assert.equal(bodies.length, 5, "thinking selection must invalidate the anchor");
  await session.prompt("/warm off");

  // Prove the controlled clock can fire an automatic probe before testing cleanup.
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  const scheduledTimers = mock.method(globalThis, "setTimeout");
  const cancelledTimers = mock.method(globalThis, "clearTimeout");
  await session.prompt("/warm on interval=1s");
  await session.prompt("Synthetic timer control turn.");
  const beforeTick = bodies.length;
  mock.timers.tick(1000);
  await nextTurn();
  assert.equal(bodies.length, beforeTick + 1, "armed extension timer must dispatch before reload");

  // A fresh real turn arms a new timer. Do not disable warming before reload.
  await session.prompt("Synthetic active-timer reload turn.");
  await session.prompt("/warm status");
  assert(notices.at(-1)?.includes(`nextDue=${new Date(Date.now() + 1000).toISOString()}`),
    "reload must begin with an armed extension timer");
  const armedTimer = scheduledTimers.mock.calls.filter((call) => call.arguments[1] === 1000).at(-1)?.result;
  assert(armedTimer, "the controlled clock must contain the armed timer");
  const beforeReload = bodies.length;
  await session.reload();
  assert.equal(shutdown, 2);
  assert.equal(started, 3);
  assert.deepEqual(loader.getExtensions().errors, []);
  assert(cancelledTimers.mock.calls.some((call) => call.arguments[0] === armedTimer),
    "shutdown must clear the armed extension timer");
  mock.timers.tick(15_000); // Cross both the warm deadline and the UI interval.
  await nextTurn();
  assert.equal(bodies.length, beforeReload, "shutdown must cancel the old armed timer");
  await session.prompt("/warm now");
  assert.equal(bodies.length, beforeReload, "reloaded extension must wait for a new anchor");
  // Emit lifecycle boundaries through the installed runner, without paid compaction.
  const lifecycleRunner = session.extensionRunner;
  const compactEvent = { type: "session_compact" as const, fromExtension: false,
    reason: "manual" as const, willRetry: false,
    compactionEntry: { type: "compaction" as const, id: "offline-compaction", parentId: null,
      timestamp: new Date().toISOString(), summary: "Synthetic summary.",
      firstKeptEntryId: "offline-entry", tokensBefore: 4096 } };
  const treeEvent = { type: "session_tree" as const, newLeafId: null, oldLeafId: null };
  for (const event of [compactEvent, treeEvent]) {
    await session.prompt(`Synthetic ${event.type} anchor.`);
    const before: number = bodies.length;
    await lifecycleRunner.emit(event);
    await session.prompt("/warm now");
    assert.equal(bodies.length, before, `${event.type} must discard the anchor`);
  }
  const shutdownEvent = { type: "session_shutdown" as const, reason: "new" as const };
  await lifecycleRunner.emit(shutdownEvent);
  const startEvent = { type: "session_start" as const, reason: "new" as const };
  await lifecycleRunner.emit(startEvent);
  const beforeReplacement = bodies.length;
  await session.prompt("/warm now");
  assert.equal(bodies.length, beforeReplacement, "session replacement requires a new anchor");
  await session.prompt("Synthetic replacement-session anchor.");
  await session.prompt("/warm now");
  assert.equal(bodies.length, beforeReplacement + 2, "fresh session warmer must not stay disposed");

  if (HAS_NATIVE_WARMING) {
    // Exercise the installed native implementation with the actual host's
    // extension decision chain. This private import is test-only.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { CacheWarmer } = await import(pathToFileURL(join(dirname(entry), "core/cache-warmer.js")).href);
    type Decision = { type: "cache_warming_decision"; action: "warm" | "stop";
      warmCost: number; missCost: number; continuationProbability: number };
    type DecisionRunner = AgentSession["extensionRunner"] & {
      emitCacheWarmingDecision(event: Decision): Promise<"warm" | "stop"> };
    // SAFETY: The event exists only on the version-gated host, with the public signature above.
    const runner = session.extensionRunner as DecisionRunner;
    const onNativePayload = async (body: PayloadObject): Promise<PayloadObject> => {
      const next = payloadObject(await runner.emitBeforeProviderRequest(body));
      assert(next);
      return next;
    };
    let nativeCalls = 0;
    session.setThinkingLevel("off");
    await session.prompt("Synthetic ownership anchor.");
    await session.prompt("/warm interval=1s");
    const nativeModel = { ...model, promptCache: { short: 20 },
      cost: { input: 1000, output: 1, cacheRead: 0.1, cacheWrite: 1000 } };
    const lastRealBody = structuredClone(bodies.at(-1));
    assert(lastRealBody);
    const nativeStore = { getBranch: () => [{ type: "message", message: firstAssistant }],
      appendUsage: () => ({ type: "usage" }) };
    const nativeModels = { streamSimple: (_model: typeof model, _context: Context,
      options: { onPayload?: typeof onNativePayload }) => ({ result: async () => {
        nativeCalls++;
        await options.onPayload?.({ ...lastRealBody, max_output_tokens: 1 });
        return firstAssistant;
      } }) };
    for (const mode of ["off", "streaming", "idle"] as const) {
      const native = new CacheWarmer(nativeModels, nativeStore, () => mode,
        (event: Decision) => runner.emitCacheWarmingDecision(event));
      const before: number = bodies.length;
      const beforeCapture: number = captured.length;
      try {
        native.start({ model: nativeModel, context: { messages: [] }, options: {
          cacheRetention: "short", onPayload: onNativePayload,
        } }, () => true);
        if (mode === "idle") native.onAgentSettled();
        mock.timers.tick(10_000);
        await nextTurn();
        await nextTurn();
        assert.equal(nativeCalls, 0, `native ${mode} must not dispatch on the extension-owned route`);
        assert.equal(bodies.length, before + 1, `only the extension timer may dispatch in native ${mode}`);
        assert.equal(captured.length, beforeCapture, "no automatic probe may replace the real anchor");
        assert.equal(bodies.at(-1)?.max_output_tokens, 16);
        if (mode !== "off") assert.equal(native.status.reason, "stopped by extension");
      } finally { native.cancel(); }
    }
    await session.prompt("/warm status");
    assert(notices.at(-1)?.includes("owner=extension (native veto"));

    // Off releases the route; native idle payload hooks must not become anchors.
    await session.prompt("/warm off");
    const released = new CacheWarmer(nativeModels, nativeStore, () => "idle",
      (event: Decision) => runner.emitCacheWarmingDecision(event));
    try {
      released.start({ model: nativeModel, context: { messages: [] }, options: {
        cacheRetention: "short", onPayload: onNativePayload,
      } }, () => true);
      released.onAgentSettled();
      mock.timers.tick(10_000);
      await nextTurn();
      assert.equal(nativeCalls, 1, "unowned native route must retain its own behavior");
      const before = bodies.length;
      await session.prompt("/warm on");
      await session.prompt("/warm now");
      assert.equal(bodies.length, before, "ownership handoff must require a new real anchor");
    } finally { released.cancel(); }

    // Prove, rather than hide, the public last-handler-wins limitation.
    await session.prompt("Synthetic conflicting-handler anchor.");
    const extension = loader.getExtensions().extensions.find((item) => item.commands.has("warm"));
    const handlers = extension?.handlers.get("cache_warming_decision");
    assert(handlers?.length);
    handlers.push(async () => ({ action: "warm" }));
    const conflict = new CacheWarmer(nativeModels, nativeStore, () => "idle",
      (event: Decision) => runner.emitCacheWarmingDecision(event));
    try {
      conflict.start({ model: nativeModel, context: { messages: [] }, options: {
        cacheRetention: "short", onPayload: onNativePayload,
      } }, () => true);
      conflict.onAgentSettled();
      mock.timers.tick(10_000);
      await nextTurn();
      assert.equal(nativeCalls, 2, "a late warm override can defeat the extension veto");
    } finally { conflict.cancel(); handlers.pop(); }

    // Stored dummy OAuth data exercises the public registry and real adapter.
    await session.prompt("/warm off");
    await session.extensionRunner.emit(shutdownEvent);
    session.dispose();
    // Seed OAuth before creating its runtime. Reusing the API-key runtime races
    // registerProvider's background availability refreshes and stale snapshots.
    const oauthCredentials = new InMemoryCredentialStore();
    await oauthCredentials.modify("openai", async () => ({ type: "oauth", access: "offline-oauth-token",
      refresh: "offline-unused-refresh", expires: Date.now() + 86_400_000 }));
    modelRuntime = await ModelRuntime.create({
      credentials: oauthCredentials,
      authPath: join(workspace, "auth.json"), modelsPath: join(workspace, "models.json"),
      modelsStorePath: join(workspace, "catalog.json"), allowModelNetwork: false,
    });
    modelRuntime.registerProvider("openai", {
      api: "openai-responses", baseUrl: "https://api.openai.com/v1",
      models: ["gpt-5.6-luna", "gpt-6.1-sol"].map((id) => ({
        id, name: id, reasoning: true, input: ["text" as const], contextWindow: 32768, maxTokens: 128,
        cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
      })),
    });
    await modelRuntime.refresh({ allowNetwork: false });
    assert.equal(modelRuntime.isUsingOAuth("openai"), true, "stored-OAuth fixture must not retain API-key auth");
    const initialSubscriptionModel = modelRuntime.getModel("openai", "gpt-5.6-luna");
    assert(initialSubscriptionModel);
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: workspace, agentDir: workspace, modelRuntime, model: initialSubscriptionModel, thinkingLevel: "off",
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(workspace), noTools: "all",
    }));
    await session.bindExtensions({ onError: (error) => { errors.push(error.error); } });
    for (const [id, thinking] of [["gpt-5.6-luna", "off"], ["gpt-6.1-sol", "low"]] as const) {
      const subscriptionModel = modelRuntime.getModel("openai", id);
      assert(subscriptionModel);
      await session.setModel(subscriptionModel);
      session.setThinkingLevel(thinking);
      await session.prompt("/warm on");
      await session.prompt(`Synthetic ${id} subscription anchor.`);
      const subscriptionBody = structuredClone(bodies.at(-1));
      assert.equal(subscriptionBody?.max_output_tokens, undefined, "actual subscription adapter omits the real-turn cap");
      const before: number = bodies.length;
      await session.prompt("/warm now");
      assert.equal(bodies.length, before + 1);
      const { max_output_tokens: cap, ...rest } = bodies.at(-1)!;
      assert.equal(cap, 16);
      assert.deepEqual(rest, subscriptionBody, "actual OAuth replay may change only the cap");
      assert(notices.at(-1)?.includes("unverified manual probe hit"), `unexpected subscription notice: ${notices.at(-1)}`);
      mock.timers.tick(60_000);
      await nextTurn();
      assert.equal(bodies.length, before + 1, "subscription manual action must not arm a timer");
      rejectStatus = 500;
      rejectNext = true;
      await session.prompt("/warm now");
      assert.equal(bodies.length, before + 2, "HTTP 500 must not cause a subscription retry");
      assert(notices.at(-1)?.includes("Probe failed"));
      hangNext = true;
      const pending = session.prompt("/warm now");
      await nextTurn();
      await nextTurn();
      const signal = requestSignals.at(-1);
      assert(signal && !signal.aborted);
      mock.timers.tick(44_999);
      assert.equal(signal.aborted, false);
      mock.timers.tick(1);
      await pending;
      assert.equal(signal.aborted, true, "45-second deadline must cancel the actual HTTP request");
      assert(notices.at(-1)?.includes("timed out after 45 seconds"));
      mock.timers.tick(60_000);
      await nextTurn();
      assert.equal(bodies.length, before + 3, "failed or cancelled subscription probes cannot queue follow-ups");
      await session.prompt("/warm off");
    }
    console.log("[check-pi-host] PASS: native off/streaming/idle ownership, off/on handoff, late-handler limitation and actual OAuth capped replay; synthetic only");
  }
  // Keep this synthetic auth fixture after the existing native/stored-OAuth checks.
  modelRuntime.registerProvider("openai", {
    api: "openai-responses", apiKey: "sk-offline-contract-only", baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5.6-luna", "gpt-6.1-sol"].map((id) => ({
      id, name: id, reasoning: true, input: ["text" as const], contextWindow: 32768, maxTokens: 128,
      cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
    })),
  });
  await modelRuntime.refresh({ allowNetwork: false });
  // Both hosts: synthetic OAuth classification, real complete()/Responses adapter,
  // and assertions on the final intercepted HTTP body, not request options.
  assert(hostApi && hostContext);
  const oauthProfile = mock.method(hostContext.modelRegistry, "isUsingOAuth", () => true);
  try {
    for (const [id, thinking] of [["gpt-5.6-luna", "off"], ["gpt-6.1-sol", "low"]] as const) {
      const selected = modelRuntime.getModel("openai", id);
      assert(selected);
      const ctx: ExtensionContext = { ...hostContext, model: selected, thinkingLevel: thinking, hasUI: false };
      const anchor: PayloadObject = { model: id, store: false, stream: true,
        instructions: "Preserve these synthetic instructions exactly.",
        input: [{ role: "user", content: [{ type: "input_text", text: "Synthetic instructions regression." }] }],
        prompt_cache_key: "offline-instructions-key" };
      if (thinking === "low") anchor.reasoning = { effort: "low" };
      const warmer = new SessionWarmer(hostApi);
      try {
        warmer.bindContext(ctx);
        warmer.capturePayload(anchor, ctx);
        assert.equal(warmer.getCapability().manualProbe, true, "instructions payload must remain eligible");
        const before: number = bodies.length;
        assert.equal((await warmer.warmNow(ctx)).ok, true);
        assert.equal(bodies.length, before + 1, "one accepted subscription action sends one HTTP request");
        const { max_output_tokens: cap, ...rest } = bodies.at(-1)!;
        assert.equal(cap, 16, `${id} instructions must not remove the final HTTP output cap`);
        assert.deepEqual(rest, anchor, "subscription HTTP replay preserves every other captured field");
      } finally { warmer.dispose(); }
    }
  } finally { oauthProfile.mock.restore(); }
  console.log("[check-pi-host] PASS: Luna/off and Sol/low instructions replay keeps exact sixteen-token HTTP cap; synthetic OAuth classification");
  assert.deepEqual(errors, [], "host handlers must not report extension errors");
  console.log("[check-pi-host] PASS: load/reload, active-timer cleanup, capture, settle, exact replay, cap, usage, failure, compaction/tree/replacement invalidation; offline only");
} finally {
  try {
    await session?.prompt("/warm off");
  } finally {
    session?.dispose();
    mock.restoreAll();
    mock.timers.reset();
    await rm(workspace, { recursive: true, force: true });
  }
  // Keep the network guard installed until this standalone check exits.
}
