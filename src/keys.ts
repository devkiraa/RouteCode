/**
 * OpenRouter key pool with health tracking and failover ordering.
 *
 * Rules:
 *  - Every request asks for an ordered list of candidate keys (pickOrder).
 *  - Healthy keys always come before keys currently in cooldown.
 *  - A failing key gets an exponential cooldown (base * 2^n, capped).
 *  - Success resets a key's failure streak and advances the round-robin cursor.
 */
export interface KeyState {
  key: string;
  label: string;
  consecutiveFailures: number;
  cooldownUntil: number; // epoch ms; 0 = no cooldown
  successes: number;
  failures: number;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitResetMs?: number;
  emaLatencyMs?: number;
  predictiveScore?: number;
  limitRemaining?: number | null;
  usageDaily?: number;
  usageMonthly?: number;
  isFreeTier?: boolean;
  dailyReqLimit?: number;
  lastCheckedMs?: number;
}

export interface KeyPoolOptions {
  /** true = rotate the starting key each request; false = always start at the first key. */
  roundRobin: boolean;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
}

export class KeyPool {
  private states: KeyState[];
  private cursor = 0;
  private readonly opts: KeyPoolOptions;

  constructor(keys: string[], opts?: Partial<KeyPoolOptions>) {
    this.opts = {
      roundRobin: true,
      cooldownBaseMs: 10_000,
      cooldownMaxMs: 300_000,
      ...opts,
    };
    this.states = keys.map((key, i) => ({
      key,
      label: `key#${i + 1} (…${key.slice(-4)})`,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      successes: 0,
      failures: 0,
    }));
  }

  get size(): number {
    return this.states.length;
  }

  list(): KeyState[] {
    return this.states.map((s) => ({
      ...s,
      predictiveScore: this.calculatePredictiveScore(s),
    }));
  }

  isHealthy(s: KeyState): boolean {
    return Date.now() >= s.cooldownUntil;
  }

  calculatePredictiveScore(s: KeyState): number {
    const now = Date.now();
    if (now < s.cooldownUntil) return 0;

    let score = 100;

    // Credit limit zero -> 402 Payment Required imminent
    if (typeof s.limitRemaining === "number" && s.limitRemaining <= 0) {
      return 0;
    }

    // Deduct for active rate limit depletion
    if (typeof s.rateLimitRemaining === "number" && s.rateLimitRemaining === 0) {
      if (s.rateLimitResetMs && now < s.rateLimitResetMs) {
        score -= 85;
      }
    } else if (typeof s.rateLimitRemaining === "number" && typeof s.rateLimitLimit === "number" && s.rateLimitLimit > 0) {
      const remainingRatio = s.rateLimitRemaining / s.rateLimitLimit;
      if (remainingRatio < 0.2) score -= 30;
    }

    // Prefer paid tier keys (higher request limit: 1000/day vs 50/day)
    if (s.isFreeTier === false) {
      score += 15;
    }

    // Deduct for failure history & latency
    score -= s.consecutiveFailures * 25;
    if (s.emaLatencyMs) {
      score -= Math.min(30, Math.round(s.emaLatencyMs / 100));
    }

    return Math.max(0, Math.round(score));
  }

  /** Ordered candidates for one request: sorted by predictive score descending. */
  pickOrder(): KeyState[] {
    const healthy: KeyState[] = [];
    const cooling: KeyState[] = [];
    const n = this.states.length;

    for (let i = 0; i < n; i++) {
      const s = this.states[this.opts.roundRobin ? (this.cursor + i) % n : i];
      (this.isHealthy(s) ? healthy : cooling).push(s);
    }

    // Sort healthy keys by predictive score descending
    healthy.sort((a, b) => this.calculatePredictiveScore(b) - this.calculatePredictiveScore(a));
    cooling.sort((a, b) => a.cooldownUntil - b.cooldownUntil);

    return [...healthy, ...cooling];
  }

  recordSuccess(s: KeyState, latencyMs?: number): void {
    s.consecutiveFailures = 0;
    s.successes++;
    if (typeof latencyMs === "number" && latencyMs > 0) {
      s.emaLatencyMs = s.emaLatencyMs ? Math.round(s.emaLatencyMs * 0.7 + latencyMs * 0.3) : latencyMs;
    }
    if (this.opts.roundRobin) {
      const i = this.states.indexOf(s);
      if (i >= 0) this.cursor = (i + 1) % this.states.length;
    }
  }

  recordFailure(s: KeyState): void {
    s.consecutiveFailures++;
    s.failures++;
    const backoff = Math.min(
      this.opts.cooldownMaxMs,
      this.opts.cooldownBaseMs * 2 ** Math.max(0, s.consecutiveFailures - 1),
    );
    s.cooldownUntil = Date.now() + backoff;
  }

  recordRateLimit(s: KeyState, headers: Headers): void {
    const limit = headers.get("x-ratelimit-limit-requests") ?? headers.get("x-ratelimit-limit");
    const remaining = headers.get("x-ratelimit-remaining-requests") ?? headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset") ?? headers.get("retry-after");

    if (limit && !isNaN(Number(limit))) {
      s.rateLimitLimit = Number(limit);
    }
    if (remaining && !isNaN(Number(remaining))) {
      s.rateLimitRemaining = Number(remaining);
    }
    if (reset) {
      const resetVal = Number(reset);
      if (!isNaN(resetVal)) {
        // If reset is relative seconds or unix timestamp
        s.rateLimitResetMs = resetVal > 1_000_000_000_000 ? resetVal : Date.now() + resetVal * 1000;
      }
    }
  }

  async probeKey(s: KeyState, openrouterBaseUrl: string): Promise<void> {
    try {
      const res = await fetch(`${openrouterBaseUrl}/v1/key`, {
        headers: { authorization: `Bearer ${s.key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: {
            is_free_tier?: boolean;
            limit_remaining?: number | null;
            usage_daily?: number;
            usage_monthly?: number;
          };
        };
        if (body.data) {
          s.isFreeTier = Boolean(body.data.is_free_tier);
          s.dailyReqLimit = s.isFreeTier ? 50 : 1000;
          s.limitRemaining = typeof body.data.limit_remaining === "number" ? body.data.limit_remaining : null;
          s.usageDaily = typeof body.data.usage_daily === "number" ? body.data.usage_daily : 0;
          s.usageMonthly = typeof body.data.usage_monthly === "number" ? body.data.usage_monthly : 0;
          s.lastCheckedMs = Date.now();
        }
      } else if (res.status === 402) {
        s.limitRemaining = 0;
        s.lastCheckedMs = Date.now();
      }
    } catch {
      /* ignore timeout / unreachable endpoints silently */
    }
  }

  async probeAllKeys(openrouterBaseUrl: string): Promise<void> {
    await Promise.allSettled(this.states.map((s) => this.probeKey(s, openrouterBaseUrl)));
  }

  reset(): void {
    this.cursor = 0;
    for (const s of this.states) {
      s.consecutiveFailures = 0;
      s.cooldownUntil = 0;
      s.successes = 0;
      s.failures = 0;
      delete s.limitRemaining;
      delete s.rateLimitRemaining;
      delete s.rateLimitLimit;
      delete s.rateLimitResetMs;
      delete s.emaLatencyMs;
      delete s.isFreeTier;
      delete s.usageDaily;
      delete s.usageMonthly;
      delete s.dailyReqLimit;
      delete s.lastCheckedMs;
    }
  }

  updateKeys(keys: string[]): void {
    const existingMap = new Map(this.states.map((s) => [s.key, s]));
    this.states = keys.map((key, i) => {
      const existing = existingMap.get(key);
      if (existing) {
        return {
          ...existing,
          label: `key#${i + 1} (…${key.slice(-4)})`,
        };
      }
      return {
        key,
        label: `key#${i + 1} (…${key.slice(-4)})`,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        successes: 0,
        failures: 0,
      };
    });
    if (this.cursor >= this.states.length) {
      this.cursor = 0;
    }
  }
}
