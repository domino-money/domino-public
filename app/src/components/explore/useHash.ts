import { useSyncExternalStore } from 'react'

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/**
 * The address bar's hash, as it changes. App.tsx re-renders a screen on
 * every change but keeps the same instance, so a screen that reads more of
 * the hash than App hands it watches the hash itself.
 */
export const useHash = () => useSyncExternalStore(subscribe, () => window.location.hash, () => '')
