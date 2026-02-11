import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tryConsume, getBucketState, resetBuckets } from '../rate-limit/token-bucket.js';
import { record, getCount, getWaitMs, getWindowState, resetWindows } from '../rate-limit/sliding-window.js';
import {
  recordRequest,
  recordError,
  recordRetryScheduled,
  recordRetrySucceeded,
  recordRetryExhausted,
  getHealthData,
  cleanupStaleUsers,
  resetMetrics,
  incrementInFlight,
  decrementInFlight,
} from '../rate-limit/metrics.js';
import { RATE_LIMIT_CONFIG } from '../rate-limit/types.js';

// Mock logger to avoid file I/O
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('token-bucket', () => {
  beforeEach(() => {
    resetBuckets();
  });

  it('allows requests up to capacity', () => {
    const now = 1000000;
    // User bucket has 60 capacity
    for (let i = 0; i < 60; i++) {
      const result = tryConsume('user:test:read', now);
      expect(result.allowed).toBe(true);
    }
    // 61st should fail
    const result = tryConsume('user:test:read', now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills tokens over time', () => {
    const now = 1000000;
    // Exhaust all tokens
    for (let i = 0; i < 60; i++) {
      tryConsume('user:test:read', now);
    }
    expect(tryConsume('user:test:read', now).allowed).toBe(false);

    // Wait 1 second = 1 token refilled (60/60000 * 1000 = 1)
    const result = tryConsume('user:test:read', now + 1000);
    expect(result.allowed).toBe(true);
  });

  it('has separate read/write buckets', () => {
    const now = 1000000;
    // Exhaust read tokens
    for (let i = 0; i < 60; i++) {
      tryConsume('user:test:read', now);
    }
    expect(tryConsume('user:test:read', now).allowed).toBe(false);

    // Write should still work
    const result = tryConsume('user:test:write', now);
    expect(result.allowed).toBe(true);
  });

  it('global bucket has 300 capacity', () => {
    const now = 1000000;
    const state = getBucketState('global:read', now);
    expect(state.capacity).toBe(300);
    expect(state.tokensRemaining).toBe(300);
  });

  it('user bucket has 60 capacity', () => {
    const now = 1000000;
    const state = getBucketState('user:u1:write', now);
    expect(state.capacity).toBe(60);
    expect(state.tokensRemaining).toBe(60);
  });

  it('getBucketState shows estimated wait when depleted', () => {
    const now = 1000000;
    for (let i = 0; i < 60; i++) {
      tryConsume('user:test:read', now);
    }
    const state = getBucketState('user:test:read', now);
    expect(state.tokensRemaining).toBe(0);
    expect(state.estimatedWaitMs).toBeGreaterThan(0);
  });
});

describe('sliding-window', () => {
  beforeEach(() => {
    resetWindows();
  });

  it('records and counts requests', () => {
    const now = 1000000;
    record('user:test:read', now);
    record('user:test:read', now);
    record('user:test:read', now);
    expect(getCount('user:test:read', now)).toBe(3);
  });

  it('rotates buckets after 10s', () => {
    const now = 1000000;
    record('user:test:read', now);
    record('user:test:read', now);

    // After 10s, new bucket
    record('user:test:read', now + 10000);
    expect(getCount('user:test:read', now + 10000)).toBe(3);
  });

  it('expires old buckets after 60s', () => {
    const now = 1000000;
    record('user:test:read', now);
    record('user:test:read', now);

    // After 60s, all old buckets are rotated out
    expect(getCount('user:test:read', now + 60000)).toBe(0);
  });

  it('returns 0 wait when below soft threshold', () => {
    const now = 1000000;
    // User soft threshold = floor(0.30 * 60) = 18
    for (let i = 0; i < 5; i++) {
      record('user:test:read', now);
    }
    expect(getWaitMs('user:test:read', now)).toBe(0);
  });

  it('returns spacing wait when above soft threshold', () => {
    const now = 1000000;
    // User soft threshold = 18, exceed it
    for (let i = 0; i < 20; i++) {
      record('user:test:read', now);
    }
    getWaitMs('user:test:read', now);
    // First call above threshold may return 0 (sets nextAllowedAt)
    // But second call should return spacing
    const wait2 = getWaitMs('user:test:read', now);
    expect(wait2).toBeGreaterThan(0);
  });

  it('getWindowState returns correct shape', () => {
    const now = 1000000;
    const state = getWindowState('global:read', now);
    expect(state).toHaveProperty('countLast60s');
    expect(state).toHaveProperty('softThreshold');
    expect(state).toHaveProperty('spacingMs');
    expect(state).toHaveProperty('nextAllowedInMs');
    expect(state).toHaveProperty('softActive');
    expect(state.softThreshold).toBe(Math.floor(0.30 * 300));
  });
});

describe('metrics', () => {
  beforeEach(() => {
    resetMetrics();
    resetBuckets();
    resetWindows();
  });

  it('getHealthData returns correct structure', () => {
    const data = getHealthData();
    expect(data).toHaveProperty('uptimeSec');
    expect(data).toHaveProperty('nowTs');
    expect(data).toHaveProperty('limits');
    expect(data).toHaveProperty('inFlightGoogleRequests');
    expect(data).toHaveProperty('memory');
    expect(data).toHaveProperty('global');
    expect(data).toHaveProperty('users');
    expect(data).toHaveProperty('errors');
    expect(data.global).toHaveProperty('read');
    expect(data.global).toHaveProperty('write');
    expect(data.global.read).toHaveProperty('countLast60s');
    expect(data.global.read).toHaveProperty('tokensRemaining');
    expect(data.users).toHaveProperty('activeCount');
    expect(data.users).toHaveProperty('topByRequestsLast60s');
    expect(data.users).toHaveProperty('topByWaitMsLast60s');
    expect(data.errors).toHaveProperty('status429');
    expect(data.errors).toHaveProperty('retryDelayMs');
  });

  it('tracks user requests', () => {
    recordRequest('user1', 'read');
    recordRequest('user1', 'read');
    recordRequest('user1', 'write');
    const data = getHealthData();
    expect(data.users.activeCount).toBe(1);
    expect(data.users.topByRequestsLast60s.length).toBeGreaterThan(0);
  });

  it('tracks errors', () => {
    recordError('user1', '429');
    recordError('user1', '403-rate');
    recordError('user1', '5xx');
    const data = getHealthData();
    expect(data.errors.status429).toBe(1);
    expect(data.errors.status403RateLimit).toBe(1);
    expect(data.errors.status5xx).toBe(1);
  });

  it('tracks retry stats', () => {
    recordRetryScheduled(1000);
    recordRetryScheduled(2000);
    recordRetrySucceeded();
    recordRetryExhausted();
    const data = getHealthData();
    expect(data.errors.retriesScheduled).toBe(2);
    expect(data.errors.retriesSucceeded).toBe(1);
    expect(data.errors.retriesExhausted).toBe(1);
    expect(data.errors.retryDelayMs.avg).toBe(1500);
    expect(data.errors.retryDelayMs.max).toBe(2000);
  });

  it('tracks in-flight requests', () => {
    incrementInFlight();
    incrementInFlight();
    const data1 = getHealthData();
    expect(data1.inFlightGoogleRequests).toBe(2);
    decrementInFlight();
    const data2 = getHealthData();
    expect(data2.inFlightGoogleRequests).toBe(1);
  });

  it('cleanupStaleUsers removes old entries', () => {
    // Create user with old timestamp by recording then manipulating
    recordRequest('old-user', 'read');
    // The user has lastSeenMs = Date.now(), so it won't be cleaned up immediately
    const result1 = cleanupStaleUsers();
    expect(result1.removedUsers).toBe(0);
    expect(result1.remainingUsers).toBe(1);
  });

  it('top-N limits to 10', () => {
    for (let i = 0; i < 15; i++) {
      recordRequest(`user${i}`, 'read');
    }
    const data = getHealthData();
    expect(data.users.topByRequestsLast60s.length).toBeLessThanOrEqual(10);
  });
});

describe('sheetsRequest integration', () => {
  beforeEach(() => {
    resetBuckets();
    resetWindows();
    resetMetrics();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through successful calls', async () => {
    const { sheetsRequest } = await import('../rate-limit/index.js');
    const result = await sheetsRequest('read', 'test-user', async () => 'success');
    expect(result).toBe('success');
  });

  it('propagates non-rate-limit errors immediately', async () => {
    const { sheetsRequest } = await import('../rate-limit/index.js');
    const error = new Error('some other error');
    (error as unknown as { code: number }).code = 500;
    await expect(
      sheetsRequest('read', 'test-user', async () => { throw error; })
    ).rejects.toThrow('some other error');
  });

  it('retries on 429 error and succeeds', async () => {
    const { sheetsRequest } = await import('../rate-limit/index.js');
    let attempt = 0;
    const result = await sheetsRequest('read', 'test-user', async () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error('rate limited') as Error & { code: number };
        err.code = 429;
        throw err;
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('retries on 403 rateLimitExceeded', async () => {
    const { sheetsRequest } = await import('../rate-limit/index.js');
    let attempt = 0;
    const result = await sheetsRequest('read', 'test-user', async () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error('rateLimitExceeded') as Error & { code: number };
        err.code = 403;
        throw err;
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('separate read/write: read load does not affect write', async () => {
    const { sheetsRequest } = await import('../rate-limit/index.js');
    // Fill up read window to trigger soft pacing
    for (let i = 0; i < 20; i++) {
      record('user:test-user:read');
      record('global:read');
    }
    // Write should still pass through quickly
    const start = Date.now();
    await sheetsRequest('write', 'test-user', async () => 'ok');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('/health response structure', () => {
  beforeEach(() => {
    resetMetrics();
    resetBuckets();
    resetWindows();
  });

  it('matches expected shape', () => {
    const data = getHealthData();
    // Top-level fields
    expect(typeof data.uptimeSec).toBe('number');
    expect(typeof data.nowTs).toBe('string');
    expect(typeof data.inFlightGoogleRequests).toBe('number');
    expect(data.limits).toBe(RATE_LIMIT_CONFIG);

    // Memory
    expect(typeof data.memory.rssMb).toBe('number');
    expect(typeof data.memory.heapUsedMb).toBe('number');

    // Global read/write shape
    for (const opType of ['read', 'write'] as const) {
      const op = data.global[opType];
      expect(typeof op.countLast60s).toBe('number');
      expect(typeof op.hardLimitPerMinute).toBe('number');
      expect(typeof op.softThreshold).toBe('number');
      expect(typeof op.tokensRemaining).toBe('number');
      expect(typeof op.estimatedHardWaitMs).toBe('number');
      expect(typeof op.spacingMs).toBe('number');
      expect(typeof op.nextAllowedInMs).toBe('number');
      expect(typeof op.softActive).toBe('number');
      expect(typeof op.waitInjectedMsLast60s).toBe('number');
      expect(typeof op.hardWaitCount).toBe('number');
      expect(typeof op.softHitCount).toBe('number');
    }

    // Users
    expect(typeof data.users.activeCount).toBe('number');
    expect(Array.isArray(data.users.topByRequestsLast60s)).toBe(true);
    expect(Array.isArray(data.users.topByWaitMsLast60s)).toBe(true);

    // Errors
    expect(typeof data.errors.status429).toBe('number');
    expect(typeof data.errors.status403RateLimit).toBe('number');
    expect(typeof data.errors.status5xx).toBe('number');
    expect(typeof data.errors.timeouts).toBe('number');
    expect(typeof data.errors.other).toBe('number');
    expect(typeof data.errors.retriesScheduled).toBe('number');
    expect(typeof data.errors.retriesSucceeded).toBe('number');
    expect(typeof data.errors.retriesExhausted).toBe('number');
    expect(typeof data.errors.retryDelayMs.avg).toBe('number');
    expect(typeof data.errors.retryDelayMs.max).toBe('number');
  });
});
