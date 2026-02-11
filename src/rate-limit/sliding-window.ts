import { RATE_LIMIT_CONFIG, type RateLimitKey } from './types.js';

interface WindowState {
  buckets: number[];
  currentBucketIndex: number;
  currentBucketStartMs: number;
  nextAllowedAtMs: number;
}

const windows = new Map<RateLimitKey, WindowState>();

function getHardLimit(key: RateLimitKey): number {
  return key.startsWith('global:')
    ? RATE_LIMIT_CONFIG.hardGlobalPerMinute
    : RATE_LIMIT_CONFIG.hardUserPerMinute;
}

function getOrCreate(key: RateLimitKey, nowMs: number): WindowState {
  let state = windows.get(key);
  if (!state) {
    state = {
      buckets: new Array(RATE_LIMIT_CONFIG.windowBuckets).fill(0),
      currentBucketIndex: 0,
      currentBucketStartMs: nowMs,
      nextAllowedAtMs: 0,
    };
    windows.set(key, state);
  }
  return state;
}

function rotateBuckets(state: WindowState, nowMs: number): void {
  const elapsed = nowMs - state.currentBucketStartMs;
  if (elapsed < RATE_LIMIT_CONFIG.windowBucketMs) return;

  const bucketsToAdvance = Math.min(
    Math.floor(elapsed / RATE_LIMIT_CONFIG.windowBucketMs),
    RATE_LIMIT_CONFIG.windowBuckets
  );

  for (let i = 0; i < bucketsToAdvance; i++) {
    state.currentBucketIndex = (state.currentBucketIndex + 1) % RATE_LIMIT_CONFIG.windowBuckets;
    state.buckets[state.currentBucketIndex] = 0;
  }

  state.currentBucketStartMs += bucketsToAdvance * RATE_LIMIT_CONFIG.windowBucketMs;
}

export function record(key: RateLimitKey, nowMs: number = Date.now()): void {
  const state = getOrCreate(key, nowMs);
  rotateBuckets(state, nowMs);
  state.buckets[state.currentBucketIndex]++;
}

export function getCount(key: RateLimitKey, nowMs: number = Date.now()): number {
  const state = windows.get(key);
  if (!state) return 0;
  rotateBuckets(state, nowMs);
  return state.buckets.reduce((sum, v) => sum + v, 0);
}

export function getWaitMs(key: RateLimitKey, nowMs: number = Date.now()): number {
  const state = getOrCreate(key, nowMs);
  rotateBuckets(state, nowMs);

  const hardLimit = getHardLimit(key);
  const softThreshold = Math.floor(RATE_LIMIT_CONFIG.softStartRatio * hardLimit);
  const count = state.buckets.reduce((sum, v) => sum + v, 0);

  if (count < softThreshold) {
    return 0;
  }

  // Calculate spacing based on remaining capacity
  const spacingMs = Math.min(
    RATE_LIMIT_CONFIG.pacingMaxMs,
    Math.max(RATE_LIMIT_CONFIG.pacingMinMs, Math.ceil(60000 / hardLimit))
  );

  const waitUntil = Math.max(nowMs, state.nextAllowedAtMs);
  const waitMs = Math.max(0, waitUntil - nowMs);
  state.nextAllowedAtMs = waitUntil + spacingMs;

  return waitMs;
}

/** Get current state for health/metrics */
export function getWindowState(key: RateLimitKey, nowMs: number = Date.now()): {
  countLast60s: number;
  softThreshold: number;
  spacingMs: number;
  nextAllowedInMs: number;
  softActive: boolean;
} {
  const hardLimit = getHardLimit(key);
  const softThreshold = Math.floor(RATE_LIMIT_CONFIG.softStartRatio * hardLimit);
  const count = getCount(key, nowMs);
  const state = windows.get(key);
  const nextAllowedInMs = state ? Math.max(0, state.nextAllowedAtMs - nowMs) : 0;
  const spacingMs = Math.min(
    RATE_LIMIT_CONFIG.pacingMaxMs,
    Math.max(RATE_LIMIT_CONFIG.pacingMinMs, Math.ceil(60000 / hardLimit))
  );

  return {
    countLast60s: count,
    softThreshold,
    spacingMs,
    nextAllowedInMs,
    softActive: count >= softThreshold,
  };
}

/** Reset all windows (for testing) */
export function resetWindows(): void {
  windows.clear();
}
