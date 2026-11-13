import { useState } from 'react'
import { api } from '../api/client'
import type { WebhookListResponse } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'

export default function Webhooks() {
  const { data, loading } = useApi<WebhookListResponse>(api.webhooks, fixtures.webhooks)
  const [hintVisible, setHintVisible] = useState(false)

  const webhooks = data?.Webhooks ?? []

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Webhooks</h1>
          <p className="page-sub type-caption text-muted">
            {data
              ? `${data.TotalCount} Endpunkte — Delivery- und Bounce-Events mit Trace-Id`
              : 'Delivery- und Bounce-Events'}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={() => setHintVisible((visible) => !visible)}
          aria-expanded={hintVisible}
        >
          Webhook hinzufügen
        </button>
      </header>

      {hintVisible ? (
        <p className="inline-hint type-caption">
          Webhooks werden über die API angelegt: <span className="mono">POST /webhooks</span> ·
          Verifizierung: <span className="mono">POST /webhooks/verify</span> ·
          Idempotenz via <span className="mono">X-PM-Webhook-Trace-Id</span>
        </p>
      ) : null}

      <section className="card">
        {loading ? (
          <p className="loading-note type-body">Lade Webhooks …</p>
        ) : webhooks.length === 0 ? (
          <p className="empty-note type-body">
            Noch keine Webhooks registriert.
          </p>
        ) : (
          webhooks.map((webhook) => (
            <div key={webhook.ID} className="webhook-row">
              <div style={{ minWidth: 0 }}>
                <p className="type-body-strong text-ellipsis mono">{webhook.Url}</p>
                <p className="type-caption text-muted" style={{ marginTop: 'var(--space-xxs)' }}>
                  {webhook.HttpAuth ? 'Basic Auth aktiv' : 'ohne HttpAuth'}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
                <div className="webhook-events">
                  {webhook.Events.map((event) => (
                    <span key={event} className="chip-pearl">
                      {event}
                    </span>
                  ))}
                </div>
                <span className={`badge ${webhook.Verified ? 'badge--ok' : 'badge--pending'}`}>
                  {webhook.Verified ? 'Verifiziert' : 'Ausstehend'}
                </span>
              </div>
            </div>
          ))
        )}
      </section>
    </>
  )
}
