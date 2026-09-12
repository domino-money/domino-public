/**
 * Light or dark: the only thing this app keeps in the browser.
 *
 * One localStorage key, `domino-appearance`, holding 'dark' or 'light', the
 * key and values the workbench uses. With nothing saved the app opens dark,
 * and a saved choice is never overridden. Storage can be missing or refuse
 * access (a private window, blocked site data), so every access is guarded:
 * the toggle then still works for the visit. A change made in another tab
 * arrives through the storage event.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'domino-appearance'
const listeners = new Set<() => void>()
/** This visit's choice, kept only when storage refused it. */
let unsaved: boolean | null = null

function stored(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'light'
  } catch {
    return true
  }
}

const snapshot = () => unsaved ?? stored()

function subscribe(listener: () => void) {
  listeners.add(listener)
  const storage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return
    unsaved = null
    listener()
  }
  window.addEventListener('storage', storage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', storage)
  }
}

export function setDark(dark: boolean) {
  try {
    window.localStorage.setItem(KEY, dark ? 'dark' : 'light')
    unsaved = null
  } catch {
    unsaved = dark
  }
  for (const listener of listeners) listener()
}

export function useAppearance() {
  const dark = useSyncExternalStore(subscribe, snapshot, () => true)
  return { dark, setDark }
}
