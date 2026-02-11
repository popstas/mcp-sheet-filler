export type OpType = 'read' | 'write';

export type RateLimitKey =
  | 'global:read'
  | 'global:write'
  | `user:${string}:read`
  | `user:${string}:write`;

export const RATE_LIMIT_CONFIG = {
  /** Fraction of hard limit where soft pacing kicks in */
  softStartRatio: 0.30,

  /** Per-user hard limit (requests per minute) */
  hardUserPerMinute: 60,

  /** Per-project (global) hard limit (requests per minute) */
  hardGlobalPerMinute: 300,

  /** Minimum spacing between requests when pacing is active (ms) */
  pacingMinMs: 200,

  /** Maximum spacing between requests when pacing is active (ms) */
  pacingMaxMs: 2000,

  /** Jitter range for wait times */
  jitterMin: 0.8,
  jitterMax: 1.2,

  /** Maximum retry attempts for rate-limit errors */
  retryAttempts: 6,

  /** Base delay for exponential backoff on retry (ms) */
  retryBaseDelayMs: 1000,

  /** Maximum delay for exponential backoff on retry (ms) */
  retryMaxDelayMs: 32000,

  /** Time budget per sheetsRequest call (ms) */
  timeBudgetMs: 55000,

  /** TTL for stale user metrics cleanup (ms) */
  userTtlMs: 20 * 60 * 1000,

  /** Sliding window duration (ms) */
  windowMs: 60000,

  /** Number of buckets in sliding window */
  windowBuckets: 6,

  /** Duration per sliding window bucket (ms) */
  windowBucketMs: 10000,
} as const;

export function userKey(userId: string, opType: OpType): RateLimitKey {
  return `user:${userId}:${opType}`;
}

export function globalKey(opType: OpType): RateLimitKey {
  return `global:${opType}`;
}
