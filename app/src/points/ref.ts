/**
 * The referrer this browser keeps (./capture.ts stores it from a referral link's `?ref=`), as the Points page reads it and
 * forgets it once the points service has recorded the link, or answered that one already holds (rugged97's spec, step 6).
 * In the Points page's own chunk: the entry every visitor downloads carries only the capture.
 */
import { REF_ADDRESS, REF_KEY, type RefStore } from './capture'

/** A stored referrer, in lower case, or null when none is stored or what is stored is not an address. */
export function storedRef(store: RefStore | null): string | null {
  try {
    const value = store?.getItem(REF_KEY) ?? null
    return value !== null && REF_ADDRESS.test(value) ? value.toLowerCase() : null
  } catch {
    return null
  }
}

/** Forgets the stored referrer. */
export function clearRef(store: RefStore | null): void {
  try {
    store?.removeItem(REF_KEY)
  } catch {
    // A browser that refuses storage keeps nothing to forget.
  }
}
