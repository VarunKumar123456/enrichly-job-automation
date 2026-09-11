const STYLES: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  PAUSED: 'bg-amber-100 text-amber-700',
  ARCHIVED: 'bg-gray-200 text-gray-600',
  SUCCEEDED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  RUNNING: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-gray-100 text-gray-600',
  CANCELLED: 'bg-gray-200 text-gray-500',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${STYLES[status] || 'bg-gray-100 text-gray-600'}`}>{status}</span>;
}
