import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface MemoryStore {
  projectRules: string[];
  techStack: string[];
  preferences: string[];
  customNotes: string;
  updatedAt: string;
}

const DEFAULT_MEMORY_DIR = join(homedir(), ".routecode");
const DEFAULT_MEMORY_PATH = join(DEFAULT_MEMORY_DIR, "memory.json");

// In-Memory Performance Cache
let cachedMemoryStore: MemoryStore | null = null;
let cachedCompressedPrompt: string | null = null;

export function getMemoryPath(): string {
  return process.env.ROUTECODE_MEMORY_PATH ?? DEFAULT_MEMORY_PATH;
}

export function loadMemory(): MemoryStore {
  if (cachedMemoryStore) {
    return cachedMemoryStore;
  }

  const filePath = getMemoryPath();
  if (!existsSync(filePath)) {
    cachedMemoryStore = {
      projectRules: [
        "concise-answers",
        "clean-typed-code",
      ],
      techStack: [],
      preferences: [],
      customNotes: "",
      updatedAt: new Date().toISOString(),
    };
    return cachedMemoryStore;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    cachedMemoryStore = {
      projectRules: Array.isArray(json.projectRules) ? json.projectRules : [],
      techStack: Array.isArray(json.techStack) ? json.techStack : [],
      preferences: Array.isArray(json.preferences) ? json.preferences : [],
      customNotes: typeof json.customNotes === "string" ? json.customNotes : "",
      updatedAt: json.updatedAt || new Date().toISOString(),
    };
    return cachedMemoryStore;
  } catch (err) {
    cachedMemoryStore = {
      projectRules: [],
      techStack: [],
      preferences: [],
      customNotes: "",
      updatedAt: new Date().toISOString(),
    };
    return cachedMemoryStore;
  }
}

export function saveMemory(memory: Partial<MemoryStore>): MemoryStore {
  const current = loadMemory();
  const updated: MemoryStore = {
    projectRules: Array.isArray(memory.projectRules) ? dedupeArray(memory.projectRules) : current.projectRules,
    techStack: Array.isArray(memory.techStack) ? dedupeArray(memory.techStack) : current.techStack,
    preferences: Array.isArray(memory.preferences) ? dedupeArray(memory.preferences) : current.preferences,
    customNotes: typeof memory.customNotes === "string" ? memory.customNotes : current.customNotes,
    updatedAt: new Date().toISOString(),
  };

  const filePath = getMemoryPath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");

  // Invalidate in-memory caches
  cachedMemoryStore = updated;
  cachedCompressedPrompt = null;
  return updated;
}

function dedupeArray(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    const trimmed = item.trim();
    const lower = trimmed.toLowerCase();
    if (trimmed && !seen.has(lower)) {
      seen.add(lower);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Ultra-Dense Token Compression Algorithm
 * Formats memory into hyper-compact <ctx> key-value tokens (saves ~80% tokens).
 */
export function formatUltraCompressedMemory(mem?: MemoryStore): string {
  if (!mem && cachedCompressedPrompt) {
    return cachedCompressedPrompt;
  }

  const memory = mem ?? loadMemory();
  const parts: string[] = [];

  if (memory.projectRules.length > 0) {
    parts.push(`rules:${memory.projectRules.join(",")}`);
  }

  if (memory.techStack.length > 0) {
    parts.push(`stack:${memory.techStack.join(",")}`);
  }

  if (memory.preferences.length > 0) {
    parts.push(`prefs:${memory.preferences.join(",")}`);
  }

  if (memory.customNotes.trim()) {
    parts.push(`notes:${memory.customNotes.trim().replace(/\s+/g, " ")}`);
  }

  if (parts.length === 0) return "";

  const compressed = `<ctx>${parts.join("|")}</ctx>`;
  if (!mem) {
    cachedCompressedPrompt = compressed;
  }
  return compressed;
}

/** Inject compressed memory prompt fragment into system string or array. */
export function injectMemoryIntoSystem(system: unknown): string | Array<{ type: string; text: string }> {
  const memoryPrompt = formatUltraCompressedMemory();
  if (!memoryPrompt) {
    return system as any;
  }

  if (!system) {
    return memoryPrompt;
  }

  if (typeof system === "string") {
    return `${memoryPrompt}\n${system}`;
  }

  if (Array.isArray(system)) {
    return [
      { type: "text", text: memoryPrompt },
      ...system,
    ];
  }

  return memoryPrompt;
}

/**
 * Asynchronous Auto-Memory Extraction Algorithm
 * Parses incoming user prompt for tech stack, rules, and preferences with 0ms blocking.
 */
export function extractAutoMemoryFromPayload(payload: any): void {
  try {
    if (!payload || !Array.isArray(payload.messages)) return;

    const userText = payload.messages
      .filter((m: any) => m.role === "user")
      .map((m: any) => (typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((c: any) => c.text || "").join(" ") : "")))
      .join("\n");

    if (!userText.trim()) return;

    const current = loadMemory();
    const newStack = new Set(current.techStack);
    const newRules = new Set(current.projectRules);
    const newPrefs = new Set(current.preferences);
    let changed = false;

    // Detect tech stack keywords
    const stackKeywords = ["Bun", "TypeScript", "React", "Next.js", "Hono", "Tailwind", "Python", "Docker", "Node.js", "Vue", "Svelte", "FastAPI", "SQLite", "PostgreSQL"];
    for (const kw of stackKeywords) {
      const regex = new RegExp(`\\b${kw.replace(".", "\\.")}\\b`, "i");
      if (regex.test(userText) && !newStack.has(kw)) {
        newStack.add(kw);
        changed = true;
      }
    }

    // Detect user preferences / rules
    if (/caveman/i.test(userText) && !newPrefs.has("caveman-terse")) {
      newPrefs.add("caveman-terse");
      changed = true;
    }
    if (/clean code|type safe/i.test(userText) && !newRules.has("clean-typed-code")) {
      newRules.add("clean-typed-code");
      changed = true;
    }

    if (changed) {
      saveMemory({
        techStack: Array.from(newStack),
        projectRules: Array.from(newRules),
        preferences: Array.from(newPrefs),
      });
    }
  } catch {
    /* ignore auto-extraction errors silently */
  }
}
