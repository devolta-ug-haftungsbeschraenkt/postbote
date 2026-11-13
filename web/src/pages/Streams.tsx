import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import type { MessageStream, MessageStreamsResponse } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { useDemoMode } from '../state/demo'

type Hint = { kind: 'ok' | 'error' | 'info'; text: string } | null

const STREAM_TYPES = [
  { value: 'Transactional', label: 'Transactional' },
  { value: 'Broadcast', label: 'Broadcast' },
]

const EMPTY_FORM = { ID: '', Name: '', MessageStreamType: 'Transactional' }

export default function Streams() {
  const { data, loading, reload } = useApi<MessageStreamsResponse>(
    api.streams,
    fixtures.streams,
  )
  const demo = useDemoMode()

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [hint, setHint] = useState<Hint>(null)

  const streams = data?.MessageStreams ?? []

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = form.ID.trim()
    const name = form.Name.trim()

    if (id === '' || name === '') {
      setHint({ kind: 'error', text: 'ID und Name sind erforderlich.' })
      return
    }

    setSubmitting(true)
    setHint(null)
    try {
      if (demo) {
        setHint({ kind: 'info', text: 'Demo-Modus: Stream wird nicht angelegt.' })
      } else {
        await api.createStream({
          ID: id,
          Name: name,
          MessageStreamType: form.MessageStreamType,
        })
        setHint({ kind: 'ok', text: `Stream „${name}“ wurde angelegt.` })
        setForm(EMPTY_FORM)
        setFormOpen(false)
        reload()
      }
    } catch {
      setHint({ kind: 'error', text: 'Anlegen fehlgeschlagen — API nicht erreichbar.' })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleToggleArchive(stream: MessageStream) {
    setBusyId(stream.ID)
    setHint(null)
    try {
      if (demo) {
        setHint({ kind: 'info', text: 'Demo-Modus: Änderungen werden nicht gespeichert.' })
      } else {
        if (stream.Archived) {
          await api.unarchiveStream(stream.ID)
          setHint({ kind: 'ok', text: `Stream „${stream.Name}“ wurde reaktiviert.` })
        } else {
          await api.archiveStream(stream.ID)
          setHint({ kind: 'ok', text: `Stream „${stream.Name}“ wurde archiviert.` })
        }
        reload()
      }
    } catch {
      setHint({ kind: 'error', text: 'Aktion fehlgeschlagen — API nicht erreichbar.' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Streams</h1>
          <p className="page-sub type-caption text-muted">
            {data
              ? `${data.TotalCount} Message-Streams — getrennte Zustellkanäle`
              : 'Getrennte Zustellkanäle für Transaktions- und Broadcast-Mails'}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={() => setFormOpen((open) => !open)}
          aria-expanded={formOpen}
          aria-controls="stream-create-form"
        >
          {formOpen ? 'Abbrechen' : 'Stream anlegen'}
        </button>
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

      {formOpen ? (
        <section className="card" id="stream-create-form">
          <h2 className="card-title type-body-strong">Neuen Stream anlegen</h2>
          <p className="type-caption text-muted" style={{ marginBottom: 'var(--space-lg)' }}>
            Die ID ist das technische Kürzel (z.&nbsp;B. <span className="mono">receipts</span>) und
            kann nach dem Anlegen nicht mehr geändert werden.
          </p>
          <form onSubmit={handleCreate} noValidate>
            <div className="form-grid">
              <div className="field">
                <label className="field-label type-caption-strong" htmlFor="stream-id">
                  ID
                </label>
                <input
                  id="stream-id"
                  type="text"
                  value={form.ID}
                  onChange={(event) => setForm({ ...form, ID: event.target.value })}
                  placeholder="receipts"
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label className="field-label type-caption-strong" htmlFor="stream-name">
                  Name
                </label>
                <input
                  id="stream-name"
                  type="text"
                  value={form.Name}
                  onChange={(event) => setForm({ ...form, Name: event.target.value })}
                  placeholder="Belege & Rechnungen"
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label className="field-label type-caption-strong" htmlFor="stream-type">
                  Typ
                </label>
                <select
                  id="stream-type"
                  value={form.MessageStreamType}
                  onChange={(event) =>
                    setForm({ ...form, MessageStreamType: event.target.value })
                  }
                >
                  {STREAM_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Legt an …' : 'Anlegen'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="card card--flush">
        {loading ? (
          <p
            className="loading-note type-body"
            style={{ padding: 'var(--space-xl) var(--space-lg)' }}
          >
            Lade Streams …
          </p>
        ) : streams.length === 0 ? (
          <p className="empty-note type-body">Noch keine Streams angelegt.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Typ</th>
                  <th>Beschreibung</th>
                  <th>Status</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {streams.map((stream) => (
                  <tr key={stream.ID}>
                    <td className="cell-strong mono">{stream.ID}</td>
                    <td>{stream.Name}</td>
                    <td className="cell-muted">
                      <span className="chip-pearl">{stream.MessageStreamType || '—'}</span>
                    </td>
                    <td className="cell-subject">{stream.Description || '—'}</td>
                    <td>
                      <span
                        className={`badge ${stream.Archived ? 'badge--pending' : 'badge--ok'}`}
                      >
                        {stream.Archived ? 'Archiviert' : 'Aktiv'}
                      </span>
                    </td>
                    <td className="cell-muted">
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        disabled={busyId === stream.ID}
                        onClick={() => handleToggleArchive(stream)}
                      >
                        {busyId === stream.ID
                          ? '…'
                          : stream.Archived
                            ? 'Reaktivieren'
                            : 'Archivieren'}
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
