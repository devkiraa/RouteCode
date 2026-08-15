/**
 * Config loader — reads/writes the two JSON files in the project root:
 *
 *   settings.json  → API credentials (OpenRouter keys)          [git-ignored]
 *   system.json    → everything else (port, model, failover...)  [tracked]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const getBaseDir = (): string => {
  const userConfigDir = resolve(homedir(), ".routecode");
  if (!existsSync(userConfigDir)) {
    try {
      mkdirSync(userConfigDir, { recursive: true });
    } catch {
      // Fallback
    }
  }
  return userConfigDir;
};

export const PROJECT_ROOT = getBaseDir();
export const SETTINGS_PATH = resolve(PROJECT_ROOT, "settings.json");
export const SYSTEM_PATH = resolve(PROJECT_ROOT, "system.json");

export interface FailoverConfig {
  /** How many keys to try per request. 0 = try every key in the pool. */
  maxRetries: number;
  /** Cooldown (seconds) after the first failure; doubles per consecutive failure. */
  cooldownBaseSeconds: number;
  /** Cap on the cooldown (seconds). */
  cooldownMaxSeconds: number;
}

export interface SystemConfig {
  port: number;
  /** The single OpenRouter model id every request is rewritten to (e.g. "anthropic/claude-sonnet-4.5"). */
  defaultModel: string | null;
  /** true = spread load across healthy keys; false = always prefer the first keys. */
  roundRobin: boolean;
  /** OpenRouter API base. Overridable for tests / self-hosted gateways. */
  openrouterBaseUrl: string;
  /** On startup, merge the router env block into Claude Code's settings file automatically. */
  autoConfigureClaude: boolean;
  /** Claude Code settings file to update (null = ~/.claude/settings.json). */
  claudeSettingsPath: string | null;
  failover: FailoverConfig;
}

export interface Settings {
  openrouterKeys: string[];
}

export const DEFAULT_SYSTEM: SystemConfig = {
  port: 8080,
  defaultModel: null,
  roundRobin: true,
  openrouterBaseUrl: "https://openrouter.ai/api",
  autoConfigureClaude: true,
  claudeSettingsPath: null,
  failover: {
    maxRetries: 0,
    cooldownBaseSeconds: 10,
    cooldownMaxSeconds: 300,
  },
};

/** Read settings.json; never throws — missing/invalid file yields an empty key list. */
export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<Settings>;
    return {
      openrouterKeys: Array.isArray(raw.openrouterKeys)
        ? raw.openrouterKeys.filter((k): k is string => typeof k === "string")
        : [],
    };
  } catch {
    return { openrouterKeys: [] };
  }
}

export function saveSettings(s: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n");
}

/** Read system.json, deep-merged over the defaults; never throws. */
export function loadSystem(): SystemConfig {
  const cfg = structuredClone(DEFAULT_SYSTEM);
  try {
    const raw = JSON.parse(readFileSync(SYSTEM_PATH, "utf8")) as Partial<SystemConfig> & {
      failover?: Partial<FailoverConfig>;
    };
    if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0) cfg.port = raw.port;
    if (typeof raw.defaultModel === "string" && raw.defaultModel.trim()) cfg.defaultModel = raw.defaultModel;
    if (typeof raw.roundRobin === "boolean") cfg.roundRobin = raw.roundRobin;
    if (typeof raw.openrouterBaseUrl === "string" && raw.openrouterBaseUrl.trim()) {
      cfg.openrouterBaseUrl = raw.openrouterBaseUrl.replace(/\/+$/, "");
    }
    if (typeof raw.autoConfigureClaude === "boolean") cfg.autoConfigureClaude = raw.autoConfigureClaude;
    if (typeof raw.claudeSettingsPath === "string" && raw.claudeSettingsPath.trim()) {
      cfg.claudeSettingsPath = raw.claudeSettingsPath;
    }
    const f = raw.failover;
    if (f && typeof f === "object") {
      if (typeof f.maxRetries === "number" && f.maxRetries >= 0) cfg.failover.maxRetries = f.maxRetries;
      if (typeof f.cooldownBaseSeconds === "number" && f.cooldownBaseSeconds >= 1) cfg.failover.cooldownBaseSeconds = f.cooldownBaseSeconds;
      if (typeof f.cooldownMaxSeconds === "number" && f.cooldownMaxSeconds >= 1) cfg.failover.cooldownMaxSeconds = f.cooldownMaxSeconds;
    }
  } catch {
    /* file missing or malformed — use defaults */
  }
  return cfg;
}

export function saveSystem(cfg: SystemConfig): void {
  writeFileSync(SYSTEM_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

/** Make sure settings.json exists; returns the (possibly empty) key list. */
export function ensureConfigFiles(): Settings {
  if (!existsSync(SETTINGS_PATH)) {
    saveSettings({ openrouterKeys: [] });
    console.log("  [setup] Created settings.json — add your OpenRouter API keys to it and re-run.");
  }
  return loadSettings();
}
