/**
 * Model discovery + interactive selection.
 *
 * The picker is deliberately dependency-free and works on any terminal:
 * you type a keyword to filter the OpenRouter catalog, then pick a number.
 */
import { createInterface } from "node:readline";

export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api";
const PAGE_SIZE = 15;

/** Fetch the OpenRouter model catalog with one key. Throws on failure. */
export async function fetchModelList(
  apiKey: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<OpenRouterModel[]> {
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models responded ${res.status} (key rejected?): ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: unknown[] };
  return (json.data ?? [])
    .map((m) => {
      const o = m as Record<string, unknown>;
      return {
        id: typeof o.id === "string" ? o.id : "",
        name: typeof o.name === "string" ? o.name : undefined,
        context_length: typeof o.context_length === "number" ? o.context_length : undefined,
        pricing:
          o.pricing && typeof o.pricing === "object"
            ? {
                prompt: (o.pricing as { prompt?: string | number }).prompt,
                completion: (o.pricing as { completion?: string | number }).completion,
              }
            : undefined,
      };
    })
    .filter((m) => m.id.length > 0);
}

/** Try each key in order until one can fetch the catalog. */
export async function fetchModelListWithKeys(
  keys: string[],
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<OpenRouterModel[]> {
  let lastError: unknown = new Error("No OpenRouter keys configured");
  for (const key of keys) {
    try {
      return await fetchModelList(key, baseUrl);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function filterModels(models: OpenRouterModel[], query: string): OpenRouterModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => `${m.id} ${m.name ?? ""}`.toLowerCase().includes(q));
}

const NON_CHAT_MODEL_KEYWORDS = [
  "lyria",
  "whisper",
  "dall-e",
  "stable-diffusion",
  "embed",
  "tts",
  "stt",
  "audio",
  "video",
  "flux",
  "midjourney",
];

/** A model is free when OpenRouter marks it `:free` or prices it at $0 (excluding non-chat models). */
export function isFreeModel(m: OpenRouterModel): boolean {
  const idLower = m.id.toLowerCase();
  if (NON_CHAT_MODEL_KEYWORDS.some((kw) => idLower.includes(kw))) {
    return false;
  }
  if (m.id.endsWith(":free")) return true;
  const p = m.pricing;
  return !!p && Number(p.prompt) === 0 && Number(p.completion) === 0;
}

/** Stable order for the picker / fallbacks: anthropic free models first, then the rest. */
export function pickerOrder(models: OpenRouterModel[]): OpenRouterModel[] {
  return [...models].sort((a, b) => {
    const aIsAnthropic = a.id.startsWith("anthropic/") ? 0 : 1;
    const bIsAnthropic = b.id.startsWith("anthropic/") ? 0 : 1;
    return aIsAnthropic - bIsAnthropic || a.id.localeCompare(b.id);
  });
}

/**
 * Decide which model a request actually hits.
 *
 *  - A requested model already in the free list passes through unchanged.
 *  - Otherwise a configured defaultModel (if set) is used.
 *  - Otherwise Claude Code's built-in class names (claude-sonnet-*, …) are
 *    mapped to the best matching free model; anything else falls back to the
 *    first free model.
 */
export function resolveFreeModel(
  requested: string | null,
  freeIds: string[],
  defaultModel: string | null,
): string | null {
  if (freeIds.length === 0) return null;
  if (!requested) return defaultModel ?? freeIds[0];
  if (freeIds.includes(requested)) return requested;
  if (defaultModel) return defaultModel;

  const lower = requested.toLowerCase();
  const klass = lower.includes("haiku") ? /haiku/ : lower.includes("sonnet") ? /sonnet/ : lower.includes("opus") ? /opus/ : null;
  if (klass) {
    const match = freeIds.find((id) => klass.test(id));
    if (match) return match;
  }
  return freeIds[0];
}

/**
 * Claude Code only surfaces gateway models whose id matches /(claude|anthropic)/i
 * — the regex is hardcoded in its bundled source (verified against 2.1.229).
 * Today no OpenRouter free model matches, so every free model would be dropped
 * from /model. We therefore advertise non-Claude models under a reversible
 * "gateway id" that passes the filter and decode it back to the real OpenRouter
 * id when the request arrives.
 */
export const GATEWAY_ID_PREFIX = "anthropic/claude-route-";

/** True when Claude Code's picker filter would drop this model id. */
export function needsGatewayId(id: string): boolean {
  return !/(claude|anthropic)/i.test(id);
}

/** Id advertised to Claude Code: the real id when it passes the filter, else an alias. */
export function gatewayIdFor(id: string): string {
  if (!needsGatewayId(id)) return id;
  return GATEWAY_ID_PREFIX + Buffer.from(id, "utf8").toString("base64url");
}

/** Decode a gateway alias back to the real OpenRouter model id (identity otherwise). */
export function realIdForGateway(id: string): string {
  if (!id.startsWith(GATEWAY_ID_PREFIX)) return id;
  // Buffer's base64url decoding is lenient; an empty payload yields "" and any
  // non-alias id falls through as-is.
  const decoded = Buffer.from(id.slice(GATEWAY_ID_PREFIX.length), "base64url").toString("utf8");
  return decoded.length > 0 ? decoded : id;
}

/**
 * Ordered model candidates for a request: the resolved model first, then the
 * default override, then the remaining free models (deduped, bounded). When the
 * picked model is rate-limited (429) or unavailable (404) at the upstream, the
 * router retries the same request with the next candidate so sessions keep
 * working instead of dying on a dead or throttled free model.
 */
export function fallbackModelCandidates(
  resolved: string,
  freeIds: string[],
  defaultModel: string | null,
  limit = 5,
): string[] {
  const out: string[] = [];
  const push = (id: string | null | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  push(resolved);
  push(defaultModel);
  for (const id of freeIds) push(id);
  return out.slice(0, limit);
}

export function formatModelLine(m: OpenRouterModel): string {
  let line = m.id;
  if (m.name && m.name !== m.id) line += `  ·  ${m.name}`;
  if (m.context_length) line += `  ·  ${Math.round(m.context_length / 1000)}K ctx`;
  const p = m.pricing;
  if (p && (p.prompt !== undefined || p.completion !== undefined)) {
    const fmt = (v: string | number | undefined) => (v === undefined ? "?" : `$${Number(v).toFixed(4).replace(/\.?0+$/, "")}`);
    line += `  ·  ${fmt(p.prompt)}/${fmt(p.completion)} per M`;
  }
  return line;
}

/**
 * Deterministic line reader. A single persistent 'line' listener buffers every
 * input line in order, so successive reads never race with stream close.
 * Resolves undefined when the stream closes without another line (EOF).
 */
function makeLineReader(rl: ReturnType<typeof createInterface>) {
  const queue: string[] = [];
  let waiter: ((v: string | undefined) => void) | null = null;
  rl.on("line", (line: string) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(undefined);
    }
  });
  return (): Promise<string | undefined> =>
    new Promise((resolve) => {
      if (queue.length > 0) resolve(queue.shift());
      else waiter = resolve;
    });
}

/**
 * Interactive searchable picker. Returns the selected model, or null if cancelled.
 * Works with piped stdin too (e.g. echo "1" | bun index.ts --select-model).
 *
 * Pass `nextLine` when the caller already owns the stdin readline (e.g. the live
 * REPL's `model` command) so only one interface ever reads from stdin.
 */
export async function pickModelInteractive(
  models: OpenRouterModel[],
  opts: { title?: string; nextLine?: () => Promise<string | undefined> } = {},
): Promise<OpenRouterModel | null> {
  let rl: ReturnType<typeof createInterface> | null = null;
  let nextLine = opts.nextLine;
  if (!nextLine) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    nextLine = makeLineReader(rl);
  }
  let query = "";
  let page = 0;
  let hint: string | null = null;

  const list = () => (query.trim() ? filterModels(models, query) : models);

  const show = () => {
    const matches = list();
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    if (page >= pages) page = pages - 1;
    const slice = matches.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

    console.log("");
    console.log(opts.title ?? "  OpenRouter model selector");
    console.log("  ─────────────────────────────────────────────────────────────");
    if (query.trim()) console.log(`  ${matches.length} match${matches.length === 1 ? "" : "es"} for "${query}"`);
    else console.log(`  ${matches.length} model${matches.length === 1 ? "" : "s"} · page ${page + 1}/${pages}`);
    if (hint) {
      console.log(`  ⚠ ${hint}`);
      hint = null;
    }
    slice.forEach((m, i) => console.log(`  ${String(page * PAGE_SIZE + i + 1).padStart(3)}) ${formatModelLine(m)}`));
    console.log("");
  };

  show();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const prompt = query.trim() ? `  filter "${query}" · # select · more · q> ` : `  search> `;
      process.stdout.write(prompt);
      const raw = await nextLine();
      if (raw === undefined) {
        console.log("\n  Selection cancelled — keeping the current default.\n");
        return null;
      }
      const input = raw.trim();
      const matches = list();
      const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));

      if (input === "") {
        if (page + 1 < pages) {
          page++;
        } else if (!query.trim()) {
          hint = "type a keyword (e.g. claude, sonnet, kimi, deepseek) to narrow the list";
        } else {
          page = 0;
        }
        show();
        continue;
      }

      const low = input.toLowerCase();
      if (low === "q" || low === "quit" || low === "exit" || low === "cancel") {
        console.log("\n  Selection cancelled — keeping the current default.\n");
        return null;
      }
      if (low === "more" || low === "n" || low === "next") {
        if (page + 1 < pages) page++;
        else hint = "no more pages";
        show();
        continue;
      }
      if (/^\d+$/.test(input)) {
        const idx = parseInt(input, 10) - 1;
        if (idx >= 0 && idx < matches.length) {
          const picked = matches[idx];
          console.log(`\n  ✓ Default model set to: ${picked.id}\n`);
          return picked;
        }
        hint = `pick a number between 1 and ${matches.length}`;
        show();
        continue;
      }

      query = input;
      page = 0;
      show();
    }
  } finally {
    rl?.close();
  }
}
