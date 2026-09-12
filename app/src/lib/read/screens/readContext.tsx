/**
 * Which read source a read screen uses: the one the read lab injects for a
 * case, otherwise the app's single scheduled source from buildMode.ts. There
 * is never a second HTTP client and never a second queue.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { loadReadSource } from '../buildMode'
import type { ReadSource } from '../types'

const ReadSourceContext = createContext<ReadSource | null>(null)

export function ReadSourceProvider({ source, children }: { source: ReadSource; children: ReactNode }) {
  return <ReadSourceContext.Provider value={source}>{children}</ReadSourceContext.Provider>
}

/** Null until the app source has loaded; screens render their idle state meanwhile. */
export function useReadSource(): ReadSource | null {
  const injected = useContext(ReadSourceContext)
  const [loaded, setLoaded] = useState<ReadSource | null>(null)
  useEffect(() => {
    if (injected) return
    let live = true
    void loadReadSource()?.then((source) => {
      if (live) setLoaded(source)
    })
    return () => {
      live = false
    }
  }, [injected])
  return injected ?? loaded
}
