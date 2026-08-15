#!/usr/bin/env bun
/**
 * RouteCode — Zero-latency failover gateway for Claude Code & OpenRouter.
 *
 *   npx routecode                      # start — all free OpenRouter models available
 *   bun run index.ts --model <id>      # force one free model as default override
 *   bun run index.ts --select-model    # open interactive picker
 *
 * While running, type `help` in terminal for live commands (models, status…).
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "node:child_process";
import {
  ensureConfigFiles,
  loadSystem,
  saveSettings,
  saveSystem,
  PROJECT_ROOT,
  SETTINGS_PATH,
  SYSTEM_PATH,
  type SystemConfig,
} from "./src/config";
import { resolveClaudeSettingsPath, writeClaudeSettings, restoreClaudeSettingsDefault } from "./src/claude";
import {
  fetchModelListWithKeys,
  isFreeModel,
  pickModelInteractive,
  pickerOrder,
  resolveFreeModel,
  type OpenRouterModel,
} from "./src/models";
import { KeyPool } from "./src/keys";
import { createRouterServer } from "./src/server";
import { loadProviders, saveProviders } from "./src/providers";

const RAW_ASCII_LINES = [
  " ________  ________  ___  ___  _________  _______   ________  ________  ________  _______      ",
  "|\\   __  \\|\\   __  \\|\\  \\|\\  \\|\\___   ___\\\\  ___ \\ |\\   ____\\|\\   __  \\|\\   ___ \\|\\  ___ \\     ",
  "\\ \\  |\\  \\ \\  |\\  \\ \\  \\\\\\  \\|___ \\  \\_\\ \\   __/|\\ \\  \\___|\\ \\  |\\  \\ \\  \\_|\\ \\ \\   __/|    ",
  " \\ \\   _  _\\ \\  \\\\\\  \\ \\  \\\\\\  \\   \\ \\  \\ \\ \\  \\_|/_\\ \\  \\    \\ \\  \\\\\\  \\ \\  \\ \\\\ \\ \\  \\_|/__  ",
  "  \\ \\  \\\\  \\\\ \\  \\\\\\  \\ \\  \\\\\\  \\   \\ \\  \\ \\ \\  \\_|\\ \\ \\  \\____\\ \\  \\\\\\  \\ \\  \\_\\\\ \\ \\  \\_|\\ \\ ",
  "   \\ \\__\\\\ _\\\\ \\_______\\ \\_______\\   \\ \\__\\ \\ \\_______\\ \\_______\\ \\_______\\ \\_______\\ \\_______\\",
  "    \\|__|\\|__|\\|_______|\\|_______|    \\|__|  \\|_______|\\|_______|\\|_______|\\|_______|\\|_______|",
];

const ORANGE_GRADIENT = [
  "\x1b[38;5;220m", // Gold Yellow
  "\x1b[38;5;214m", // Amber Orange
  "\x1b[38;5;208m", // Vibrant Orange
  "\x1b[38;5;208m", // Vibrant Orange
  "\x1b[38;5;202m", // Flame Orange
  "\x1b[38;5;202m", // Flame Orange
  "\x1b[38;5;166m", // Deep Fire Orange
];

const ASCII_BANNER_LINES = [
  ...RAW_ASCII_LINES.map((l, i) => `  ${ORANGE_GRADIENT[i]}${l}\x1b[0m`),
  "  \x1b[38;5;208m==================================================================================================\x1b[0m",
  "  \x1b[1;38;5;214m  RouteCode — Claude Code × OpenRouter Gateway Console \x1b[0m",
  "  \x1b[38;5;208m==================================================================================================\x1b[0m",
];

async function animateBanner(): Promise<void> {
  // Step 1: Initial line-by-line 3D ASCII render
  for (const line of ASCII_BANNER_LINES) {
    console.log(line);
    await new Promise((r) => setTimeout(r, 15));
  }

  // Step 2: Post-generation Orange Color Wave Shimmer Animation
  const asciiColorPalettes = [
    // Frame 1: White/Gold light flash
    ["\x1b[1;97m", "\x1b[1;97m", "\x1b[38;5;226m", "\x1b[38;5;226m", "\x1b[38;5;220m", "\x1b[38;5;214m", "\x1b[38;5;208m"],
    // Frame 2: Bright Amber sweep
    ["\x1b[38;5;226m", "\x1b[38;5;220m", "\x1b[38;5;214m", "\x1b[38;5;208m", "\x1b[38;5;202m", "\x1b[38;5;202m", "\x1b[38;5;166m"],
    // Frame 3: Flame Red-Orange pulse
    ["\x1b[38;5;214m", "\x1b[38;5;208m", "\x1b[38;5;202m", "\x1b[38;5;196m", "\x1b[38;5;202m", "\x1b[38;5;208m", "\x1b[38;5;214m"],
    // Frame 4 (Final): Rich Orange Color Gradient
    ORANGE_GRADIENT,
  ];

  for (const palette of asciiColorPalettes) {
    // Move up 10 lines to top of ASCII banner
    process.stdout.write("\x1b[10A");
    for (let i = 0; i < RAW_ASCII_LINES.length; i++) {
      process.stdout.write(`\x1b[2K  ${palette[i]}${RAW_ASCII_LINES[i]}\x1b[0m\n`);
    }
    // Skip remaining 3 title/border lines
    process.stdout.write("\x1b[3B");
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface CliArgs {
  model?: string;
  selectModel: boolean;
  port?: number;
  modelsFile?: string;
  config: boolean;
  configDefault: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { selectModel: false, config: false, configDefault: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "config") {
      if (argv[i + 1] === "default") {
        args.configDefault = true;
        i++;
      } else {
        args.config = true;
      }
      continue;
    }
    switch (a) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--select-model":
        args.selectModel = true;
        break;
      case "--config":
        args.config = true;
        break;
      case "--config-default":
        args.configDefault = true;
        break;
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--port":
      case "-p":
        args.port = Number(argv[++i]);
        break;
      case "--models-file":
        args.modelsFile = argv[++i];
        break;
      default:
        break;
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
RouteCode — Claude Code × OpenRouter Failover Gateway

All OpenRouter free models are available — no selection needed. Every free
model shows up in Claude Code's /model picker.

Usage:
  npx routecode                    start RouteCode
  npx routecode config             route Claude Code through RouteCode (all free models enabled)
  npx routecode config default     restore Claude Code settings back to default Anthropic
  bun run index.ts --model <id>    force one free model as default override
  bun run index.ts --select-model  open the picker to set that override
  bun run index.ts --port <n>      listen on a different port (default 8080)

Files:
  settings.json   OpenRouter API keys (edit these — one per account)
  system.json     port, failover tuning (defaultModel is optional)

While running, type: models · status · keys · help · quit
`);
}

function loadModelsFile(path: string): OpenRouterModel[] {
  const text = readFileSync(resolve(path), "utf8");
  const json = JSON.parse(text) as { data?: unknown[] } | unknown[];
  const array = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : [];
  return array
    .map((m: unknown) => {
      const o = m as Record<string, unknown>;
      if (!o || typeof o.id !== "string") return null;
      return {
        id: o.id,
        name: typeof o.name === "string" ? o.name : undefined,
        context_length: typeof o.context_length === "number" ? o.context_length : undefined,
        pricing: o.pricing as OpenRouterModel["pricing"],
      };
    })
    .filter((m: OpenRouterModel | null): m is OpenRouterModel => m !== null);
}

function openBrowser(url: string): void {
  const startCmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(startCmd, () => {
    /* ignore error */
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const sys: SystemConfig = loadSystem();
  if (args.port && Number.isInteger(args.port) && args.port > 0) sys.port = args.port;

  // Handle CLI config sub-commands
  if (args.configDefault) {
    const targetPath = resolveClaudeSettingsPath(sys.claudeSettingsPath);
    const res = restoreClaudeSettingsDefault(targetPath);
    console.log(`\n  \x1b[32m✓ Claude Code settings restored to default Anthropic configuration.\x1b[0m`);
    console.log(`    Target file: ${res.path}\n`);
    return;
  }

  if (args.config) {
    const targetPath = resolveClaudeSettingsPath(sys.claudeSettingsPath);
    const res = writeClaudeSettings(targetPath, sys.port);
    console.log(`\n  \x1b[32m✓ Claude Code configured to route through RouteCode!\x1b[0m`);
    console.log(`    Target file: ${res.path}`);
    console.log(`    Gateway URL: http://127.0.0.1:${sys.port}`);
    console.log(`    All free OpenRouter models are now listed in Claude Code's /model picker.\n`);
    return;
  }

  await animateBanner();

  // 1) Credentials ----------------------------------------------------------
  const settings = ensureConfigFiles();
  let keys = settings.openrouterKeys.filter((k) => k.trim() && !k.includes("REPLACE"));

  if (keys.length === 0) {
    console.log(`\n  \x1b[33m⚠ No OpenRouter API key found in settings.json!\x1b[0m`);
    console.log(`  OpenRouter keys are 100% free and instant to create.`);
    console.log(`  Get your API key at: \x1b[36mhttps://openrouter.ai/keys\x1b[0m\n`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const userKey = await new Promise<string>((res) => {
      rl.question("  Paste your OpenRouter API key (sk-or-v1-...): ", (ans: string) => {
        rl.close();
        res(ans.trim());
      });
    });

    if (userKey) {
      settings.openrouterKeys = [userKey];
      saveSettings(settings);
      keys = [userKey];
      console.log(`\n  \x1b[32m✓ Key saved to settings.json! Starting RouteCode...\x1b[0m`);
    } else {
      console.error("\n  ✗ No key entered. Exiting RouteCode.\n");
      process.exit(1);
    }
  }

  // 2) System config --------------------------------------------------------
  console.log(`\n  Accounts : ${keys.length} OpenRouter key${keys.length === 1 ? "" : "s"} loaded from settings.json`);

  // 3) Model catalog — free models only --------------------------------------
  let freeModels: OpenRouterModel[] = [];
  let freeIds: string[] = [];
  try {
    const catalog = args.modelsFile ? loadModelsFile(args.modelsFile) : await fetchModelListWithKeys(keys, sys.openrouterBaseUrl);
    freeModels = pickerOrder(catalog.filter(isFreeModel));
    freeIds = freeModels.map((m) => m.id);
  } catch (err) {
    console.error(`\n  ✗ Could not fetch the model list from OpenRouter: ${err instanceof Error ? err.message : err}`);
    console.error("    Check that your keys are valid and you have an internet connection.\n");
    process.exit(1);
  }
  if (freeIds.length === 0) {
    console.error("\n  ✗ No free models found in the catalog. The router only routes free models.\n");
    process.exit(1);
  }
  console.log(`  Free models : ${freeIds.length} (all available in Claude Code's /model picker)`);

  // 4) Optional default override ---------------------------------------------
  const state: { model: string | null } = { model: null };

  const pick = async (reason: string): Promise<string | null> => {
    const chosen = await pickModelInteractive(freeModels, { title: `  ${reason}` });
    if (!chosen) return null;
    state.model = chosen.id;
    sys.defaultModel = chosen.id;
    saveSystem(sys);
    console.log(`  ✓ Saved to system.json: ${chosen.id}`);
    return chosen.id;
  };

  if (args.model) {
    if (!freeIds.includes(args.model)) {
      console.error(`\n  ✗ "${args.model}" is not a free model.\n    Run \`bun run index.ts --select-model\` to see the free list.\n`);
      process.exit(1);
    }
    state.model = args.model;
    sys.defaultModel = args.model;
    saveSystem(sys);
    console.log(`  Default    : ${args.model} (forced override via --model)`);
  } else if (args.selectModel) {
    await pick("Pick a default model override (optional — other free models stay available):");
  } else if (sys.defaultModel) {
    if (freeIds.includes(sys.defaultModel)) {
      state.model = sys.defaultModel;
      console.log(`  Default    : ${sys.defaultModel} (override from system.json)`);
    } else {
      console.log(`  ⚠ Saved default "${sys.defaultModel}" is not a free model — ignoring it.`);
      sys.defaultModel = null;
      saveSystem(sys);
    }
  } else {
    console.log("  Default    : auto — every free model is selectable inside Claude Code (/model)");
  }

  // 5) Start the gateway ----------------------------------------------------
  const keyPool = new KeyPool(keys, {
    roundRobin: sys.roundRobin,
    cooldownBaseMs: sys.failover.cooldownBaseSeconds * 1000,
    cooldownMaxMs: sys.failover.cooldownMaxSeconds * 1000,
  });

  const router = createRouterServer({
    port: sys.port,
    resolveModel: (requested) => resolveFreeModel(requested, freeIds, state.model),
    getDefaultModel: () => state.model,
    keyPool,
    getModels: () => freeModels,
    openrouterBaseUrl: sys.openrouterBaseUrl,
    maxRetries: sys.failover.maxRetries,
    roundRobin: sys.roundRobin,
  });
  await router.ready;

  const actualPort = router.server.port;
  const dashboardUrl = `http://localhost:${actualPort}/dashboard`;
  console.log(`\n  ✓ Gateway listening on http://127.0.0.1:${actualPort}`);
  console.log(`  ✓ Dashboard UI available on ${dashboardUrl}`);
  openBrowser(dashboardUrl);

  // 5b) Automatically point Claude Code at the router -------------------------
  if (sys.autoConfigureClaude) {
    const target = resolveClaudeSettingsPath(sys.claudeSettingsPath, PROJECT_ROOT);
    // Case-insensitive on Windows, where paths compare ignoring case.
    const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (samePath(target, SETTINGS_PATH) || samePath(target, SYSTEM_PATH)) {
      console.log(
        `  ⚠ Refusing to write Claude settings to ${target} — that's a router config file.\n    Set "claudeSettingsPath" to a real Claude Code settings file.`,
      );
    } else {
      try {
        const result = writeClaudeSettings(target, actualPort ?? sys.port);
        if (result.changed) {
          console.log(`  ✓ Claude Code settings updated: ${target}`);
          for (const change of result.changes) console.log(`      ${change}`);
        } else {
          console.log(`  ✓ Claude Code settings already point at the router (${target})`);
        }
      } catch (err) {
        console.log(`  ⚠ Could not update Claude Code settings (${target}): ${err instanceof Error ? err.message : err}`);
      }
    }
  } else {
    console.log(
      `  (auto-config of Claude Code is off — set "autoConfigureClaude": true in system.json to enable)`,
    );
  }

  console.log(`
  Then run: claude
  In Claude Code, open /model — every free model is listed there. Requests are
  routed across your OpenRouter accounts with automatic failover.

  Type "help" here for live commands (models · status · keys · quit).`);

  // 6) Live terminal REPL ---------------------------------------------------
  // ONE readline interface owns stdin. The picker (opened by the `model`
  // command) borrows its lines through a mode flag, so two interfaces never
  // fight over the same stream.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let pickerActive = false;
  const lineQueue: string[] = [];
  let lineWaiter: ((v: string | undefined) => void) | null = null;

  const nextLine = (): Promise<string | undefined> =>
    new Promise((resolve) => {
      if (lineQueue.length > 0) resolve(lineQueue.shift());
      else lineWaiter = resolve;
    });

  const runCommand = (raw: string) => void handleCommand(raw).finally(() => process.stdout.write("router> "));

  rl.on("line", (line: string) => {
    if (pickerActive) {
      if (lineWaiter) {
        const w = lineWaiter;
        lineWaiter = null;
        w(line);
      } else {
        lineQueue.push(line);
      }
      return;
    }
    runCommand(line);
  });
  rl.on("close", () => {
    if (lineWaiter) {
      const w = lineWaiter;
      lineWaiter = null;
      w(undefined);
    }
  });

  async function handleCommand(raw: string) {
    const cmd = raw.trim().toLowerCase();
    switch (cmd) {
      case "help":
      case "?":
        console.log(`
  models   list the available free models
  model    set/clear the default model override (pick from the free list)
  status   show free-model count, override, port and per-key health
  keys     list configured keys (masked)
  quit     stop the router`);
        break;
      case "models": {
        console.log(`\n  ${freeIds.length} free models available:`);
        for (const m of freeModels.slice(0, 25)) console.log(`    ${m.id}`);
        if (freeIds.length > 25) console.log(`    … and ${freeIds.length - 25} more (full list in Claude Code's /model picker)`);
        break;
      }
      case "status": {
        console.log(`\n  Default override : ${state.model ?? "(none — auto, pick in Claude Code /model)"}`);
        console.log(`  Free models      : ${freeIds.length}`);
        console.log(`  Port             : ${actualPort}`);
        for (const k of keyPool.list()) {
          const cool = Math.max(0, Math.ceil((k.cooldownUntil - Date.now()) / 1000));
          console.log(`  ${k.label.padEnd(22)} healthy=${k.consecutiveFailures === 0 || cool === 0} · ok=${k.successes} · fail=${k.failures}${cool > 0 ? ` · cooldown ${cool}s` : ""}`);
        }
        break;
      }
      case "keys":
        for (const k of keyPool.list()) console.log(`  ${k.label}  ${k.key.slice(0, 12)}…`);
        break;
      case "model": {
        pickerActive = true;
        try {
          try {
            const catalog = await fetchModelListWithKeys(keys, sys.openrouterBaseUrl);
            const fresh = pickerOrder(catalog.filter(isFreeModel));
            if (fresh.length > 0) {
              freeModels = fresh;
              freeIds = fresh.map((m) => m.id);
            }
          } catch {
            console.log("  ⚠ Could not refresh the catalog — reusing the cached list.");
          }
          const chosen = await pickModelInteractive(freeModels, { title: "  Pick a default model override (or q to clear it):", nextLine });
          if (chosen) {
            state.model = chosen.id;
            sys.defaultModel = chosen.id;
            saveSystem(sys);
            console.log(`  ✓ Default override is now ${chosen.id}`);
          } else if (state.model || sys.defaultModel) {
            // Cancelled while an override was set — treat as "clear the override".
            state.model = null;
            sys.defaultModel = null;
            saveSystem(sys);
            console.log("  ✓ Default override cleared — all free models available again.");
          }
        } finally {
          pickerActive = false;
          // Flush lines typed ahead while the picker was open back into the REPL.
          for (const buffered of lineQueue.splice(0)) runCommand(buffered);
        }
        break;
      }
      case "quit":
      case "exit":
        await gracefulShutdown("command");
        break;
      default:
        if (raw.trim()) console.log('  Unknown command — type "help".');
        break;
    }
  }

  let shuttingDown = false;
  async function gracefulShutdown(reason: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  Shutting down RouteCode (${reason})…`);
    try {
      if (state.model !== undefined) {
        sys.defaultModel = state.model;
      }
      saveSystem(sys);
      saveProviders(loadProviders());
      console.log("  ✓ Models catalog, provider settings, and router configuration saved.");
    } catch (err) {
      console.log(`  ⚠ Could not save state on exit: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      router.server.stop(true);
      console.log("  ✓ Gateway server stopped cleanly.");
    } catch {
      /* ignore */
    }

    rl.close();
    console.log("  Bye!\n");
    process.exit(0);
  }

  process.stdout.write("router> ");
  rl.on("SIGINT", () => void gracefulShutdown("Ctrl+C"));
  process.on("SIGINT", () => void gracefulShutdown("Ctrl+C"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGHUP", () => void gracefulShutdown("SIGHUP"));
}

main().catch((err) => {
  console.error("\n  ✗ Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
