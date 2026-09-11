'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { logout } from '@/lib/useRequireAuth';

export function TopNav() {
  const router = useRouter();
  return (
    <div className="border-b border-gray-100 bg-white">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-brand-navy">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-navy text-white text-xs font-bold">JA</span>
          Job Automation
        </Link>
        <button onClick={() => logout(router)} className="text-sm text-gray-500 hover:text-brand-navy transition">
          Log out
        </button>
      </div>
    </div>
  );
}
