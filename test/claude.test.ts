/**
 * Unit tests for src/claude.ts — the automatic Claude Code settings updater.
 *
 *   bun test
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { writeClaudeSettings, restoreClaudeSettingsDefault, resolveClaudeSettingsPath, defaultClaudeSettingsPath } from "../src/claude";

/** The exact env block writeClaudeSettings produces for port 8080. */
const ROUTER_ENV = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
  ANTHROPIC_API_BASE_URL: "http://127.0.0.1:8080",
  CLAUDE_AGENT_API_BASE_URL: "http://127.0.0.1:8080",
  ANTHROPIC_AUTH_TOKEN: "router",
  ANTHROPIC_API_KEY: "",
  CLAUDE_CODE_USE_GATEWAY: "1",
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  ENABLE_TOOL_SEARCH: "false",
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kr-claude-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeClaudeSettings", () => {
  test("creates the file (and parent dirs) with all router env keys", () => {
    const target = join(dir, "a", "settings.json");
    const result = writeClaudeSettings(target, 8080);
    expect(existsSync(target)).toBe(true);
    expect(result.changed).toBe(true);

    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.env).toEqual(ROUTER_ENV);
  });

  test("preserves unrelated settings and other env vars while merging", () => {
    const target = join(dir, "merge.json");
    writeFileSync(
      target,
      JSON.stringify({
        permissions: { allow: ["Bash", "Read"] },
        env: { MY_CUSTOM_VAR: "keep-me", ANTHROPIC_BASE_URL: "https://old.example.com" },
      }),
    );

    const result = writeClaudeSettings(target, 9090);
    expect(result.changed).toBe(true);
    expect(result.changes).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:9090");

    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.permissions).toEqual({ allow: ["Bash", "Read"] });
    expect(parsed.env.MY_CUSTOM_VAR).toBe("keep-me");
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9090");
    expect(parsed.env.ANTHROPIC_API_BASE_URL).toBe("http://127.0.0.1:9090");
    expect(parsed.env.CLAUDE_AGENT_API_BASE_URL).toBe("http://127.0.0.1:9090");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("router");
  });

  test("removes claude-code-router leftovers while keeping personal settings", () => {
    const target = join(dir, "ccr.json");
    writeFileSync(
      target,
      JSON.stringify({
        apiKeyHelper: "\"C:\\ccr\\api-key.cmd\"",
        model: "anthropic/claude-ccr-h4f70656e436f6465",
        theme: "dark",
        statusLine: { type: "command", command: "node status.mjs", padding: 0 },
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_API_BASE_URL: "http://127.0.0.1:3456",
          CLAUDE_AGENT_API_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_MODEL: "OpenRouter/poolside/laguna-s-2.1:free",
          CCR_CLAUDE_CODE_MODEL: "OpenRouter/poolside/laguna-s-2.1:free",
          CODEXL_CLAUDE_CODE_MODEL: "OpenRouter/poolside/laguna-s-2.1:free",
          ANCHOR_LOGIN_BYPASS: "true",
        },
      }),
    );

    const result = writeClaudeSettings(target, 8080);
    expect(result.changed).toBe(true);
    expect(result.changes).toContain("- apiKeyHelper (removed claude-code-router leftover)");

    const parsed = JSON.parse(readFileSync(target, "utf8"));
    // Personal settings survive.
    expect(parsed.theme).toBe("dark");
    expect(parsed.statusLine).toEqual({ type: "command", command: "node status.mjs", padding: 0 });
    // Gateway leftovers are gone.
    expect(parsed.apiKeyHelper).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(parsed.env.CCR_CLAUDE_CODE_MODEL).toBeUndefined();
    expect(parsed.env.CODEXL_CLAUDE_CODE_MODEL).toBeUndefined();
    // Neutral flags kept, router URLs applied.
    expect(parsed.env.ANCHOR_LOGIN_BYPASS).toBe("true");
    expect(parsed.env).toEqual({ ...ROUTER_ENV, ANCHOR_LOGIN_BYPASS: "true" });
  });

  test("keeps deliberate non-gateway model and apiKeyHelper values", () => {
    const target = join(dir, "deliberate.json");
    writeFileSync(
      target,
      JSON.stringify({
        model: "claude-sonnet-4-5",
        apiKeyHelper: "my-own-helper.cmd",
        env: { ANTHROPIC_MODEL: "claude-opus-4-1" },
      }),
    );

    const result = writeClaudeSettings(target, 8080);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.model).toBe("claude-sonnet-4-5");
    expect(parsed.apiKeyHelper).toBe("my-own-helper.cmd");
    expect(parsed.env.ANTHROPIC_MODEL).toBe("claude-opus-4-1");
    expect(result.changed).toBe(true); // only the env URLs needed updating
  });

  test("reports no changes when already configured", () => {
    const target = join(dir, "fresh.json");
    writeClaudeSettings(target, 8080);
    const second = writeClaudeSettings(target, 8080);
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
  });

  test("reports changes when the port moves", () => {
    const target = join(dir, "port.json");
    writeClaudeSettings(target, 8080);
    const moved = writeClaudeSettings(target, 9090);
    expect(moved.changed).toBe(true);
    expect(moved.changes).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:9090");
  });

  test("recovers from a malformed existing file", () => {
    const target = join(dir, "broken.json");
    writeFileSync(target, "{not valid json");
    const result = writeClaudeSettings(target, 8080);
    expect(result.changed).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
  });

  test("recovers from an existing JSON array instead of destroying it silently", () => {
    const target = join(dir, "array.json");
    writeFileSync(target, "[]");
    const result = writeClaudeSettings(target, 8080);
    expect(result.changed).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ env: ROUTER_ENV });
  });

  test("does not rewrite the file when nothing changed", async () => {
    const target = join(dir, "skipwrite.json");
    writeClaudeSettings(target, 8080);
    await Bun.sleep(15); // let the mtime settle
    const before = statSync(target).mtimeMs;
    const result = writeClaudeSettings(target, 8080);
    expect(result.changed).toBe(false);
    expect(statSync(target).mtimeMs).toBe(before);
  });
});

describe("resolveClaudeSettingsPath", () => {
  test("defaults to ~/.claude/settings.json", () => {
    expect(defaultClaudeSettingsPath()).toBe(resolve(homedir(), ".claude", "settings.json"));
    expect(resolveClaudeSettingsPath(null)).toBe(resolve(homedir(), ".claude", "settings.json"));
  });

  test("expands a leading ~", () => {
    expect(resolveClaudeSettingsPath("~/custom/claude.json")).toBe(resolve(homedir(), "custom/claude.json"));
  });

  test("resolves relative paths against the base dir", () => {
    expect(resolveClaudeSettingsPath(".claude/settings.json", "/base")).toBe(resolve("/base", ".claude/settings.json"));
  });
});

describe("restoreClaudeSettingsDefault", () => {
  test("strips RouteCode env overrides and leaves non-gateway env vars intact", () => {
    const target = join(dir, "restore.json");
    writeFileSync(
      target,
      JSON.stringify({
        theme: "dark",
        env: {
          ...ROUTER_ENV,
          MY_CUSTOM_VAR: "preserve-this",
        },
      }),
    );

    const result = restoreClaudeSettingsDefault(target);
    expect(result.changed).toBe(true);
    expect(result.changes).toContain("- env.ANTHROPIC_BASE_URL");

    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.env).toEqual({ MY_CUSTOM_VAR: "preserve-this" });
    expect(parsed.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(parsed.env.CLAUDE_CODE_USE_GATEWAY).toBeUndefined();
  });
});
