'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { api, Job, ApiError } from '@/lib/api';
import { TopNav } from '@/components/TopNav';
import { StatusPill } from '@/components/StatusPill';

export default function DashboardPage() {
  const ready = useRequireAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listJobs({ q: q || undefined, status: status || undefined });
      setJobs(data);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, [q, status]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  async function handleRun(id: string) {
    setRunningId(id);
    try {
      const result = await api.runJob(id);
      setToast(result.deduped ? "Already has an execution in progress — didn't start a duplicate." : 'Execution started.');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Failed to run job');
    } finally {
      setRunningId(null);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handlePauseResume(job: Job) {
    try {
      if (job.status === 'ACTIVE') await api.pauseJob(job.id);
      else await api.resumeJob(job.id);
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  if (!ready) return null;

  return (
    <div>
      <TopNav />
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-brand-navy">Jobs</h1>
            <p className="text-sm text-gray-500 mt-1">Create, trigger, and monitor your automated jobs.</p>
          </div>
          <Link
            href="/dashboard/new"
            className="rounded-lg bg-brand-indigo text-white text-sm font-medium px-4 py-2 hover:opacity-90 transition"
          >
            + New job
          </Link>
        </div>

        <div className="flex gap-3 mb-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search jobs by name…"
            className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-indigo/30"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>

        {toast && <div className="mb-4 rounded-lg bg-brand-navy text-white text-sm px-3 py-2">{toast}</div>}

        {loading ? (
          <div className="text-sm text-gray-400 py-12 text-center">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-2xl border border-gray-100">
            <p className="text-gray-500 text-sm">No jobs yet.</p>
            <Link href="/dashboard/new" className="text-brand-indigo text-sm font-medium mt-2 inline-block">
              Create your first job →
            </Link>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-100 overflow-hidden">
            {jobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between px-5 py-4 hover:bg-gray-50/60 transition">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link href={`/dashboard/jobs/${job.id}`} className="font-medium text-brand-navy hover:underline truncate">
                      {job.name}
                    </Link>
                    <StatusPill status={job.status} />
                    {job.last_execution_status && <StatusPill status={job.last_execution_status} />}
                  </div>
                  <p className="text-xs text-gray-400 mt-1 truncate">
                    {job.http_method} {job.target_url}
                    {job.cron_expression ? ` · cron: ${job.cron_expression}` : ' · manual trigger only'}
                    {' · '}
                    {job.total_executions || 0} run{job.total_executions === '1' ? '' : 's'}
                    {job.failed_executions && job.failed_executions !== '0' ? `, ${job.failed_executions} failed` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <button
                    onClick={() => handlePauseResume(job)}
                    className="text-xs font-medium text-gray-500 hover:text-brand-navy border border-gray-200 rounded-lg px-3 py-1.5 transition"
                  >
                    {job.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    onClick={() => handleRun(job.id)}
                    disabled={runningId === job.id || job.status !== 'ACTIVE'}
                    className="text-xs font-medium text-white bg-brand-navy hover:opacity-90 rounded-lg px-3 py-1.5 transition disabled:opacity-40"
                  >
                    {runningId === job.id ? 'Starting…' : 'Run now'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
