'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { api, ApiError } from '@/lib/api';
import { TopNav } from '@/components/TopNav';

const CRON_PRESETS = [
  { label: 'Manual trigger only', value: '' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at 9am', value: '0 9 * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Custom…', value: 'custom' },
];

export default function NewJobPage() {
  const ready = useRequireAuth();
  const router = useRouter();

  const [name, setName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [httpMethod, setHttpMethod] = useState('GET');
  const [cronPreset, setCronPreset] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [maxRetries, setMaxRetries] = useState(3);
  const [allowConcurrent, setAllowConcurrent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!ready) return null;

  const effectiveCron = cronPreset === 'custom' ? customCron : cronPreset;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const job = await api.createJob({
        name,
        targetUrl,
        httpMethod,
        cronExpression: effectiveCron || null,
        maxRetries,
        allowConcurrentRuns: allowConcurrent,
      });
      router.push(`/dashboard/jobs/${job.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create job');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <TopNav />
      <div className="max-w-xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold text-brand-navy mb-1">New job</h1>
        <p className="text-sm text-gray-500 mb-6">A job calls a URL on a schedule, or whenever you trigger it manually.</p>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Job name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sync inventory from warehouse API"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-indigo/30"
            />
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="col-span-1">
              <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
              <select
                value={httpMethod}
                onChange={(e) => setHttpMethod(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-2 py-2 text-sm"
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="col-span-3">
              <label className="block text-xs font-medium text-gray-600 mb-1">Target URL</label>
              <input
                required
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://api.example.com/sync"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-indigo/30"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Schedule</label>
            <select
              value={cronPreset}
              onChange={(e) => setCronPreset(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.label} value={p.value}>{p.label}</option>
              ))}
            </select>
            {cronPreset === 'custom' && (
              <input
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="*/30 * * * *"
                className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Max retries on failure</label>
              <input
                type="number"
                min={0}
                max={10}
                value={maxRetries}
                onChange={(e) => setMaxRetries(parseInt(e.target.value, 10) || 0)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={allowConcurrent} onChange={(e) => setAllowConcurrent(e.target.checked)} />
                Allow overlapping runs
              </label>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-brand-navy text-white text-sm font-medium px-5 py-2.5 hover:opacity-90 transition disabled:opacity-50"
            >
              {loading ? 'Creating…' : 'Create job'}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="rounded-lg border border-gray-200 text-sm font-medium px-5 py-2.5 text-gray-600 hover:bg-gray-50 transition"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
