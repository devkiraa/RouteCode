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

/** Get model definitions from all enabled providers. */
export function getEnabledProviderModels(): ProviderModelInfo[] {
  const providers = loadProviders();
  const result: ProviderModelInfo[] = [];

  for (const p of providers) {
    if (p.enabled && Array.isArray(p.models)) {
      for (const item of p.models) {
        const id = typeof item === "string" ? item : item.id;
        const displayName = typeof item === "object" && item.name ? item.name : id;
        result.push({
          id,
          name: displayName,
          providerId: p.id,
          providerName: p.name,
        });
      }
    }
  }

  return result;
}
