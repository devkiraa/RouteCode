/**
 * Integration tests: spins up a mock OpenRouter (in-process) and the real
 * router, then verifies model rewriting, failover and the helper endpoints.
 *
 *   bun test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { KeyPool } from "../src/keys";
import { createRouterServer, sanitizeToolsForModel } from "../src/server";
import { gatewayIdFor, resolveFreeModel, type OpenRouterModel } from "../src/models";
import { loadSettings, saveSettings } from "../src/config";

const MOCK_MODELS: OpenRouterModel[] = [
  { id: "test/model-one:free", name: "Test Model One", context_length: 100_000, pricing: { prompt: "0", completion: "0" } },
  { id: "test/model-two:free", name: "Test Model Two", context_length: 50_000, pricing: { prompt: "0", completion: "0" } },
  { id: "cohere/north-mini-code-20260617:free", name: "Cohere North Mini Code", pricing: { prompt: "0", completion: "0" } },
];
const FREE_IDS = MOCK_MODELS.map((m) => m.id);
const resolve = (requested: string | null) => resolveFreeModel(requested, FREE_IDS, "test/model-one:free");

let mock: ReturnType<typeof Bun.serve>;
let router: ReturnType<typeof createRouterServer>;
let routerUrl: string;
let lastUpstream: { auth: string; body: { model: string } } | null = null;
// Models the mock OpenRouter refuses with a given status (model-level failures).
let modelFailures: Record<string, number> = {};
let receivedModels: string[] = [];

const MESSAGES_BODY = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
});

function mockSseBody(model: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

let testKeyPool: KeyPool;
let initialSettings: ReturnType<typeof loadSettings>;

beforeAll(async () => {
  initialSettings = loadSettings();
  saveSettings({ openrouterKeys: ["sk-or-v1-bad", "sk-or-v1-good"] });
  testKeyPool = new KeyPool(["sk-or-v1-bad", "sk-or-v1-good"], { roundRobin: false });

  mock = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";

      if (req.method === "GET" && url.pathname === "/api/v1/models") {
        return Response.json({ data: MOCK_MODELS });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/messages") {
        return req.text().then((text) => {
          lastUpstream = { auth, body: JSON.parse(text) };
          receivedModels.push(lastUpstream.body.model);
          const refused = modelFailures[lastUpstream.body.model];
          if (refused) {
            return Response.json({ error: { type: "api_error", message: `mock refuses ${lastUpstream.body.model}` } }, { status: refused });
          }
          if (auth.includes("sk-or-v1-bad")) {
            return Response.json({ error: { type: "rate_limit_error", message: "rate limited (mock)" } }, { status: 429 });
          }
          return new Response(mockSseBody(lastUpstream.body.model), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/key") {
        return Response.json({
          data: {
            label: "Test Key",
            limit: null,
            limit_remaining: auth.includes("sk-or-v1-bad") ? 0 : 100,
            is_free_tier: !auth.includes("sk-or-v1-good"),
            usage_daily: 0.05,
            usage_monthly: 1.25,
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/messages/count_tokens") {
        return req.text().then((text) => {
          lastUpstream = { auth, body: JSON.parse(text) };
          return Response.json({ input_tokens: 7, output_tokens: 0 });
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  router = createRouterServer({
    port: 0,
    resolveModel: resolve,
    getDefaultModel: () => "test/model-one:free",
    keyPool: testKeyPool,
    getModels: () => MOCK_MODELS,
    openrouterBaseUrl: `http://127.0.0.1:${mock.port}/api`,
    maxRetries: 0,
    roundRobin: false,
    log: () => {},
  });
  await router.ready;
  routerUrl = `http://127.0.0.1:${router.server.port}`;
});

afterAll(() => {
  saveSettings(initialSettings);
  router.server.stop(true);
  mock.stop(true);
});

describe("gateway endpoints", () => {
  test("GET / returns banner", async () => {
    const res = await fetch(`${routerUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("RouteCode");
  });

  test("GET /health reports model and key pool", async () => {
    const res = await fetch(`${routerUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.defaultModel).toBe("test/model-one:free");
    expect(body.freeModels).toBe(3);
    expect(body.keyCount).toBe(2);
    expect(body.keys.length).toBe(2);
  });

  test("GET /dashboard serves dashboard HTML page", async () => {
    const res = await fetch(`${routerUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("RouteCode");
  });

  test("GET /api/stats returns telemetry stats JSON", async () => {
    const res = await fetch(`${routerUrl}/api/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.health).toBeDefined();
    expect(body.logs).toBeDefined();
    expect(body.latencyHistory).toBeDefined();
    expect(body.modelStats).toBeDefined();
  });

  test("GET and POST /api/config allows updating default model and strategy", async () => {
    const resGet = await fetch(`${routerUrl}/api/config`);
    expect(resGet.status).toBe(200);
    const getBody = await resGet.json();
    expect(getBody.models).toBeDefined();

    const resPost = await fetch(`${routerUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: "test/model-two:free", roundRobin: true }),
    });
    expect(resPost.status).toBe(200);
    const postBody = await resPost.json();
    expect(postBody.defaultModel).toBe("test/model-two:free");
    expect(postBody.roundRobin).toBe(true);
  });

  test("key management API endpoints (GET, POST, DELETE /api/keys)", async () => {
    // GET initial
    const resGet = await fetch(`${routerUrl}/api/keys`);
    expect(resGet.status).toBe(200);
    const getBody = await resGet.json();
    expect(Array.isArray(getBody.keys)).toBe(true);

    // POST add key
    const testKey = "sk-or-v1-testkey123456789";
    const resAdd = await fetch(`${routerUrl}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: testKey }),
    });
    expect(resAdd.status).toBe(200);
    const addBody = await resAdd.json();
    expect(addBody.keys.some((k: { key: string }) => k.key === testKey)).toBe(true);

    // DELETE remove key
    const resDel = await fetch(`${routerUrl}/api/keys`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: testKey }),
    });
    expect(resDel.status).toBe(200);
    const delBody = await resDel.json();
    expect(delBody.keys.some((k: { key: string }) => k.key === testKey)).toBe(false);
  });

  test("predictive rate limit tracking & key re-ordering", () => {
    const pool = new KeyPool(["sk-key1", "sk-key2"]);
    const keys = pool.pickOrder();
    expect(keys[0].key).toBe("sk-key1");

    // Record exhausted rate limit for key1
    const headers = new Headers({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "20",
      "x-ratelimit-reset": "60",
    });
    pool.recordRateLimit(keys[0], headers);

    // pickOrder should now proactively prefer key2 over key1
    const newOrder = pool.pickOrder();
    expect(newOrder[0].key).toBe("sk-key2");
    expect(pool.list()[0].predictiveScore ?? 0).toBeLessThan(pool.list()[1].predictiveScore ?? 0);
  });

  test("proactive GET /v1/key probing and 402 credit limit scoring", async () => {
    await testKeyPool.probeAllKeys(`http://127.0.0.1:${mock.port}/api`);
    const list = testKeyPool.list();
    expect(list.length).toBe(2);
    expect(list.find((k) => k.key === "sk-or-v1-bad")?.limitRemaining).toBe(0);
    expect(list.find((k) => k.key === "sk-or-v1-good")?.isFreeTier).toBe(false);
    expect(list.find((k) => k.key === "sk-or-v1-bad")?.predictiveScore).toBe(0);
  });

  test("GET /v1/models advertises gateway aliases that pass Claude Code's picker filter", async () => {
    const res = await fetch(`${routerUrl}/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(3);
    // Non-claude ids are advertised under an alias Claude Code's /model keeps.
    expect(body.data[0]).toEqual({
      id: gatewayIdFor("test/model-one:free"),
      type: "model",
      display_name: "Test Model One",
      description: "test/model-one:free",
      created_at: "2025-01-01T00:00:00Z",
    });
    for (const m of body.data) {
      expect(/(claude|anthropic)/i.test(m.id)).toBe(true);
    }
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBe(gatewayIdFor("test/model-one:free"));
    expect(body.last_id).toBe(gatewayIdFor("cohere/north-mini-code-20260617:free"));
  });

  test("unknown route returns 404 JSON", async () => {
    const res = await fetch(`${routerUrl}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.type).toBe("not_found");
  });
});

describe("messages proxy", () => {
  beforeEach(() => {
    modelFailures = {};
    receivedModels = [];
    lastUpstream = null;
    saveSettings({ openrouterKeys: ["sk-or-v1-bad", "sk-or-v1-good"] });
    testKeyPool.updateKeys(["sk-or-v1-bad", "sk-or-v1-good"]);
    testKeyPool.reset();
  });

  test("rewrites model and fails over from a 429 key to a healthy key", async () => {
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");

    // The successful attempt used the healthy key and the resolved fallback model
    // ("claude-sonnet-4-5" is not free → falls back to the configured default).
    expect(lastUpstream).not.toBeNull();
    expect(lastUpstream!.auth).toBe("Bearer sk-or-v1-good");
    expect(lastUpstream!.body.model).toBe("test/model-one:free");

    // The failed key is now in cooldown.
    const health = await (await fetch(`${routerUrl}/health`)).json();
    const bad = health.keys.find((k: { label: string }) => k.label.includes("bad"));
    expect(bad.consecutiveFailures).toBe(1);
    expect(bad.healthy).toBe(false);
  });

  test("sanitizes Anthropic-only tools before forwarding to a non-Anthropic model", async () => {
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cohere/north-mini-code-20260617:free", // free → passes through as-is (non-Anthropic)
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "deploy", description: "d", input_schema: { type: "object" }, defer_to_client: true },
          { type: "web_search_20250305" },
          { name: "plain", description: "p", input_schema: { type: "object" } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const body = lastUpstream!.body as { model: string; tools: Record<string, unknown>[] };
    expect(body.model).toBe("cohere/north-mini-code-20260617:free");
    // defer_to_client stripped, the Anthropic server tool dropped, the plain tool kept.
    expect(body.tools).toEqual([
      { name: "deploy", description: "d", input_schema: { type: "object" } },
      { name: "plain", description: "p", input_schema: { type: "object" } },
    ]);
  });

  test("keeps Anthropic-only tool shapes untouched for Anthropic models", () => {
    const payload = {
      model: "anthropic/claude-3.5-sonnet:free",
      tools: [
        { name: "deploy", input_schema: { type: "object" }, defer_to_client: true },
        { type: "web_search_20250305" },
      ],
    };
    expect(sanitizeToolsForModel(payload, "anthropic/claude-3.5-sonnet:free")).toBe(payload);
  });

  test("returns the payload unchanged when there are no tools or no Anthropic-only flags", () => {
    const noTools = { model: "cohere/x", messages: [] };
    expect(sanitizeToolsForModel(noTools, "cohere/x")).toBe(noTools);
    const clean = {
      model: "cohere/x",
      tools: [{ name: "plain", input_schema: { type: "object" } }],
    };
    expect(sanitizeToolsForModel(clean, "cohere/x")).toBe(clean);
  });

  test("falls back to another free model when the picked model returns 404", async () => {
    modelFailures = { "test/model-two:free": 404 };
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test/model-two:free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // The dead model was tried first, then the request succeeded on the fallback.
    expect(receivedModels[0]).toBe("test/model-two:free");
    expect(lastUpstream!.body.model).toBe("test/model-one:free");
  });

  test("falls back to another free model when the picked model is rate-limited (429)", async () => {
    modelFailures = { "cohere/north-mini-code-20260617:free": 429 };
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cohere/north-mini-code-20260617:free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(receivedModels[0]).toBe("cohere/north-mini-code-20260617:free");
    expect(lastUpstream!.body.model).toBe("test/model-one:free");
  });

  test("returns the model failure when every candidate model fails", async () => {
    modelFailures = {
      "test/model-two:free": 429,
      "test/model-one:free": 429,
      "cohere/north-mini-code-20260617:free": 429,
    };
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test/model-two:free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toContain("mock refuses");
  });

  test("routes a request picked from the gateway alias back to the real model", async () => {
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: gatewayIdFor("cohere/north-mini-code-20260617:free"),
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(lastUpstream!.body.model).toBe("cohere/north-mini-code-20260617:free");
  });

  test("passes through a requested free model unchanged", async () => {
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test/model-two:free",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(lastUpstream!.body.model).toBe("test/model-two:free");
  });

  test("returns the upstream error when every key fails", async () => {
    const doomed = createRouterServer({
      port: 0,
      resolveModel: resolve,
      getDefaultModel: () => "test/model-one:free",
      keyPool: new KeyPool(["sk-or-v1-bad", "sk-or-v1-bad2"], { roundRobin: false }),
      getModels: () => MOCK_MODELS,
      openrouterBaseUrl: `http://127.0.0.1:${mock.port}/api`,
      maxRetries: 0,
      roundRobin: false,
      log: () => {},
    });
    await doomed.ready;
    const res = await fetch(`http://127.0.0.1:${doomed.server.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toContain("rate limited");
    doomed.server.stop(true);
  });

  test("fails over on network errors and reports 502 when every key is unreachable", async () => {
    const doomed = createRouterServer({
      port: 0,
      resolveModel: resolve,
      getDefaultModel: () => "test/model-one:free",
      keyPool: new KeyPool(["sk-or-v1-dead", "sk-or-v1-dead2"], { roundRobin: false }),
      getModels: () => MOCK_MODELS,
      openrouterBaseUrl: "http://127.0.0.1:1/api", // closed port -> connection refused
      maxRetries: 0,
      roundRobin: false,
      log: () => {},
    });
    await doomed.ready;
    const res = await fetch(`http://127.0.0.1:${doomed.server.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain("connection error");
    const health = await (await fetch(`http://127.0.0.1:${doomed.server.port}/health`)).json();
    expect(health.keys.every((k: { failures: number }) => k.failures === 1)).toBe(true);
    doomed.server.stop(true);
  });

  test("count_tokens is proxied with the rewritten model", async () => {
    const res = await fetch(`${routerUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: MESSAGES_BODY,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 7, output_tokens: 0 });
    expect(lastUpstream!.body.model).toBe("test/model-one:free");
  });

  test("invalid JSON body returns 400", async () => {
    const res = await fetch(`${routerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
