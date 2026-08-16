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

export function getMemoryPath(): string {
  return process.env.ROUTECODE_MEMORY_PATH ?? DEFAULT_MEMORY_PATH;
}

export function loadMemory(): MemoryStore {
  const filePath = getMemoryPath();
  if (!existsSync(filePath)) {
    return {
      projectRules: [
        "Keep responses concise and direct.",
        "Prioritize clean code with strict type safety.",
      ],
      techStack: [],
      preferences: [],
      customNotes: "",
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    return {
      projectRules: Array.isArray(json.projectRules) ? json.projectRules : [],
      techStack: Array.isArray(json.techStack) ? json.techStack : [],
      preferences: Array.isArray(json.preferences) ? json.preferences : [],
      customNotes: typeof json.customNotes === "string" ? json.customNotes : "",
      updatedAt: json.updatedAt || new Date().toISOString(),
    };
  } catch (err) {
    return {
      projectRules: [],
      techStack: [],
      preferences: [],
      customNotes: "",
      updatedAt: new Date().toISOString(),
    };
  }
}

export function saveMemory(memory: Partial<MemoryStore>): MemoryStore {
  const current = loadMemory();
  const updated: MemoryStore = {
    projectRules: Array.isArray(memory.projectRules) ? memory.projectRules : current.projectRules,
    techStack: Array.isArray(memory.techStack) ? memory.techStack : current.techStack,
    preferences: Array.isArray(memory.preferences) ? memory.preferences : current.preferences,
    customNotes: typeof memory.customNotes === "string" ? memory.customNotes : current.customNotes,
    updatedAt: new Date().toISOString(),
  };

  const filePath = getMemoryPath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

/** Formats memory store into a compact system prompt fragment. */
export function formatMemorySystemPrompt(mem?: MemoryStore): string {
  const memory = mem ?? loadMemory();
  const lines: string[] = ["<routecode_memory>"];

  if (memory.projectRules.length > 0) {
    lines.push("Project Rules:");
    memory.projectRules.forEach((r) => lines.push(`- ${r}`));
  }

  if (memory.techStack.length > 0) {
    lines.push(`Tech Stack: ${memory.techStack.join(", ")}`);
  }

  if (memory.preferences.length > 0) {
    lines.push(`Preferences: ${memory.preferences.join(", ")}`);
  }

  if (memory.customNotes.trim()) {
    lines.push(`Notes: ${memory.customNotes.trim()}`);
  }

  lines.push("</routecode_memory>");
  return lines.join("\n");
}

/** Inject memory prompt fragment into system string or array. */
export function injectMemoryIntoSystem(system: unknown): string | Array<{ type: string; text: string }> {
  const memoryPrompt = formatMemorySystemPrompt();

  if (!system) {
    return memoryPrompt;
  }

  if (typeof system === "string") {
    return `${memoryPrompt}\n\n${system}`;
  }

  if (Array.isArray(system)) {
    return [
      { type: "text", text: memoryPrompt },
      ...system,
    ];
  }

  return memoryPrompt;
}
