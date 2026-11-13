import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { DemoProvider } from './state/demo'
import { Layout } from './components/Layout'
import Overview from './pages/Overview'
import Messages from './pages/Messages'
import Bounces from './pages/Bounces'
import Templates from './pages/Templates'
import Webhooks from './pages/Webhooks'
import Settings from './pages/Settings'
import Streams from './pages/Streams'
import Suppressions from './pages/Suppressions'
import Stats from './pages/Stats'

export default function App() {
  return (
    <BrowserRouter>
      <DemoProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/bounces" element={<Bounces />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/webhooks" element={<Webhooks />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/streams" element={<Streams />} />
            <Route path="/suppressions" element={<Suppressions />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="*" element={<Overview />} />
          </Route>
        </Routes>
      </DemoProvider>
    </BrowserRouter>
  )
}
