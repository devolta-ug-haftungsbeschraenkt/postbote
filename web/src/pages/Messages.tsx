import { useMemo, useState } from 'react'
import { api } from '../api/client'
import type { MessageStatus, MessagesResponse } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { StatusBadge } from '../components/StatusBadge'
import { formatDateTime } from '../utils/format'

type StatusFilter = 'all' | MessageStatus

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Alle' },
  { value: 'sent', label: 'Sent' },
  { value: 'queued', label: 'Queued' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'failed', label: 'Failed' },
]

export default function Messages() {
  const { data, loading } = useApi<MessagesResponse>(
    () => api.messages(50),
    () => fixtures.messages(50),
  )
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')

  const all = data?.Messages ?? []

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return all.filter(
      (message) =>
        (status === 'all' || message.Status === status) &&
        (needle === '' ||
          [message.Subject, message.Recipient, message.From, message.Tag ?? '']
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    )
  }, [all, query, status])

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Messages</h1>
          <p className="page-sub type-caption text-muted">
            {data ? `${data.TotalCount.toLocaleString('de-DE')} ausgehende Nachrichten insgesamt` : 'Ausgehende Nachrichten'}
          </p>
        </div>
      </header>

      <div className="filter-bar">
        <div className="search">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.5 9.5 12.6 12.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            className="search-input"
            type="search"
            placeholder="Betreff, Empfänger oder Tag suchen"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Nachrichten durchsuchen"
          />
        </div>
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={`chip${status === filter.value ? ' chip--selected' : ''}`}
            onClick={() => setStatus(filter.value)}
            aria-pressed={status === filter.value}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <section className="card card--flush">
        {loading ? (
          <p className="loading-note type-body">Lade Nachrichten …</p>
        ) : filtered.length === 0 ? (
          <p className="empty-note type-body">
            Keine Nachrichten für diese Auswahl gefunden.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Betreff</th>
                  <th>Empfänger</th>
                  <th>Status</th>
                  <th>Tag</th>
                  <th>Verarbeitet</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((message) => (
                  <tr key={message.MessageID}>
                    <td className="cell-strong cell-subject">{message.Subject}</td>
                    <td>{message.Recipient}</td>
                    <td>
                      <StatusBadge status={message.Status} />
                    </td>
                    <td className="cell-muted">{message.Tag ?? '—'}</td>
                    <td className="cell-muted">
                      {formatDateTime(message.ReceivedAt ?? message.SubmittedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
