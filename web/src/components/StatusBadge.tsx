import type { MessageStatus } from '../api/types'

const LABELS: Record<MessageStatus, string> = {
  queued: 'Queued',
  sent: 'Sent',
  failed: 'Failed',
  bounced: 'Bounced',
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase() as MessageStatus
  const label = LABELS[normalized] ?? status
  return <span className={`badge badge--${normalized}`}>{label}</span>
}
