import { useState, type FormEvent } from 'react'
import { api, API_BASE } from '../api/client'
import type { RelayConfig, ServerInfo, TlsMode } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { useDemoMode } from '../state/demo'
import { getUserLabel, isOidcEnabled } from '../auth/oidc'

const TLS_MODES: Array<{ value: TlsMode; label: string }> = [
  { value: 'none', label: 'Kein TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'tls', label: 'TLS' },
]

type StatusState = { kind: 'ok' | 'error' | 'info'; text: string } | null

export default function Settings() {
  const demo = useDemoMode()
  const oidcEnabled = isOidcEnabled()
  const server = useApi<ServerInfo>(api.server, fixtures.server)
  const [form, setForm] = useState<RelayConfig>(fixtures.relayConfig)
  const [status, setStatus] = useState<StatusState>(null)
  const [saving, setSaving] = useState(false)

  const info = server.data

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const host = form.Host.trim()
    const port = Number(form.Port)

    if (host === '') {
      setStatus({ kind: 'error', text: 'Host ist erforderlich.' })
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setStatus({ kind: 'error', text: 'Port muss eine ganze Zahl zwischen 1 und 65535 sein.' })
      return
    }

    setSaving(true)
    setStatus(null)
    try {
      if (demo) {
        setStatus({ kind: 'info', text: 'Demo-Modus: Einstellungen werden nicht gespeichert.' })
      } else {
        await api.saveRelay({ ...form, Host: host, Port: port })
        setStatus({ kind: 'ok', text: 'Relay-Konfiguration gespeichert.' })
      }
    } catch {
      setStatus({ kind: 'error', text: 'Speichern fehlgeschlagen — API nicht erreichbar.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Einstellungen</h1>
          <p className="page-sub type-caption text-muted">
            Server, Token und Upstream-SMTP-Relay.
          </p>
        </div>
      </header>

      {oidcEnabled ? (
        <section className="card">
          <h2 className="card-title type-body-strong">Anmeldung</h2>
          <p className="type-caption text-muted">
            Single Sign-On (OIDC) ist aktiv. Angemeldet als{' '}
            {getUserLabel() ?? 'unbekannter Benutzer'}.
          </p>
        </section>
      ) : null}

      <section className="card">
        <h2 className="card-title type-body-strong">Server</h2>
        {info ? (
          <div>
            <div className="info-row">
              <span className="info-label type-caption">Name</span>
              <span className="info-value type-caption">{info.Name}</span>
            </div>
            <div className="info-row">
              <span className="info-label type-caption">Server-ID</span>
              <span className="info-value type-caption mono">{info.ServerId ?? '—'}</span>
            </div>
            <div className="info-row">
              <span className="info-label type-caption">API-Basis-URL</span>
              <span className="info-value type-caption mono">{API_BASE}</span>
            </div>
            <div className="info-row">
              <span className="info-label type-caption">Message-Stream</span>
              <span className="info-value type-caption">{info.MessageStream ?? 'outbound'}</span>
            </div>
          </div>
        ) : (
          <p className="loading-note type-body">Lade Server-Info …</p>
        )}
      </section>

      <section className="card">
        <h2 className="card-title type-body-strong">Server-Token</h2>
        <p className="mono type-caption" style={{ marginBottom: 'var(--space-xs)' }}>
          {info?.TokenPreview ?? '••••••••••••••••'}
        </p>
        <p className="type-caption text-muted">
          Aus Sicherheitsgründen wird der Token nur maskiert angezeigt — er liegt in der Datenbank
          ausschließlich gehasht vor. Rotieren über <span className="mono">POST /server/token</span>.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title type-body-strong">Upstream-SMTP-Relay</h2>
        <p className="type-caption text-muted" style={{ marginBottom: 'var(--space-lg)' }}>
          Anmeldedaten für den Upstream (z.&nbsp;B. Mailcow). Der Worker versendet über diesen
          Relay mit Retry und Backoff.
        </p>
        <form onSubmit={handleSubmit} noValidate>
          <div className="form-grid">
            <div className="field">
              <label className="field-label type-caption-strong" htmlFor="relay-host">
                Host
              </label>
              <input
                id="relay-host"
                type="text"
                value={form.Host}
                onChange={(event) => setForm({ ...form, Host: event.target.value })}
                placeholder="smtp.example.com"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="field-label type-caption-strong" htmlFor="relay-port">
                Port
              </label>
              <input
                id="relay-port"
                type="text"
                inputMode="numeric"
                value={String(form.Port)}
                onChange={(event) => setForm({ ...form, Port: Number(event.target.value) || 0 })}
                placeholder="587"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="field-label type-caption-strong" htmlFor="relay-username">
                Benutzername
              </label>
              <input
                id="relay-username"
                type="text"
                value={form.Username}
                onChange={(event) => setForm({ ...form, Username: event.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="field-label type-caption-strong" htmlFor="relay-password">
                Passwort
              </label>
              <input
                id="relay-password"
                type="password"
                value={form.Password}
                onChange={(event) => setForm({ ...form, Password: event.target.value })}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="field" style={{ marginBottom: 'var(--space-lg)' }}>
            <span className="field-label type-caption-strong">TLS-Modus</span>
            <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
              {TLS_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  className={`chip${form.TlsMode === mode.value ? ' chip--selected' : ''}`}
                  onClick={() => setForm({ ...form, TlsMode: mode.value })}
                  aria-pressed={form.TlsMode === mode.value}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Speichert …' : 'Relay speichern'}
            </button>
            {status ? (
              <span className={`form-status form-status--${status.kind}`} role="status">
                {status.text}
              </span>
            ) : null}
          </div>
        </form>
      </section>
    </>
  )
}
