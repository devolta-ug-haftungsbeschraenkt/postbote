import { Outlet } from 'react-router-dom'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'

export function Layout() {
  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
