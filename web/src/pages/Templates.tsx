import { useState } from 'react'
import { api } from '../api/client'
import type { TemplateListResponse } from '../api/types'
import * as fixtures from '../data/fixtures'
import { useApi } from '../hooks/useApi'
import { formatDateTime } from '../utils/format'

export default function Templates() {
  const { data, loading } = useApi<TemplateListResponse>(api.templates, fixtures.templates)
  const [hintVisible, setHintVisible] = useState(false)

  const templates = data?.Templates ?? []

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="type-display-md">Templates</h1>
          <p className="page-sub type-caption text-muted">
            {data
              ? `${data.TotalCount} Vorlagen mit Mustachio-Rendering und Layout-Referenz`
              : 'Mustachio-Vorlagen'}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={() => setHintVisible((visible) => !visible)}
          aria-expanded={hintVisible}
        >
          Neue Vorlage
        </button>
      </header>

      {hintVisible ? (
        <p className="inline-hint type-caption">
          Vorlagen werden über die Postmark-kompatible API verwaltet:{' '}
          <span className="mono">POST /templates</span> · Validierung:{' '}
          <span className="mono">POST /templates/validate</span>
        </p>
      ) : null}

      {loading ? (
        <p className="loading-note type-body">Lade Vorlagen …</p>
      ) : templates.length === 0 ? (
        <p className="empty-note type-body card">Noch keine Vorlagen angelegt.</p>
      ) : (
        <div className="grid-2">
          {templates.map((template) => (
            <article key={template.TemplateId} className="card">
              <h2 className="card-title type-body-strong">{template.Name}</h2>
              <p className="type-caption text-muted mono" style={{ marginBottom: 'var(--space-xxs)' }}>
                {template.Alias ?? `template-${template.TemplateId}`}
              </p>
              <p className="type-caption" style={{ marginBottom: 'var(--space-sm)' }}>
                {template.Subject}
              </p>
              <div className="template-meta">
                <span className="chip-pearl">
                  Layout: {template.Layout ?? 'kein'}
                </span>
                <span className="type-caption text-muted">
                  {formatDateTime(template.LastModified)}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  )
}
