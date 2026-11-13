import { api } from '../api/client'
import type { OutboundStats } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { formatNumber } from '../utils/format'

type KpiKey = 'Sent' | 'Bounced' | 'Opens' | 'Clicks' | 'Tracked'

interface KpiDefinition {
  label: string
  key: KpiKey
  note: (stats: OutboundStats) => string
}

function formatDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

function rate(part: number, base: number): string {
  if (base <= 0) return '—'
  return `${((part / base) * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`
}

const KPIS: KpiDefinition[] = [
  {
    label: 'Gesendet',
    key: 'Sent',
    note: (s) => `${s.Days.length} Tage im Zeitraum`,
  },
  {
    label: 'Bounces',
    key: 'Bounced',
    note: (s) => `Bounce-Rate ${rate(s.Bounced, s.Sent)}`,
  },
  {
    label: 'Öffnungen',
    key: 'Opens',
    note: (s) => `Öffnungsrate ${rate(s.Opens, s.Tracked)}`,
  },
  {
    label: 'Klicks',
    key: 'Clicks',
    note: (s) => `Klickrate ${rate(s.Clicks, s.Tracked)}`,
  },
  {
    label: 'Tracked',
    key: 'Tracked',
    note: (s) => `${rate(s.Tracked, s.Sent)} der Sendungen`,
  },
]

export default function Stats() {
  const { data, loading } = useApi<OutboundStats>(
    () => api.outboundStats(),
    fixtures.outboundStats,
  )

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Statistik</h1>
          <p className="page-sub type-caption text-muted">
            {data
              ? `Outbound · ${formatDay(data.FromDate)} – ${formatDay(data.ToDate)}`
              : 'Versand- und Engagement-Zahlen des Outbound-Streams'}
          </p>
        </div>
      </header>

      {loading || !data ? (
        <p className="loading-note type-body">Lade Statistik …</p>
      ) : (
        <>
          <div className="stat-grid">
            {KPIS.map((kpi) => (
              <article key={kpi.key} className="stat-card">
                <p className="stat-label type-caption-strong">{kpi.label}</p>
                <p className="stat-value">{formatNumber(data[kpi.key])}</p>
                <p className="stat-note type-caption">{kpi.note(data)}</p>
              </article>
            ))}
          </div>

          <section className="card">
            <h2 className="card-title type-body-strong">Gesendete Nachrichten pro Tag</h2>
            <p
              className="type-caption text-muted"
              style={{ marginBottom: 'var(--space-lg)' }}
            >
              Tägliches Versandvolumen im gewählten Zeitraum.
            </p>
            <div
              className="bar-chart"
              role="img"
              aria-label="Balkendiagramm: gesendete Nachrichten pro Tag"
            >
              {data.Days.map((day) => {
                const max = Math.max(...data.Days.map((item) => item.Sent), 1)
                const height = Math.max((day.Sent / max) * 100, 2)
                return (
                  <div className="bar-chart__col" key={day.Date}>
                    <span className="bar-chart__value type-fine-print text-muted">
                      {formatNumber(day.Sent)}
                    </span>
                    <div className="bar-chart__track">
                      <div
                        className="bar-chart__bar"
                        style={{ height: `${height}%` }}
                      />
                    </div>
                    <span className="bar-chart__label type-fine-print text-muted">
                      {formatDay(day.Date)}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="card card--flush">
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Gesendet</th>
                    <th>Bounces</th>
                    <th>Öffnungen</th>
                    <th>Klicks</th>
                    <th>Tracked</th>
                  </tr>
                </thead>
                <tbody>
                  {data.Days.map((day) => (
                    <tr key={day.Date}>
                      <td className="cell-strong">{formatDay(day.Date)}</td>
                      <td>{formatNumber(day.Sent)}</td>
                      <td>{formatNumber(day.Bounced)}</td>
                      <td>{formatNumber(day.Opens)}</td>
                      <td>{formatNumber(day.Clicks)}</td>
                      <td>{formatNumber(day.Tracked)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Gesamt</td>
                    <td>{formatNumber(data.Sent)}</td>
                    <td>{formatNumber(data.Bounced)}</td>
                    <td>{formatNumber(data.Opens)}</td>
                    <td>{formatNumber(data.Clicks)}</td>
                    <td>{formatNumber(data.Tracked)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  )
}
