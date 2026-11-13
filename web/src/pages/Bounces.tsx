import { useMemo, useState } from 'react'
import { api } from '../api/client'
import type { BouncesResponse } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { formatDateTime } from '../utils/format'

export default function Bounces() {
  const { data, loading } = useApi<BouncesResponse>(
    () => api.bounces(50),
    fixtures.bounces,
  )
  const [query, setQuery] = useState('')

  const all = data?.Bounces ?? []

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return all
    return all.filter((bounce) =>
      [bounce.Type, bounce.Email, bounce.Subject ?? '', bounce.Description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [all, query])

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Bounces</h1>
          <p className="page-sub type-caption text-muted">
            {data
              ? `${data.TotalCount.toLocaleString('de-DE')} Bounces — klassifiziert nach TypeCode`
              : 'Zustellfehler und Klassifikation'}
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
            placeholder="Typ, Adresse oder Betreff suchen"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Bounces durchsuchen"
          />
        </div>
      </div>

      <section className="card card--flush">
        {loading ? (
          <p className="loading-note type-body">Lade Bounces …</p>
        ) : filtered.length === 0 ? (
          <p className="empty-note type-body">Keine Bounces für diese Suche gefunden.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Typ</th>
                  <th>TypeCode</th>
                  <th>Beschreibung</th>
                  <th>E-Mail</th>
                  <th>Zeitpunkt</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((bounce) => (
                  <tr key={bounce.ID}>
                    <td className="cell-strong">{bounce.Type}</td>
                    <td className="cell-muted">
                      <span className="chip-pearl mono">{bounce.TypeCode}</span>
                    </td>
                    <td className="cell-subject">{bounce.Description ?? bounce.Name ?? '—'}</td>
                    <td>{bounce.Email}</td>
                    <td className="cell-muted">{formatDateTime(bounce.BouncedAt)}</td>
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
