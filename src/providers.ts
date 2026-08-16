/**
 * Multi-Provider Registry
 *
 * Configures upstream providers (OpenRouter, ZCode API, OpenCode Public, Custom)
 * with protocol type (anthropic vs openai), base URL, API keys, and model list.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config";

export type ProviderType = "anthropic" | "openai";

export interface ProviderModel {
  id: string;
  name: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  enabled: boolean;
  keys: string[];
  rpmLimit?: number;
  models?: Array<string | ProviderModel>;
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "openrouter",
    name: "OpenRouter (Default)",
    type: "anthropic",
    baseUrl: "https://openrouter.ai/api",
    enabled: true,
    keys: [],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM API (build.nvidia.com)",
    type: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    enabled: false,
    keys: [],
    rpmLimit: 40,
    models: [
      { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct (NVIDIA)" },
      { id: "deepseek-ai/deepseek-r1", name: "DeepSeek R1 (NVIDIA NIM)" },
      { id: "deepseek-ai/deepseek-v3", name: "DeepSeek V3 (NVIDIA NIM)" },
      { id: "mistralai/mistral-large-2411", name: "Mistral Large 2411 (NVIDIA)" },
      { id: "google/gemma-2-27b-it", name: "Gemma 2 27B IT (NVIDIA)" },
      { id: "nvidia/nemotron-4-340b-instruct", name: "Nemotron 4 340B (NVIDIA)" },
      { id: "microsoft/phi-3-mini-128k-instruct", name: "Phi-3 Mini 128k (NVIDIA)" },
      { id: "qwen/qwen2.5-72b-instruct", name: "Qwen 2.5 72B Instruct (NVIDIA)" },
    ],
  },
  {
    id: "zcode",
    name: "ZCode API",
    type: "anthropic",
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    enabled: false,
    keys: [],
    models: [
      { id: "GLM-5.2", name: "GLM-5.2" },
      { id: "GLM-5-Turbo", name: "glm-5-turbo" },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode Public (Chat Completions)",
    type: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    enabled: false,
    keys: [],
    models: [
      { id: "north-mini-code-free", name: "North Mini Code Free" },
      { id: "ling-3.0-flash-free", name: "Ling-3.0-flash Free" },
      { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
      { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free (New)" },
      { id: "mimo-v2.5-free", name: "MiMo V2.5 Free" },
      { id: "big-pickle", name: "Big Pickle" },
      { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
    ],
  },
];

export const PROVIDERS_PATH = resolve(PROJECT_ROOT, "providers.json");

/** Load providers from providers.json or initialize defaults. */
export function loadProviders(): ProviderConfig[] {
  try {
    if (existsSync(PROVIDERS_PATH)) {
      const raw = JSON.parse(readFileSync(PROVIDERS_PATH, "utf8")) as ProviderConfig[];
      if (Array.isArray(raw)) {
        // Merge defaults if any missing & keep default models updated
        for (const def of DEFAULT_PROVIDERS) {
          const idx = raw.findIndex((p) => p.id === def.id);
          if (idx === -1) {
            raw.push({ ...def });
          } else if (def.models && def.models.length > 0) {
            raw[idx].models = def.models;
          }
        }
        return raw;
      }
    }
  } catch {
    /* fallback to defaults */
  }
  return structuredClone(DEFAULT_PROVIDERS);
}

/** Save providers to providers.json. */
export function saveProviders(providers: ProviderConfig[]): void {
  writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2) + "\n");
}

export interface ProviderModelInfo {
  id: string;
  name?: string;
  providerId: string;
  providerName: string;
}

/** Get model definitions from all enabled providers with provider prefix (providerId/modelId). */
export function getEnabledProviderModels(): ProviderModelInfo[] {
  const providers = loadProviders();
  const result: ProviderModelInfo[] = [];

  for (const p of providers) {
    if (p.enabled && Array.isArray(p.models)) {
      for (const item of p.models) {
        const rawId = typeof item === "string" ? item : item.id;
        const displayName = typeof item === "object" && item.name ? item.name : rawId;
        const fullId = p.id === "openrouter" ? rawId : `${p.id}/${rawId}`;
        result.push({
          id: fullId,
          name: displayName,
          providerId: p.id,
          providerName: p.name,
        });
      }
    }
  }

  return result;
}

/** Find target provider & raw model id for any requested model string. */
export function findProviderForModel(modelId: string): { provider: ProviderConfig; rawModelId: string } | null {
  if (modelId.startsWith("test/")) return null;
  const providers = loadProviders();

  // 1) Prefix match (e.g. "opencode/deepseek-v4-flash-free" -> provider "opencode", rawModelId "deepseek-v4-flash-free")
  if (modelId.includes("/")) {
    const parts = modelId.split("/");
    const prefix = parts[0];
    const rawModelId = parts.slice(1).join("/");
    const p = providers.find((x) => x.id === prefix && x.enabled);
    if (p && p.id !== "openrouter") return { provider: p, rawModelId };
  }

  // 2) Exact model list match across all non-openrouter providers
  for (const p of providers) {
    if (!p.enabled || p.id === "openrouter") continue;
    if (Array.isArray(p.models)) {
      for (const m of p.models) {
        const id = typeof m === "string" ? m : m.id;
        if (id === modelId || `${p.id}/${id}` === modelId) {
          return { provider: p, rawModelId: id };
        }
      }
    }
  }

  return null;
}

interface ProviderKeyStats {
  timestamps: number[];
  cooldownUntil: number;
  failures: number;
  successes: number;
}

const providerKeyStats = new Map<string, Map<string, ProviderKeyStats>>();

function getKeyStats(providerId: string, key: string): ProviderKeyStats {
  let pMap = providerKeyStats.get(providerId);
  if (!pMap) {
    pMap = new Map();
    providerKeyStats.set(providerId, pMap);
  }
  let stats = pMap.get(key);
  if (!stats) {
    stats = { timestamps: [], cooldownUntil: 0, failures: 0, successes: 0 };
    pMap.set(key, stats);
  }
  return stats;
}

export function getProviderKeyRpm(providerId: string, key: string): number {
  const stats = getKeyStats(providerId, key);
  const now = Date.now();
  stats.timestamps = stats.timestamps.filter((t) => now - t < 60_000);
  return stats.timestamps.length;
}

export interface SelectedProviderKey {
  key: string;
  keyIndex: number;
  currentRpm: number;
  maxRpm: number;
}

export function selectProviderKey(provider: ProviderConfig): SelectedProviderKey | null {
  if (!provider.keys || provider.keys.length === 0) {
    if (provider.id === "opencode") {
      return { key: "public", keyIndex: 0, currentRpm: 1, maxRpm: 120 };
    }
    return null;
  }
  const now = Date.now();
  const maxRpm = provider.rpmLimit ?? (provider.id === "nvidia" ? 40 : 120);

  const candidates: Array<{ key: string; index: number; rpm: number }> = [];

  for (let i = 0; i < provider.keys.length; i++) {
    const k = provider.keys[i];
    const stats = getKeyStats(provider.id, k);
    stats.timestamps = stats.timestamps.filter((t) => now - t < 60_000);

    if (now >= stats.cooldownUntil && stats.timestamps.length < maxRpm) {
      candidates.push({ key: k, index: i, rpm: stats.timestamps.length });
    }
  }

  if (candidates.length === 0) {
    const best = provider.keys
      .map((k, i) => {
        const stats = getKeyStats(provider.id, k);
        stats.timestamps = stats.timestamps.filter((t) => now - t < 60_000);
        return { key: k, index: i, rpm: stats.timestamps.length, cooldownUntil: stats.cooldownUntil };
      })
      .sort((a, b) => a.rpm - b.rpm || a.cooldownUntil - b.cooldownUntil)[0];

    if (!best) return null;
    recordProviderKeyRequest(provider.id, best.key);
    return { key: best.key, keyIndex: best.index, currentRpm: best.rpm + 1, maxRpm };
  }

  candidates.sort((a, b) => a.rpm - b.rpm);
  const picked = candidates[0];
  recordProviderKeyRequest(provider.id, picked.key);
  return { key: picked.key, keyIndex: picked.index, currentRpm: picked.rpm + 1, maxRpm };
}

export function recordProviderKeyRequest(providerId: string, key: string): void {
  const stats = getKeyStats(providerId, key);
  stats.timestamps.push(Date.now());
  stats.successes++;
}

export function recordProviderKeyFailure(providerId: string, key: string, status: number): void {
  const stats = getKeyStats(providerId, key);
  stats.failures++;
  if (status === 429) {
    stats.cooldownUntil = Date.now() + 60_000;
  } else {
    stats.cooldownUntil = Date.now() + 10_000;
  }
}
