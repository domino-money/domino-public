import { useSyncExternalStore } from 'react'
import { currentRoute, subscribeRoute } from '../../lib/route'

/**
 * The route, as it changes, in the hash router's form (`#/markets/<token>`). App.tsx re-renders a screen on
 * every change but keeps the same instance, so a screen that reads more of
 * the route than App hands it watches the route itself. Changed on purpose 2026-11-07 (pages of their own,
 * lib/route.ts): read from the address's path and section, where it was the hash.
 */
export const useHash = () => useSyncExternalStore(subscribeRoute, currentRoute, () => '')
