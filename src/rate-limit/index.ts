import { FillerError } from '../types.js';
import { logger } from '../logger.js';
import {
  RATE_LIMIT_CONFIG,
  globalKey,
  userKey,
  type OpType,
} from './types.js';
import { tryConsume } from './token-bucket.js';
import { record, getWaitMs } from './sliding-window.js';
import {
  recordRequest,
  recordRetry,
  recordError,
  recordRetryScheduled,
  recordRetrySucceeded,
  recordRetryExhausted,
  recordWaitInjected,
  recordHardWait,
  recordSoftHit,
  recordUserWait,
  incrementInFlight,
  decrementInFlight,
  type ErrorCategory,
} from './metrics.js';

function applyJitter(ms: number): number {
  if (ms <= 0) return 0;
  const factor = RATE_LIMIT_CONFIG.jitterMin +
    Math.random() * (RATE_LIMIT_CONFIG.jitterMax - RATE_LIMIT_CONFIG.jitterMin);
  return Math.round(ms * factor);
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; status?: number; errors?: Array<{ reason?: string }>; message?: string };
  const status = e.code || e.status;
  if (status === 429) return true;
  if (status === 403) {
    const reasons = e.errors?.map((r) => r.reason) || [];
    if (reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded')) return true;
    const msg = e.message || '';
    if (msg.includes('rateLimitExceeded') || msg.includes('userRateLimitExceeded')) return true;
  }
  return false;
}

function categorizeError(err: unknown): ErrorCategory {
  if (!err || typeof err !== 'object') return 'other';
  const e = err as { code?: number; status?: number; errors?: Array<{ reason?: string }>; message?: string };
  const status = e.code || e.status;
  if (status === 429) return '429';
  if (status === 403) {
    const reasons = e.errors?.map((r) => r.reason) || [];
    if (reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded')) return '403-rate';
  }
  if (status && status >= 500 && status < 600) return '5xx';
  return 'other';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sheetsRequest<T>(
  opType: OpType,
  userId: string,
  fn: () => Promise<T>
): Promise<T> {
  const startTs = Date.now();
  incrementInFlight();

  const gKey = globalKey(opType);
  const uKey = userKey(userId, opType);

  let lastError: unknown;

  try {
    for (let attempt = 1; attempt <= RATE_LIMIT_CONFIG.retryAttempts; attempt++) {
      const nowMs = Date.now();

      // Soft pacing
      const waitSoftGlobal = getWaitMs(gKey, nowMs);
      const waitSoftUser = getWaitMs(uKey, nowMs);
      let waitSoftMs = Math.max(waitSoftGlobal, waitSoftUser);
      if (waitSoftMs > 0) {
        waitSoftMs = applyJitter(waitSoftMs);
        const scope = waitSoftGlobal >= waitSoftUser ? `global:${opType}` : `user:${userId}:${opType}`;
        recordSoftHit(scope);
        logger.info('rate.soft_hit', {
          scope,
          countLast60s: undefined, // computed lazily
          softThreshold: undefined,
          spacingMs: waitSoftMs,
          waitSoftMs,
        });
      }

      // Hard limit
      const hardGlobal = tryConsume(gKey, nowMs);
      const hardUser = tryConsume(uKey, nowMs);
      let waitHardMs = 0;
      if (!hardGlobal.allowed || !hardUser.allowed) {
        waitHardMs = Math.max(hardGlobal.retryAfterMs || 0, hardUser.retryAfterMs || 0);
        waitHardMs = applyJitter(waitHardMs);
        const scope = (hardGlobal.retryAfterMs || 0) >= (hardUser.retryAfterMs || 0)
          ? `global:${opType}` : `user:${userId}:${opType}`;
        recordHardWait(scope);
        logger.warn('rate.hard_wait', {
          scope,
          waitHardMs,
        });
      }

      const totalWait = Math.max(waitSoftMs, waitHardMs);

      // Time budget check
      const elapsed = Date.now() - startTs;
      if (elapsed + totalWait > RATE_LIMIT_CONFIG.timeBudgetMs) {
        logger.warn('rate.time_budget_exceeded', {
          elapsedMs: elapsed,
          budgetMs: RATE_LIMIT_CONFIG.timeBudgetMs,
          opType,
        });
        throw new FillerError('rate_limited', 'Rate limit wait too long', {
          opType,
          retryAfterMs: totalWait,
          elapsedMs: elapsed,
        });
      }

      if (totalWait > 0) {
        logger.info('rate.wait_applied', {
          waitMs: totalWait,
          softMs: waitSoftMs,
          hardMs: waitHardMs,
        });
        recordWaitInjected(`global:${opType}`, totalWait);
        recordUserWait(userId, opType, totalWait);
        await sleep(totalWait);

        // Re-acquire hard tokens after sleeping (they may have refilled)
        if (!hardGlobal.allowed) tryConsume(gKey);
        if (!hardUser.allowed) tryConsume(uKey);
      }

      // Record in sliding window and metrics
      record(gKey);
      record(uKey);
      recordRequest(userId, opType);

      try {
        const result = await fn();
        if (attempt > 1) {
          recordRetrySucceeded();
        }
        return result;
      } catch (err) {
        lastError = err;

        if (!isRateLimitError(err)) {
          const category = categorizeError(err);
          recordError(userId, category);
          logger.error('google.api_error', {
            httpStatus: (err as { code?: number })?.code,
            reason: (err as { message?: string })?.message,
            elapsedMs: Date.now() - startTs,
          });
          throw err;
        }

        // Rate limit error - retry with backoff
        const category = categorizeError(err);
        recordError(userId, category);
        recordRetry(userId);

        const backoff = Math.min(
          RATE_LIMIT_CONFIG.retryMaxDelayMs,
          RATE_LIMIT_CONFIG.retryBaseDelayMs * Math.pow(2, attempt - 1)
        );
        const backoffWithJitter = applyJitter(backoff);

        recordRetryScheduled(backoffWithJitter);

        logger.warn('google.retry_scheduled', {
          attempt,
          backoffMs: backoffWithJitter,
        });

        // Check time budget before sleeping for retry
        const elapsedNow = Date.now() - startTs;
        if (elapsedNow + backoffWithJitter > RATE_LIMIT_CONFIG.timeBudgetMs) {
          logger.warn('rate.time_budget_exceeded', {
            elapsedMs: elapsedNow,
            budgetMs: RATE_LIMIT_CONFIG.timeBudgetMs,
            opType,
          });
          throw new FillerError('rate_limited', 'Rate limit wait too long', {
            opType,
            retryAfterMs: backoffWithJitter,
            elapsedMs: elapsedNow,
          });
        }

        await sleep(backoffWithJitter);
      }
    }

    // All retries exhausted
    recordRetryExhausted();
    logger.error('google.retry_exhausted', {
      attempts: RATE_LIMIT_CONFIG.retryAttempts,
    });
    throw lastError;
  } finally {
    decrementInFlight();
  }
}

export { type OpType } from './types.js';
export { getHealthData, cleanupStaleUsers } from './metrics.js';
