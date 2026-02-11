import { RATE_LIMIT_CONFIG, type RateLimitKey } from './types.js';

interface Bucket {
  tokens: number;
  maxTokens: number;
  lastRefillMs: number;
  refillRatePerMs: number;
}

const buckets = new Map<RateLimitKey, Bucket>();

function getCapacity(key: RateLimitKey): number {
  return key.startsWith('global:')
    ? RATE_LIMIT_CONFIG.hardGlobalPerMinute
    : RATE_LIMIT_CONFIG.hardUserPerMinute;
}

function getOrCreateBucket(key: RateLimitKey, nowMs: number): Bucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    const capacity = getCapacity(key);
    bucket = {
      tokens: capacity,
      maxTokens: capacity,
      lastRefillMs: nowMs,
      refillRatePerMs: capacity / 60000,
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function refill(bucket: Bucket, nowMs: number): void {
  const elapsed = nowMs - bucket.lastRefillMs;
  if (elapsed <= 0) return;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRatePerMs);
  bucket.lastRefillMs = nowMs;
}

export function tryConsume(
  key: RateLimitKey,
  nowMs: number = Date.now()
): { allowed: boolean; retryAfterMs?: number } {
  const bucket = getOrCreateBucket(key, nowMs);
  refill(bucket, nowMs);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  // Calculate time until 1 token is available
  const retryAfterMs = Math.ceil((1 - bucket.tokens) / bucket.refillRatePerMs);
  return { allowed: false, retryAfterMs };
}

/** Get current state for health/metrics */
export function getBucketState(key: RateLimitKey, nowMs: number = Date.now()): {
  tokensRemaining: number;
  capacity: number;
  estimatedWaitMs: number;
} {
  const bucket = buckets.get(key);
  if (!bucket) {
    const capacity = getCapacity(key);
    return { tokensRemaining: capacity, capacity, estimatedWaitMs: 0 };
  }
  // Simulate refill without mutating
  const elapsed = nowMs - bucket.lastRefillMs;
  const tokens = Math.min(bucket.maxTokens, bucket.tokens + Math.max(0, elapsed) * bucket.refillRatePerMs);
  const estimatedWaitMs = tokens >= 1 ? 0 : Math.ceil((1 - tokens) / bucket.refillRatePerMs);
  return { tokensRemaining: Math.floor(tokens), capacity: bucket.maxTokens, estimatedWaitMs };
}

/** Reset all buckets (for testing) */
export function resetBuckets(): void {
  buckets.clear();
}
