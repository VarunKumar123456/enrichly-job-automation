export interface HttpJobConfig {
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface ExecutionResult {
  ok: boolean;
  status?: number;
  bodySnippet?: string;
  errorMessage?: string;
  durationMs: number;
}

const MAX_STORED_BODY_CHARS = 4000; // don't let a huge response blow up the DB row

/**
 * Runs the configured HTTP call. Every failure mode below is one the
 * assignment explicitly calls out: timeout, DNS/connection failure,
 * non-2xx response. We treat non-2xx as a failed execution (not a thrown
 * error) so retry logic can inspect the status code if needed later.
 */
export async function executeHttpJob(config: HttpJobConfig): Promise<ExecutionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const start = Date.now();

  try {
    const res = await fetch(config.targetUrl, {
      method: config.method,
      headers: config.headers,
      body: config.body ? JSON.stringify(config.body) : undefined,
      signal: controller.signal,
    });
    const durationMs = Date.now() - start;
    const text = await res.text().catch(() => '');
    const bodySnippet = text.slice(0, MAX_STORED_BODY_CHARS);

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, bodySnippet, durationMs };
    }
    return {
      ok: false,
      status: res.status,
      bodySnippet,
      errorMessage: `Non-2xx response: ${res.status}`,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    if (err.name === 'AbortError') {
      return { ok: false, errorMessage: `Timed out after ${config.timeoutMs}ms`, durationMs };
    }
    return { ok: false, errorMessage: err.message || 'Network error', durationMs };
  } finally {
    clearTimeout(timeout);
  }
}
