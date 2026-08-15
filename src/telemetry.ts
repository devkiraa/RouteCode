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
}

export interface ModelStats {
  requests: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
}

export class TelemetryTracker {
  private logs: RequestLogEntry[] = [];
  private maxLogs = 100;
  private modelStatsMap = new Map<string, ModelStats>();

  recordRequest(entry: RequestLogEntry): void {
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    let stats = this.modelStatsMap.get(entry.resolvedModel);
    if (!stats) {
      stats = { requests: 0, successes: 0, failures: 0, totalLatencyMs: 0, avgLatencyMs: 0 };
      this.modelStatsMap.set(entry.resolvedModel, stats);
    }

    stats.requests++;
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

  clear(): void {
    this.logs = [];
    this.modelStatsMap.clear();
  }
}

export const globalTelemetry = new TelemetryTracker();
