/**
 * Automatic Claude Code configuration.
 *
 * After the first run (and on every startup) the router merges its connection
 * variables into Claude Code's user-level settings file, so `claude` works in
 * any project folder without editing shell profiles or `.claude` files.
 *
 * Only the keys below are touched — everything else already in the file
 * (permissions, hooks, other env vars…) is preserved.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

/** Default target: ~/.claude/settings.json (user-wide, applies to every project). */
export function defaultClaudeSettingsPath(): string {
  return resolve(homedir(), ".claude", "settings.json");
}

/**
 * Resolve a configured settings path: null → default, "~/..." → home-expanded,
 * relative → resolved against the given base directory.
 */
export function resolveClaudeSettingsPath(
  configured: string | null,
  baseDir: string = process.cwd(),
): string {
  if (!configured) return defaultClaudeSettingsPath();
  const p = configured.trim();
  if (p.startsWith("~")) return resolve(p.replace(/^~/, homedir()));
  return resolve(baseDir, p);
}

export interface ClaudeSettingsResult {
  path: string;
  /** true when at least one key changed/was added. */
  changed: boolean;
  /** Human-readable list of the keys that changed. */
  changes: string[];
}

/**
 * Values that betray a claude-code-router / Codex migrated settings file.
 * apiKeyHelper and model are legitimate Claude Code settings, so they are only
 * removed when they actually look like gateway leftovers.
 */
const looksLikeGatewayValue = (v: unknown): boolean =>
  typeof v === "string" && /ccr|claude-code-router|^OpenRouter\//i.test(v);

/** Env keys owned by other gateways by name — always safe to drop. */
const GATEWAY_ENV_KEYS = ["CCR_CLAUDE_CODE_MODEL", "CODEXL_CLAUDE_CODE_MODEL"] as const;

/**
 * Merge the router env block into the Claude Code settings file at `path`,
 * creating it (and its directory) if missing. Returns what changed.
 */
export function writeClaudeSettings(path: string, port: number): ClaudeSettingsResult {
  // All three base-URL variants must point at the router — different Claude Code
  // surfaces (CLI, Agent SDK, codex bridge) read different ones.
  // CLAUDE_CODE_USE_GATEWAY is required: Claude Code only runs gateway model
  // discovery (GET /v1/models → the /model picker) when its provider mode is
  // "gateway", and the only env path to that mode is USE_GATEWAY + BASE_URL +
  // AUTH_TOKEN set together (otherwise /model shows only the built-in models).
  // ENABLE_TOOL_SEARCH is forced off: it makes Claude Code send "deferred custom
  // tools" (defer_to_client), which only Anthropic models accept — the free
  // models this router serves are mostly non-Anthropic, so it must stay off.
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_AGENT_API_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: "router",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_USE_GATEWAY: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ENABLE_TOOL_SEARCH: "false",
  };

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed file — replaced below rather than crashing.
    }
  }

  const currentEnv =
    existing.env && typeof existing.env === "object" && !Array.isArray(existing.env)
      ? (existing.env as Record<string, unknown>)
      : {};

  const changes: string[] = [];

  // Drop gateway leftovers so they can't interfere — but only when they really
  // look like leftovers, so deliberate user values are never clobbered.
  for (const key of ["apiKeyHelper", "model"] as const) {
    if (key in existing && looksLikeGatewayValue(existing[key])) {
      delete existing[key];
      changes.push(`- ${key} (removed claude-code-router leftover)`);
    }
  }
  for (const key of GATEWAY_ENV_KEYS) {
    if (key in currentEnv) {
      delete currentEnv[key];
      changes.push(`- env.${key} (removed gateway leftover)`);
    }
  }
  if ("ANTHROPIC_MODEL" in currentEnv && looksLikeGatewayValue(currentEnv.ANTHROPIC_MODEL)) {
    delete currentEnv.ANTHROPIC_MODEL;
    changes.push("- env.ANTHROPIC_MODEL (removed gateway leftover)");
  }

  for (const [key, value] of Object.entries(env)) {
    if (currentEnv[key] !== value) {
      changes.push(`${key}=${value}`);
      currentEnv[key] = value;
    }
  }
  existing.env = currentEnv;

  // Don't touch the file when it already points at the router — this also
  // avoids spurious failures on read-only files that need no changes.
  if (changes.length === 0) {
    return { path, changed: false, changes };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");

  return { path, changed: true, changes };
}
