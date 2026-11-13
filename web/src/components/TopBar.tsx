import { useDemoMode } from '../state/demo'

export function TopBar() {
  const demo = useDemoMode()

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
