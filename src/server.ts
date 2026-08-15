/**
 * The local gateway Claude Code talks to.
 *
 *   Claude Code ──(Anthropic Messages API)──▶ local router :8080
 *   local router ──(rewritten model + pool key)──▶ OpenRouter /api/v1/messages
 *
 * Every request has its `model` field forced to the configured default, so all
 * traffic uses exactly one model. If the upstream fails (429 / 5xx / network
 * error) the router rotates to the next healthy OpenRouter key.
 */
import type { KeyPool } from "./keys";
import { fallbackModelCandidates, gatewayIdFor, realIdForGateway, type OpenRouterModel } from "./models";
import { globalTelemetry } from "./telemetry";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT, loadSettings, saveSettings, loadSystem, saveSystem } from "./config";

export interface RouterDeps {
  port: number;
  /** Decide which model a request hits (free-list pass-through + fallbacks). */
  resolveModel: (requested: string | null) => string | null;
  /** Optional forced default model (display only in /health and the banner). */
  getDefaultModel: () => string | null;
  keyPool: KeyPool;
  /** The model catalog advertised to Claude Code (free models only). */
  getModels: () => OpenRouterModel[];
  openrouterBaseUrl: string;
  /** How many keys to try per request. 0 = try every key. */
  maxRetries: number;
  roundRobin: boolean;
  log?: (msg: string) => void;
}

const JSON_HEADERS = { "content-type": "application/json" };

/** Headers we must not copy from the upstream response (Bun already decoded the body). */
const STRIPPED_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "content-length",
  "proxy-authenticate",
  "proxy-authorization",
]);

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: JSON_HEADERS },
  );
}

/**
 * Anthropic-only tool shapes that other models reject (400 "Deferred custom
 * tools are only supported on Anthropic models"). Claude Code can send:
 *
 *   - `defer_to_client: true` on custom tools (deferred custom commands) — we
 *     strip the flag so they act as ordinary callable tools; removing them
 *     entirely would break the commands, at the cost of keeping them in context.
 *   - Anthropic server tools (`type: "web_search_20250305"`, `code_execution`,
 *     …) — no other provider understands them, so they are dropped outright.
 *
 * Anthropic models are passed through untouched.
 */
export function sanitizeToolsForModel(
  payload: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (model.startsWith("anthropic/")) return payload;
  const tools = payload.tools;
  if (!Array.isArray(tools)) return payload;
  let changed = false;
  const cleaned: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      cleaned.push(tool);
      continue;
    }
    const o = tool as Record<string, unknown>;
    if (typeof o.type === "string" && o.type !== "custom") {
      // Anthropic server tool (web_search, code_execution, …) — drop it.
      changed = true;
      continue;
    }
    if ("defer_to_client" in o) {
      changed = true;
      const { defer_to_client: _drop, ...rest } = o;
      cleaned.push(rest);
      continue;
    }
    cleaned.push(tool);
  }
  return changed ? { ...payload, tools: cleaned } : payload;
}

export function createRouterServer(deps: RouterDeps) {
  const log = deps.log ?? ((msg: string) => console.log(`  [router] ${msg}`));
  const startedAt = Date.now();
  let requestId = 0;

  async function handleMessages(req: Request, isCountTokens: boolean): Promise<Response> {
    const id = ++requestId;

    // Only JSON parsing is a 400; everything downstream has its own error handling.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, "invalid_request_error", "Request body must be valid JSON.");
    }

    const payload = body as Record<string, unknown>;
    const requested = typeof payload.model === "string" ? payload.model : null;
    // Claude Code picks gateway models by their advertised alias — decode it to
    // the real OpenRouter id before resolving so the request routes correctly.
    const realRequested = requested ? realIdForGateway(requested) : requested;
    const resolved = deps.resolveModel(realRequested);
    if (!resolved) {
      return errorResponse(500, "api_error", "No free OpenRouter models are available — the router cannot route requests.");
    }

    const path = isCountTokens ? "/v1/messages/count_tokens" : "/v1/messages";
    // AbortSignal guards against hung connections so the request can rotate keys.
    const timeoutMs = isCountTokens ? 30_000 : 300_000;
    const upstreamHeaders: Record<string, string> = {
      "content-type": "application/json",
      authorization: "",
      // OpenRouter attribution (recommended, especially for the free tier).
      "HTTP-Referer": `http://127.0.0.1:${deps.port}`,
      "X-Title": "RouteCode",
    };
    const anthropicVersion = req.headers.get("anthropic-version");
    const anthropicBeta = req.headers.get("anthropic-beta");
    if (anthropicVersion) upstreamHeaders["anthropic-version"] = anthropicVersion;
    if (anthropicBeta) upstreamHeaders["anthropic-beta"] = anthropicBeta;

    // Model-level failover: a 404 (dead/unsupported model) or 429 (free-tier
    // rate limit) means this model can't serve the request, so the router retries
    // with the next candidate free model (resolved → default → first free).
    const candidates = fallbackModelCandidates(
      resolved,
      deps.getModels().map((m) => m.id),
      deps.getDefaultModel(),
    );
    const allKeyCandidates = deps.keyPool.pickOrder();
    if (allKeyCandidates.length === 0) {
      return errorResponse(500, "api_error", "No OpenRouter keys configured.");
    }

    let lastStatus = 502;
    let lastBody = JSON.stringify({
      error: { type: "api_error", message: "All OpenRouter keys failed." },
    });
    let triedFallback = false;

    for (let ci = 0; ci < candidates.length; ci++) {
      const candidate = candidates[ci];

      // Pick keys for this attempt (prefer healthy keys)
      const activeCandidates = deps.keyPool.pickOrder();
      const healthyAttempts = activeCandidates.filter((k) => deps.keyPool.isHealthy(k));
      const attempts = healthyAttempts.length > 0 ? healthyAttempts : activeCandidates;
      const effectiveAttempts = deps.maxRetries > 0 ? attempts.slice(0, deps.maxRetries) : attempts;

      // Pass through when the client already picked this model; otherwise rewrite.
      const rewritten = requested !== null && requested === candidate ? payload : { ...payload, model: candidate };
      if (rewritten !== payload) {
        log(`${id} ~ model "${requested}" → ${candidate}`);
      }
      // Deferred custom tools + server tools are Anthropic-only — sanitize for others.
      const forwarded = sanitizeToolsForModel(rewritten, candidate);
      if (forwarded !== rewritten) {
        log(`${id} ~ sanitized Anthropic-only tool flags (non-Anthropic model ${candidate})`);
      }

      for (const key of effectiveAttempts) {
        const started = Date.now();
        try {
          upstreamHeaders.authorization = `Bearer ${key.key}`;
          const upstream = await fetch(`${deps.openrouterBaseUrl}${path}`, {
            method: "POST",
            headers: upstreamHeaders,
            body: JSON.stringify(forwarded),
            signal: AbortSignal.timeout(timeoutMs),
          });

          const duration = Date.now() - started;
          deps.keyPool.recordRateLimit(key, upstream.headers);

          if (upstream.ok) {
            deps.keyPool.recordSuccess(key, duration);
            globalTelemetry.recordRequest({
              id,
              timestamp: new Date().toISOString(),
              requestedModel: requested,
              resolvedModel: candidate,
              keyLabel: key.label,
              status: upstream.status,
              latencyMs: duration,
              retried: triedFallback || key !== effectiveAttempts[0],
            });
            const headers = new Headers();
            for (const [h, v] of upstream.headers) {
              if (STRIPPED_HEADERS.has(h)) continue;
              headers.set(h, v);
            }
            log(`${id} → ${key.label}: ${upstream.status} in ${duration}ms ✓`);
            return new Response(upstream.body, { status: upstream.status, headers });
          }

          const errText = await upstream.text();
          deps.keyPool.recordFailure(key);
          lastStatus = upstream.status;
          lastBody = errText || JSON.stringify({ error: { type: "api_error", message: `Upstream ${upstream.status}` } });
          globalTelemetry.recordRequest({
            id,
            timestamp: new Date().toISOString(),
            requestedModel: requested,
            resolvedModel: candidate,
            keyLabel: key.label,
            status: upstream.status,
            latencyMs: Date.now() - started,
            error: `Upstream ${upstream.status}`,
            retried: true,
          });
          log(`${id} ✗ ${key.label}: ${upstream.status} — rotating to next key`);
        } catch (err) {
          deps.keyPool.recordFailure(key);
          lastStatus = 502;
          const reason =
            err instanceof Error && err.name === "TimeoutError"
              ? `upstream timed out after ${Math.round(timeoutMs / 1000)}s`
              : `upstream connection error: ${err instanceof Error ? err.message : String(err)}`;
          lastBody = JSON.stringify({ error: { type: "api_error", message: reason } });
          globalTelemetry.recordRequest({
            id,
            timestamp: new Date().toISOString(),
            requestedModel: requested,
            resolvedModel: candidate,
            keyLabel: key.label,
            status: 502,
            latencyMs: Date.now() - started,
            error: reason,
            retried: true,
          });
          log(`${id} ✗ ${key.label}: ${reason} — rotating to next key`);
        }
      }

      // Only model-level failures (404/429) switch models — key-level errors
      // (5xx, network, auth) are returned as-is.
      if ((lastStatus === 404 || lastStatus === 429) && ci < candidates.length - 1) {
        triedFallback = true;
        log(`${id} ~ model "${candidate}" failed (${lastStatus}) → falling back to "${candidates[ci + 1]}"`);
        continue;
      }
      break;
    }

    log(`${id} ✗ all ${candidates.length} model(s) failed (last: ${lastStatus})`);
    return new Response(lastBody, {
      status: lastStatus,
      headers: { "content-type": "application/json" },
    });
  }

  function handleModels(): Response {
    const models = deps.getModels();
    // Claude Code's picker only keeps ids matching /(claude|anthropic)/i, so
    // non-Claude free models are advertised under a gateway alias
    // (anthropic/claude-route-<base64url>) that the router decodes on requests.
    const advertised = models.map((m) => ({
      id: gatewayIdFor(m.id),
      type: "model",
      display_name: m.name ?? m.id,
      // Show the real OpenRouter id under the name so the picker stays honest.
      description: m.id,
      created_at: "2025-01-01T00:00:00Z",
    }));
    const ids = advertised.map((m) => m.id);
    return Response.json({
      data: advertised,
      has_more: false,
      first_id: ids[0] ?? null,
      last_id: ids[ids.length - 1] ?? null,
    });
  }

  function getHealthData() {
    const keys = deps.keyPool.list().map((k) => ({
      label: k.label,
      healthy: Date.now() >= k.cooldownUntil,
      cooldownSecondsLeft: Math.max(0, Math.ceil((k.cooldownUntil - Date.now()) / 1000)),
      consecutiveFailures: k.consecutiveFailures,
      successes: k.successes,
      failures: k.failures,
      rateLimitLimit: k.rateLimitLimit,
      rateLimitRemaining: k.rateLimitRemaining,
      rateLimitResetSecondsLeft: k.rateLimitResetMs ? Math.max(0, Math.ceil((k.rateLimitResetMs - Date.now()) / 1000)) : 0,
      predictiveScore: k.predictiveScore,
      isFreeTier: k.isFreeTier,
      limitRemaining: k.limitRemaining,
      usageDaily: k.usageDaily,
      dailyReqLimit: k.dailyReqLimit,
    }));
    return {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      port: deps.port,
      defaultModel: deps.getDefaultModel(),
      freeModels: deps.getModels().length,
      keyCount: deps.keyPool.size,
      keys,
      routing: {
        roundRobin: deps.roundRobin,
        maxRetries: deps.maxRetries === 0 ? "all" : deps.maxRetries,
      },
    };
  }

  function handleHealth(): Response {
    return Response.json(getHealthData());
  }

  function handleDashboard(): Response {
    try {
      const htmlPath = resolve(PROJECT_ROOT, "src", "dashboard.html");
      const html = readFileSync(htmlPath, "utf8");
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch {
      return errorResponse(500, "api_error", "Could not load dashboard template.");
    }
  }

  function handleStats(): Response {
    return Response.json({
      health: getHealthData(),
      logs: globalTelemetry.getLogs(),
      latencyHistory: globalTelemetry.getLatencyHistory(),
      modelStats: globalTelemetry.getModelStats(),
    });
  }

  function handleGetKeys(): Response {
    const s = loadSettings();
    const poolList = deps.keyPool.list();
    const result = s.openrouterKeys.map((rawKey, i) => {
      const state = poolList.find((k) => k.key === rawKey);
      return {
        key: rawKey,
        label: state ? state.label : `key#${i + 1} (…${rawKey.slice(-4)})`,
        healthy: state ? Date.now() >= state.cooldownUntil : true,
        cooldownSecondsLeft: state ? Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000)) : 0,
        successes: state ? state.successes : 0,
        failures: state ? state.failures : 0,
        rateLimitLimit: state?.rateLimitLimit,
        rateLimitRemaining: state?.rateLimitRemaining,
        rateLimitResetSecondsLeft: state?.rateLimitResetMs ? Math.max(0, Math.ceil((state.rateLimitResetMs - Date.now()) / 1000)) : 0,
        predictiveScore: state?.predictiveScore ?? 100,
        isFreeTier: state?.isFreeTier,
        limitRemaining: state?.limitRemaining,
        usageDaily: state?.usageDaily,
        dailyReqLimit: state?.dailyReqLimit,
      };
    });
    return Response.json({ keys: result });
  }

  async function handleAddKey(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { key?: string };
      const rawKey = body?.key?.trim();
      if (!rawKey) {
        return errorResponse(400, "invalid_request", "Key string is required.");
      }
      const s = loadSettings();
      if (!s.openrouterKeys.includes(rawKey)) {
        s.openrouterKeys.push(rawKey);
        saveSettings(s);
        deps.keyPool.updateKeys(s.openrouterKeys);
        log(`Added new API key (…${rawKey.slice(-4)}) to pool`);
      }
      return handleGetKeys();
    } catch {
      return errorResponse(400, "invalid_request", "Invalid JSON payload.");
    }
  }

  async function handleDeleteKey(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { key?: string };
      const rawKey = body?.key?.trim();
      if (!rawKey) {
        return errorResponse(400, "invalid_request", "Key string is required.");
      }
      const s = loadSettings();
      const updated = s.openrouterKeys.filter((k) => k !== rawKey);
      if (updated.length === s.openrouterKeys.length) {
        return errorResponse(404, "not_found", "Key not found in pool.");
      }
      s.openrouterKeys = updated;
      saveSettings(s);
      deps.keyPool.updateKeys(s.openrouterKeys);
      log(`Removed API key (…${rawKey.slice(-4)}) from pool`);
      return handleGetKeys();
    } catch {
      return errorResponse(400, "invalid_request", "Invalid JSON payload.");
    }
  }

  function handleGetConfig(): Response {
    const sys = loadSystem();
    return Response.json({
      defaultModel: sys.defaultModel,
      roundRobin: sys.roundRobin,
      maxRetries: sys.failover.maxRetries,
      port: sys.port,
      models: deps.getModels().map((m) => ({ id: m.id, name: m.name ?? m.id })),
    });
  }

  async function handleUpdateConfig(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { defaultModel?: string | null; roundRobin?: boolean };
      const sys = loadSystem();
      if ("defaultModel" in body) {
        sys.defaultModel = body.defaultModel ? body.defaultModel.trim() || null : null;
        log(`Default model override updated to: ${sys.defaultModel ?? "auto"}`);
      }
      if (typeof body.roundRobin === "boolean") {
        sys.roundRobin = body.roundRobin;
        deps.roundRobin = body.roundRobin;
        log(`Routing strategy updated to: ${sys.roundRobin ? "Round-Robin" : "Predictive Score"}`);
      }
      saveSystem(sys);
      return handleGetConfig();
    } catch {
      return errorResponse(400, "invalid_request", "Invalid JSON payload.");
    }
  }

  function handleIndex(): Response {
    const model = deps.getDefaultModel();
    return new Response(
      [
        "RouteCode — Claude Code × OpenRouter Failover Gateway",
        "",
        `  Free models   : ${deps.getModels().length} (listed in Claude Code's /model picker)`,
        `  Default model : ${model ?? "(auto — Claude Code picks from the free list)"}`,
        `  Keys in pool  : ${deps.keyPool.size}`,
        `  Endpoints     : POST /v1/messages · POST /v1/messages/count_tokens · GET /v1/models · GET /health · GET /dashboard`,
        "",
        `  Web Dashboard : http://localhost:${deps.port}/dashboard`,
        "",
        "Point Claude Code at this server:",
        `  export ANTHROPIC_BASE_URL="http://127.0.0.1:${deps.port}"`,
        '  export ANTHROPIC_AUTH_TOKEN="router"   # any value — the router manages the real keys',
        '  export ANTHROPIC_API_KEY=""',
        "",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path === "/v1/messages") return handleMessages(req, false);
    if (req.method === "POST" && path === "/v1/messages/count_tokens") return handleMessages(req, true);
    if (req.method === "GET" && path === "/v1/models") return handleModels();
    if (req.method === "GET" && path === "/health") return handleHealth();
    if (req.method === "GET" && path === "/dashboard") return handleDashboard();
    if (req.method === "GET" && path === "/api/stats") return handleStats();
    if (req.method === "GET" && path === "/api/config") return handleGetConfig();
    if (req.method === "POST" && path === "/api/config") return handleUpdateConfig(req);
    if (req.method === "GET" && path === "/api/keys") return handleGetKeys();
    if (req.method === "POST" && path === "/api/keys") return handleAddKey(req);
    if (req.method === "DELETE" && path === "/api/keys") return handleDeleteKey(req);
    if (req.method === "GET" && (path === "/" || path === "")) return handleIndex();

    return errorResponse(404, "not_found", `Not found: ${req.method} ${path}`);
  }

  const server = Bun.serve({
    port: deps.port,
    idleTimeout: 0,
    fetch: handler,
  });

  return { server, url: server.url, ready: (server as unknown as { ready?: Promise<void> }).ready ?? Promise.resolve() };
}

export type RouterHandle = ReturnType<typeof createRouterServer>;
