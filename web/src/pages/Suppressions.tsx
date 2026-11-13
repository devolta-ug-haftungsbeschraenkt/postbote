import { useMemo, useState, type FormEvent } from 'react'
import { api } from '../api/client'
import type {
  MessageStreamsResponse,
  SuppressionReason,
  SuppressionsResponse,
} from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { useDemoMode } from '../state/demo'
import { formatDateTime } from '../utils/format'

type Hint = { kind: 'ok' | 'error' | 'info'; text: string } | null

const REASONS: Array<{ value: SuppressionReason; label: string }> = [
  { value: 'HardBounce', label: 'HardBounce' },
  { value: 'SpamComplaint', label: 'SpamComplaint' },
  { value: 'ManualSuppression', label: 'ManualSuppression' },
]

const EMPTY_FORM: { EmailAddress: string; SuppressionReason: SuppressionReason } = {
  EmailAddress: '',
  SuppressionReason: 'ManualSuppression',
}

export default function Suppressions() {
  const demo = useDemoMode()
  const [selectedStream, setSelectedStream] = useState('outbound')

  const streams = useApi<MessageStreamsResponse>(api.streams, fixtures.streams)
  const suppressions = useApi<SuppressionsResponse>(
    () => api.suppressions(selectedStream),
    () => fixtures.suppressions(),
  )

  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [busyEmail, setBusyEmail] = useState<string | null>(null)
  const [hint, setHint] = useState<Hint>(null)

  const entries = suppressions.data?.Suppressions ?? []

  const streamOptions = useMemo(() => {
    const ids = new Set<string>(['outbound'])
    for (const stream of streams.data?.MessageStreams ?? []) {
      ids.add(stream.ID)
    }
    return Array.from(ids)
  }, [streams.data])

  function handleStreamChange(value: string) {
    setSelectedStream(value)
    suppressions.reload()
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = form.EmailAddress.trim()

    if (email === '') {
      setHint({ kind: 'error', text: 'E-Mail-Adresse ist erforderlich.' })
      return
    }

    setSubmitting(true)
    setHint(null)
    try {
      if (demo) {
        setHint({ kind: 'info', text: 'Demo-Modus: Eintrag wird nicht gespeichert.' })
      } else {
        await api.addSuppression(selectedStream, {
          EmailAddress: email,
          SuppressionReason: form.SuppressionReason,
        })
        setHint({ kind: 'ok', text: `${email} wird nun unterdrückt.` })
        setForm(EMPTY_FORM)
        suppressions.reload()
      }
    } catch {
      setHint({ kind: 'error', text: 'Hinzufügen fehlgeschlagen — API nicht erreichbar.' })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemove(email: string) {
    setBusyEmail(email)
    setHint(null)
    try {
      if (demo) {
        setHint({ kind: 'info', text: 'Demo-Modus: Eintrag wird nicht entfernt.' })
      } else {
        await api.removeSuppression(selectedStream, email)
        setHint({ kind: 'ok', text: `${email} wurde entfernt.` })
        suppressions.reload()
      }
    } catch {
      setHint({ kind: 'error', text: 'Entfernen fehlgeschlagen — API nicht erreichbar.' })
    } finally {
      setBusyEmail(null)
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Suppressions</h1>
          <p className="page-sub type-caption text-muted">
            {suppressions.data
              ? `${suppressions.data.TotalCount} unterdrückte Adressen in „${selectedStream}“`
              : 'Unterdrückte Empfängeradressen je Stream'}
          </p>
        </div>
      </header>

      {hint ? (
        <p
          className={`form-status form-status--${hint.kind}`}
          role="status"
          style={{ marginBottom: 'var(--space-md)' }}
        >
          {hint.text}
        </p>
      ) : null}

      <div className="filter-bar">
        <div className="field" style={{ marginBottom: 0, minWidth: 220 }}>
          <label className="field-label type-caption-strong" htmlFor="suppression-stream">
            Message-Stream
          </label>
          <select
            id="suppression-stream"
            value={selectedStream}
            onChange={(event) => handleStreamChange(event.target.value)}
          >
            {streamOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section className="card">
        <h2 className="card-title type-body-strong">Adresse unterdrücken</h2>
        <p className="type-caption text-muted" style={{ marginBottom: 'var(--space-lg)' }}>
          An diese Adresse werden im gewählten Stream keine Nachrichten mehr zugestellt.
        </p>
        <form onSubmit={handleAdd} noValidate>
          <div className="form-grid">
            <div className="field">
              <label className="field-label type-caption-strong" htmlFor="suppression-email">
                E-Mail-Adresse
              </label>
              <input
                id="suppression-email"
                type="email"
                value={form.EmailAddress}
                onChange={(event) =>
                  setForm({ ...form, EmailAddress: event.target.value })
                }
                placeholder="name@beispiel.de"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="field-label type-caption-strong" htmlFor="suppression-reason">
                Grund
              </label>
              <select
                id="suppression-reason"
                value={form.SuppressionReason}
                onChange={(event) =>
                  setForm({
                    ...form,
                    SuppressionReason: event.target.value as SuppressionReason,
                  })
                }
              >
                {REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Speichert …' : 'Hinzufügen'}
            </button>
          </div>
        </form>
      </section>

      <section className="card card--flush">
        {suppressions.loading ? (
          <p
            className="loading-note type-body"
            style={{ padding: 'var(--space-xl) var(--space-lg)' }}
          >
            Lade Suppressions …
          </p>
        ) : entries.length === 0 ? (
          <p className="empty-note type-body">
            Keine unterdrückten Adressen in diesem Stream.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>E-Mail-Adresse</th>
                  <th>Grund</th>
                  <th>Hinzugefügt</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.EmailAddress}>
                    <td className="cell-strong mono">{entry.EmailAddress}</td>
                    <td>
                      <span className="chip-pearl">{entry.SuppressionReason || '—'}</span>
                    </td>
                    <td className="cell-muted">{formatDateTime(entry.CreatedAt)}</td>
                    <td className="cell-muted">
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        disabled={busyEmail === entry.EmailAddress}
                        onClick={() => handleRemove(entry.EmailAddress)}
                      >
                        {busyEmail === entry.EmailAddress ? '…' : 'Entfernen'}
                      </button>
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
