export interface RequestLogEntry {
  id: number;
  timestamp: string;
  requestedModel: string | null;
  resolvedModel: string;
  keyLabel: string;
  status: number;
  latencyMs: number;
  error?: string;
  retried: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  savedCostUsd?: number;
}

export interface ModelStats {
  requests: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  savedCostUsd: number;
}

export interface ModelPricing {
  promptUsdPerM: number;
  completionUsdPerM: number;
}

/** Standard reference pricing table per 1M tokens ($ USD) */
const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  // Anthropic Official Rates
  "claude-3-5-sonnet": { promptUsdPerM: 3.0, completionUsdPerM: 15.0 },
  "claude-3-7-sonnet": { promptUsdPerM: 3.0, completionUsdPerM: 15.0 },
  "claude-3-opus": { promptUsdPerM: 15.0, completionUsdPerM: 75.0 },
  "claude-3-5-haiku": { promptUsdPerM: 0.8, completionUsdPerM: 4.0 },

  // NVIDIA NIM API Rates (Commercial equivalent)
  "meta/llama-3.3-70b-instruct": { promptUsdPerM: 0.7, completionUsdPerM: 0.9 },
  "nvidia/nemotron-4-340b-instruct": { promptUsdPerM: 1.2, completionUsdPerM: 1.6 },
  "deepseek-ai/deepseek-r1": { promptUsdPerM: 0.55, completionUsdPerM: 2.19 },

  // OpenCode & Public Endpoints
  "opencode/deepseek-v4-flash-free": { promptUsdPerM: 0.0, completionUsdPerM: 0.0 },
  "zcode/claude-3-5-sonnet": { promptUsdPerM: 0.0, completionUsdPerM: 0.0 },
};

/** Lookup model pricing per 1M tokens ($ USD). */
export function getModelPricing(modelId: string): ModelPricing {
  const lower = modelId.toLowerCase();
  for (const [key, price] of Object.entries(MODEL_PRICING_TABLE)) {
    if (lower.includes(key.toLowerCase())) {
      return price;
    }
  }

  if (lower.includes("free") || lower.startsWith("opencode") || lower.startsWith("zcode")) {
    return { promptUsdPerM: 0.0, completionUsdPerM: 0.0 };
  }
  if (lower.includes("haiku")) return { promptUsdPerM: 0.8, completionUsdPerM: 4.0 };
  if (lower.includes("opus")) return { promptUsdPerM: 15.0, completionUsdPerM: 75.0 };
  if (lower.includes("sonnet")) return { promptUsdPerM: 3.0, completionUsdPerM: 15.0 };
  if (lower.includes("llama")) return { promptUsdPerM: 0.7, completionUsdPerM: 0.9 };

  // Baseline default for custom providers
  return { promptUsdPerM: 1.0, completionUsdPerM: 3.0 };
}

/** Calculate real estimated API cost for given input/output token counts. */
export function calculateTokenCost(modelId: string, inputTokens: number = 0, outputTokens: number = 0): { estimatedCostUsd: number; savedCostUsd: number } {
  const pricing = getModelPricing(modelId);
  const cost = (inputTokens / 1_000_000) * pricing.promptUsdPerM + (outputTokens / 1_000_000) * pricing.completionUsdPerM;

  const lower = modelId.toLowerCase();
  const isFree = lower.includes(":free") || lower.startsWith("opencode") || lower.startsWith("zcode") || pricing.promptUsdPerM === 0;

  if (isFree) {
    const commercialBenchmark = { promptUsdPerM: 3.0, completionUsdPerM: 15.0 };
    const saved = (inputTokens / 1_000_000) * commercialBenchmark.promptUsdPerM + (outputTokens / 1_000_000) * commercialBenchmark.completionUsdPerM;
    return { estimatedCostUsd: 0.0, savedCostUsd: Number(saved.toFixed(6)) };
  }

  return { estimatedCostUsd: Number(cost.toFixed(6)), savedCostUsd: 0.0 };
}

export class TelemetryTracker {
  private logs: RequestLogEntry[] = [];
  private maxLogs = 100;
  private modelStatsMap = new Map<string, ModelStats>();

  recordRequest(entry: RequestLogEntry): void {
    const input = entry.inputTokens || 0;
    const output = entry.outputTokens || 0;
    const total = entry.totalTokens || (input + output);

    const costCalc = calculateTokenCost(entry.resolvedModel, input, output);
    entry.inputTokens = input;
    entry.outputTokens = output;
    entry.totalTokens = total;
    entry.estimatedCostUsd = costCalc.estimatedCostUsd;
    entry.savedCostUsd = costCalc.savedCostUsd;

    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    let stats = this.modelStatsMap.get(entry.resolvedModel);
    if (!stats) {
      stats = {
        requests: 0,
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        savedCostUsd: 0,
      };
      this.modelStatsMap.set(entry.resolvedModel, stats);
    }

    stats.requests++;
    stats.inputTokens += input;
    stats.outputTokens += output;
    stats.totalTokens += total;
    stats.estimatedCostUsd += costCalc.estimatedCostUsd;
    stats.savedCostUsd += costCalc.savedCostUsd;

    if (entry.status >= 200 && entry.status < 300) {
      stats.successes++;
      stats.totalLatencyMs += entry.latencyMs;
      stats.avgLatencyMs = Math.round(stats.totalLatencyMs / stats.successes);
    } else {
      stats.failures++;
    }
  }

  getLogs(): RequestLogEntry[] {
    return this.logs;
  }

  getLatencyHistory(): { timestamp: string; latencyMs: number; model: string; status: number }[] {
    return this.logs
      .slice(0, 30)
      .reverse()
      .map((l) => ({
        timestamp: l.timestamp.split("T")[1]?.slice(0, 8) ?? l.timestamp,
        latencyMs: l.latencyMs,
        model: l.resolvedModel,
        status: l.status,
      }));
  }

  getModelStats(): Record<string, ModelStats> {
    const result: Record<string, ModelStats> = {};
    for (const [m, stats] of this.modelStatsMap.entries()) {
      result[m] = { ...stats };
    }
    return result;
  }

  getTotals(): { totalRequests: number; totalInputTokens: number; totalOutputTokens: number; totalTokens: number; totalCostUsd: number; totalSavingsUsd: number } {
    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let totalSavingsUsd = 0;

    for (const stats of this.modelStatsMap.values()) {
      totalRequests += stats.requests;
      totalInputTokens += stats.inputTokens;
      totalOutputTokens += stats.outputTokens;
      totalTokens += stats.totalTokens;
      totalCostUsd += stats.estimatedCostUsd;
      totalSavingsUsd += stats.savedCostUsd;
    }

    return {
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      totalSavingsUsd: Number(totalSavingsUsd.toFixed(4)),
    };
  }

  clear(): void {
    this.logs = [];
    this.modelStatsMap.clear();
  }
}

export const globalTelemetry = new TelemetryTracker();
