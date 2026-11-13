import { api } from '../api/client'
import type { DeliveryStats, MessagesResponse } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { formatDateTime, formatNumber } from '../utils/format'

interface StatDefinition {
  label: string
  key: 'Sent' | 'Queued' | 'Bounced' | 'Failed'
  note: (stats: DeliveryStats) => string
}

const STATS: StatDefinition[] = [
  {
    label: 'Gesendet',
    key: 'Sent',
    note: (s) =>
      typeof s.SentDelta24h === 'number' ? `+${formatNumber(s.SentDelta24h)} in 24 h` : '',
  },
  {
    label: 'In Warteschlange',
    key: 'Queued',
    note: (s) => s.QueuedNextRun ?? '',
  },
  {
    label: 'Bounces',
    key: 'Bounced',
    note: (s) => (s.BounceRate ? `Bounce-Rate ${s.BounceRate}` : ''),
  },
  {
    label: 'Fehlgeschlagen',
    key: 'Failed',
    note: () => '',
  },
]

export default function Overview() {
  const stats = useApi<DeliveryStats>(api.deliveryStats, fixtures.deliveryStats)
  const messages = useApi<MessagesResponse>(
    () => api.messages(8),
    () => fixtures.messages(8),
  )

  const data = stats.data
  const recent = messages.data?.Messages ?? []

  return (
    <>
      <section className="hero-tile">
        <p className="type-caption text-on-dark-muted">Übersicht</p>
        <h1 className="type-display-lg" style={{ marginTop: 'var(--space-xs)' }}>
          Nachrichtenfluss
        </h1>
        <p className="type-lead-airy hero-lead text-on-dark-muted">
          Zustellung, Warteschlange und Fehler — direkt aus der postbote-Queue.
        </p>
      </section>

      {stats.loading || !data ? (
        <p className="loading-note type-body">Lade Zustellzahlen …</p>
      ) : (
        <div className="stat-grid">
          {STATS.map((stat) => (
            <article key={stat.key} className="stat-card">
              <p className="stat-label type-caption-strong">{stat.label}</p>
              <p className="stat-value">{formatNumber(data[stat.key])}</p>
              <p className="stat-note type-caption">{stat.note(data)}</p>
            </article>
          ))}
        </div>
      )}

      <section className="card">
        <h2 className="card-title type-body-strong">Letzte Aktivität</h2>
        <p className="type-caption text-muted" style={{ marginBottom: 'var(--space-md)' }}>
          Die zuletzt verarbeiteten Nachrichten mit aktuellem Status.
        </p>
        {messages.loading ? (
          <p className="loading-note type-body">Lade Aktivität …</p>
        ) : (
          recent.map((message) => (
            <div key={message.MessageID} className="activity-row">
              <span className={`dot dot--${message.Status}`} />
              <div className="activity-main">
                <p className="type-caption-strong text-ellipsis">{message.Subject}</p>
                <p className="type-caption text-muted text-ellipsis">
                  {message.Recipient} · {message.Status}
                </p>
              </div>
              <span className="activity-time type-caption text-muted">
                {formatDateTime(message.ReceivedAt ?? message.SubmittedAt)}
              </span>
            </div>
          ))
        )}
      </section>
    </>
  )
}
