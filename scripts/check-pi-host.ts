// Offline contract check against the installed Pi host and its real Responses adapter.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { payloadObject, type PayloadObject } from "../src/capability.ts";

const workspace = await mkdtemp(join(tmpdir(), "warm-host-contract-"));
const bodies: PayloadObject[] = [];
const captured: PayloadObject[] = [];
const errors: string[] = [];
const notices: string[] = [];
let rejectNext = false;
let settled = 0;
let started = 0;
let shutdown = 0;
let session: AgentSession | undefined;

// No outbound fallback: even an unexpected request fails locally.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  assert.equal(url, "https://api.openai.com/v1/responses");
  const request = input instanceof Request ? input : new Request(input, init);
  const body = payloadObject(JSON.parse(await request.text()));
  assert(body, "serialized request must be an object");
  bodies.push(body);
  if (rejectNext) {
    rejectNext = false;
    return new Response(JSON.stringify({ error: { message: "synthetic rejection" } }), {
      status: 400,
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
  const modelRuntime = await ModelRuntime.create({
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
      pi.on("before_provider_request", (event) => {
        const payload = payloadObject(JSON.parse(JSON.stringify(event.payload)));
        assert(payload);
        captured.push(payload);
      });
      pi.on("agent_settled", () => { settled++; });
      pi.on("session_start", (_event, ctx) => {
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
  assert.deepEqual(errors, [], "host handlers must not report extension errors");
  console.log("[check-pi-host] PASS: load/reload, active-timer cleanup, capture, settle, exact replay, cap, usage, failure, invalidation; offline only; native warmer disabled");
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
