'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';

export function useRequireAuth() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/');
    } else {
      setReady(true);
    }
  }, [router]);

  return ready;
}

export function logout(router: ReturnType<typeof useRouter>) {
  localStorage.removeItem('enrichly_token');
  localStorage.removeItem('enrichly_email');
  router.replace('/');
}
