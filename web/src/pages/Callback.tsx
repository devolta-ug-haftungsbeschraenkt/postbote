import { useEffect, useRef, useState } from 'react'
import { handleCallback, signIn } from '../auth/oidc'

/**
 * OIDC-Callback-Seite. Liegt bewusst außerhalb des Layouts/Login-Gates und
 * tauscht den Authorization Code gegen Tokens (siehe handleCallback).
 */
export default function Callback() {
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // Schutz gegen doppelte Ausführung (React.StrictMode) — der Code darf nur
    // einmal eingelöst werden.
    if (started.current) return
    started.current = true

    handleCallback().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Anmeldung fehlgeschlagen.')
    })
  }, [])

  return (
    <main className="callback-page" id="main">
      <div className="card callback-card">
        {error ? (
          <>
            <h1 className="type-display-md">Anmeldung fehlgeschlagen</h1>
            <p className="type-body text-muted" role="alert">
              {error}
            </p>
            <p className="inline-hint type-caption">
              <a
                className="text-link"
                href="/"
                onClick={(event) => {
                  event.preventDefault()
                  void signIn()
                }}
              >
                Erneut anmelden
              </a>
              {' · '}
              <a className="text-link" href="/">
                Zurück zur Startseite
              </a>
            </p>
          </>
        ) : (
          <>
            <h1 className="type-display-md">Anmeldung läuft …</h1>
            <p className="type-body text-muted">Sie werden weitergeleitet.</p>
          </>
        )}
      </div>
    </main>
  )
}
