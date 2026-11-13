import { NavLink } from 'react-router-dom'

const NAV = [
  { to: '/', label: 'Übersicht', end: true },
  { to: '/messages', label: 'Messages', end: false },
  { to: '/bounces', label: 'Bounces', end: false },
  { to: '/templates', label: 'Templates', end: false },
  { to: '/webhooks', label: 'Webhooks', end: false },
  { to: '/streams', label: 'Streams', end: false },
  { to: '/suppressions', label: 'Suppressions', end: false },
  { to: '/stats', label: 'Statistik', end: false },
  { to: '/settings', label: 'Einstellungen', end: false },
]

export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Hauptnavigation">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `nav-item${isActive ? ' nav-item--active' : ''}`
          }
        >
          {item.label}
        </NavLink>
      ))}
      <div className="sidebar-footer">
        <span className="type-fine-print text-muted">postbote v0.1 · self-hosted</span>
      </div>
    </nav>
  )
}
