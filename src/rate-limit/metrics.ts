import crypto from 'node:crypto';
import { RATE_LIMIT_CONFIG, globalKey, type OpType } from './types.js';
import { getBucketState } from './token-bucket.js';
import { getWindowState } from './sliding-window.js';

interface UserMetrics {
  lastSeenMs: number;
  requests: { read: number; write: number };
  retries: number;
  waitMs: { read: number; write: number };
}

interface ErrorCounters {
  status429: number;
  status403RateLimit: number;
  status5xx: number;
  timeouts: number;
  other: number;
  retriesScheduled: number;
  retriesSucceeded: number;
  retriesExhausted: number;
  retryDelayMsTotal: number;
  retryDelayMsMax: number;
  retryDelayMsCount: number;
}

export type ErrorCategory = '429' | '403-rate' | '5xx' | 'timeout' | 'other';

const users = new Map<string, UserMetrics>();
const errors: ErrorCounters = {
  status429: 0,
  status403RateLimit: 0,
  status5xx: 0,
  timeouts: 0,
  other: 0,
  retriesScheduled: 0,
  retriesSucceeded: 0,
  retriesExhausted: 0,
  retryDelayMsTotal: 0,
  retryDelayMsMax: 0,
  retryDelayMsCount: 0,
};

let _inFlightRequests = 0;
const startTimeMs = Date.now();

// Per-key counters for wait/hit tracking within last 60s
const waitInjected = new Map<string, number>();
const hardWaitCounts = new Map<string, number>();
const softHitCounts = new Map<string, number>();

function getOrCreateUser(userId: string, nowMs: number): UserMetrics {
  let m = users.get(userId);
  if (!m) {
    m = { lastSeenMs: nowMs, requests: { read: 0, write: 0 }, retries: 0, waitMs: { read: 0, write: 0 } };
    users.set(userId, m);
  }
  return m;
}

function hashUserId(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12);
}

export function recordRequest(userId: string, opType: OpType): void {
  const m = getOrCreateUser(userId, Date.now());
  m.lastSeenMs = Date.now();
  m.requests[opType]++;
}

export function recordRetry(userId: string): void {
  const m = getOrCreateUser(userId, Date.now());
  m.lastSeenMs = Date.now();
  m.retries++;
}

export function recordError(_userId: string, category: ErrorCategory): void {
  switch (category) {
    case '429': errors.status429++; break;
    case '403-rate': errors.status403RateLimit++; break;
    case '5xx': errors.status5xx++; break;
    case 'timeout': errors.timeouts++; break;
    case 'other': errors.other++; break;
  }
}

export function recordRetryScheduled(delayMs: number): void {
  errors.retriesScheduled++;
  errors.retryDelayMsTotal += delayMs;
  errors.retryDelayMsCount++;
  if (delayMs > errors.retryDelayMsMax) errors.retryDelayMsMax = delayMs;
}

export function recordRetrySucceeded(): void {
  errors.retriesSucceeded++;
}

export function recordRetryExhausted(): void {
  errors.retriesExhausted++;
}

export function recordWaitInjected(scope: string, waitMs: number): void {
  waitInjected.set(scope, (waitInjected.get(scope) || 0) + waitMs);
}

export function recordHardWait(scope: string): void {
  hardWaitCounts.set(scope, (hardWaitCounts.get(scope) || 0) + 1);
}

export function recordSoftHit(scope: string): void {
  softHitCounts.set(scope, (softHitCounts.get(scope) || 0) + 1);
}

export function recordUserWait(userId: string, opType: OpType, waitMs: number): void {
  const m = getOrCreateUser(userId, Date.now());
  m.waitMs[opType] += waitMs;
}

export function incrementInFlight(): void { _inFlightRequests++; }
export function decrementInFlight(): void { _inFlightRequests = Math.max(0, _inFlightRequests - 1); }

export function cleanupStaleUsers(): { removedUsers: number; remainingUsers: number } {
  const nowMs = Date.now();
  let removed = 0;
  for (const [userId, m] of users) {
    if (nowMs - m.lastSeenMs > RATE_LIMIT_CONFIG.userTtlMs) {
      users.delete(userId);
      removed++;
    }
  }
  return { removedUsers: removed, remainingUsers: users.size };
}

function buildOpMetrics(opType: OpType) {
  const gKey = globalKey(opType);
  const bucketState = getBucketState(gKey);
  const windowState = getWindowState(gKey);
  const scope = `global:${opType}`;

  return {
    countLast10s: 0, // approximation not tracked separately
    countLast60s: windowState.countLast60s,
    hardLimitPerMinute: opType === 'read'
      ? RATE_LIMIT_CONFIG.hardGlobalPerMinute
      : RATE_LIMIT_CONFIG.hardGlobalPerMinute,
    softThreshold: windowState.softThreshold,
    tokensRemaining: bucketState.tokensRemaining,
    estimatedHardWaitMs: bucketState.estimatedWaitMs,
    spacingMs: windowState.spacingMs,
    nextAllowedInMs: windowState.nextAllowedInMs,
    softActive: windowState.softActive ? 1 : 0,
    waitInjectedMsLast60s: waitInjected.get(scope) || 0,
    hardWaitCount: hardWaitCounts.get(scope) || 0,
    softHitCount: softHitCounts.get(scope) || 0,
  };
}

export function getHealthData() {
  const nowMs = Date.now();

  // Top-10 users by requests
  const userEntries = Array.from(users.entries()).map(([userId, m]) => ({
    userIdHash: hashUserId(userId),
    metrics: m,
  }));

  const topByRequests = userEntries
    .flatMap(({ userIdHash, metrics }) => [
      { userIdHash, opType: 'read' as OpType, countLast60s: metrics.requests.read },
      { userIdHash, opType: 'write' as OpType, countLast60s: metrics.requests.write },
    ])
    .filter((e) => e.countLast60s > 0)
    .sort((a, b) => b.countLast60s - a.countLast60s)
    .slice(0, 10);

  const topByWait = userEntries
    .flatMap(({ userIdHash, metrics }) => [
      { userIdHash, opType: 'read' as OpType, waitMs: metrics.waitMs.read },
      { userIdHash, opType: 'write' as OpType, waitMs: metrics.waitMs.write },
    ])
    .filter((e) => e.waitMs > 0)
    .sort((a, b) => b.waitMs - a.waitMs)
    .slice(0, 10);

  const retryAvg = errors.retryDelayMsCount > 0
    ? Math.round(errors.retryDelayMsTotal / errors.retryDelayMsCount)
    : 0;

  const mem = process.memoryUsage();

  return {
    uptimeSec: Math.floor((nowMs - startTimeMs) / 1000),
    nowTs: new Date(nowMs).toISOString(),
    limits: RATE_LIMIT_CONFIG,
    inFlightGoogleRequests: _inFlightRequests,
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    global: {
      read: buildOpMetrics('read'),
      write: buildOpMetrics('write'),
    },
    users: {
      activeCount: users.size,
      topByRequestsLast60s: topByRequests,
      topByWaitMsLast60s: topByWait,
    },
    errors: {
      status429: errors.status429,
      status403RateLimit: errors.status403RateLimit,
      status5xx: errors.status5xx,
      timeouts: errors.timeouts,
      other: errors.other,
      retriesScheduled: errors.retriesScheduled,
      retriesSucceeded: errors.retriesSucceeded,
      retriesExhausted: errors.retriesExhausted,
      retryDelayMs: {
        avg: retryAvg,
        max: errors.retryDelayMsMax,
      },
    },
  };
}

/** Reset all metrics (for testing) */
export function resetMetrics(): void {
  users.clear();
  _inFlightRequests = 0;
  errors.status429 = 0;
  errors.status403RateLimit = 0;
  errors.status5xx = 0;
  errors.timeouts = 0;
  errors.other = 0;
  errors.retriesScheduled = 0;
  errors.retriesSucceeded = 0;
  errors.retriesExhausted = 0;
  errors.retryDelayMsTotal = 0;
  errors.retryDelayMsMax = 0;
  errors.retryDelayMsCount = 0;
  waitInjected.clear();
  hardWaitCounts.clear();
  softHitCounts.clear();
}
