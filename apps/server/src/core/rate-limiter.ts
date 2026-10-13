import { systemClock, type Clock } from "./util.js";

export interface BucketConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface TakeResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until one token is available (0 when allowed). */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Keyed token-bucket rate limiter. Buckets refill continuously; idle buckets
 * that would be full anyway are pruned so memory stays bounded by the number
 * of recently active keys (and hard-capped by `maxKeys`).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastPrune: number;

  constructor(
    private readonly config: BucketConfig,
    private readonly clock: Clock = systemClock,
    private readonly maxKeys = 50_000,
  ) {
    this.lastPrune = clock.now();
  }

  take(key: string, cost = 1): TakeResult {
    const now = this.clock.now();
    this.maybePrune(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      bucket = { tokens: this.config.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(this.config.capacity, bucket.tokens + elapsed * this.config.refillPerSecond);
      bucket.updatedAt = now;
      // Refresh insertion order so eviction removes least-recently used keys.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    }
    const deficit = cost - bucket.tokens;
    return { allowed: false, remaining: 0, retryAfterSeconds: deficit / this.config.refillPerSecond };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictOldest(): void {
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }

  private maybePrune(now: number): void {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const fullAfterMs = (this.config.capacity / this.config.refillPerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) this.buckets.delete(key);
    }
  }
}
