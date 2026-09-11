
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export interface Job {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  target_url: string;
  http_method: string;
  cron_expression: string | null;
  next_run_at: string | null;
  max_retries: number;
  retry_backoff_base_ms: number;
  allow_concurrent_runs: boolean;
  version: number;
  created_at: string;
  total_executions?: string;
  failed_executions?: string;
  last_execution_status?: string | null;
}

export interface Execution {
  id: string;
  job_id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  trigger_source: 'SCHEDULE' | 'MANUAL' | 'RETRY';
  attempt_number: number;
  parent_execution_id: string | null;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
}

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('enrichly_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let message = res.statusText;

    try {
      const body = await res.json();
      message = body.error || message;
    } catch {
      // ignore non-JSON error bodies
    }

    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;

  return res.json();
}

export const api = {
  register: (email: string, password: string) =>
    request<{ token: string; user: { id: string; email: string } }>(
      '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }
    ),

  login: (email: string, password: string) =>
    request<{ token: string; user: { id: string; email: string } }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }
    ),

  listJobs: (params?: { q?: string; status?: string }) => {
    const qs = new URLSearchParams();

    if (params?.q !== undefined) {
      qs.set('q', params.q);
    }

    if (params?.status !== undefined) {
      qs.set('status', params.status);
    }

    const queryString = qs.toString();

    return request<Job[]>(
      `/api/jobs${queryString ? `?${queryString}` : ''}`
    );
  },

  getJob: (id: string) =>
    request<Job>(`/api/jobs/${id}`),

  createJob: (input: Record<string, unknown>) =>
    request<Job>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateJob: (id: string, input: Record<string, unknown>) =>
    request<Job>(`/api/jobs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  pauseJob: (id: string) =>
    request<Job>(`/api/jobs/${id}/pause`, {
      method: 'POST',
    }),

  resumeJob: (id: string) =>
    request<Job>(`/api/jobs/${id}/resume`, {
      method: 'POST',
    }),

  archiveJob: (id: string) =>
    request<void>(`/api/jobs/${id}`, {
      method: 'DELETE',
    }),

  runJob: (id: string) =>
    request<Execution & { deduped?: boolean }>(
      `/api/jobs/${id}/run`,
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': crypto.randomUUID(),
        },
      }
    ),

  jobStats: (id: string) =>
    request<{
      succeeded: string;
      failed: string;
      running: string;
      pending: string;
      avg_duration_ms: string | null;
    }>(`/api/jobs/${id}/stats`),

  listExecutions: (
    jobId: string,
    params?: { status?: string }
  ) => {
    const qs = new URLSearchParams();

    if (params?.status !== undefined) {
      qs.set('status', params.status);
    }

    const queryString = qs.toString();

    return request<Execution[]>(
      `/api/executions/job/${jobId}${queryString ? `?${queryString}` : ''}`
    );
  },

  retryExecution: (id: string) =>
    request<Execution>(
      `/api/executions/${id}/retry`,
      {
        method: 'POST',
      }
    ),

  cancelExecution: (id: string) =>
    request<Execution>(
      `/api/executions/${id}/cancel`,
      {
        method: 'POST',
      }
    ),
};

export { ApiError, getToken };
