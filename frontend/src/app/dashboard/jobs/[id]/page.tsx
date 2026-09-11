'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { api, Job, Execution, ApiError } from '@/lib/api';
import { TopNav } from '@/components/TopNav';
import { StatusPill } from '@/components/StatusPill';

function formatDuration(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function JobDetailPage() {
  const ready = useRequireAuth();
  const params = useParams<{ id: string }>();
  const jobId = params.id;

  const [job, setJob] = useState<Job | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [stats, setStats] = useState<{ succeeded: string; failed: string; running: string; pending: string; avg_duration_ms: string | null } | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [j, execs, s] = await Promise.all([
        api.getJob(jobId),
        api.listExecutions(jobId, { status: statusFilter || undefined }),
        api.jobStats(jobId),
      ]);
      setJob(j);
      setExecutions(execs);
      setStats(s);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Failed to load job');
    }
  }, [jobId, statusFilter]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  // Light polling so PENDING/RUNNING rows update without a manual refresh —
  // simple and sufficient for this assignment's scope; a production version
  // would use SSE/websockets instead (see ENGINEERING.md "known limitations").
  useEffect(() => {
    if (!ready) return;
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [ready, load]);

  async function handleRun() {
    setBusy(true);
    try {
      const result = await api.runJob(jobId);
      setToast(result.deduped ? "Already has an execution in progress." : 'Execution started.');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Failed to run job');
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleRetry(executionId: string) {
    try {
      await api.retryExecution(executionId);
      setToast('Retry queued.');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Failed to retry');
    } finally {
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleCancel(executionId: string) {
    try {
      await api.cancelExecution(executionId);
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Failed to cancel');
    } finally {
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handlePauseResume() {
    if (!job) return;
    try {
      if (job.status === 'ACTIVE') await api.pauseJob(job.id);
      else await api.resumeJob(job.id);
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  if (!ready || !job) return null;

  return (
    <div>
      <TopNav />
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-brand-navy">{job.name}</h1>
              <StatusPill status={job.status} />
            </div>
            <p className="text-sm text-gray-500 mt-1 font-mono">{job.http_method} {job.target_url}</p>
            <p className="text-xs text-gray-400 mt-1">
              {job.cron_expression ? `Scheduled: ${job.cron_expression}` : 'Manual trigger only'}
              {' · '}Max retries: {job.max_retries}
              {' · '}{job.allow_concurrent_runs ? 'Overlapping runs allowed' : 'Single run at a time'}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePauseResume}
              className="text-sm font-medium text-gray-600 border border-gray-200 rounded-lg px-4 py-2 hover:bg-gray-50 transition"
            >
              {job.status === 'ACTIVE' ? 'Pause' : 'Resume'}
            </button>
            <button
              onClick={handleRun}
              disabled={busy || job.status !== 'ACTIVE'}
              className="text-sm font-medium text-white bg-brand-navy rounded-lg px-4 py-2 hover:opacity-90 transition disabled:opacity-40"
            >
              {busy ? 'Starting…' : 'Run now'}
            </button>
          </div>
        </div>

        {toast && <div className="mb-4 rounded-lg bg-brand-navy text-white text-sm px-3 py-2">{toast}</div>}

        {stats && (
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Succeeded', value: stats.succeeded, color: 'text-emerald-600' },
              { label: 'Failed', value: stats.failed, color: 'text-red-600' },
              { label: 'In progress', value: (parseInt(stats.running) + parseInt(stats.pending)).toString(), color: 'text-blue-600' },
              { label: 'Avg duration', value: stats.avg_duration_ms ? formatDuration(Math.round(parseFloat(stats.avg_duration_ms))) : '—', color: 'text-gray-700' },
            ].map((s) => (
              <div key={s.label} className="bg-white rounded-xl border border-gray-100 p-4">
                <p className="text-xs text-gray-400">{s.label}</p>
                <p className={`text-xl font-semibold mt-1 ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-brand-navy">Execution history</h2>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
          >
            <option value="">All statuses</option>
            <option value="SUCCEEDED">Succeeded</option>
            <option value="FAILED">Failed</option>
            <option value="RUNNING">Running</option>
            <option value="PENDING">Pending</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>

        {executions.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-2xl border border-gray-100 text-sm text-gray-400">
            No executions yet. Click "Run now" to trigger one.
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-100 overflow-hidden">
            {executions.map((exec) => (
              <div key={exec.id}>
                <button
                  onClick={() => setExpandedId(expandedId === exec.id ? null : exec.id)}
                  className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-50/60 transition"
                >
                  <div className="flex items-center gap-3">
                    <StatusPill status={exec.status} />
                    <span className="text-xs text-gray-400">{exec.trigger_source.toLowerCase()}</span>
                    <span className="text-xs text-gray-400">attempt #{exec.attempt_number}</span>
                    {exec.response_status && (
                      <span className="text-xs font-mono text-gray-500">HTTP {exec.response_status}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">{formatTime(exec.created_at)}</span>
                    <span className="text-xs text-gray-400">{formatDuration(exec.duration_ms)}</span>
                  </div>
                </button>

                {expandedId === exec.id && (
                  <div className="px-5 pb-4 text-xs space-y-2 bg-gray-50/60">
                    {exec.error_message && (
                      <p className="text-red-600"><span className="font-medium">Error:</span> {exec.error_message}</p>
                    )}
                    {exec.response_body && (
                      <div>
                        <p className="font-medium text-gray-500 mb-1">Response body (truncated):</p>
                        <pre className="bg-white border border-gray-100 rounded-lg p-2 overflow-x-auto max-h-40 font-mono text-[11px]">
                          {exec.response_body}
                        </pre>
                      </div>
                    )}
                    <div className="flex gap-4 text-gray-400">
                      <span>Scheduled: {formatTime(exec.scheduled_for)}</span>
                      <span>Started: {formatTime(exec.started_at)}</span>
                      <span>Finished: {formatTime(exec.finished_at)}</span>
                    </div>
                    <div className="flex gap-2 pt-1">
                      {exec.status === 'FAILED' && (
                        <button
                          onClick={() => handleRetry(exec.id)}
                          className="text-xs font-medium text-white bg-brand-indigo rounded-lg px-3 py-1.5 hover:opacity-90 transition"
                        >
                          Retry
                        </button>
                      )}
                      {exec.status === 'PENDING' && (
                        <button
                          onClick={() => handleCancel(exec.id)}
                          className="text-xs font-medium text-gray-600 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-white transition"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
