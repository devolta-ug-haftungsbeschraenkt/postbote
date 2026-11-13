/** Formatier-Helfer (de-DE). */

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatNumber(value: number): string {
  return value.toLocaleString('de-DE')
}
