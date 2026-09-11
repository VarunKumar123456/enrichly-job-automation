import { decideRetry, isStale } from '../src/retryPolicy';

describe('decideRetry', () => {
  it('retries when attemptNumber is within maxRetries', () => {
    const decision = decideRetry({ attemptNumber: 1, maxRetries: 3, baseBackoffMs: 1000 });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.nextAttemptNumber).toBe(2);
  });

  it('stops retrying once attemptNumber exceeds maxRetries', () => {
    const decision = decideRetry({ attemptNumber: 4, maxRetries: 3, baseBackoffMs: 1000 });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.delayMs).toBe(0);
  });

  it('retries exactly maxRetries times, not more', () => {
    let attempt = 1;
    let retries = 0;
    for (let i = 0; i < 10; i++) {
      const d = decideRetry({ attemptNumber: attempt, maxRetries: 3, baseBackoffMs: 100 });
      if (!d.shouldRetry) break;
      retries++;
      attempt = d.nextAttemptNumber;
    }
    expect(retries).toBe(3);
  });

  it('backs off exponentially (ignoring jitter, base grows by 2x per attempt)', () => {
    const d1 = decideRetry({ attemptNumber: 1, maxRetries: 5, baseBackoffMs: 1000 });
    const d2 = decideRetry({ attemptNumber: 2, maxRetries: 5, baseBackoffMs: 1000 });
    const d3 = decideRetry({ attemptNumber: 3, maxRetries: 5, baseBackoffMs: 1000 });
    // jitter adds up to 20%, so compare floors of the un-jittered exponential term
    expect(d1.delayMs).toBeGreaterThanOrEqual(1000);
    expect(d1.delayMs).toBeLessThan(1200);
    expect(d2.delayMs).toBeGreaterThanOrEqual(2000);
    expect(d2.delayMs).toBeLessThan(2400);
    expect(d3.delayMs).toBeGreaterThanOrEqual(4000);
    expect(d3.delayMs).toBeLessThan(4800);
  });

  it('caps backoff delay at 5 minutes even for large attempt numbers', () => {
    const d = decideRetry({ attemptNumber: 20, maxRetries: 25, baseBackoffMs: 1000 });
    expect(d.delayMs).toBeLessThanOrEqual(5 * 60 * 1000 * 1.2);
  });

  it('treats maxRetries = 0 as "never retry"', () => {
    const d = decideRetry({ attemptNumber: 1, maxRetries: 0, baseBackoffMs: 1000 });
    expect(d.shouldRetry).toBe(false);
  });
});

describe('isStale', () => {
  it('is not stale immediately after locking', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const lockedAt = new Date('2026-01-01T00:00:00Z');
    expect(isStale(lockedAt, now)).toBe(false);
  });

  it('is stale after the threshold elapses', () => {
    const lockedAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-01T00:02:00Z'); // 2 minutes later > 90s threshold
    expect(isStale(lockedAt, now)).toBe(true);
  });

  it('is not stale just under the threshold', () => {
    const lockedAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-01T00:01:20Z'); // 80s < 90s threshold
    expect(isStale(lockedAt, now)).toBe(false);
  });
});
