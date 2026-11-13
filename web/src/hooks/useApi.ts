/**
 * Daten-Hook: lädt live aus der postbote-API; bei Fehlschlag automatisch
 * auf die Demo-Fixtures zurückfallend (die UI muss ohne Backend laufbar sein).
 */

import { useCallback, useEffect, useState } from 'react'
import { useDemoMode } from '../state/demo'

interface UseApiResult<T> {
  data: T | null
  loading: boolean
  /** null = Health-Check läuft; true = Demo-Modus; false = live */
  demo: boolean | null
  reload: () => void
}

export function useApi<T>(
  load: () => Promise<T>,
  fixture: () => T,
): UseApiResult<T> {
  const demo = useDemoMode()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    if (demo === null) return // Health-Check läuft noch
    let alive = true
    setLoading(true)

    const run = demo
      ? Promise.resolve(fixture())
      : load().catch(() => fixture())

    run
      .then((result) => {
        if (alive) {
          setData(result)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
    // Bewusst nur von demo/reloadKey abhängig — load/fixture sind pro Seite stabil.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, reloadKey])

  return { data, loading, demo, reload }
}
