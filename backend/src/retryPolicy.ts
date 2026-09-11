/**
 * Pure functions for retry/backoff decisions. Kept free of I/O so they can
 * be unit tested directly (see tests/retryPolicy.test.ts) without spinning
 * up Postgres.
 */

export interface RetryDecisionInput {
  attemptNumber: number; // the attempt that just finished
  maxRetries: number;
  baseBackoffMs: number;
}

export interface RetryDecision {
  shouldRetry: boolean;
  nextAttemptNumber: number;
  delayMs: number;
}

/**
 * Exponential backoff with a cap, plus jitter to avoid a "thundering herd"
 * of retries all firing at the exact same millisecond (relevant once you
 * have many jobs failing around the same time, e.g. a downstream outage).
 */
export function decideRetry({
  attemptNumber,
  maxRetries,
  baseBackoffMs,
}: RetryDecisionInput): RetryDecision {
  const shouldRetry = attemptNumber <= maxRetries;
  if (!shouldRetry) {
    return { shouldRetry: false, nextAttemptNumber: attemptNumber, delayMs: 0 };
  }

  const CAP_MS = 5 * 60 * 1000; // never wait more than 5 minutes
  const exponential = baseBackoffMs * Math.pow(2, attemptNumber - 1);
  const capped = Math.min(exponential, CAP_MS);
  const jitter = Math.floor(Math.random() * capped * 0.2); // +0-20% jitter

  return {
    shouldRetry: true,
    nextAttemptNumber: attemptNumber + 1,
    delayMs: capped + jitter,
  };
}

/**
 * A RUNNING execution whose lock hasn't been refreshed (heartbeat) in this
 * long is assumed to belong to a dead worker and is eligible for reclaim.
 */
export const STALE_LOCK_THRESHOLD_MS = 90_000;

export function isStale(lockedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - lockedAt.getTime() > STALE_LOCK_THRESHOLD_MS;
}
