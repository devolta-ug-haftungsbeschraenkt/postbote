import { useDemoMode } from '../state/demo'
import { getUserLabel, isAuthenticated, isOidcEnabled, signIn, signOut } from '../auth/oidc'

export function TopBar() {
  const demo = useDemoMode()

  // Ohne OIDC bleibt der Header exakt wie gehabt (Demo-Modus unverändert).
  if (!isOidcEnabled()) {
    return (
      <header className="topbar">
        <span className="wordmark">postbote</span>
        <span className="topbar-note type-fine-print">self-hosted Mail-Versand-Service</span>
        <div className="topbar-right">
          {demo === true ? (
            <span className="demo-badge type-fine-print">Demo-Daten</span>
          ) : null}
        </div>
      </header>
    )
  }

  const authenticated = isAuthenticated()
  const userLabel = authenticated ? getUserLabel() ?? 'Angemeldet' : null

  return (
    <header className="topbar">
      <span className="wordmark">postbote</span>
      <span className="topbar-note type-fine-print">self-hosted Mail-Versand-Service</span>
      <div className="topbar-right">
        {demo === true ? (
          <span className="demo-badge type-fine-print">Demo-Daten</span>
        ) : null}
        <div className="auth-cluster" role="group" aria-label="Anmeldung">
          {authenticated ? (
            <>
              <span className="auth-user type-caption" title={userLabel ?? undefined}>
                {userLabel}
              </span>
              <button type="button" className="btn btn-auth type-caption" onClick={() => signOut()}>
                Abmelden
              </button>
            </>
          ) : (
            <>
              <span className="auth-hint type-fine-print">Bitte melden Sie sich an.</span>
              <button
                type="button"
                className="btn btn-auth type-caption"
                onClick={() => void signIn()}
              >
                Anmelden
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
