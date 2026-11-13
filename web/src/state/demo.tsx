/**
 * Demo-Modus: Beim Start wird einmal /deliverystats angefragt.
 * Antwortet die API nicht, läuft die gesamte UI auf Fixtures und der
 * Header zeigt den dezenten „Demo-Daten“-Badge.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api/client'

type DemoState = { demo: boolean | null } // null = Health-Check läuft

const DemoContext = createContext<DemoState>({ demo: null })

export function DemoProvider({ children }: { children: ReactNode }) {
  const [demo, setDemo] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    api
      .deliveryStats()
      .then(() => {
        if (alive) setDemo(false)
      })
      .catch(() => {
        if (alive) setDemo(true)
      })
    return () => {
      alive = false
    }
  }, [])

  return <DemoContext.Provider value={{ demo }}>{children}</DemoContext.Provider>
}

export function useDemoMode(): boolean | null {
  return useContext(DemoContext).demo
}
