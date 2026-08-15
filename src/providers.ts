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

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  enabled: boolean;
  keys: string[];
  models?: string[];
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
    models: ["zcode-pro", "zcode-lite"],
  },
  {
    id: "opencode",
    name: "OpenCode Public (Chat Completions)",
    type: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    enabled: false,
    keys: [],
    models: ["opencode-zen", "opencode-mini"],
  },
];

export const PROVIDERS_PATH = resolve(PROJECT_ROOT, "providers.json");

/** Load providers from providers.json or initialize defaults. */
export function loadProviders(): ProviderConfig[] {
  try {
    if (existsSync(PROVIDERS_PATH)) {
      const raw = JSON.parse(readFileSync(PROVIDERS_PATH, "utf8")) as ProviderConfig[];
      if (Array.isArray(raw)) {
        // Merge defaults if any missing
        const ids = new Set(raw.map((p) => p.id));
        for (const def of DEFAULT_PROVIDERS) {
          if (!ids.has(def.id)) raw.push({ ...def });
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

/** Get model definitions from all enabled providers. */
export function getEnabledProviderModels(): Array<{ id: string; name?: string }> {
  const providers = loadProviders();
  const result: Array<{ id: string; name?: string }> = [];

  for (const p of providers) {
    if (p.enabled && Array.isArray(p.models)) {
      for (const m of p.models) {
        result.push({
          id: m,
          name: `${m} (${p.name})`,
        });
      }
    }
  }

  return result;
}
