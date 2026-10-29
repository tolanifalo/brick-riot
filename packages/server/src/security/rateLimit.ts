/** Token bucket: `ratePerSecond` refill, up to `burst` tokens. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now(), cost = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Per-key (e.g. per IP) fixed-window limiter with temporary blocking. */
export class KeyedLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly failures = new Map<string, { count: number; blockedUntil: number }>();

  constructor(
    private readonly limitPerWindow: number,
    private readonly windowMs: number,
    private readonly maxFailures: number,
    private readonly blockMs: number,
  ) {}

  /** Counts an attempt; false when over the window limit or blocked. */
  attempt(key: string, now = Date.now()): boolean {
    if (this.isBlocked(key, now)) return false;
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.limitPerWindow;
  }

  /** Records a failed guess; after `maxFailures` the key is blocked for `blockMs`. */
  fail(key: string, now = Date.now()): void {
    const f = this.failures.get(key) ?? { count: 0, blockedUntil: 0 };
    f.count++;
    if (f.count >= this.maxFailures) {
      f.blockedUntil = now + this.blockMs;
      f.count = 0;
    }
    this.failures.set(key, f);
  }

  isBlocked(key: string, now = Date.now()): boolean {
    const f = this.failures.get(key);
    return !!f && f.blockedUntil > now;
  }

  /** Housekeeping to keep memory bounded. */
  prune(now = Date.now()): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    for (const [k, f] of this.failures) if (f.blockedUntil <= now && f.count === 0) this.failures.delete(k);
  }
}
