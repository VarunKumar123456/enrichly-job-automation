'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = mode === 'login' ? await api.login(email, password) : await api.register(email, password);
      localStorage.setItem('enrichly_token', result.token);
      localStorage.setItem('enrichly_email', result.user.email);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-navy text-white font-bold mb-3">JA</div>
          <h1 className="text-xl font-semibold text-brand-navy">Job Automation</h1>
          <p className="text-sm text-gray-500 mt-1">Create, run, and monitor automated jobs.</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="flex mb-6 rounded-lg bg-gray-100 p-1 text-sm font-medium">
            <button
              className={`flex-1 rounded-md py-1.5 transition ${mode === 'login' ? 'bg-white shadow-sm text-brand-navy' : 'text-gray-500'}`}
              onClick={() => setMode('login')}
              type="button"
            >
              Log in
            </button>
            <button
              className={`flex-1 rounded-md py-1.5 transition ${mode === 'register' ? 'bg-white shadow-sm text-brand-navy' : 'text-gray-500'}`}
              onClick={() => setMode('register')}
              type="button"
            >
              Sign up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-indigo/40"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-indigo/40"
                placeholder="At least 8 characters"
              />
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand-navy text-white text-sm font-medium py-2.5 hover:opacity-90 transition disabled:opacity-50"
            >
              {loading ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
